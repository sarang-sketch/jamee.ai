/**
 * @vitest-environment node
 *
 * The integration harness has two halves, and only one of them needs a database.
 *
 * This file tests the half that does NOT: the classification fixtures and the two-stage validation
 * they drive, and the provider stubs (the real gateway over the real adapters over stubbed SDK
 * calls). All of it runs on every machine on every `npm test`, which matters because the other
 * half — `tests/integration/harness.test.ts` — needs an in-memory replica set, so a fixture bug
 * there would surface only when the integration project runs.
 *
 * Requirements: 5.1 – 5.6 (the two validation stages), 6.2 / 6.3 (the model's own non-identified
 *               statuses), 14.4 (a rate limit on the primary retries on the fallback), 14.8 (a
 *               both-provider failure is one failed operation), 17.5
 * Design: Amendment A3 — the harness runs on `mongodb-memory-server`, and the DB-bound fixtures
 *         (the two Google-path farmers and the GridFS media) are exercised in the integration
 *         `harness.test.ts` rather than here, because under A3 there is no session-derivation or
 *         object-store double left to test without a database.
 *
 * `node` rather than the unit project's jsdom default, for the reason `src/lib/groq.test.ts` gives:
 * the provider adapters are `server-only` modules that run in the Node.js runtime V17 pins every
 * route handler to, and a DOM shim's `Response` has already produced one false negative here.
 */
import { describe, expect, it } from 'vitest';

import { Buffer } from 'node:buffer';

import { isFallbackTrigger } from '@/lib/ai/errors';
import { isAppError } from '@/lib/errors';
import { interpret } from '@/services/diagnosis.service';

import {
  CLASSIFICATIONS,
  DEFAULT_REPHRASE,
  DEFAULT_TRANSCRIPTION,
  RATE_LIMIT_STATUS,
  UNPARSEABLE_CLASSIFICATION,
  UNPROCESSABLE_STATUS,
  classificationText,
  providerCallCount,
  providerRejection,
  providerStubs,
  rephraseNaming,
  respondsAfterPrimaryRateLimit,
} from '../integration/providers';

const VISION_CALL = {
  imageBase64: 'aGVsbG8=',
  imageMimeType: 'image/jpeg',
  prompt: 'classify this leaf',
  responseSchema: { type: 'object' },
} as const;

describe('the classification fixtures', () => {
  /**
   * The four branches driven through the REAL two-stage validation rather than compared against the
   * fixture's own values. `interpret()` is `diagnosis.service.ts`'s.
   */
  it('drives the identified, healthy, unclear and no_plant branches', () => {
    const identified = interpret(classificationText(CLASSIFICATIONS.tomatoEarlyBlight));
    expect(identified.ok).toBe(true);
    expect(identified.ok && identified.verified.disease_name).toBe('Tomato Early Blight');
    expect(identified.ok && identified.verified.confidence).toBe(0.92);

    const healthy = interpret(classificationText(CLASSIFICATIONS.tomatoHealthy));
    expect(healthy.ok).toBe(true);
    expect(healthy.ok && healthy.verified.disease_name).toBe('Tomato Healthy');
    expect(healthy.ok && healthy.verified.severity).toBe('none');

    expect(interpret(classificationText(CLASSIFICATIONS.unclear))).toEqual({
      ok: false,
      reason: 'model_unclear',
    });
    expect(interpret(classificationText(CLASSIFICATIONS.noPlant))).toEqual({
      ok: false,
      reason: 'model_no_plant',
    });
  });

  it('drives the two rejection branches a scenario needs', () => {
    expect(interpret(classificationText(CLASSIFICATIONS.outsideKnowledgeBase))).toEqual({
      ok: false,
      reason: 'unverified_condition',
    });
    expect(interpret(UNPARSEABLE_CLASSIFICATION)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('scripts a rephrase that needs no canonical-name repair', () => {
    expect(rephraseNaming('Tomato Late Blight')).toContain('Tomato Late Blight');
    expect(rephraseNaming('Tomato Late Blight')).toContain(DEFAULT_REPHRASE);
  });
});

describe('the provider seam', () => {
  it('answers a classification through the real gateway and the real adapter', async () => {
    const providers = providerStubs({
      vision: classificationText(CLASSIFICATIONS.potatoLateBlight),
    });

    const result = await providers.models.classify(VISION_CALL);

    expect(result.provider).toBe('gemini');
    expect(result.usedFallback).toBe(false);
    expect(JSON.parse(result.value)).toEqual(CLASSIFICATIONS.potatoLateBlight);

    // The adapter built this request, not the harness: the image part carries the inline bytes and
    // the MIME type in A3's `data` form (V34), which is what makes the seam sit BELOW the adapter.
    expect(providers.calls.geminiVision[0]?.input).toEqual([
      { type: 'image', data: VISION_CALL.imageBase64, mime_type: 'image/jpeg' },
      { type: 'text', text: VISION_CALL.prompt },
    ]);
    expect(providers.calls.geminiVision[0]?.store).toBe(false);
    expect(providerCallCount(providers.calls)).toBe(1);
  });

  it('runs the real fallback loop when the primary rate-limits (Requirement 14.4)', async () => {
    const providers = respondsAfterPrimaryRateLimit({
      vision: classificationText(CLASSIFICATIONS.tomatoHealthy),
    });

    const result = await providers.models.classify(VISION_CALL);

    expect(result.provider).toBe('groq');
    expect(result.usedFallback).toBe(true);
    expect(providers.calls.geminiVision).toHaveLength(1);
    expect(providers.calls.groqChat).toHaveLength(1);
    // Nothing in the harness decided that: V11's table classified the 429 and the gateway acted.
    expect(isFallbackTrigger('RATE_LIMIT')).toBe(true);
  });

  it('stops the chain on a status V11 does not treat as a fallback trigger', async () => {
    const providers = providerStubs({
      geminiRejection: providerRejection(UNPROCESSABLE_STATUS),
    });

    await expect(providers.models.classify(VISION_CALL)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'PROVIDERS_UNAVAILABLE',
    );
    expect(providers.calls.groqChat).toHaveLength(0);
  });

  it('reports a both-member failure as one failed operation (Requirement 14.8)', async () => {
    const providers = providerStubs({
      geminiRejection: providerRejection(RATE_LIMIT_STATUS),
      groqChatRejection: providerRejection(RATE_LIMIT_STATUS),
    });

    await expect(providers.models.classify(VISION_CALL)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'PROVIDERS_UNAVAILABLE',
    );
    expect(providerCallCount(providers.calls)).toBe(2);
  });

  it('scripts a text generation and records the prompt the caller built', async () => {
    const providers = providerStubs({ text: (prompt) => `echo: ${prompt.slice(0, 8)}` });

    const result = await providers.models.generate({ prompt: 'rephrase this row', system: 'rules' });

    expect(result.value).toBe('echo: rephrase');
    expect(providers.calls.geminiText).toHaveLength(1);
    expect(providers.calls.geminiText[0]?.system_instruction).toBe('rules');
  });

  it('returns a fixed transcript, and an empty one as a successful call', async () => {
    const providers = providerStubs();

    const spoken = await providers.transcribe({
      audioBytes: Buffer.from('fake-opus-bytes'),
      container: 'audio/webm',
      language: 'en',
    });
    expect(spoken.provider).toBe('groq');
    expect(spoken.value.text).toBe(DEFAULT_TRANSCRIPTION.text);
    expect(spoken.value.signals.noSpeechProb).toBe(DEFAULT_TRANSCRIPTION.no_speech_prob);
    expect(providers.calls.transcription[0]?.language).toBe('en');

    // Requirement 8.7: an empty transcript is the provider answering, not the provider failing.
    providers.script.transcription = { text: '', language: 'hi' };
    const silence = await providers.transcribe({
      audioBytes: Buffer.from('fake-silent-bytes'),
      container: 'audio/webm',
      language: 'hi',
    });
    expect(silence.value.text).toBe('');
  });
});

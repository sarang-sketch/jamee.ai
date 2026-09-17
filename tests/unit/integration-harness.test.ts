/**
 * @vitest-environment node
 *
 * The integration harness has two halves, and only one of them needs a database.
 *
 * This file tests the half that does not: the connection-string derivation, the provider stubs and
 * the classification fixtures they script, and the object-store double. All of it runs on every
 * machine on every `npm test`, which matters because the other half —
 * `tests/integration/harness.test.ts` — is skipped without `JAMEE_TEST_DATABASE_URL`, so a fixture
 * bug there would sit undiscovered on any machine that has no local stack.
 *
 * Requirements: 5.1 – 5.6 (the two validation stages), 6.2 / 6.3 (the model's own non-identified
 *               statuses), 14.4 (a rate limit on the primary retries on the fallback), 14.8 (a
 *               both-provider failure is one failed operation), 2.5 / 2.6 (a reference outside the
 *               farmer's own prefix, or in the wrong bucket, is refused), 17.5
 *
 * `node` rather than the unit project's jsdom default, for the reason `src/lib/groq.test.ts` gives:
 * the provider adapters are `server-only` modules that run in the Node.js runtime V17 pins every
 * route handler to, and a DOM shim's `Response` has already produced one false negative here.
 */
import { describe, expect, it } from 'vitest';

import { isFallbackTrigger } from '@/lib/ai/errors';
import { STORAGE_BUCKETS } from '@/lib/config/verified';
import { isAppError } from '@/lib/errors';
import { buildStorageRef } from '@/lib/storage';
import { interpret } from '@/services/diagnosis.service';

import {
  LOCAL_SUPABASE_API_PORT,
  SUPABASE_ANON_KEY_VAR,
  SUPABASE_API_URL_VAR,
  SUPABASE_SERVICE_ROLE_KEY_VAR,
  TEST_DATABASE_URL_VAR,
  apiUrlFromDatabaseUrl,
  hostOfDatabaseUrl,
  requireSupabaseTestConfig,
} from '../integration/database';
import { objectStore, uploadedImage, uploadedRecording } from '../integration/objects';
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

/** The documented local value, from `.env.example` and `docs/DEPLOYMENT.md`. */
const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const VISION_CALL = {
  imageUrl: 'https://jamee-test.invalid/signed/leaf.jpg',
  imageMimeType: 'image/jpeg',
  prompt: 'classify this leaf',
  responseSchema: { type: 'object' },
} as const;

/** Swap in an environment, run, and put every variable back — including its absence. */
async function withEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('the harness stack configuration', () => {
  it('derives the local API URL from the documented database URL', () => {
    expect(hostOfDatabaseUrl(LOCAL_DATABASE_URL)).toBe('127.0.0.1');
    expect(apiUrlFromDatabaseUrl(LOCAL_DATABASE_URL)).toBe(
      `http://127.0.0.1:${LOCAL_SUPABASE_API_PORT}`,
    );
  });

  it('reads a host out of a connection string the URL parser rejects', () => {
    expect(hostOfDatabaseUrl('postgres://user:p@ss@db.internal:5432/postgres')).toBe('db.internal');
    expect(hostOfDatabaseUrl('not a url at all')).toBeUndefined();
  });

  it('prefers a configured API URL over the derived one', async () => {
    await withEnv(
      {
        [TEST_DATABASE_URL_VAR]: LOCAL_DATABASE_URL,
        [SUPABASE_API_URL_VAR]: 'https://project.supabase.co',
        [SUPABASE_ANON_KEY_VAR]: 'anon',
        [SUPABASE_SERVICE_ROLE_KEY_VAR]: 'service-role',
      },
      () => {
        expect(requireSupabaseTestConfig()).toEqual({
          databaseUrl: LOCAL_DATABASE_URL,
          apiUrl: 'https://project.supabase.co',
          anonKey: 'anon',
          serviceRoleKey: 'service-role',
        });
      },
    );
  });

  it('fails by naming the missing variable rather than skipping the opted-in suite', async () => {
    await withEnv(
      {
        [TEST_DATABASE_URL_VAR]: LOCAL_DATABASE_URL,
        [SUPABASE_API_URL_VAR]: undefined,
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': undefined,
        [SUPABASE_ANON_KEY_VAR]: undefined,
        [SUPABASE_SERVICE_ROLE_KEY_VAR]: undefined,
      },
      () => {
        expect(() => requireSupabaseTestConfig()).toThrow(SUPABASE_SERVICE_ROLE_KEY_VAR);
        // The URL is derivable from the database URL, so it must NOT be reported as missing.
        expect(() => requireSupabaseTestConfig()).toThrow(SUPABASE_ANON_KEY_VAR);
        expect(() => requireSupabaseTestConfig()).toThrow('supabase start');
      },
    );
  });
});

describe('the classification fixtures', () => {
  /**
   * The four branches task 29.1 names, driven through the REAL two-stage validation rather than
   * compared against the fixture's own values. `interpret()` is `diagnosis.service.ts`'s.
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

    // The adapter built this request, not the harness: the image part carries the signed URL and
    // the MIME type in V6's `uri` form, which is what makes the seam sit BELOW the adapter.
    expect(providers.calls.geminiVision[0]?.input).toEqual([
      { type: 'image', uri: VISION_CALL.imageUrl, mime_type: 'image/jpeg' },
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
      audioUrl: 'https://jamee-test.invalid/signed/note.webm',
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
      audioUrl: 'https://jamee-test.invalid/signed/silence.webm',
      container: 'audio/webm',
      language: 'hi',
    });
    expect(silence.value.text).toBe('');
  });
});

describe('the object fixture', () => {
  const farmerA = '11111111-1111-4111-8111-111111111111';
  const farmerB = '22222222-2222-4222-8222-222222222222';

  it('builds references under the owning farmer prefix, in the right bucket', () => {
    const store = objectStore();
    const image = uploadedImage(store, farmerA);
    const recording = uploadedRecording(store, farmerA);

    expect(image.bucket).toBe(STORAGE_BUCKETS.cropImages);
    expect(image.path.startsWith(`${farmerA}/`)).toBe(true);
    expect(recording.bucket).toBe(STORAGE_BUCKETS.voiceMessages);
    expect(store.has(image)).toBe(true);
  });

  it('answers the two questions the ownership check asks', async () => {
    const store = objectStore();
    const present = uploadedImage(store, farmerA);
    const absent = buildStorageRef({
      bucket: STORAGE_BUCKETS.cropImages,
      userId: farmerB,
      extension: 'jpg',
    });

    await expect(store.storage.from(present.bucket).exists(present.path)).resolves.toEqual({
      data: true,
      error: null,
    });
    await expect(store.storage.from(absent.bucket).exists(absent.path)).resolves.toEqual({
      data: false,
      error: null,
    });

    const signed = await store.storage.from(present.bucket).createSignedUrl(present.path, 600);
    expect(signed.data?.signedUrl).toContain(present.path);
    expect(store.signed[0]).toEqual({
      bucket: present.bucket,
      path: present.path,
      expiresInSeconds: 600,
    });
  });

  it('models a removed original and a failing probe', async () => {
    const store = objectStore();
    const image = uploadedImage(store, farmerA);

    store.remove(image);
    expect(store.has(image)).toBe(false);

    store.failProbe = true;
    await expect(store.storage.from(image.bucket).exists(image.path)).rejects.toThrow();
  });
});

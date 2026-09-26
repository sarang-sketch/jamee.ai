import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LanguageContext, type LanguageContextValue } from '@/components/LanguageProvider';
import {
  AUDIO_COUNTDOWN_FROM_SECONDS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import { AppError, toEnvelope } from '@/lib/errors';
import { messages } from '@/lib/messages';
import {
  SUPPORTED_LANGUAGES,
  voiceRequestSchema,
  type Language,
  type MediaRef,
} from '@/lib/schemas';

import {
  chooseRecordingType,
  countdownSeconds,
  DURATION_OVERSHOOT_TOLERANCE_SECONDS,
  isTranscribableRecordingType,
  measuredSeconds,
  microphoneBlockedNotice,
  RECORDER_MIME_PREFERENCES,
  recorderFailureNotice,
  recordingContainerOf,
  recordingUnsupportedNotice,
  reportedDurationSeconds,
  resolveRecordedType,
  submitVoiceRecording,
  voiceRejectionCode,
  voiceRejectionMessage,
  voiceRejectionNotice,
  VoiceRecorder,
  type MediaUploader,
  type RecordedAudio,
} from './VoiceRecorder';

/**
 * Unit tests for the decisions `VoiceRecorder` makes: which container it will record in, what the
 * countdown reads, which recordings are declined and what a rejection says, and the ORDER of
 * upload and voice request.
 *
 * Requirements: 8.1 (browser-direct upload, then the reference and the measured duration only),
 *               8.2 (120 s and 10 MB, with a countdown from 100 s), 8.3 (a recording over either
 *               limit is declined and BOTH limits are stated), 15.5 (a failed upload sends
 *               nothing)
 * Depends on: V10 (the accepted containers), V20 / U-V20 (the container is probed, not assumed)
 *
 * The capture half — `MediaRecorder`, `getUserMedia`, the two buttons — is not exercised here:
 * jsdom has neither API, so a test of it would be a test of a stub. That follows
 * `ImageUploader.test.tsx`, which leaves its canvas re-encoder alone for the same reason and its
 * DOM to task 26.2's accessibility pass and the manual plan. What IS tested is every pure decision
 * those handlers delegate to.
 */

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

/** The reference the media endpoint returns for a `voice` upload. */
const AUDIO_REF: MediaRef = { fileId: 'c'.repeat(24), kind: 'voice' };

/** A recording that is admitted: an accepted container, well inside both limits. */
function recording(overrides: Partial<RecordedAudio> = {}): RecordedAudio {
  return {
    blob: overrides.blob ?? new Blob(['opus-frames'], { type: 'audio/webm' }),
    mimeType: overrides.mimeType ?? 'audio/webm;codecs=opus',
    elapsedMs: overrides.elapsedMs ?? 8_000,
  };
}

interface RecordedUpload {
  kind: 'voice';
  size: number;
  type: string;
}

interface Recorder {
  uploads: RecordedUpload[];
  bodies: unknown[];
  upload: MediaUploader;
  voice: (body: unknown) => Promise<Response>;
}

/** Records what would have gone to the Media_Endpoint and to `/api/voice`. */
function recorder(options: { failUpload?: boolean; failVoice?: boolean } = {}): Recorder {
  const uploads: RecordedUpload[] = [];
  const bodies: unknown[] = [];
  return {
    uploads,
    bodies,
    upload: async ({ body, kind }) => {
      if (options.failUpload === true) throw new Error('media upload refused');
      uploads.push({ kind, size: body.size, type: body.type });
      return AUDIO_REF;
    },
    voice: async (body) => {
      bodies.push(body);
      if (options.failVoice === true) throw new TypeError('network failure');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function submit(
  overrides: {
    recording?: RecordedAudio;
    upload?: MediaUploader;
    voice?: (body: unknown) => Promise<Response>;
  } = {},
) {
  const io = recorder();
  return submitVoiceRecording({
    recording: overrides.recording ?? recording(),
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    upload: overrides.upload ?? io.upload,
    voice: overrides.voice ?? io.voice,
  });
}

/* ========================================================================== */
/* Container choice — V10 ∩ isTypeSupported (V20)                               */
/* ========================================================================== */

describe('RECORDER_MIME_PREFERENCES', () => {
  it('contains only containers the Transcription_Provider accepts (V10)', () => {
    const accepted: readonly string[] = TRANSCRIBE_ACCEPTED_CONTAINERS;
    for (const mimeType of RECORDER_MIME_PREFERENCES) {
      const container = recordingContainerOf(mimeType);
      expect(container).toBeDefined();
      expect(accepted).toContain(container);
    }
  });

  /**
   * Task 22.2 confirmed `aac` and `amr` are NOT in V10's list and corrected
   * `docs/VERIFIED_VALUES.md`. Recording in either would produce a provider refusal after the
   * farmer had already spoken and the object had already been uploaded.
   */
  it('offers neither aac nor amr nor 3gp, none of which V10 lists', () => {
    const preferences: readonly string[] = RECORDER_MIME_PREFERENCES;
    for (const absent of ['audio/aac', 'audio/amr', 'audio/3gpp', 'audio/3gp']) {
      expect(preferences).not.toContain(absent);
      expect(isTranscribableRecordingType(absent)).toBe(false);
    }
  });

  it('prefers Opus, the smallest of the candidates at speech bitrates', () => {
    expect(RECORDER_MIME_PREFERENCES[0]).toBe('audio/webm;codecs=opus');
  });
});

describe('recordingContainerOf', () => {
  it('drops parameters, the type prefix, a leading dot and the legacy x- tree', () => {
    expect(recordingContainerOf('audio/webm;codecs=opus')).toBe('webm');
    expect(recordingContainerOf('audio/ogg')).toBe('ogg');
    expect(recordingContainerOf('AUDIO/WEBM')).toBe('webm');
    expect(recordingContainerOf('audio/x-m4a')).toBe('m4a');
    expect(recordingContainerOf('.WEBM')).toBe('webm');
    expect(recordingContainerOf('  audio/wav  ')).toBe('wav');
  });

  it('reports nothing rather than an empty container', () => {
    expect(recordingContainerOf('')).toBeUndefined();
    expect(recordingContainerOf('   ')).toBeUndefined();
    expect(recordingContainerOf('audio/')).toBeUndefined();
  });
});

describe('isTranscribableRecordingType', () => {
  it('accepts every container V10 lists, whatever spelling it arrives in', () => {
    for (const container of TRANSCRIBE_ACCEPTED_CONTAINERS) {
      expect(isTranscribableRecordingType(`audio/${container}`)).toBe(true);
      expect(isTranscribableRecordingType(container)).toBe(true);
    }
  });

  it('refuses a container V10 does not list', () => {
    for (const mimeType of ['audio/aac', 'audio/amr', 'audio/3gpp', 'video/mp2t', '']) {
      expect(isTranscribableRecordingType(mimeType)).toBe(false);
    }
  });
});

describe('chooseRecordingType', () => {
  it('takes the first preference the browser supports', () => {
    expect(chooseRecordingType(() => true)).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      container: 'webm',
    });

    // A browser with no WebM at all falls through to the next accepted candidate.
    const noWebm = (mimeType: string): boolean => !mimeType.includes('webm');
    expect(chooseRecordingType(noWebm)).toEqual({
      mimeType: 'audio/ogg;codecs=opus',
      container: 'ogg',
    });
  });

  it('records nothing when the browser offers none of them (U-V20)', () => {
    expect(chooseRecordingType(() => false)).toBeNull();
  });

  /**
   * The intersection is with V10, not with the browser alone: a browser that happily records AAC
   * still gets no AAC recording out of this component.
   */
  it('never returns a container V10 rejects, even when the browser supports it', () => {
    const chosen = chooseRecordingType(() => true, [
      'audio/aac',
      'audio/amr',
      'audio/ogg;codecs=opus',
    ]);
    expect(chosen).toEqual({ mimeType: 'audio/ogg;codecs=opus', container: 'ogg' });

    expect(chooseRecordingType(() => true, ['audio/aac', 'audio/amr'])).toBeNull();
  });

  it('probes with the full MIME type, parameters included', () => {
    const probed: string[] = [];
    chooseRecordingType((mimeType) => {
      probed.push(mimeType);
      return false;
    });
    expect(probed).toEqual([...RECORDER_MIME_PREFERENCES]);
  });
});

describe('resolveRecordedType', () => {
  const requested = { mimeType: 'audio/webm;codecs=opus', container: 'webm' } as const;

  it('prefers what the browser actually selected (V20)', () => {
    expect(resolveRecordedType(requested, 'audio/ogg;codecs=opus')).toEqual({
      mimeType: 'audio/ogg;codecs=opus',
      container: 'ogg',
    });
  });

  it('keeps the requested type when the browser reports nothing', () => {
    expect(resolveRecordedType(requested, '')).toEqual(requested);
    expect(resolveRecordedType(requested, '   ')).toEqual(requested);
    expect(resolveRecordedType(requested, null)).toEqual(requested);
    expect(resolveRecordedType(requested, undefined)).toEqual(requested);
  });

  it('abandons the recording when the selected container is not accepted', () => {
    expect(resolveRecordedType(requested, 'audio/aac')).toBeNull();
    expect(resolveRecordedType(requested, 'audio/3gpp')).toBeNull();
  });
});

/* ========================================================================== */
/* The countdown and the measured duration (Requirement 8.2)                    */
/* ========================================================================== */

describe('countdownSeconds', () => {
  it('shows no number until the countdown is due', () => {
    expect(countdownSeconds(0)).toBeNull();
    // One tick before 100 seconds remain.
    expect(countdownSeconds((MAX_AUDIO_SECONDS - AUDIO_COUNTDOWN_FROM_SECONDS) * 1000 - 250)).toBeNull();
  });

  it('starts at exactly AUDIO_COUNTDOWN_FROM_SECONDS and runs down to zero', () => {
    const startsAtMs = (MAX_AUDIO_SECONDS - AUDIO_COUNTDOWN_FROM_SECONDS) * 1000;
    expect(countdownSeconds(startsAtMs)).toBe(AUDIO_COUNTDOWN_FROM_SECONDS);
    expect(countdownSeconds(startsAtMs + 1_000)).toBe(AUDIO_COUNTDOWN_FROM_SECONDS - 1);
    // The last whole second still reads 1 while audio is being captured.
    expect(countdownSeconds((MAX_AUDIO_SECONDS - 0.5) * 1000)).toBe(1);
    expect(countdownSeconds(MAX_AUDIO_SECONDS * 1000)).toBe(0);
  });

  it('never reports a negative remainder past the hard stop', () => {
    expect(countdownSeconds((MAX_AUDIO_SECONDS + 5) * 1000)).toBe(0);
  });
});

describe('measuredSeconds and reportedDurationSeconds', () => {
  it('measures real elapsed time to millisecond precision', () => {
    expect(measuredSeconds(8_000)).toBe(8);
    expect(measuredSeconds(8_432)).toBe(8.432);
    expect(measuredSeconds(-5)).toBe(0);
  });

  /**
   * The posted value has to satisfy `voiceRequestSchema.durationSeconds.max(MAX_AUDIO_SECONDS)`,
   * so a stop that landed a few hundred milliseconds late must not produce a body the client's own
   * schema rejects — which would surface as "something went wrong at Jamee's end" for a recording
   * that was fine.
   */
  it('clamps the reported duration to the cap the schema enforces', () => {
    expect(reportedDurationSeconds(8_000)).toBe(8);
    expect(reportedDurationSeconds(MAX_AUDIO_SECONDS * 1000)).toBe(MAX_AUDIO_SECONDS);
    expect(reportedDurationSeconds(MAX_AUDIO_SECONDS * 1000 + 400)).toBe(MAX_AUDIO_SECONDS);

    for (const elapsedMs of [1, 8_000, MAX_AUDIO_SECONDS * 1000, MAX_AUDIO_SECONDS * 1000 + 900]) {
      const parsed = voiceRequestSchema.safeParse({
        audio: AUDIO_REF,
        language: 'en',
        conversationId: CONVERSATION_ID,
        durationSeconds: reportedDurationSeconds(elapsedMs),
      });
      expect(parsed.success).toBe(true);
    }
  });
});

/* ========================================================================== */
/* Admission (Requirements 8.2, 8.3)                                            */
/* ========================================================================== */

describe('voiceRejectionCode', () => {
  const facts = (overrides: Partial<Parameters<typeof voiceRejectionCode>[0]> = {}) => ({
    mimeType: overrides.mimeType ?? 'audio/webm;codecs=opus',
    sizeBytes: overrides.sizeBytes ?? 64 * 1024,
    elapsedMs: overrides.elapsedMs ?? 8_000,
  });

  it('admits a recording inside both limits, right up to and including 10 MB', () => {
    expect(voiceRejectionCode(facts())).toBeNull();
    // Requirement 8.2 says "up to 10 MB", so the boundary itself is admitted.
    expect(voiceRejectionCode(facts({ sizeBytes: MAX_AUDIO_BYTES }))).toBeNull();
    expect(voiceRejectionCode(facts({ elapsedMs: MAX_AUDIO_SECONDS * 1000 }))).toBeNull();
  });

  it('declines one byte over the size limit (Requirement 8.3)', () => {
    expect(voiceRejectionCode(facts({ sizeBytes: MAX_AUDIO_BYTES + 1 }))).toBe('FILE_TOO_LARGE');
  });

  it('absorbs a late hard stop but declines a recording that is really too long', () => {
    const capMs = MAX_AUDIO_SECONDS * 1000;
    const toleranceMs = DURATION_OVERSHOOT_TOLERANCE_SECONDS * 1000;
    // Timer lag, not speech: admitted, and reported as the cap.
    expect(voiceRejectionCode(facts({ elapsedMs: capMs + toleranceMs }))).toBeNull();
    // A suspended tab: the recording really is longer than Requirement 8.2 allows.
    expect(voiceRejectionCode(facts({ elapsedMs: capMs + toleranceMs + 1 }))).toBe(
      'AUDIO_TOO_LONG',
    );
  });

  it('declines a recording below the minimum transcribable length', () => {
    expect(voiceRejectionCode(facts({ elapsedMs: 0 }))).toBe('TRANSCRIPT_EMPTY');
    expect(voiceRejectionCode(facts({ elapsedMs: TRANSCRIBE_MIN_SECONDS * 1000 }))).toBeNull();
  });

  it('declines a container V10 does not accept, before either limit', () => {
    expect(
      voiceRejectionCode(facts({ mimeType: 'audio/aac', sizeBytes: MAX_AUDIO_BYTES + 1 })),
    ).toBe('AUDIO_FORMAT_UNSUPPORTED');
    expect(voiceRejectionCode(facts({ mimeType: '' }))).toBe('AUDIO_FORMAT_UNSUPPORTED');
  });
});

describe('voiceRejectionMessage', () => {
  /**
   * Requirement 8.3 wants BOTH limits on either limit rejection. `120`, `10` and `MB` appear
   * verbatim in all three catalogs once `{maxSeconds}` and `{maxMb}` are filled, so this holds
   * across languages without the test knowing any of them.
   */
  const namesBothLimits = (message: string): void => {
    expect(message).toContain(String(MAX_AUDIO_SECONDS));
    expect(message).toContain(String(Math.round(MAX_AUDIO_BYTES / (1024 * 1024))));
    expect(message).toContain('MB');
    // The placeholders are filled, not shown.
    expect(message).not.toContain('{maxSeconds}');
    expect(message).not.toContain('{maxMb}');
  };

  it('states the duration and size limits for a too-long recording, in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      namesBothLimits(voiceRejectionMessage('AUDIO_TOO_LONG', language));
    }
  });

  it('states the duration and size limits for a too-large recording, in every language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      namesBothLimits(voiceRejectionMessage('FILE_TOO_LARGE', language));
    }
  });

  it('keeps the too-large reason distinct from the shared instruction', () => {
    const tooLarge = voiceRejectionMessage('FILE_TOO_LARGE', 'en');
    const tooLong = voiceRejectionMessage('AUDIO_TOO_LONG', 'en');
    expect(tooLarge).not.toBe(tooLong);
    // The reason comes first, the instruction second.
    expect(tooLarge.endsWith(tooLong)).toBe(true);
  });

  it('quotes the AUDIO byte limit, not the image one, for a too-large recording', () => {
    const megabytes = Math.round(MAX_AUDIO_BYTES / (1024 * 1024));
    expect(voiceRejectionMessage('FILE_TOO_LARGE', 'en')).toContain(`${megabytes} MB`);
  });

  it('offers the two non-limit refusals their own copy, stating no limit', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const format = voiceRejectionMessage('AUDIO_FORMAT_UNSUPPORTED', language);
      const empty = voiceRejectionMessage('TRANSCRIPT_EMPTY', language);
      expect(format).not.toBe(empty);
      for (const message of [format, empty]) {
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toContain('{');
        expect(message).not.toContain(String(MAX_AUDIO_SECONDS));
      }
    }
  });
});

/* ========================================================================== */
/* Sequencing (Requirements 8.1, 15.5)                                          */
/* ========================================================================== */

describe('submitVoiceRecording', () => {
  it('uploads the recording, then posts the reference and the measured duration', async () => {
    const io = recorder();
    const outcome = await submit({ upload: io.upload, voice: io.voice });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') return;

    // Requirement 8.1 (A3) — the recording is uploaded as a `voice` file and its reference returned.
    expect(outcome.audio).toEqual(AUDIO_REF);
    expect(io.uploads).toHaveLength(1);
    expect(io.uploads[0]?.kind).toBe('voice');
    expect(io.uploads[0]?.type).toBe('audio/webm');
    expect(io.bodies).toHaveLength(1);
    expect(outcome.durationSeconds).toBe(8);
  });

  it('uploads whatever container the browser used, as a voice-kind file', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      voice: io.voice,
      recording: recording({ mimeType: 'audio/ogg;codecs=opus', blob: new Blob(['x'], { type: 'audio/ogg' }) }),
    });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);
    // The kind is always `voice`; the container is carried on the request's `mimeType`, not a path.
    expect(io.uploads[0]?.kind).toBe('voice');
    expect((io.bodies[0] as { mimeType?: string }).mimeType).toBe('audio/ogg;codecs=opus');
  });

  it('posts a media reference and no audio bytes (Requirements 8.1, 2.7)', async () => {
    const io = recorder();
    const outcome = await submit({ upload: io.upload, voice: io.voice });
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    const [body] = io.bodies;
    expect(body).toEqual({
      audio: AUDIO_REF,
      conversationId: CONVERSATION_ID,
      durationSeconds: 8,
      mimeType: 'audio/webm;codecs=opus',
    });

    // The body the LanguageProvider will stamp a language onto is a valid voice request.
    expect(voiceRequestSchema.safeParse({ ...(body as object), language: 'hi' }).success).toBe(true);

    // Nothing binary anywhere in the body, at any depth.
    const walk = (value: unknown): void => {
      expect(value instanceof Blob).toBe(false);
      expect(value instanceof ArrayBuffer).toBe(false);
      expect(ArrayBuffer.isView(value)).toBe(false);
      if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) walk(nested);
      }
    };
    walk(body);

    // And the serialized body stays a reference in size, whatever the recording weighed.
    expect(JSON.stringify(body).length).toBeLessThan(300);
  });

  it('sends no voice request when the upload fails (Requirement 15.5)', async () => {
    const io = recorder({ failUpload: true });
    const outcome = await submit({ upload: io.upload, voice: io.voice });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('upload');
    expect(io.bodies).toHaveLength(0);
    expect(io.uploads).toHaveLength(0);
  });

  it('reports a voice request that never produced a response', async () => {
    const io = recorder({ failVoice: true });
    const outcome = await submit({ upload: io.upload, voice: io.voice });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('voice');
    // The object is in the bucket; the sweep's orphan scan is what reclaims it.
    expect(io.uploads).toHaveLength(1);
  });

  it('declines an over-limit recording before any byte leaves the phone', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      voice: io.voice,
      recording: recording({
        blob: new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: 'audio/webm' }),
      }),
    });

    expect(outcome).toEqual({ status: 'rejected', code: 'FILE_TOO_LARGE' });
    expect(io.uploads).toHaveLength(0);
    expect(io.bodies).toHaveLength(0);
  });

  it('declines a container V10 does not accept before any byte leaves the phone', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      voice: io.voice,
      recording: recording({ mimeType: 'audio/aac' }),
    });

    expect(outcome).toEqual({ status: 'rejected', code: 'AUDIO_FORMAT_UNSUPPORTED' });
    expect(io.uploads).toHaveLength(0);
    expect(io.bodies).toHaveLength(0);
  });

  it('posts the cap rather than an overshoot the schema would reject', async () => {
    const io = recorder();
    const outcome = await submit({
      upload: io.upload,
      voice: io.voice,
      recording: recording({ elapsedMs: MAX_AUDIO_SECONDS * 1000 + 400 }),
    });

    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);
    expect(outcome.durationSeconds).toBe(MAX_AUDIO_SECONDS);
    expect(
      voiceRequestSchema.safeParse({ ...(io.bodies[0] as object), language: 'mr' }).success,
    ).toBe(true);
  });
});
/* ========================================================================== */
/* Notices — the recorder's own failures, as an ErrorBanner (task 26.2)         */
/* ========================================================================== */

describe('recorder notices', () => {
  /**
   * A declined recording cannot be retried: the same audio is declined identically, and recording a
   * shorter one is a new request. `ImageUploader` says the same about a declined photo, which is why
   * both use the `none` arm rather than claiming a retry that does not exist.
   */
  it('claims no retry for a declined recording, and states both limits', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const notice = voiceRejectionNotice('AUDIO_TOO_LONG', language);

      expect(notice.retry.kind).toBe('none');
      expect(notice.error.language).toBe(language);
      expect(notice.error.message).toBe(voiceRejectionMessage('AUDIO_TOO_LONG', language));
    }
  });

  /**
   * `retryable` is the taxonomy's answer, not a judgement made here — `TRANSCRIPT_EMPTY` is the one
   * rejection `ERROR_SPECS` marks retryable, because the farmer can act over the same object.
   */
  it('takes retryable from the taxonomy rather than restating it', () => {
    expect(voiceRejectionNotice('TRANSCRIPT_EMPTY', 'en').error.retryable).toBe(true);
    expect(voiceRejectionNotice('AUDIO_TOO_LONG', 'en').error.retryable).toBe(false);
    expect(voiceRejectionNotice('FILE_TOO_LARGE', 'en').error.retryable).toBe(false);
  });

  /**
   * The one `control` case in this component. Nothing was captured when the microphone was refused,
   * so nothing is lost, and pressing the same control after granting permission retries exactly the
   * operation that failed (Requirement 15.4).
   */
  it('points a refused microphone at the record controls as its retry', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const notice = microphoneBlockedNotice(language);

      expect(notice.retry.kind).toBe('control');
      expect(notice.error.retryable).toBe(true);
      expect(notice.error.message).toBe(messages(language).ui.microphoneBlocked);
      expect(notice.error.language).toBe(language);
    }
  });

  /**
   * A browser with no container the provider accepts latches `unsupported`, which disables both
   * controls — so `retryable: false` and `none` are the same fact stated twice rather than a
   * forgotten retry.
   */
  it('claims nothing retries an unsupported browser', () => {
    const notice = recordingUnsupportedNotice('mr');

    expect(notice.retry.kind).toBe('none');
    expect(notice.error.retryable).toBe(false);
    expect(notice.error.message).toBe(messages('mr').ui.recordingUnsupported);
  });

  /**
   * A failed upload or POST is `retryable: true` as an error *class* and still `none` as an arm: the
   * blob is not held past `send()`, so there is nothing left to re-send. Both halves are asserted
   * because it is the pair that looks contradictory and is not.
   */
  it('reports a failed upload with the generic code and no retry claim', () => {
    const notice = recorderFailureNotice('hi');

    expect(notice.retry.kind).toBe('none');
    expect(notice.error.retryable).toBe(true);
    expect(notice.error.message).toBe(
      toEnvelope(new AppError('INTERNAL_ERROR'), 'hi').error.message,
    );
    /**
     * Requirement 15.6: nothing a notice carries can be a cause. The envelope's `code` rides along
     * (`ErrorBannerError` is a structural subset of `error`, so it is simply not read), and what must
     * not appear is a cause, a stack or a provider payload — none of which `toEnvelope` produces and
     * none of which `ErrorBanner` has a slot for.
     */
    expect(Object.keys(notice.error).sort()).toEqual(['code', 'language', 'message', 'retryable']);
  });
});

/* ========================================================================== */
/* The idle markup — labels, one polite region, no fake progress (task 26.2)     */
/* ========================================================================== */

/**
 * The capture half still cannot be exercised: jsdom has no `MediaRecorder` and no `getUserMedia`, so
 * a test that pressed the button would be testing a stub. What a static render *can* answer is every
 * accessibility question the design asks about this component's first paint, and those are the ones
 * that regress silently.
 */
describe('VoiceRecorder markup', () => {
  function render(language: Language = 'en'): string {
    const value: LanguageContextValue = { language, setLanguage: () => {} };
    return renderToStaticMarkup(
      <LanguageContext.Provider value={value}>
        <VoiceRecorder userId={USER_ID} conversationId={CONVERSATION_ID} />
      </LanguageContext.Provider>,
    );
  }

  /**
   * Both paths the design requires, as real `<button>` elements with visible labels: press-and-hold,
   * and the tap-to-start/tap-to-stop equivalent. A click-handled `<div>` would be focusable by
   * nothing and announced as nothing.
   */
  it('renders both record controls as real buttons with visible labels', () => {
    const markup = render();
    const { ui } = messages('en');

    expect(markup).toContain(ui.holdToSpeak);
    expect(markup).toContain(ui.tapToStart);
    expect([...markup.matchAll(/<button[ >]/g)]).toHaveLength(2);
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('tabindex');
  });

  /**
   * Requirement 15.2: exactly one polite region, present from the first render and empty until
   * something real is open — a live region inserted together with its text is not reliably announced.
   * And nothing time-driven: no progress element, no percentage, no simulated bar.
   */
  it('reserves one empty polite region and simulates no progress', () => {
    const markup = render();
    const { loading, ui } = messages('en');

    expect([...markup.matchAll(/role="status"/g)]).toHaveLength(1);
    expect(markup).not.toContain(loading.uploadingRecording);
    expect(markup).not.toContain(loading.listening);
    expect(markup).not.toContain(ui.recording);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('<progress');
    expect(markup).not.toContain('aria-valuenow');
  });

  /** Nothing has failed on a screen nobody has used yet, so nothing claims it has. */
  it('renders no error banner before anything has been recorded', () => {
    expect(render()).not.toContain('role="alert"');
  });

  /** Every string on the control comes from the active catalog, in all three languages. */
  it('labels both controls in each Supported_Language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const markup = render(language);
      const { ui } = messages(language);

      expect(markup).toContain(ui.holdToSpeak);
      expect(markup).toContain(ui.tapToStart);
    }
  });
});

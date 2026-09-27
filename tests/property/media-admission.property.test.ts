import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  admissionCode,
  rejectionMessage,
  type AdmissionCode,
  type SelectedFileFacts,
} from '@/components/ImageUploader';
import {
  DURATION_OVERSHOOT_TOLERANCE_SECONDS,
  measuredSeconds,
  recordingContainerOf,
  reportedDurationSeconds,
  voiceRejectionCode,
  voiceRejectionMessage,
  type RecordingFacts,
  type VoiceRejectionCode,
} from '@/components/VoiceRecorder';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  TRANSCRIBE_ACCEPTED_CONTAINERS,
  TRANSCRIBE_MIN_SECONDS,
} from '@/lib/config/verified';
import { SUPPORTED_LANGUAGES, type Language } from '@/lib/schemas';

/**
 * ### Property 3: Client-side media admission is exactly the stated limits
 *
 * *"For any candidate image characterized by (MIME type, byte size), the uploader accepts it if
 * and only if the type is `image/jpeg`, `image/png`, or `image/webp` and the size is at most
 * 10 MB; for any candidate recording characterized by (duration, byte size), the recorder accepts
 * it if and only if the duration is at most 120 seconds and the size is at most 3 MB (Amendment
 * A3 lowered the voice cap from 10 MB to 3 MB — `MAX_AUDIO_BYTES`). Every rejection states the
 * accepted types or duration limit and the size limit."*
 *
 * **Validates: Requirements 2.3, 2.4, 8.2, 8.3**
 *
 * =============================================================================
 * WHERE THE PROPERTY IS OBSERVED, AND WHY IT IS NOT A RENDERED COMPONENT
 * =============================================================================
 *
 * Admission is `admissionCode()` in `ImageUploader.tsx` and `voiceRejectionCode()` in
 * `VoiceRecorder.tsx`, and both are already **pure functions over a facts record** —
 * `SelectedFileFacts` is `{ type, size }`, `RecordingFacts` is `{ mimeType, sizeBytes,
 * elapsedMs }`. Neither reads the DOM, and both component headers say why: *"the check is about
 * the MIME type the browser reported and the byte count it measured, and neither becomes more
 * real for having a JPEG behind it."*
 *
 * So this file runs in the **property project under node**, with no `File`, no `MediaRecorder`,
 * and no jsdom. That is not a workaround for the harness: fabricating a 10 MB `File` a hundred
 * times per run would allocate a gigabyte to exercise a `>` comparison, and a `MediaRecorder`
 * jsdom does not implement cannot produce a duration to check anyway. The DOM-dependent half —
 * the two file inputs, the countdown readout, the banner regions — belongs to the component
 * tests and to task 26.2's accessibility pass, and neither is part of this statement.
 *
 * The rejection **messages** are checked here too, in all three languages, because they come
 * from the same pure functions (`rejectionMessage`, `voiceRejectionMessage`) that the components
 * render. What is *not* checked here is that a component actually displays them; that is
 * `ErrorBanner`'s contract.
 *
 * =============================================================================
 * THE EXPECTATION IS THE REQUIREMENT, NOT A COPY OF THE CODE
 * =============================================================================
 *
 * A property that recomputes the implementation's own branch order proves only that the file
 * parses. So each `admissible` predicate below is written from the requirement text as a single
 * conjunction over the generated facts — *type ∈ accepted AND size ≤ limit* — and the assertion
 * is the **biconditional**: admitted exactly when that conjunction holds. The specific rejection
 * code and its precedence are asserted as a strengthening on top, not as the property itself.
 *
 * Both directions are generated, because "if and only if" needs both: a gate that admitted
 * everything and a gate that refused everything each satisfy one half alone.
 *
 * =============================================================================
 * TWO DISCREPANCIES WITH THE DESIGN SENTENCE, BOTH STATED RATHER THAN SMOOTHED
 * =============================================================================
 *
 * **1. The recorder's predicate has four clauses, not two.** The design sentence names duration
 * and size. `voiceRejectionCode()` also refuses a container V10 does not accept
 * (`AUDIO_FORMAT_UNSUPPORTED`) and a recording below `TRANSCRIBE_MIN_SECONDS`
 * (`TRANSCRIPT_EMPTY`). Both are strengthenings the design argues for elsewhere — the container
 * check is the V10 intersection the recorder is built around, and the minimum is *"a tap that
 * starts and stops the recorder in the same moment has captured nothing"* — so the biconditional
 * is stated over all four clauses. Omitting them would make the property false against correct
 * code.
 *
 * **2. "At most 120 seconds" is enforced with a one-second tolerance, and the posted number is
 * clamped.** `DURATION_OVERSHOOT_TOLERANCE_SECONDS` exists because the hard stop is a timer and
 * a timer fires late; a measurement at 120.4 s is lag rather than farmer speech. That is a real
 * widening of the admission window, so the reconciliation is asserted rather than assumed: for
 * **every** admitted recording, `reportedDurationSeconds()` is at most `MAX_AUDIO_SECONDS`. The
 * number that leaves the browser therefore never exceeds Requirement 8.2's limit even when the
 * measurement did, which is what keeps the tolerance a measurement allowance instead of a
 * quietly higher cap.
 *
 * =============================================================================
 * A THIRD, NARROWER DISCREPANCY: WHICH REJECTIONS MUST QUOTE THE LIMITS
 * =============================================================================
 *
 * The design's last clause reads *"every rejection states the accepted types or duration limit
 * and the size limit"*. Taken literally that is false of correct code, and deliberately so.
 * Requirements 2.4 and 8.3 are both conditional on a **limit or type** violation, and the
 * recorder has two refusals that are neither:
 *
 *  - `AUDIO_FORMAT_UNSUPPORTED` → *"Jamee cannot use this recording. Please type your question
 *    instead."* The catalog comment explains the choice: naming containers to a farmer is not
 *    advice anyone can act on.
 *  - `TRANSCRIPT_EMPTY` → *"…record it again somewhere quieter."* Nothing about a limit was
 *    exceeded; the recording was too short to contain speech.
 *
 * So the messages clause is asserted over the **limit rejections** Requirements 2.4 and 8.3
 * actually scope it to, and the two non-limit codes are asserted to quote **no** limit — which
 * is the stronger statement, since a message that padded itself with irrelevant numbers would
 * pass a laxer check.
 *
 * =============================================================================
 * THE KNOWN, RECORDED GAP: `audio/aac` AND `audio/amr` (REQUIREMENT 10.6)
 * =============================================================================
 *
 * The container generator produces `aac` and `amr` in its **refused** set, and that is the
 * recorded state of the system rather than an oversight. `docs/VERIFIED_VALUES.md` (V14, and the
 * discrepancy note under it) records that V10's accepted list covers neither, that a Telegram
 * voice note delivered in either is refused before the media download, and that **Requirement
 * 10.6 is therefore not satisfied for those two containers** — closing it needs a transcode step
 * or a second transcription provider, not a constant edit. Widening
 * `TRANSCRIBE_ACCEPTED_CONTAINERS` to make a test greener would produce recordings the provider
 * rejects *after* the farmer has spoken and after the upload, which is the failure mode the
 * intersection exists to prevent. So this file asserts the refusal.
 */

/* ========================================================================== */
/* Shared arbitraries                                                          */
/* ========================================================================== */

const languageArb = fc.constantFrom<Language>(...SUPPORTED_LANGUAGES);

/**
 * A size class, named so a shrunk counterexample says which boundary it came from and so the
 * run can prove afterwards that it visited all of them.
 *
 * The three that matter are `one_under_limit`, `at_limit` and `one_over_limit`: a limit test
 * that never lands on the boundary is not testing the limit. `at_limit` is admitted because both
 * requirements say "up to", and `one_over_limit` is the smallest possible refusal.
 */
const SIZE_KINDS = [
  'zero',
  'one',
  'well_under_limit',
  'one_under_limit',
  'at_limit',
  'one_over_limit',
  'far_over_limit',
] as const;

type SizeKind = (typeof SIZE_KINDS)[number];

interface SizedCandidate {
  readonly kind: SizeKind;
  readonly bytes: number;
}

/** Byte counts straddling `limit` by exactly one in each direction, plus the interior. */
function sizeArb(limit: number): fc.Arbitrary<SizedCandidate> {
  return fc.oneof(
    fc.constant<SizedCandidate>({ kind: 'zero', bytes: 0 }),
    fc.constant<SizedCandidate>({ kind: 'one', bytes: 1 }),
    fc
      .integer({ min: 2, max: limit - 2 })
      .map((bytes) => ({ kind: 'well_under_limit' as const, bytes })),
    fc.constant<SizedCandidate>({ kind: 'one_under_limit', bytes: limit - 1 }),
    fc.constant<SizedCandidate>({ kind: 'at_limit', bytes: limit }),
    fc.constant<SizedCandidate>({ kind: 'one_over_limit', bytes: limit + 1 }),
    fc
      .integer({ min: limit + 2, max: limit * 4 })
      .map((bytes) => ({ kind: 'far_over_limit' as const, bytes })),
  );
}

/* ========================================================================== */
/* Image candidates (Requirements 2.3, 2.4)                                    */
/* ========================================================================== */

/**
 * MIME types outside the accepted three, chosen to be the ones a phone gallery really offers.
 *
 * `image/heic` is what an iPhone hands over by default and `image/avif` is what a modern Android
 * gallery can export, so both are the realistic refusals rather than adversarial ones.
 * `image/jpg` is not a MIME type however often it is written as one, and `IMAGE/JPEG` plus
 * `image/jpeg; charset=binary` pin that the comparison is exact — an inexact one would admit a
 * type the re-encoder and the storage `contentType` were never checked against.
 */
const REFUSED_IMAGE_TYPES = [
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/bmp',
  'image/svg+xml',
  'image/jpg',
  'IMAGE/JPEG',
  'image/jpeg; charset=binary',
  'application/pdf',
  'application/octet-stream',
  'video/mp4',
  'text/plain',
  '',
] as const;

interface ImageCandidate {
  readonly facts: SelectedFileFacts;
  readonly sizeKind: SizeKind;
  readonly typeAccepted: boolean;
  readonly label: string;
}

const imageCandidateArb: fc.Arbitrary<ImageCandidate> = fc
  .record({
    type: fc.oneof(
      fc.constantFrom<string>(...ACCEPTED_IMAGE_TYPES),
      fc.constantFrom<string>(...REFUSED_IMAGE_TYPES),
    ),
    size: sizeArb(MAX_IMAGE_BYTES),
  })
  .map(({ type, size }) => {
    const accepted: readonly string[] = ACCEPTED_IMAGE_TYPES;
    return {
      facts: { type, size: size.bytes },
      sizeKind: size.kind,
      typeAccepted: accepted.includes(type),
      label: `type "${type}", size ${size.bytes} (${size.kind})`,
    } satisfies ImageCandidate;
  });

/* ========================================================================== */
/* Recording candidates (Requirements 8.2, 8.3)                                */
/* ========================================================================== */

/**
 * Elapsed-time classes, straddling all three duration boundaries the recorder has: the
 * transcribable minimum, the 120 s cap, and the cap plus the overshoot tolerance.
 *
 * `at_cap_plus_tolerance` is admitted (measurement lag) and `one_ms_past_tolerance` is not, which
 * is the pair that makes the tolerance a real boundary rather than a fudge factor. `at_minimum`
 * and `one_ms_under_minimum` do the same for `TRANSCRIBE_MIN_SECONDS`.
 */
const DURATION_KINDS = [
  'zero',
  'one_ms_under_minimum',
  'at_minimum',
  'just_over_minimum',
  'interior',
  'one_second_under_cap',
  'at_cap',
  'one_ms_over_cap',
  'at_cap_plus_tolerance',
  'one_ms_past_tolerance',
  'far_past_tolerance',
] as const;

type DurationKind = (typeof DURATION_KINDS)[number];

const CAP_MS = MAX_AUDIO_SECONDS * 1000;
const TOLERANCE_MS = DURATION_OVERSHOOT_TOLERANCE_SECONDS * 1000;
/** `measuredSeconds` rounds to the millisecond, so the minimum is an exact whole-ms figure. */
const MINIMUM_MS = TRANSCRIBE_MIN_SECONDS * 1000;

interface TimedCandidate {
  readonly kind: DurationKind;
  readonly elapsedMs: number;
}

const durationArb: fc.Arbitrary<TimedCandidate> = fc.oneof(
  fc.constant<TimedCandidate>({ kind: 'zero', elapsedMs: 0 }),
  fc.constant<TimedCandidate>({ kind: 'one_ms_under_minimum', elapsedMs: MINIMUM_MS - 1 }),
  fc.constant<TimedCandidate>({ kind: 'at_minimum', elapsedMs: MINIMUM_MS }),
  fc.constant<TimedCandidate>({ kind: 'just_over_minimum', elapsedMs: MINIMUM_MS + 1 }),
  fc
    .integer({ min: MINIMUM_MS + 2, max: CAP_MS - 1001 })
    .map((elapsedMs) => ({ kind: 'interior' as const, elapsedMs })),
  fc.constant<TimedCandidate>({ kind: 'one_second_under_cap', elapsedMs: CAP_MS - 1000 }),
  fc.constant<TimedCandidate>({ kind: 'at_cap', elapsedMs: CAP_MS }),
  fc.constant<TimedCandidate>({ kind: 'one_ms_over_cap', elapsedMs: CAP_MS + 1 }),
  fc.constant<TimedCandidate>({ kind: 'at_cap_plus_tolerance', elapsedMs: CAP_MS + TOLERANCE_MS }),
  fc.constant<TimedCandidate>({
    kind: 'one_ms_past_tolerance',
    elapsedMs: CAP_MS + TOLERANCE_MS + 1,
  }),
  fc
    .integer({ min: CAP_MS + TOLERANCE_MS + 2, max: CAP_MS * 4 })
    .map((elapsedMs) => ({ kind: 'far_past_tolerance' as const, elapsedMs })),
);

/**
 * Containers outside V10's accepted list.
 *
 * `aac` and `amr` are the recorded Requirement 10.6 gap — see the header. `3gpp`/`3gp` is what
 * MDN mentions for Firefox for Android and V10 does not list. `opus` is the interesting one:
 * `audio/opus` names the *codec* as the subtype, and V10 lists the containers Opus travels in
 * (`ogg`, `webm`) rather than a bare `opus`, so a browser reporting it is refused.
 */
const REFUSED_AUDIO_MIME_TYPES = [
  'audio/aac',
  'audio/amr',
  'audio/3gpp',
  'audio/3gp',
  'audio/opus',
  'audio/x-caf',
  'audio/basic',
  'audio/vnd.wave',
  'video/mp2t',
  'application/octet-stream',
  'audio/',
  '',
  '   ',
] as const;

/**
 * Accepted containers, spelled the several ways a browser really reports them: bare
 * (`audio/webm`), with codec parameters (`audio/webm;codecs=opus`), and via the legacy `x-` tree
 * (`audio/x-m4a`). All three normalize onto one V10 member, which is `recordingContainerOf`'s
 * job, and admission has to hold for every spelling rather than for the canonical one.
 */
const acceptedAudioMimeArb: fc.Arbitrary<string> = fc
  .constantFrom<string>(...TRANSCRIBE_ACCEPTED_CONTAINERS)
  .chain((container) =>
    fc.constantFrom(
      `audio/${container}`,
      `audio/${container};codecs=opus`,
      `audio/x-${container}`,
      `AUDIO/${container.toUpperCase()}`,
    ),
  );

interface RecordingCandidate {
  readonly facts: RecordingFacts;
  readonly durationKind: DurationKind;
  readonly sizeKind: SizeKind;
  readonly containerAccepted: boolean;
  readonly label: string;
}

const recordingCandidateArb: fc.Arbitrary<RecordingCandidate> = fc
  .record({
    mimeType: fc.oneof(
      acceptedAudioMimeArb,
      fc.constantFrom<string>(...REFUSED_AUDIO_MIME_TYPES),
    ),
    duration: durationArb,
    size: sizeArb(MAX_AUDIO_BYTES),
  })
  .map(({ mimeType, duration, size }) => {
    const container = recordingContainerOf(mimeType);
    const accepted: readonly string[] = TRANSCRIBE_ACCEPTED_CONTAINERS;
    return {
      facts: { mimeType, sizeBytes: size.bytes, elapsedMs: duration.elapsedMs },
      durationKind: duration.kind,
      sizeKind: size.kind,
      containerAccepted: container !== undefined && accepted.includes(container),
      label:
        `mimeType "${mimeType}", ${duration.elapsedMs} ms (${duration.kind}), ` +
        `${size.bytes} bytes (${size.kind})`,
    } satisfies RecordingCandidate;
  });

/* ========================================================================== */
/* What a limit rejection has to say                                           */
/* ========================================================================== */

/**
 * Requirement 2.4's two facts: the accepted types and the size limit.
 *
 * `JPG`, `PNG`, `WebP`, `10` and `MB` appear verbatim in all three catalogs, so this holds across
 * languages without the assertion knowing any of them. The limit is derived from
 * `MAX_IMAGE_BYTES` rather than written out, so a message quoting a stale number fails here.
 */
function namesTypesAndSizeLimit(message: string, label: string): void {
  const megabytes = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
  for (const fact of ['JPG', 'PNG', 'WebP', `${megabytes} MB`]) {
    expect(message, `${label}: rejection must state "${fact}"`).toContain(fact);
  }
  // An unfilled placeholder would satisfy every check above and tell a farmer nothing.
  expect(message, label).not.toContain('{');
}

/** Requirement 8.3's two facts: the duration limit and the size limit. */
function namesDurationAndSizeLimit(message: string, label: string): void {
  const megabytes = Math.round(MAX_AUDIO_BYTES / (1024 * 1024));
  for (const fact of [`${MAX_AUDIO_SECONDS}`, `${megabytes} MB`]) {
    expect(message, `${label}: rejection must state "${fact}"`).toContain(fact);
  }
  expect(message, label).not.toContain('{');
}

/* ========================================================================== */
/* Property 3, first kind: images                                              */
/* ========================================================================== */

describe('Property 3: client-side media admission is exactly the stated limits', () => {
  it('admits an image exactly when its type is accepted and its size is at most 10 MB', () => {
    const seenSizes = new Set<SizeKind>();
    const seenTypes = new Set<string>();
    const seenCodes = new Set<AdmissionCode | 'admitted'>();

    fc.assert(
      fc.property(imageCandidateArb, languageArb, (candidate, language) => {
        seenSizes.add(candidate.sizeKind);
        seenTypes.add(candidate.facts.type);

        /**
         * Requirements 2.3 and 2.4 as one conjunction, written from the requirement rather than
         * from the branch order in `admissionCode()`. `<=` because both say "up to".
         */
        const admissible =
          candidate.typeAccepted && candidate.facts.size <= MAX_IMAGE_BYTES;

        const code = admissionCode(candidate.facts);
        seenCodes.add(code ?? 'admitted');

        // The biconditional itself.
        expect(code === null, candidate.label).toBe(admissible);

        if (code === null) return;

        // The strengthening: which refusal, and in which order. The type is reported before the
        // size because it is the more actionable fact, and its message names the size limit too.
        expect(code, candidate.label).toBe(
          candidate.typeAccepted ? 'FILE_TOO_LARGE' : 'FILE_TYPE_UNSUPPORTED',
        );

        // Requirement 2.4's messages clause, on both refusals, in the active language.
        namesTypesAndSizeLimit(rejectionMessage(code, language), candidate.label);
      }),
      // 600 runs over seven size classes crossed with eighteen types, so every boundary below is
      // reached many times rather than probably. The coverage assertions make that a fact.
      { numRuns: 600 },
    );

    // Non-vacuity: the run really did land on the limit and on both sides of it, really did see
    // every accepted type, and really did produce all three outcomes.
    expect([...seenSizes].sort()).toStrictEqual([...SIZE_KINDS].sort());
    for (const type of ACCEPTED_IMAGE_TYPES) expect(seenTypes).toContain(type);
    expect([...seenCodes].sort()).toStrictEqual(
      ['FILE_TOO_LARGE', 'FILE_TYPE_UNSUPPORTED', 'admitted'].sort(),
    );
  });

  /* ======================================================================== */
  /* Second kind: recordings                                                   */
  /* ======================================================================== */

  it('admits a recording exactly when its container, duration and size are all within the limits', () => {
    const seenDurations = new Set<DurationKind>();
    const seenSizes = new Set<SizeKind>();
    const seenCodes = new Set<VoiceRejectionCode | 'admitted'>();

    fc.assert(
      fc.property(recordingCandidateArb, languageArb, (candidate, language) => {
        seenDurations.add(candidate.durationKind);
        seenSizes.add(candidate.sizeKind);

        const seconds = measuredSeconds(candidate.facts.elapsedMs);

        /**
         * Requirements 8.2 and 8.3 as one conjunction, with the two strengthenings the header
         * argues for: V10's container intersection, and the transcribable minimum. The duration
         * clause carries the documented overshoot tolerance, and the clamp assertion below is
         * what keeps that compatible with "up to 120 seconds".
         */
        const admissible =
          candidate.containerAccepted &&
          seconds <= MAX_AUDIO_SECONDS + DURATION_OVERSHOOT_TOLERANCE_SECONDS &&
          candidate.facts.sizeBytes <= MAX_AUDIO_BYTES &&
          seconds >= TRANSCRIBE_MIN_SECONDS;

        const code = voiceRejectionCode(candidate.facts);
        seenCodes.add(code ?? 'admitted');

        expect(code === null, candidate.label).toBe(admissible);

        if (code === null) {
          /**
           * Discrepancy 2, reconciled: the tolerance widens what is *admitted*, never what is
           * *reported*. Requirement 8.2's limit is what leaves the browser, which is also what
           * `voiceRequestSchema.durationSeconds.max(MAX_AUDIO_SECONDS)` will accept.
           */
          const reported = reportedDurationSeconds(candidate.facts.elapsedMs);
          expect(reported, candidate.label).toBeLessThanOrEqual(MAX_AUDIO_SECONDS);
          expect(reported, candidate.label).toBeGreaterThan(0);
          return;
        }

        // The strengthening: which refusal, in the implementation's documented order — container,
        // then duration, then size, then too-short.
        const expected: VoiceRejectionCode = !candidate.containerAccepted
          ? 'AUDIO_FORMAT_UNSUPPORTED'
          : seconds > MAX_AUDIO_SECONDS + DURATION_OVERSHOOT_TOLERANCE_SECONDS
            ? 'AUDIO_TOO_LONG'
            : candidate.facts.sizeBytes > MAX_AUDIO_BYTES
              ? 'FILE_TOO_LARGE'
              : 'TRANSCRIPT_EMPTY';
        expect(code, candidate.label).toBe(expected);

        const message = voiceRejectionMessage(code, language);

        if (code === 'AUDIO_TOO_LONG' || code === 'FILE_TOO_LARGE') {
          // Requirement 8.3's messages clause, on both limit refusals.
          namesDurationAndSizeLimit(message, candidate.label);
        } else {
          /**
           * Discrepancy 3: the two non-limit refusals quote no limit, which is the stronger claim
           * — a message padded with irrelevant numbers would pass a laxer check. Asserted on the
           * two figures a limit message would carry.
           */
          expect(message, candidate.label).not.toContain(`${MAX_AUDIO_SECONDS}`);
          expect(message, candidate.label).not.toContain('MB');
          expect(message.length, candidate.label).toBeGreaterThan(0);
        }
      }),
      { numRuns: 600 },
    );

    // Non-vacuity: every duration boundary and every size boundary was visited, and all four
    // refusals plus admission were produced. Without this, a branch that never generated would
    // make its expectation green by absence.
    expect([...seenDurations].sort()).toStrictEqual([...DURATION_KINDS].sort());
    expect([...seenSizes].sort()).toStrictEqual([...SIZE_KINDS].sort());
    expect([...seenCodes].sort()).toStrictEqual(
      [
        'AUDIO_FORMAT_UNSUPPORTED',
        'AUDIO_TOO_LONG',
        'FILE_TOO_LARGE',
        'TRANSCRIPT_EMPTY',
        'admitted',
      ].sort(),
    );
  });

  /* ======================================================================== */
  /* The recorded Requirement 10.6 gap, asserted rather than papered over      */
  /* ======================================================================== */

  it('refuses aac and amr in every spelling, which is the recorded Requirement 10.6 gap', () => {
    const accepted: readonly string[] = TRANSCRIBE_ACCEPTED_CONTAINERS;
    expect(accepted).not.toContain('aac');
    expect(accepted).not.toContain('amr');

    fc.assert(
      fc.property(
        fc.constantFrom('aac', 'amr'),
        fc.constantFrom('audio/{c}', 'audio/x-{c}', 'audio/{c};codecs=lc', 'AUDIO/{C}'),
        durationArb,
        sizeArb(MAX_AUDIO_BYTES),
        (container, template, duration, size) => {
          const mimeType = template
            .replace('{c}', container)
            .replace('{C}', container.toUpperCase());

          // Refused on the container, whatever the duration and size are — including a recording
          // that is otherwise perfectly admissible.
          expect(
            voiceRejectionCode({
              mimeType,
              sizeBytes: size.bytes,
              elapsedMs: duration.elapsedMs,
            }),
            mimeType,
          ).toBe('AUDIO_FORMAT_UNSUPPORTED');
        },
      ),
    );
  });
});

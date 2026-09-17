import type {
  ErrorCode,
  Language,
  Operation,
  RejectionReason,
  Severity,
} from '@/lib/schemas';

/**
 * The shape every localized catalog must fill.
 *
 * Requirements: 6.1, 6.2, 6.3 (inconclusive copy per cause), 14.3 (quota decline states the
 *               limit and reset), 14.5 (the busy message), 15.3 (localized farmer-readable
 *               messages), 4.7 / 7.6 (honest referral)
 * Design: D5 (inconclusive, quota, and error copy are pre-translated STATIC strings),
 *         D6 (the busy literal is the English rendering of a coded error)
 *
 * ### Why this file exists at all
 *
 * D5 is the reason. Requirement 6.6 forbids a model call once a result is inconclusive,
 * Requirement 14.3 forbids a provider call once a quota is exhausted, and Requirement 15.3
 * still demands a localized message. Those three together mean the en/hi/mr copy for these
 * paths must ship IN THE REPOSITORY. The model is used for translation only when rephrasing
 * knowledge-base content for an *identified* condition.
 *
 * ### The mechanism that makes coverage total
 *
 * `Record<ErrorCode, string>` and `Record<RejectionReason, string>` are exhaustive mapped
 * types. Adding a code to `ERROR_CODES` breaks the build in all three catalogs until each has
 * a real string. That is what makes Property 29 ("the error envelope is total") a structural
 * property rather than a test that has to remember every code — and it is why `hi.ts` and
 * `mr.ts` are annotated `: MessageCatalog` rather than inferred.
 *
 * ### The rule about model calls
 *
 * **No lookup in this module may reach a model, a network call, or `process.env`.** Every value
 * is a literal or a pure interpolation of numbers already computed by the caller. A catalog
 * that could call a model would silently reintroduce the spend Requirement 6.6 forbids.
 */
export interface MessageCatalog {
  /** Requirement 15.3 — one message per stable code, in this language. */
  errors: Record<ErrorCode, string>;

  /**
   * The word `errors.QUOTA_EXCEEDED` interpolates as `{operation}`.
   *
   * **A map rather than the value the server already has**, because the server's value is the
   * DATABASE's: `usage_logs.operation` is `'image' | 'chat' | 'voice'`, and interpolating it raw put
   * the English token `chat` in the middle of a Devanagari sentence. That is Jamee's own vocabulary
   * leaking into a farmer's message, and it is not a localized message in the sense Requirement 15.3
   * means — the one code Requirement 14.3 makes content-rich was the one rendering an English word.
   *
   * Deliberately not reused from `ui.navDiagnose` and friends: those are verbs a farmer taps
   * ("Check a crop"). Each language writes the form its own `QUOTA_EXCEEDED` sentence needs, which
   * is why these are not always bare nouns.
   */
  operations: Record<Operation, string>;

  /**
   * Requirement 6.4's single shape carries DIFFERENT copy per cause, which is the one place
   * the seven rejection reasons are visible to a farmer — and even then only as advice about
   * what to do next, never as "the model returned malformed JSON".
   *
   * Requirements 6.1 (out-of-knowledge-base → consult an expert), 6.2 (unclear → retake in
   * better light AND consult an expert), 6.3 (no plant → send a photo of the affected crop).
   * The four schema-failure reasons share the honest "could not judge this photo" wording,
   * because a farmer cannot act on the difference between them.
   */
  inconclusive: Record<RejectionReason, string>;

  /** Requirements 4.7 and 7.6 — the honest referral, made with no model call. */
  chat: {
    /** 4.7 — the question is about a crop or condition Jamee does not cover. */
    outOfScope: string;
    /** 7.6 — the topic is in scope but no verified content answers the question. */
    noVerifiedInfo: string;
  };

  /**
   * Requirement 15.2 forbids simulated progress, so every string here is bound to an OBSERVED
   * request state. `analyzing` is Requirement 15.1's exact text in English.
   */
  loading: {
    uploading: string;
    /**
     * The voice equivalent of `uploading`, bound to the open `voice-messages` upload.
     *
     * A separate key rather than a reuse of `uploading`, because that string names a photo
     * ("Uploading your photo…") in all three languages. A farmer who just spoke a question and
     * is told Jamee is uploading a photo would reasonably conclude the recorder sent the wrong
     * thing — and Requirement 15.2's point is that a state line reports what is actually
     * happening.
     */
    uploadingRecording: string;
    analyzing: string;
    thinking: string;
    listening: string;
    /**
     * The two sign-in waits (task 6.1). They are catalog entries rather than component
     * literals for the same reason everything else here is: a farmer signing in has not
     * reached a profile yet, so this is the FIRST text they read, and hardcoding it in
     * `SignInForm.tsx` would put English in front of a Marathi speaker at the one screen
     * they cannot skip. Both are bound to an open `signInWithOtp` / `verifyOtp` request
     * (Requirement 15.2) — nothing here is driven by a timer.
     */
    sendingCode: string;
    verifyingCode: string;
    /**
     * The profile save (task 6.4), bound to the open `profiles` update. Here for the same reason
     * the two sign-in waits are: the profile screen is where a farmer chooses their language, so
     * the wait text on it is read by someone who has not yet told Jamee they read Marathi.
     */
    saving: string;
  };

  /** Screen furniture. Localized for the same reason the errors are. */
  ui: {
    appName: string;
    tagline: string;
    signInHeading: string;
    phoneLabel: string;
    phoneHint: string;
    sendCode: string;
    otpLabel: string;
    otpHint: string;
    verifyCode: string;
    resendCode: string;
    changeNumber: string;
    signOut: string;
    navDiagnose: string;
    navChat: string;
    navVoice: string;
    navHistory: string;
    navProfile: string;
    chooseImage: string;
    /**
     * The second of the uploader's two file inputs — the one carrying `capture="environment"`,
     * which opens the rear camera on a phone.
     *
     * Two controls rather than one because Requirement 2's user story is "upload **or**
     * capture": on Android Chrome a single input with `capture` goes straight to the camera and
     * takes the gallery away, so a farmer photographing a leaf yesterday could not send it.
     */
    captureImage: string;
    imageHint: string;
    submitImage: string;
    retry: string;
    holdToSpeak: string;
    tapToStart: string;
    tapToStop: string;
    /**
     * The recorder's state while it is running and the countdown has not started yet
     * (Requirement 8.2's countdown begins with `AUDIO_COUNTDOWN_FROM_SECONDS` remaining).
     *
     * Real text rather than a red dot alone: the design requires loading text to be text, and a
     * farmer using a screen reader has nothing to hear from a coloured circle.
     */
    recording: string;
    recordingSecondsLeft: string;
    /**
     * Microphone permission was refused, or the device produced no audio track.
     *
     * Its own sentence rather than `errors.INTERNAL_ERROR`, because nothing went wrong at
     * Jamee's end and the farmer is the only one who can fix it. It names the action that
     * changes the outcome and nothing else — Jamee cannot tell a denied prompt from a device
     * with no microphone, so it does not claim to.
     */
    microphoneBlocked: string;
    /**
     * The browser offers no recording container the Transcription_Provider accepts
     * (V10's list intersected with `MediaRecorder.isTypeSupported`, empty).
     *
     * Kept distinct from `errors.AUDIO_FORMAT_UNSUPPORTED`, which is about a recording that
     * already exists. This one is read *before* anything is recorded, so it must not imply
     * something was captured and then refused. Both end with the same advice, because typing
     * the question is the one thing that works on such a browser.
     */
    recordingUnsupported: string;
    transcriptLabel: string;
    answerLabel: string;
    askPlaceholder: string;
    send: string;
    historyHeading: string;
    historyEmpty: string;
    historyEmptyAction: string;
    /**
     * The detail view's way back to the list (Requirement 12.3 is reached *from* 12.1, so the
     * return trip is part of the same screen pair). A link label rather than a browser-back
     * instruction, because a farmer arriving from a WhatsApp deep link has no history entry to
     * go back to.
     */
    backToHistory: string;
    inconclusiveLabel: string;
    needsExpertBanner: string;
    confidenceLabel: string;
    severityLabel: string;
    /**
     * Requirement 12.1 — the term for the channel an entry arrived through, so `channelWeb` and
     * `channelWhatsapp` read as an answer rather than as a bare word next to a photo. Without
     * it a screen reader announces "WhatsApp" with nothing to say what that describes.
     */
    channelLabel: string;
    channelWeb: string;
    channelWhatsapp: string;
    /** Requirement 12.1 — the term for an entry's creation timestamp, for the same reason. */
    dateLabel: string;
    symptomsHeading: string;
    causesHeading: string;
    treatmentHeading: string;
    preventionHeading: string;
    sourceHeading: string;
    conversationHeading: string;
    /** Requirement 12.3 — the conversation exists but carries no messages yet. */
    conversationEmpty: string;
    /**
     * Who said a message, for the `messages.role` values `farmer` and `jamee`.
     *
     * Rendered as a visible label rather than as alignment or colour alone: a farmer using a
     * screen reader, or reading a Devanagari thread on a narrow phone, needs the speaker stated
     * in words (design: "Mobile layout and accessibility").
     */
    roleFarmer: string;
    roleJamee: string;
    displayNameLabel: string;
    preferredLanguageLabel: string;
    save: string;
    saved: string;
    /**
     * Alt text for a rendered crop photo. Deliberately generic: the photo's content is exactly
     * what Jamee is uncertain about, so describing it as the reported condition would state a
     * diagnosis as fact — and on an inconclusive result there is no condition to name at all.
     */
    cropPhotoAlt: string;
    /** Requirement 12.9 — the full-size photo is gone, the thumbnail survives. */
    photoThumbnailOnly: string;
    /** Requirement 12.10 — neither derivative survives. */
    photoNoLongerStored: string;
  };

  /**
   * Replies the WhatsApp adapter sends. Localized from the resolved profile's preferred
   * language; the unresolvable-number case has no profile, so it falls back to `en`.
   */
  whatsapp: {
    /** Requirement 10.3 — the sender has no Profile. */
    signInFirst: string;
    /** Requirement 10.9 — a message type outside text, image and audio. */
    unsupportedType: string;
    /**
     * A voice note Jamee cannot transcribe because of the container it arrived in — the
     * V10-versus-V14 discrepancy documented in `src/lib/whatsapp.ts`.
     *
     * **Why this is not `unsupportedType`.** Requirement 10.9's sentence names voice notes as
     * something Jamee accepts, and an `aac` voice note *is* a voice note — replying "Jamee
     * accepts photos, text and voice notes" to one would be both confusing and untrue.
     *
     * **Why it is not `errors.TRANSCRIPTION_FAILED` either.** That code is `retryable: true`,
     * and Requirement 15.4 makes the flag mean "the same request could plausibly succeed".
     * WhatsApp chooses the recording container, not the farmer, so re-sending the identical
     * voice note fails identically forever. The only thing the farmer can actually do is type
     * the question instead, so that is what this sentence says.
     */
    voiceNoteFormatUnsupported: string;
    /** D11's soft-deadline branch — the row is marked `failed` and 200 is still returned. */
    takingLonger: string;
  };

  /** Requirement 15.4/26.2 — severity is conveyed by LABEL TEXT, never by colour alone. */
  severity: Record<Severity, string>;

  /** Each language's own endonym, so the switcher is readable before you can read it. */
  languageNames: Record<Language, string>;
}

/**
 * Interpolation helper for the handful of messages that carry a number.
 *
 * Placeholders are `{name}`. Deliberately not a template literal at the call site: the ORDER
 * of a limit and a reset time differs between languages, and a template literal would freeze
 * English word order into every translation.
 *
 * An unknown placeholder is left in place rather than replaced with `undefined`, so a missing
 * value shows up as a visible `{limit}` in review instead of as the word "undefined" in front
 * of a farmer.
 */
export function interpolate(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

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
    /**
     * The Google sign-in button label (Amendment A1: web sign-in is Google OAuth, not phone OTP).
     * `GoogleSignInButton` reads it. A catalog entry rather than a component literal because the
     * sign-in screen is the FIRST text a farmer reads, before any preferred language is known.
     */
    googleSignIn: string;
    /**
     * Requirement 1.3 — the callback returned nothing exchangeable (cancelled, provider error, or
     * an empty return). Shown on the sign-in screen with a working retry. This is the farmer-facing
     * rendering of `OAUTH_INCOMPLETE`, kept here as well as in `errors` because the sign-in screen
     * renders it directly rather than through the API error envelope.
     */
    signInDidNotComplete: string;
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
    /**
     * Requirement 12.1 — the term for an entry that arrived through the Telegram channel, so a
     * Telegram-originated diagnosis reads as an answer in history rather than a bare word. Added by
     * Amendment A1 alongside `channelWhatsapp` (which is retained only for not-yet-deleted modules).
     */
    channelTelegram: string;
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
   *
   * RETIRED by Amendment A1 — the channel is Telegram now (see `telegram` below). This block is
   * kept only because the not-yet-retired WhatsApp modules still read it; task 44 deletes it with
   * `src/lib/whatsapp.ts` and `src/lib/whatsapp-dispatch.ts`.
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

  /**
   * Replies the Telegram adapter sends (Amendment A1). All of it is **pre-translated static
   * copy** shipped in the repository — no lookup here reaches a model, a network call, or
   * `process.env` (D5). Replies go out in the resolved Profile's language, and in English where
   * no Profile was resolved (a `/start` from a sender on no Profile has no language to resolve).
   *
   * These are the FOUR Telegram outcomes that are NOT errors (37.4): the linking instructions,
   * the invalid-link reply, the already-linked-elsewhere reply, and the gated reply are all
   * successful handling of a well-formed authenticated delivery. They are catalog sentences, each
   * accompanied by HTTP 200 to Telegram, and their audit trail is `telegram_inbound.status`, not
   * `usage_logs` — so they live here rather than in the error taxonomy.
   *
   * Requirements: 10.3, 21.8, 21.9, 21.10, 21.11, 21.12, 21.13, 21.17, 21.19, 22.14.
   * Design: D5, D13.
   */
  telegram: {
    /**
     * Requirement 10.3 / 21.9. Shown to a sender stored on no Profile AND to a `/start` carrying
     * no token payload — both mean "this Telegram account is not linked yet". Tells the farmer
     * what to do on the web profile screen to link this account. Names no token, because in this
     * branch there is none.
     */
    linkingInstructions: string;
    /**
     * Requirement 21.8. The reply for a `/start` token that is unknown, expired, OR consumed —
     * **one string serving all three, byte-identical within each language.** Distinguishing them
     * would turn the bot into a token-validity oracle: a party sending arbitrary `/start` payloads
     * to a public bot could tell "no such token" from "that token existed and has expired", which
     * leaks whether a guess was structurally right (D13). The three cases share one message and
     * one code path that never learns which it is in.
     */
    invalidLink: string;
    /** Requirement 21.10. The token bound THIS Telegram account to a Profile it is already on. */
    alreadyLinked: string;
    /**
     * Requirement 21.11. A new Telegram account replaced the one previously on this Profile. Sent
     * to the NEW account, naming that it is now the linked one.
     */
    replaced: string;
    /**
     * Requirement 21.12. The separate message sent to the Telegram_User_Id that was REPLACED,
     * telling it that it no longer reaches that Jamee account. A distinct string with a distinct
     * recipient — the replaced account did nothing and is being informed, not answered.
     */
    replacedNotice: string;
    /**
     * Requirement 21.13. This Telegram account is already linked to a DIFFERENT Jamee account and
     * must be unlinked there first. Not an error (37.4): it is the correct handling of a
     * well-formed delivery whose sender resolves to someone else's `telegram_user_id`.
     */
    alreadyLinkedElsewhere: string;
    /**
     * Requirement 22.14. This Telegram account is linked, but the farmer holds no unexpired
     * entitlement, so the bot needs a recharge before it does farmer-facing work. Names the price,
     * the 7-day period, and where in the Web_App to pay. The price is interpolated as `{price}` from
     * `RECHARGE_PRICE_RUPEES` in `src/lib/config/access.ts` — the copy carries no literal amount,
     * so a price change is one constant edit and never a translation edit (criterion 22.4).
     * Amendment A2: also names the bot recharge command as an alternative.
     */
    gated: string;
    /**
     * Amendment A2 decision 5: the bot recharge command is exempt from the gate, so a farmer
     * whose window has lapsed can recover from inside Telegram. Replies with a payment link.
     * Price interpolated as `{price}`.
     */
    rechargeCommand: string;
    /**
     * A window that was once active but has lapsed — the farmer has recharged before but the
     * window expired. Same copy as `gated` may use but can note expiry; price as `{price}`.
     */
    lapsedWindow: string;
    /**
     * Requirement 10.9 — a message type outside text, photo and voice note. Same intent as the
     * retired whatsapp.unsupportedType, now for the Telegram channel.
     */
    unsupportedType: string;
    /**
     * D11's soft-deadline branch — the row is marked `failed` and 200 is still returned. Same
     * intent as the retired whatsapp.takingLonger, now for the Telegram channel.
     */
    takingLonger: string;
    /**
     * Confirmation sent after a successful recharge, stating the new expiry. Interpolated as
     * `{expiry}` (a formatted date/time string in the farmer's language).
     */
    rechargeConfirmation: string;
  };

  /**
   * Web_App static copy for the two access cards on the profile screen (Amendment A1, A2, A3).
   * All static — no model call, no network call, no `process.env` (D5). The price is interpolated
   * as `{price}` from `RECHARGE_PRICE_RUPEES` and the current expiry as `{expiry}` from the
   * farmer's entitlement, both computed by the caller.
   *
   * Requirements: 21.20 (the link/unlink card), 22.4 (price from one constant), 22.7/22.18 (the
   * recharge card shows the active window and offers a further recharge), O22-3/A3 (test mode).
   */
  access: {
    /** The recharge card heading. */
    rechargeHeading: string;
    /** The recharge action button, naming the price: e.g. "Recharge for ₹{price}". */
    rechargeButton: string;
    /** Shown while the window is active, naming the current expiry: interpolates `{expiry}`. */
    rechargeActiveUntil: string;
    /** Shown when no window is active (never recharged, or lapsed). */
    rechargeInactive: string;
    /** The optimistic "confirming your payment" state after checkout returns — grants nothing. */
    rechargeConfirming: string;
    /**
     * The test-mode note (A3 resolves O22-3 to test mode for all pilot testers). States that no
     * real money moves and test cards are used, so a tester is not surprised by a test checkout.
     */
    rechargeTestModeNote: string;
    /** The Telegram link card heading. */
    linkHeading: string;
    /** The action that mints a Link_Token and opens the deep link (Requirement 21.20). */
    linkButton: string;
    /** The action that unlinks the currently linked Telegram account (Requirement 21.15). */
    unlinkButton: string;
    /** Shown when a Telegram account is currently linked. */
    linkedState: string;
    /** Shown when no Telegram account is linked yet. */
    notLinkedState: string;
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

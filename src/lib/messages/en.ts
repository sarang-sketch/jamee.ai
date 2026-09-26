import type { MessageCatalog } from '@/lib/messages/types';

/**
 * English catalog — the reference the other two are written against.
 *
 * Requirements: 6.1–6.3, 14.3, 14.5, 15.1, 15.3, 15.7, 4.7, 7.6
 * Design: D5, D6
 *
 * Register: a smallholder farmer with limited schooling. Short sentences, no jargon, no
 * apology-padding, and never an explanation of Jamee's internals. "Jamee could not judge this
 * photo" is honest; "the model returned malformed JSON" is a leak dressed as transparency.
 */
export const en: MessageCatalog = {
  errors: {
    AUTH_REQUIRED: 'Please sign in to continue.',
    /**
     * Requirement 1.3, as amended by A1. Google sign-in did not complete — cancelled, a provider
     * error, or a callback with nothing to exchange. The farmer's one action is to sign in again,
     * so the sentence says exactly that and names none of Google's internals.
     */
    OAUTH_INCOMPLETE: 'Sign-in did not complete. Please try signing in again.',
    LANGUAGE_UNSUPPORTED: 'Jamee answers in English, Hindi and Marathi only.',

    /**
     * The text counterpart of `STORAGE_REF_INVALID`. It names no limit and no field: the farmer
     * reaching this typed nothing, typed only spaces, or is not using Jamee's own composer at all,
     * and "your question was 1043 characters" is not something to act on. Not retryable, so the
     * sentence asks for a different question rather than for the same one again.
     */
    MESSAGE_INVALID: 'Jamee could not read that question. Please type it again.',

    STORAGE_REF_INVALID: 'That photo could not be found. Please upload it again.',
    STORAGE_REF_FORBIDDEN: 'That file does not belong to your account.',
    FILE_TYPE_UNSUPPORTED:
      'Please choose a JPG, PNG or WebP photo of up to {maxMb} MB.',
    FILE_TOO_LARGE: 'That file is too large. The limit is {maxMb} MB.',
    AUDIO_TOO_LONG:
      'A recording can be up to {maxSeconds} seconds and {maxMb} MB. Please record a shorter question.',
    /**
     * The container is the recorder's choice, not the farmer's, so there is nothing to retry and
     * the sentence offers the one thing that does work. It quotes no format names: "flac, mpga,
     * m4a" is not advice a farmer can act on.
     */
    AUDIO_FORMAT_UNSUPPORTED:
      'Jamee cannot use this recording. Please type your question instead.',
    RATE_LIMITED: 'That was very quick. Please wait a moment and try again.',
    QUOTA_EXCEEDED:
      'You have used all {limit} of today\u2019s {operation} requests. You can send more after {resetsAt}.',
    TRANSCRIPT_EMPTY:
      'Jamee could not hear anything in that recording. Please record it again somewhere quieter.',
    TRANSCRIPTION_FAILED:
      'Jamee could not listen to that recording just now. Please try again.',

    /**
     * Requirement 14.5 specifies this English text EXACTLY, and D6 makes the literal the
     * English rendering of a coded error rather than a hardcoded string at a call site.
     *
     * DO NOT EDIT THIS STRING — not the wording, not the punctuation, not the trailing period.
     * `src/lib/errors.test.ts` asserts it byte for byte — code point by code point, through the
     * rendered response — and that test is the guard on Requirement 14.5. If it needs to change,
     * the requirement changes first.
     */
    PROVIDERS_UNAVAILABLE: 'Jamee is temporarily busy. Please try again shortly.',

    DIAGNOSIS_TIMEOUT:
      'Looking at your crop photo took longer than usual. Please send the photo again.',

    /**
     * Requirements 11.3, 11.4, 22.6 are machine-to-machine. Telegram and Razorpay read a status
     * code, not prose, and these responses carry no body content — so these strings exist only to
     * keep `Record<ErrorCode, string>` total, and are never rendered to a farmer.
     * `WEBHOOK_SIGNATURE_INVALID` is the payment route (raw-body signature); the Telegram route's
     * `WEBHOOK_SECRET_TOKEN_INVALID` is the header secret. The old verify-token code retired with
     * the WhatsApp GET handshake.
     */
    WEBHOOK_SIGNATURE_INVALID: 'Request signature could not be verified.',
    WEBHOOK_SECRET_TOKEN_INVALID: 'Webhook secret token did not match.',

    /**
     * Requirement 22.1. Creating the payment order failed on the provider's side. The provider's
     * own error text is deliberately NOT here (D15) — the farmer can only try again, so that is
     * all the sentence says.
     */
    PAYMENT_ORDER_FAILED: 'Jamee could not start the payment just now. Please try again.',

    CONVERSATION_NOT_FOUND: 'That conversation could not be found.',
    DIAGNOSIS_NOT_FOUND: 'That result could not be found.',

    /** Also never farmer-facing: the sweep route has no human caller. */
    SWEEP_UNAUTHORIZED: 'Not authorized.',

    INTERNAL_ERROR: 'Something went wrong at Jamee\u2019s end. Please try again.',
  },

  /**
   * The `{operation}` in `QUOTA_EXCEEDED`, as a farmer would name it rather than as `usage_logs`
   * does. `image` is the one that had to change: "today's image requests" is Jamee's word for a
   * photo, not the farmer's.
   */
  operations: {
    image: 'crop photo',
    chat: 'chat',
    voice: 'voice',
  },

  inconclusive: {
    /**
     * Requirement 6.1 — the model named a real condition outside the five Jamee has verified
     * content for. The farmer is told the limit of Jamee's coverage, NOT the name the model
     * guessed: Requirement 6.5 discards that name, and repeating it would be advice.
     */
    unverified_condition:
      'Jamee could not match this photo to a condition it knows. Jamee covers tomato and potato early blight and late blight only. Please show this crop to an agricultural expert.',

    /** Requirement 6.2 — retake in better light, AND consult an expert. */
    model_unclear:
      'Jamee could not judge this photo clearly. Please take another photo in good daylight, close to the affected leaf. If it is still unclear, please show the crop to an agricultural expert.',

    /** Requirement 6.3 — ask for a photo of the affected crop. */
    model_no_plant:
      'Jamee could not see a plant in this photo. Please send a photo of the affected crop leaf.',

    /**
     * The four schema-failure reasons (Requirements 5.2–5.5) share one honest sentence.
     *
     * They are separate keys because `usage_logs.rejection_reason` distinguishes them for the
     * audit (Requirement 5.7), and identical text here is the deliberate answer to "what does
     * the farmer see": a farmer cannot act on the difference between malformed JSON and an
     * out-of-range confidence value, and telling them about either would be leaking Jamee's
     * internals in place of advice.
     */
    not_json:
      'Jamee could not judge this photo. Please try again with a clear photo of the affected leaf, or show the crop to an agricultural expert.',
    missing_field:
      'Jamee could not judge this photo. Please try again with a clear photo of the affected leaf, or show the crop to an agricultural expert.',
    confidence_out_of_range:
      'Jamee could not judge this photo. Please try again with a clear photo of the affected leaf, or show the crop to an agricultural expert.',
    invalid_severity:
      'Jamee could not judge this photo. Please try again with a clear photo of the affected leaf, or show the crop to an agricultural expert.',
  },

  chat: {
    /** Requirement 4.7 — states the coverage limit and recommends an expert. No model call. */
    outOfScope:
      'Jamee covers tomato and potato conditions only. For this question, please consult an agricultural expert.',
    /** Requirement 7.6 — in scope, but no verified content answers it. */
    noVerifiedInfo:
      'Jamee does not have verified information for that question. Please consult an agricultural expert.',
  },

  loading: {
    uploading: 'Uploading your photo\u2026',
    /** Bound to the open `voice-messages` upload (Requirements 8.1, 15.2). */
    uploadingRecording: 'Uploading your recording\u2026',
    /**
     * Requirement 15.1 specifies this text EXACTLY, including the ellipsis character. Bound to
     * the open request, never to a timer (Requirement 15.2).
     */
    analyzing: 'Jamee is analyzing your crop image\u2026',
    thinking: 'Jamee is thinking\u2026',
    /** Requirement 15.7 — a state indicating Jamee is listening to the recording. */
    listening: 'Jamee is listening to your recording\u2026',
    /** Bound to the open `signInWithOtp` request (Requirements 1.1, 15.2). */
    sendingCode: 'Sending your code\u2026',
    /** Bound to the open `verifyOtp` request (Requirements 1.2, 15.2). */
    verifyingCode: 'Checking your code\u2026',
    /** Bound to the open `profiles` update (Requirements 1.8, 15.2). */
    saving: 'Saving your details\u2026',
  },

  ui: {
    appName: 'Jamee',
    tagline: 'Crop disease help for tomato and potato farmers.',
    signInHeading: 'Sign in with your phone number',
    googleSignIn: 'Continue with Google',
    signInDidNotComplete: 'Sign-in did not complete. Please try signing in again.',
    phoneLabel: 'Phone number',
    phoneHint: 'Include your country code, for example +919876543210.',
    sendCode: 'Send code',
    otpLabel: 'Six-digit code',
    otpHint: 'Enter the code sent to your phone by SMS.',
    verifyCode: 'Verify code',
    resendCode: 'Send a new code',
    changeNumber: 'Use a different number',
    signOut: 'Sign out',
    navDiagnose: 'Check a crop',
    navChat: 'Ask a question',
    navVoice: 'Speak a question',
    navHistory: 'My results',
    navProfile: 'My details',
    chooseImage: 'Choose a crop photo',
    captureImage: 'Take a crop photo',
    imageHint: 'JPG, PNG or WebP, up to {maxMb} MB. Photograph the affected leaf in daylight.',
    submitImage: 'Check this crop',
    retry: 'Try again',
    holdToSpeak: 'Hold to speak',
    tapToStart: 'Tap to start recording',
    tapToStop: 'Tap to stop recording',
    recording: 'Recording\u2026',
    recordingSecondsLeft: '{seconds} seconds left',
    microphoneBlocked:
      'Jamee could not use your microphone. Please allow microphone access, then try again.',
    recordingUnsupported:
      'This browser cannot make a recording Jamee can use. Please type your question instead.',
    transcriptLabel: 'What Jamee heard',
    answerLabel: 'Jamee\u2019s answer',
    askPlaceholder: 'Ask about your crop\u2026',
    send: 'Send',
    historyHeading: 'My results',
    historyEmpty: 'You have no results yet.',
    historyEmptyAction: 'Send your first crop photo',
    backToHistory: 'Back to my results',
    /** Requirement 12.1 — the label an inconclusive entry carries in place of a condition. */
    inconclusiveLabel: 'Not identified',
    needsExpertBanner: 'Please show this crop to an agricultural expert.',
    confidenceLabel: 'Confidence',
    severityLabel: 'Severity',
    channelLabel: 'Sent from',
    channelWeb: 'Website',
    channelWhatsapp: 'WhatsApp',
    channelTelegram: 'Telegram',
    dateLabel: 'Date',
    symptomsHeading: 'What to look for',
    causesHeading: 'Why it happens',
    treatmentHeading: 'What to do',
    preventionHeading: 'How to prevent it',
    sourceHeading: 'Source',
    conversationHeading: 'Questions about this result',
    conversationEmpty: 'You have not asked anything about this result yet.',
    roleFarmer: 'You',
    roleJamee: 'Jamee',
    displayNameLabel: 'Your name',
    preferredLanguageLabel: 'Language',
    save: 'Save',
    saved: 'Saved',
    cropPhotoAlt: 'The crop photo you sent',
    photoThumbnailOnly: 'The full-size photo is no longer stored. This is the small copy.',
    photoNoLongerStored: 'The photo for this result is no longer stored.',
  },

  whatsapp: {
    /** Requirement 10.3. */
    signInFirst:
      'Welcome to Jamee. Please sign in on the Jamee website with this same phone number first, then send your crop photo here.',
    /** Requirement 10.9 — names exactly what Jamee accepts. */
    unsupportedType: 'Jamee accepts photos, text and voice notes.',
    /**
     * The V10-versus-V14 container discrepancy. The farmer cannot change what WhatsApp records
     * in, so the one actionable instruction is to type the question instead.
     */
    voiceNoteFormatUnsupported:
      'Jamee could not use this voice note. Please type your question here instead.',
    /** D11's soft deadline. The farmer's next send is a new message id, so it is processed. */
    takingLonger:
      'Jamee is taking longer than usual on this photo. Please send it again in a moment.',
  },

  /**
   * Telegram replies (Amendment A1). Static, in-repository copy — no model call is reachable
   * (D5). The four outcomes here are successful handling, not errors (37.4). English is also the
   * fallback for a `/start` from a sender on no Profile, who has no resolved language.
   */
  telegram: {
    /** Requirement 10.3 / 21.9 — not linked yet: what to do on the web profile screen. */
    linkingInstructions:
      'Welcome to Jamee. This Telegram account is not linked yet. Please open Jamee in your web browser, sign in, and go to your profile to get a link. Open that link to connect this Telegram account.',
    /**
     * Requirement 21.8 — ONE string for unknown, expired, and consumed. It must give no hint of
     * which case it is: it never says "expired" or "already used", only that the link did not
     * work and where to get a fresh one.
     */
    invalidLink:
      'This link did not work. Please open Jamee in your web browser, sign in, and get a new link from your profile.',
    /** Requirement 21.10 — the token bound an account already on this Profile. */
    alreadyLinked: 'This Telegram account is already linked to your Jamee account.',
    /** Requirement 21.11 — sent to the new account that replaced the old one. */
    replaced:
      'This Telegram account is now linked to your Jamee account. The account linked before this one no longer reaches it.',
    /** Requirement 21.12 — sent to the account that was replaced. */
    replacedNotice:
      'This Telegram account is no longer linked to that Jamee account. Another Telegram account was linked in its place.',
    /** Requirement 21.13 — this account belongs to a different Jamee account. */
    alreadyLinkedElsewhere:
      'This Telegram account is already linked to a different Jamee account. Please unlink it there first, then try again.',
    /**
     * Requirement 22.14 — linked but not entitled. Price interpolated as `{price}` from
     * `RECHARGE_PRICE_RUPEES`; the copy carries no literal amount. Amendment A2: names the 7-day
     * window and the /recharge command as an in-Telegram alternative to the web app.
     */
    gated:
      'This Telegram account is linked. To use Jamee here, recharge for \u20B9{price} — that gives you 7 days. Pay in the Jamee web app under Payments, or send /recharge here for a payment link. After it goes through, send your crop photo.',
    /** Amendment A2 decision 5 — the /recharge command, exempt from the gate. Price as `{price}`. */
    rechargeCommand:
      'Recharge Jamee for \u20B9{price} to use the bot for 7 days. Open this link to pay: {link}',
    /** A window that was active before but has lapsed. Price as `{price}`. */
    lapsedWindow:
      'Your Jamee access has ended. Recharge for \u20B9{price} to use the bot for another 7 days. Send /recharge here for a payment link, or pay in the Jamee web app.',
    /** Requirement 10.9 — a type outside text, photo and voice note. */
    unsupportedType: 'Jamee accepts photos, text and voice notes.',
    /** D11's soft deadline. The farmer's next send is a new update, so it is processed. */
    takingLonger:
      'Jamee is taking longer than usual on this. Please send it again in a moment.',
    /** Confirmation after a successful recharge, naming the new expiry as `{expiry}`. */
    rechargeConfirmation:
      'Your recharge went through. Jamee is active until {expiry}. Send your crop photo here.',
  },

  /**
   * Web recharge card and Telegram link card (Amendment A1/A2/A3). Static copy; `{price}` from
   * `RECHARGE_PRICE_RUPEES`, `{expiry}` from the entitlement.
   */
  access: {
    rechargeHeading: 'Telegram bot access',
    rechargeButton: 'Recharge for \u20B9{price}',
    rechargeActiveUntil: 'Your Telegram access is active until {expiry}.',
    rechargeInactive: 'You have no active Telegram access. Recharge to use the Jamee bot.',
    rechargeConfirming: 'Confirming your payment\u2026',
    rechargeTestModeNote:
      'This is a test-mode payment. No real money is charged; use a test card.',
    linkHeading: 'Telegram account',
    linkButton: 'Link a Telegram account',
    unlinkButton: 'Unlink this Telegram account',
    linkedState: 'A Telegram account is linked to your Jamee account.',
    notLinkedState: 'No Telegram account is linked yet.',
  },

  severity: {
    none: 'Healthy',
    low: 'Mild',
    moderate: 'Moderate',
    high: 'Severe',
  },

  languageNames: {
    en: 'English',
    hi: '\u0939\u093F\u0928\u094D\u0926\u0940',
    mr: '\u092E\u0930\u093E\u0920\u0940',
  },
};

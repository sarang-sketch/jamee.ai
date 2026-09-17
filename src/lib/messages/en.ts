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
    OTP_INVALID: 'That code is incorrect or has expired. Please request a new one.',
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
     * Requirement 11.4 and 11.2 are machine-to-machine. Meta reads a status code, not prose,
     * and the design is explicit that these responses carry no body content — so these two
     * strings exist only to keep `Record<ErrorCode, string>` total, and are never rendered to
     * a farmer.
     */
    WEBHOOK_SIGNATURE_INVALID: 'Request signature could not be verified.',
    WEBHOOK_VERIFY_TOKEN_INVALID: 'Verification token did not match.',

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

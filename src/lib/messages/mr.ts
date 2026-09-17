import type { MessageCatalog } from '@/lib/messages/types';

/**
 * Marathi catalog.
 *
 * Requirements: 9.1, 9.3, 15.3 — and D5, which is why this copy is static rather than
 * translated by a model at request time.
 *
 * ### Marathi is not Hindi with different words
 *
 * The two share the Devanagari script, which is exactly why Requirement 9.6 cannot be served by
 * a script-range check and why D9 leaves language identification to the model. They do not share
 * grammar: Marathi verb agreement, its distinct postpositions, and its own everyday vocabulary
 * (`फोटो पाठवा` rather than Hindi's `फोटो भेजें`; `तज्ज्ञ` rather than `विशेषज्ञ`) mean this file
 * is a translation from the English reference, not a transliteration of `hi.ts`.
 *
 * Sentence-final punctuation is the full stop, which is what modern digital Marathi uses, rather
 * than Hindi's danda (`।`). That difference is visible and deliberate.
 *
 * ### The rule that outranks fluency
 *
 * **No canonical disease name appears in Devanagari anywhere below** (Requirements 4.6, 9.4).
 * Where a message names Jamee's coverage it names the CROPS — `टोमॅटो`, `बटाटा` — and leaves the
 * condition names to the grounded explanation, which carries them in Latin script. Property 13
 * asserts this across the whole farmer-facing surface.
 *
 * ### One gender decision, applied everywhere: `फोटो` is masculine
 *
 * `हा फोटो`, `पिकाचा फोटो`, `फोटो सापडला नाही`. This file previously agreed `फोटो` as feminine
 * (`ही फोटो सापडली नाही`), which is Hindi's treatment of the same loanword carried across —
 * exactly the bleed-through this file's header warns about, and the kind of thing that reads as
 * translated-by-machine to a Marathi speaker while looking fine to everyone else. Agreement is
 * now masculine on every string that names a photo: the demonstrative, the adjective, and the
 * verb ending.
 *
 * **Flagged for the native-speaker pass** (task 30.1 / `docs/TESTING_REPORT.md`): this is one
 * decision, so a reviewer who disagrees reverses it in one sweep rather than string by string.
 */
export const mr: MessageCatalog = {
  errors: {
    AUTH_REQUIRED: 'पुढे जाण्यासाठी साइन इन करा.',
    OTP_INVALID: 'हा कोड चुकीचा आहे किंवा त्याची मुदत संपली आहे. नवीन कोड मागवा.',
    LANGUAGE_UNSUPPORTED: 'जामी फक्त इंग्रजी, हिंदी आणि मराठीत उत्तर देते.',
    MESSAGE_INVALID: 'जामीला हा प्रश्न वाचता आला नाही. कृपया तो पुन्हा लिहून पाठवा.',
    STORAGE_REF_INVALID: 'हा फोटो सापडला नाही. कृपया पुन्हा पाठवा.',
    STORAGE_REF_FORBIDDEN: 'ही फाईल तुमच्या खात्याची नाही.',
    FILE_TYPE_UNSUPPORTED: 'कृपया {maxMb} MB पर्यंतचा JPG, PNG किंवा WebP फोटो निवडा.',
    FILE_TOO_LARGE: 'ही फाईल खूप मोठी आहे. मर्यादा {maxMb} MB आहे.',
    AUDIO_TOO_LONG:
      'रेकॉर्डिंग {maxSeconds} सेकंद आणि {maxMb} MB पर्यंत असू शकते. कृपया लहान प्रश्न रेकॉर्ड करा.',
    AUDIO_FORMAT_UNSUPPORTED:
      'जामी ही रेकॉर्डिंग वापरू शकत नाही. कृपया आपला प्रश्न लिहून पाठवा.',
    RATE_LIMITED: 'हे फार पटकन झाले. थोडा वेळ थांबून पुन्हा प्रयत्न करा.',
    /**
     * Requirement 14.3 — the limit and the reset time, both in the sentence.
     *
     * Phrased around `मर्यादा` rather than around the farmer, because a Marathi transitive past
     * agrees with its OBJECT: `पाठवले आहेत` would need a different ending for each of the three
     * operation words. Nominalizing to "the limit for sending X" makes `ती` agree with `मर्यादा`,
     * which is fixed, so one template is correct for all three.
     */
    QUOTA_EXCEEDED:
      'आजची {operation} पाठवण्याची मर्यादा {limit} आहे आणि ती पूर्ण झाली आहे. {resetsAt} नंतर पुन्हा पाठवू शकता.',
    TRANSCRIPT_EMPTY:
      'जामीला या रेकॉर्डिंगमध्ये काहीही ऐकू आले नाही. कृपया शांत ठिकाणी पुन्हा रेकॉर्ड करा.',
    TRANSCRIPTION_FAILED: 'जामीला आता ही रेकॉर्डिंग ऐकता आली नाही. कृपया पुन्हा प्रयत्न करा.',

    /**
     * D6 — the Marathi equivalent of Requirement 14.5's English literal. Only the ENGLISH
     * string is asserted byte-for-byte; this one must mean the same thing and be non-empty.
     */
    PROVIDERS_UNAVAILABLE: 'जामी आता थोडा वेळ व्यस्त आहे. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.',

    DIAGNOSIS_TIMEOUT:
      'तुमच्या पिकाचा फोटो पाहण्यास नेहमीपेक्षा जास्त वेळ लागला. कृपया फोटो पुन्हा पाठवा.',

    /** Machine-to-machine; never rendered to a farmer. Present so the record stays total. */
    WEBHOOK_SIGNATURE_INVALID: 'विनंतीची ओळख पडताळता आली नाही.',
    WEBHOOK_VERIFY_TOKEN_INVALID: 'पडताळणी टोकन जुळले नाही.',

    CONVERSATION_NOT_FOUND: 'हे संभाषण सापडले नाही.',
    DIAGNOSIS_NOT_FOUND: 'हा निकाल सापडला नाही.',
    SWEEP_UNAUTHORIZED: 'परवानगी नाही.',

    INTERNAL_ERROR: 'जामीच्या बाजूने काहीतरी चूक झाली. कृपया पुन्हा प्रयत्न करा.',
  },

  /** The `{operation}` in `QUOTA_EXCEEDED`, in the plain words the sentence above is built for. */
  operations: {
    image: 'फोटो',
    chat: 'प्रश्न',
    voice: 'रेकॉर्डिंग',
  },

  inconclusive: {
    /** Requirement 6.1. Crops named in Marathi; condition names deliberately absent. */
    unverified_condition:
      'जामीने तपासलेल्या कोणत्याही रोगाशी हा फोटो जुळत नाही. जामी फक्त टोमॅटो आणि बटाट्याच्या रोगांकडे पाहते. कृपया हे पीक कृषी तज्ज्ञाला दाखवा.',

    /** Requirement 6.2 — retake in daylight AND consult an expert. */
    model_unclear:
      'जामीला हा फोटो स्पष्टपणे ओळखता आला नाही. कृपया दिवसाच्या उजेडात, प्रभावित पानाच्या जवळून दुसरा फोटो काढा. तरीही स्पष्ट न झाल्यास हे पीक कृषी तज्ज्ञाला दाखवा.',

    /** Requirement 6.3 — ask for a photo of the affected crop leaf. */
    model_no_plant:
      'या फोटोत जामीला कोणतेही झाड दिसले नाही. कृपया प्रभावित पिकाच्या पानाचा फोटो पाठवा.',

    /** Requirements 5.2–5.5 — one honest sentence, repeated deliberately. See `en.ts`. */
    not_json:
      'जामीला हा फोटो ओळखता आला नाही. कृपया प्रभावित पानाच्या स्पष्ट फोटोसह पुन्हा प्रयत्न करा, किंवा हे पीक कृषी तज्ज्ञाला दाखवा.',
    missing_field:
      'जामीला हा फोटो ओळखता आला नाही. कृपया प्रभावित पानाच्या स्पष्ट फोटोसह पुन्हा प्रयत्न करा, किंवा हे पीक कृषी तज्ज्ञाला दाखवा.',
    confidence_out_of_range:
      'जामीला हा फोटो ओळखता आला नाही. कृपया प्रभावित पानाच्या स्पष्ट फोटोसह पुन्हा प्रयत्न करा, किंवा हे पीक कृषी तज्ज्ञाला दाखवा.',
    invalid_severity:
      'जामीला हा फोटो ओळखता आला नाही. कृपया प्रभावित पानाच्या स्पष्ट फोटोसह पुन्हा प्रयत्न करा, किंवा हे पीक कृषी तज्ज्ञाला दाखवा.',
  },

  chat: {
    outOfScope:
      'जामी फक्त टोमॅटो आणि बटाट्याच्या रोगांकडे पाहते. या प्रश्नासाठी कृपया कृषी तज्ज्ञाला विचारा.',
    noVerifiedInfo:
      'या प्रश्नासाठी जामीकडे तपासलेली माहिती नाही. कृपया कृषी तज्ज्ञाला विचारा.',
  },

  loading: {
    uploading: 'तुमचा फोटो अपलोड होत आहे…',
    uploadingRecording: 'तुमची रेकॉर्डिंग अपलोड होत आहे…',
    analyzing: 'जामी तुमच्या पिकाचा फोटो पाहत आहे…',
    thinking: 'जामी विचार करत आहे…',
    listening: 'जामी तुमची रेकॉर्डिंग ऐकत आहे…',
    sendingCode: 'कोड पाठवला जात आहे…',
    verifyingCode: 'कोड तपासला जात आहे…',
    saving: 'तुमची माहिती जतन होत आहे…',
  },

  ui: {
    /** Not translated: it is the product's name. */
    appName: 'Jamee',
    tagline: 'टोमॅटो आणि बटाटा शेतकऱ्यांसाठी पीक रोग मदत.',
    signInHeading: 'तुमच्या मोबाईल नंबरने साइन इन करा',
    phoneLabel: 'मोबाईल नंबर',
    phoneHint: 'देशाचा कोड सुद्धा लिहा, जसे +919876543210.',
    sendCode: 'कोड पाठवा',
    otpLabel: 'सहा अंकी कोड',
    otpHint: 'तुमच्या फोनवर SMS ने आलेला कोड लिहा.',
    verifyCode: 'कोड तपासा',
    resendCode: 'नवीन कोड पाठवा',
    changeNumber: 'दुसरा नंबर वापरा',
    signOut: 'साइन आउट',
    navDiagnose: 'पीक तपासा',
    navChat: 'प्रश्न विचारा',
    navVoice: 'बोलून विचारा',
    navHistory: 'माझे निकाल',
    navProfile: 'माझी माहिती',
    chooseImage: 'पिकाचा फोटो निवडा',
    captureImage: 'पिकाचा फोटो काढा',
    imageHint:
      'JPG, PNG किंवा WebP, {maxMb} MB पर्यंत. प्रभावित पानाचा फोटो दिवसाच्या उजेडात काढा.',
    submitImage: 'हे पीक तपासा',
    retry: 'पुन्हा प्रयत्न करा',
    holdToSpeak: 'बोलण्यासाठी दाबून धरा',
    tapToStart: 'रेकॉर्डिंग सुरू करण्यासाठी दाबा',
    tapToStop: 'रेकॉर्डिंग थांबवण्यासाठी दाबा',
    recording: 'रेकॉर्डिंग सुरू आहे…',
    recordingSecondsLeft: '{seconds} सेकंद शिल्लक',
    /** `मायक्रोफोन`, the Marathi spelling — `माइक्रोफोन` is Hindi's. */
    microphoneBlocked:
      'जामीला तुमचा मायक्रोफोन वापरता आला नाही. कृपया मायक्रोफोनला परवानगी द्या आणि पुन्हा प्रयत्न करा.',
    recordingUnsupported:
      'हा ब्राउझर जामी वापरू शकेल अशी रेकॉर्डिंग करू शकत नाही. कृपया तुमचा प्रश्न लिहून विचारा.',
    transcriptLabel: 'जामीने जे ऐकले',
    answerLabel: 'जामीचे उत्तर',
    askPlaceholder: 'तुमच्या पिकाबद्दल विचारा…',
    send: 'पाठवा',
    historyHeading: 'माझे निकाल',
    historyEmpty: 'अजून कोणताही निकाल नाही.',
    historyEmptyAction: 'तुमच्या पिकाचा पहिला फोटो पाठवा',
    backToHistory: 'माझ्या निकालांकडे परत जा',
    inconclusiveLabel: 'ओळख झाली नाही',
    needsExpertBanner: 'कृपया हे पीक कृषी तज्ज्ञाला दाखवा.',
    confidenceLabel: 'खात्री',
    severityLabel: 'तीव्रता',
    channelLabel: 'माध्यम',
    channelWeb: 'वेबसाइट',
    channelWhatsapp: 'WhatsApp',
    dateLabel: 'तारीख',
    symptomsHeading: 'काय पाहावे',
    causesHeading: 'हे का होते',
    treatmentHeading: 'काय करावे',
    preventionHeading: 'प्रतिबंध कसा करावा',
    sourceHeading: 'स्रोत',
    conversationHeading: 'या निकालावरील प्रश्न',
    conversationEmpty: 'तुम्ही या निकालाबद्दल अजून काहीही विचारलेले नाही.',
    roleFarmer: 'तुम्ही',
    roleJamee: 'जामी',
    displayNameLabel: 'तुमचे नाव',
    preferredLanguageLabel: 'भाषा',
    save: 'जतन करा',
    saved: 'जतन केले',
    cropPhotoAlt: 'तुम्ही पाठवलेला पिकाचा फोटो',
    photoThumbnailOnly: 'पूर्ण आकाराचा फोटो आता जतन केलेला नाही. ही छोटी प्रत आहे.',
    photoNoLongerStored: 'या निकालाचा फोटो आता जतन केलेला नाही.',
  },

  whatsapp: {
    signInFirst:
      'जामीमध्ये स्वागत आहे. कृपया आधी याच मोबाईल नंबरने जामीच्या वेबसाइटवर साइन इन करा, नंतर येथे पिकाचा फोटो पाठवा.',
    unsupportedType: 'जामी फोटो, लिखित संदेश आणि व्हॉइस नोट स्वीकारते.',
    voiceNoteFormatUnsupported:
      'जामीला हा व्हॉइस नोट ऐकता आला नाही. कृपया आपला प्रश्न येथे लिहून पाठवा.',
    takingLonger:
      'जामीला या फोटोसाठी नेहमीपेक्षा जास्त वेळ लागत आहे. कृपया थोड्या वेळाने पुन्हा पाठवा.',
  },

  severity: {
    none: 'निरोगी',
    low: 'सौम्य',
    moderate: 'मध्यम',
    high: 'गंभीर',
  },

  languageNames: {
    en: 'English',
    hi: 'हिन्दी',
    mr: 'मराठी',
  },
};

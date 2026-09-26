import type { MessageCatalog } from '@/lib/messages/types';

/**
 * Hindi catalog.
 *
 * Requirements: 9.1, 9.3, 15.3 — and D5, which is why this copy is static rather than
 * translated by a model at request time.
 *
 * ### Two rules that shaped this file
 *
 * **No canonical disease name appears in Devanagari anywhere below** (Requirements 4.6, 9.4).
 * Where a message names Jamee's coverage it names the CROPS — `टमाटर`, `आलू` — and leaves the
 * condition names to the grounded explanation, which carries them in Latin script. Property 13
 * asserts this across the whole farmer-facing surface.
 *
 * **Plain Hindi, not administrative Hindi.** The audience is a smallholder farmer with limited
 * schooling, so this uses everyday vocabulary (`पत्ती`, `फोटो`, `दिखाएँ`) rather than a
 * Sanskritised register. Sentence-final punctuation is the danda (`।`), which is what Hindi
 * uses — Marathi in `mr.ts` uses the full stop, and that difference is deliberate.
 *
 * The `: MessageCatalog` annotation is what makes coverage total: a key added to the catalog
 * shape breaks this file until it has a real Hindi string. It is never `as MessageCatalog`,
 * which would silently accept a missing key.
 */
export const hi: MessageCatalog = {
  errors: {
    AUTH_REQUIRED: 'आगे बढ़ने के लिए साइन इन करें।',
    OAUTH_INCOMPLETE: 'साइन इन पूरा नहीं हुआ। कृपया फिर से साइन इन करें।',
    LANGUAGE_UNSUPPORTED: 'जामी केवल अंग्रेजी, हिन्दी और मराठी में जवाब देता है।',
    MESSAGE_INVALID: 'जामी यह प्रश्न पढ़ नहीं पाया। कृपया इसे दोबारा लिखकर भेजें।',
    STORAGE_REF_INVALID: 'यह फोटो नहीं मिली। कृपया दोबारा भेजें।',
    STORAGE_REF_FORBIDDEN: 'यह फाइल आपके खाते की नहीं है।',
    /** "चुनें", not "लें": the farmer is picking a file that already exists, not taking a photo. */
    FILE_TYPE_UNSUPPORTED: 'कृपया {maxMb} MB तक की JPG, PNG या WebP फोटो चुनें।',
    FILE_TOO_LARGE: 'यह फाइल बहुत बड़ी है। सीमा {maxMb} MB है।',
    AUDIO_TOO_LONG:
      'रिकॉर्डिंग {maxSeconds} सेकंड और {maxMb} MB तक हो सकती है। कृपया छोटा प्रश्न रिकॉर्ड करें।',
    AUDIO_FORMAT_UNSUPPORTED:
      'जामी इस रिकॉर्डिंग का उपयोग नहीं कर सकता। कृपया अपना सवाल लिखकर भेजें।',
    RATE_LIMITED: 'यह बहुत जल्दी हो गया। थोड़ा रुककर फिर कोशिश करें।',
    /**
     * Requirement 14.3 — the limit and the reset time, both in the sentence.
     *
     * Built around `आप` so the verb agrees with the farmer rather than with `{operation}`: the three
     * operation words differ in gender (`फोटो` and `रिकॉर्डिंग` feminine, `सवाल` masculine), and a
     * template whose verb agreed with the noun would be wrong for two of the three.
     */
    QUOTA_EXCEEDED:
      'आज आप {limit} {operation} भेज चुके हैं, जो आज की पूरी सीमा है। {resetsAt} के बाद फिर भेज सकते हैं।',
    TRANSCRIPT_EMPTY:
      'जामी को इस रिकॉर्डिंग में कुछ सुनाई नहीं दिया। किसी शांत जगह पर फिर रिकॉर्ड करें।',
    TRANSCRIPTION_FAILED: 'जामी अभी यह रिकॉर्डिंग नहीं सुन पाया। कृपया फिर कोशिश करें।',

    /**
     * D6 — the Hindi equivalent of Requirement 14.5's English literal. Only the ENGLISH string
     * is asserted byte-for-byte; this one must mean the same thing and be non-empty.
     */
    PROVIDERS_UNAVAILABLE: 'जामी अभी थोड़ी देर के लिए व्यस्त है। कृपया थोड़ी देर बाद फिर कोशिश करें।',

    DIAGNOSIS_TIMEOUT:
      'आपकी फसल की फोटो देखने में सामान्य से अधिक समय लगा। कृपया फोटो फिर भेजें।',

    /** Machine-to-machine; never rendered to a farmer. Present so the record stays total. */
    WEBHOOK_SIGNATURE_INVALID: 'अनुरोध की पहचान सत्यापित नहीं हुई।',
    WEBHOOK_SECRET_TOKEN_INVALID: 'वेबहुक सीक्रेट टोकन मेल नहीं खाया।',

    /** Requirement 22.1 — provider order creation failed; no provider text (D15). */
    PAYMENT_ORDER_FAILED: 'जामी अभी भुगतान शुरू नहीं कर पाया। कृपया फिर कोशिश करें।',

    CONVERSATION_NOT_FOUND: 'यह बातचीत नहीं मिली।',
    DIAGNOSIS_NOT_FOUND: 'यह परिणाम नहीं मिला।',
    SWEEP_UNAUTHORIZED: 'अनुमति नहीं है।',

    INTERNAL_ERROR: 'जामी की ओर से कुछ गलत हो गया। कृपया फिर कोशिश करें।',
  },

  /** The `{operation}` in `QUOTA_EXCEEDED`, in the plain words the sentence above is built for. */
  operations: {
    image: 'फोटो',
    chat: 'सवाल',
    voice: 'रिकॉर्डिंग',
  },

  inconclusive: {
    /** Requirement 6.1. Crops named in Hindi; condition names deliberately absent. */
    unverified_condition:
      'जामी इस फोटो को अपनी जाँची गई किसी बीमारी से नहीं मिला पाया। जामी केवल टमाटर और आलू की बीमारियों को देखता है। कृपया यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',

    /** Requirement 6.2 — retake in daylight AND consult an expert. */
    model_unclear:
      'जामी इस फोटो को साफ तरह से नहीं पहचान पाया। कृपया दिन की रोशनी में, प्रभावित पत्ती के पास से दूसरी फोटो लें। फिर भी साफ न हो तो यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',

    /** Requirement 6.3 — ask for a photo of the affected crop leaf. */
    model_no_plant:
      'इस फोटो में जामी को कोई पौधा नहीं दिखा। कृपया प्रभावित फसल की पत्ती की फोटो भेजें।',

    /** Requirements 5.2–5.5 — one honest sentence, repeated deliberately. See `en.ts`. */
    not_json:
      'जामी इस फोटो को पहचान नहीं पाया। कृपया प्रभावित पत्ती की साफ फोटो से फिर कोशिश करें, या यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',
    missing_field:
      'जामी इस फोटो को पहचान नहीं पाया। कृपया प्रभावित पत्ती की साफ फोटो से फिर कोशिश करें, या यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',
    confidence_out_of_range:
      'जामी इस फोटो को पहचान नहीं पाया। कृपया प्रभावित पत्ती की साफ फोटो से फिर कोशिश करें, या यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',
    invalid_severity:
      'जामी इस फोटो को पहचान नहीं पाया। कृपया प्रभावित पत्ती की साफ फोटो से फिर कोशिश करें, या यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',
  },

  chat: {
    outOfScope:
      'जामी केवल टमाटर और आलू की बीमारियों को देखता है। इस प्रश्न के लिए कृपया किसी कृषि विशेषज्ञ से पूछें।',
    noVerifiedInfo:
      'इस प्रश्न के लिए जामी के पास जाँची गई जानकारी नहीं है। कृपया किसी कृषि विशेषज्ञ से पूछें।',
  },

  loading: {
    uploading: 'आपकी फोटो अपलोड हो रही है…',
    uploadingRecording: 'आपकी रिकॉर्डिंग अपलोड हो रही है…',
    analyzing: 'जामी आपकी फसल की फोटो देख रहा है…',
    thinking: 'जामी सोच रहा है…',
    listening: 'जामी आपकी रिकॉर्डिंग सुन रहा है…',
    sendingCode: 'कोड भेजा जा रहा है…',
    verifyingCode: 'कोड जाँचा जा रहा है…',
    saving: 'आपकी जानकारी सहेजी जा रही है…',
  },

  ui: {
    /** Not translated: it is the product's name. */
    appName: 'Jamee',
    tagline: 'टमाटर और आलू के किसानों के लिए फसल रोग सहायता।',
    signInHeading: 'अपने मोबाइल नंबर से साइन इन करें',
    googleSignIn: 'Google से जारी रखें',
    signInDidNotComplete: 'साइन इन पूरा नहीं हुआ। कृपया फिर से साइन इन करें।',
    phoneLabel: 'मोबाइल नंबर',
    phoneHint: 'देश का कोड भी लिखें, जैसे +919876543210।',
    sendCode: 'कोड भेजें',
    otpLabel: 'छह अंकों का कोड',
    otpHint: 'अपने फोन पर SMS से आया कोड लिखें।',
    verifyCode: 'कोड जाँचें',
    resendCode: 'नया कोड भेजें',
    changeNumber: 'दूसरा नंबर इस्तेमाल करें',
    signOut: 'साइन आउट',
    navDiagnose: 'फसल जाँचें',
    navChat: 'प्रश्न पूछें',
    navVoice: 'बोलकर पूछें',
    navHistory: 'मेरे परिणाम',
    navProfile: 'मेरी जानकारी',
    chooseImage: 'फसल की फोटो चुनें',
    captureImage: 'फसल की फोटो खींचें',
    imageHint: 'JPG, PNG या WebP, {maxMb} MB तक। प्रभावित पत्ती की फोटो दिन की रोशनी में लें।',
    submitImage: 'यह फसल जाँचें',
    retry: 'फिर कोशिश करें',
    holdToSpeak: 'बोलने के लिए दबाए रखें',
    tapToStart: 'रिकॉर्डिंग शुरू करने के लिए दबाएँ',
    tapToStop: 'रिकॉर्डिंग बंद करने के लिए दबाएँ',
    recording: 'रिकॉर्डिंग हो रही है…',
    recordingSecondsLeft: '{seconds} सेकंड बाकी',
    microphoneBlocked:
      'जामी आपका माइक्रोफोन इस्तेमाल नहीं कर पाया। कृपया माइक्रोफोन की अनुमति दें, फिर कोशिश करें।',
    recordingUnsupported:
      'यह ब्राउज़र ऐसी रिकॉर्डिंग नहीं बना सकता जिसे जामी इस्तेमाल कर सके। कृपया अपना प्रश्न लिखकर पूछें।',
    transcriptLabel: 'जामी ने जो सुना',
    answerLabel: 'जामी का जवाब',
    askPlaceholder: 'अपनी फसल के बारे में पूछें…',
    send: 'भेजें',
    historyHeading: 'मेरे परिणाम',
    historyEmpty: 'अभी तक कोई परिणाम नहीं है।',
    historyEmptyAction: 'अपनी पहली फसल की फोटो भेजें',
    backToHistory: 'मेरे परिणामों पर वापस जाएँ',
    inconclusiveLabel: 'पहचान नहीं हुई',
    needsExpertBanner: 'कृपया यह फसल किसी कृषि विशेषज्ञ को दिखाएँ।',
    confidenceLabel: 'भरोसा',
    severityLabel: 'गंभीरता',
    channelLabel: 'माध्यम',
    channelWeb: 'वेबसाइट',
    channelWhatsapp: 'WhatsApp',
    channelTelegram: 'Telegram',
    dateLabel: 'तारीख',
    symptomsHeading: 'क्या देखना है',
    causesHeading: 'यह क्यों होता है',
    treatmentHeading: 'क्या करना है',
    preventionHeading: 'रोकने के उपाय',
    sourceHeading: 'स्रोत',
    conversationHeading: 'इस परिणाम पर प्रश्न',
    conversationEmpty: 'आपने इस परिणाम पर अभी तक कुछ नहीं पूछा है।',
    roleFarmer: 'आप',
    roleJamee: 'जामी',
    displayNameLabel: 'आपका नाम',
    preferredLanguageLabel: 'भाषा',
    save: 'सहेजें',
    saved: 'सहेज लिया',
    cropPhotoAlt: 'आपने भेजी हुई फसल की फोटो',
    photoThumbnailOnly: 'पूरी फोटो अब सहेजी नहीं है। यह छोटी प्रति है।',
    photoNoLongerStored: 'इस परिणाम की फोटो अब सहेजी नहीं है।',
  },

  whatsapp: {
    signInFirst:
      'जामी में स्वागत है। कृपया पहले इसी मोबाइल नंबर से जामी की वेबसाइट पर साइन इन करें, फिर यहाँ फसल की फोटो भेजें।',
    unsupportedType: 'जामी फोटो, लिखित संदेश और वॉइस नोट स्वीकार करता है।',
    voiceNoteFormatUnsupported:
      'जामी इस वॉइस नोट को सुन नहीं सका। कृपया अपना सवाल यहाँ लिखकर भेजें।',
    takingLonger:
      'जामी को इस फोटो में सामान्य से अधिक समय लग रहा है। कृपया कुछ देर बाद फिर भेजें।',
  },

  /**
   * Telegram replies (Amendment A1). Static Hindi copy, no model call (D5). The invalid-link
   * string gives no hint of which case it is (Requirement 21.8), and the gated reply's amount is
   * `{price}`, never a literal.
   */
  telegram: {
    linkingInstructions:
      'जामी में स्वागत है। यह Telegram खाता अभी जुड़ा नहीं है। कृपया अपने वेब ब्राउज़र में जामी खोलें, साइन इन करें, और अपनी प्रोफ़ाइल से एक लिंक लें। इस Telegram खाते को जोड़ने के लिए वह लिंक खोलें।',
    invalidLink:
      'यह लिंक काम नहीं आया। कृपया अपने वेब ब्राउज़र में जामी खोलें, साइन इन करें, और अपनी प्रोफ़ाइल से नया लिंक लें।',
    alreadyLinked: 'यह Telegram खाता पहले से आपके जामी खाते से जुड़ा है।',
    replaced:
      'यह Telegram खाता अब आपके जामी खाते से जुड़ा है। इससे पहले जुड़ा खाता अब उस तक नहीं पहुँचता।',
    replacedNotice:
      'यह Telegram खाता अब उस जामी खाते से जुड़ा नहीं है। उसकी जगह दूसरा Telegram खाता जोड़ा गया है।',
    alreadyLinkedElsewhere:
      'यह Telegram खाता पहले से किसी दूसरे जामी खाते से जुड़ा है। कृपया पहले उसे वहाँ से हटाएँ, फिर कोशिश करें।',
    gated:
      'यह Telegram खाता जुड़ा है। जामी को यहाँ इस्तेमाल करने के लिए \u20B9{price} का रिचार्ज करें — इससे 7 दिन मिलते हैं। जामी वेब ऐप में Payments के अंतर्गत भुगतान करें, या यहाँ /recharge भेजें और भुगतान लिंक पाएँ। रिचार्ज होने के बाद अपनी फसल की फोटो भेजें।',
    rechargeCommand:
      'जामी को 7 दिन इस्तेमाल करने के लिए \u20B9{price} का रिचार्ज करें। भुगतान के लिए यह लिंक खोलें: {link}',
    lapsedWindow:
      'आपकी जामी सुविधा समाप्त हो गई है। और 7 दिन के लिए \u20B9{price} का रिचार्ज करें। भुगतान लिंक के लिए यहाँ /recharge भेजें, या जामी वेब ऐप में भुगतान करें।',
    unsupportedType: 'जामी फोटो, लिखित संदेश और वॉइस नोट स्वीकार करता है।',
    takingLonger:
      'जामी को इसमें सामान्य से अधिक समय लग रहा है। कृपया कुछ देर बाद फिर भेजें।',
    rechargeConfirmation:
      'आपका रिचार्ज हो गया। जामी {expiry} तक चालू है। यहाँ अपनी फसल की फोटो भेजें।',
  },

  /**
   * Web recharge card and Telegram link card (Amendment A1/A2/A3). Static Hindi copy; `{price}`
   * from `RECHARGE_PRICE_RUPEES`, `{expiry}` from the entitlement.
   */
  access: {
    rechargeHeading: 'Telegram बॉट सुविधा',
    rechargeButton: '\u20B9{price} का रिचार्ज करें',
    rechargeActiveUntil: 'आपकी Telegram सुविधा {expiry} तक चालू है।',
    rechargeInactive: 'आपके पास कोई चालू Telegram सुविधा नहीं है। जामी बॉट इस्तेमाल करने के लिए रिचार्ज करें।',
    rechargeConfirming: 'आपका भुगतान जाँचा जा रहा है…',
    rechargeTestModeNote:
      'यह टेस्ट-मोड भुगतान है। असली पैसे नहीं कटते; टेस्ट कार्ड इस्तेमाल करें।',
    linkHeading: 'Telegram खाता',
    linkButton: 'Telegram खाता जोड़ें',
    unlinkButton: 'यह Telegram खाता हटाएँ',
    linkedState: 'एक Telegram खाता आपके जामी खाते से जुड़ा है।',
    notLinkedState: 'अभी कोई Telegram खाता जुड़ा नहीं है।',
  },

  severity: {
    none: 'स्वस्थ',
    low: 'हल्का',
    moderate: 'मध्यम',
    high: 'गंभीर',
  },

  languageNames: {
    en: 'English',
    hi: 'हिन्दी',
    mr: 'मराठी',
  },
};

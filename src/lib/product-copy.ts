import type { Language } from '@/lib/schemas';

export interface ProductCopy {
  nav: {
    home: string;
    how: string;
    features: string;
    languages: string;
    telegram: string;
    about: string;
    login: string;
    getStarted: string;
    openMenu: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    body: string;
    primary: string;
    secondary: string;
    trust: readonly string[];
  };
  preview: {
    eyebrow: string;
    title: string;
    body: string;
    label: string;
    user: string;
    response: string;
    cropLabel: string;
    crop: string;
    conditionLabel: string;
    condition: string;
    observedLabel: string;
    observed: readonly string[];
    guidanceLabel: string;
    guidance: string;
  };
  how: {
    eyebrow: string;
    title: string;
    body: string;
    steps: readonly { title: string; body: string }[];
  };
  features: {
    eyebrow: string;
    title: string;
    body: string;
    items: readonly { title: string; body: string; icon: string }[];
  };
  ways: {
    eyebrow: string;
    title: string;
    body: string;
    items: readonly { title: string; body: string; icon: string }[];
  };
  languages: {
    eyebrow: string;
    title: string;
    body: string;
  };
  telegram: {
    eyebrow: string;
    title: string;
    body: string;
    cta: string;
    website: string;
    assistant: string;
  };
  payment: {
    eyebrow: string;
    title: string;
    body: string;
    detail: string;
    cta: string;
  };
  why: {
    eyebrow: string;
    title: string;
    body: string;
    items: readonly { title: string; body: string }[];
  };
  examples: {
    eyebrow: string;
    title: string;
    body: string;
    items: readonly string[];
  };
  safety: {
    eyebrow: string;
    title: string;
    body: string;
  };
  final: {
    title: string;
    body: string;
    primary: string;
    secondary: string;
  };
  footer: {
    description: string;
    product: string;
    account: string;
    legal: string;
    privacy: string;
    terms: string;
    disclaimer: string;
    copyright: string;
  };
  login: {
    eyebrow: string;
    visualTitle: string;
    visualBody: string;
    highlights: readonly string[];
    welcome: string;
    body: string;
    accountNote: string;
    back: string;
  };
  workspace: {
    newChat: string;
    startingChat: string;
    history: string;
    connect: string;
    profile: string;
    recent: string;
    today: string;
    yesterday: string;
    older: string;
    untitled: string;
    noHistory: string;
    openMenu: string;
    closeMenu: string;
    assistantSubtitle: string;
    emptyTitle: string;
    emptyBody: string;
    suggestions: readonly string[];
    composerPlaceholder: string;
    addAttachment: string;
    uploadPhoto: string;
    takePhoto: string;
    removePhoto: string;
    send: string;
    cropPhoto: string;
    historyTitle: string;
    historyBody: string;
    connectTitle: string;
    connectBody: string;
    connectNote: string;
    profileTitle: string;
    profileBody: string;
    accountTitle: string;
    email: string;
    signedInWithGoogle: string;
    chatFailed: string;
    imageReady: string;
    responsibleNote: string;
  };
  legal: {
    privacyTitle: string;
    privacyBody: readonly string[];
    termsTitle: string;
    termsBody: readonly string[];
    back: string;
  };
}

const COPY = {
  en: {
    nav: {
      home: 'Home', how: 'How it works', features: 'Features', languages: 'Languages',
      telegram: 'Telegram', about: 'About', login: 'Login', getStarted: 'Get started', openMenu: 'Open navigation',
    },
    hero: {
      eyebrow: 'AI crop-care assistant',
      title: 'Understand your crop. Protect your harvest.',
      body: 'Upload a crop photo, ask a question, or speak naturally. Jamee helps you understand possible crop problems and explore practical next steps.',
      primary: 'Check your crop', secondary: 'How Jamee works',
      trust: ['Photo, voice and text', 'English, हिन्दी and मराठी', 'Your history in one place'],
    },
    preview: {
      eyebrow: 'One simple conversation', title: 'See the problem. Ask what comes next.',
      body: 'Jamee keeps crop checks and follow-up questions together, so you can continue without choosing a different tool.',
      label: 'Illustrative product preview', user: 'These spots are appearing on my tomato leaves.',
      response: 'Here is a possible match based on the photo. Check the observed signs and use the guidance carefully.',
      cropLabel: 'Crop', crop: 'Tomato', conditionLabel: 'Possible condition', condition: 'Tomato Early Blight',
      observedLabel: 'What was observed', observed: ['Dark brown, ring-shaped spots', 'Yellowing around affected areas'],
      guidanceLabel: 'General guidance', guidance: 'Review the verified guidance, keep observing the crop, and consult a local agricultural professional for important treatment decisions.',
    },
    how: {
      eyebrow: 'How it works', title: 'From crop problem to a clearer next step.',
      body: 'Use the way that is easiest in the moment. Jamee keeps the conversation together.',
      steps: [
        { title: 'Capture', body: 'Take a clear photo of the affected crop in good light.' },
        { title: 'Ask', body: 'Upload the photo, describe the problem, or speak your question.' },
        { title: 'Understand', body: 'Read the AI-generated assessment and the signs it considered.' },
        { title: 'Continue', body: 'Ask a follow-up on the website or continue through Telegram.' },
      ],
    },
    features: {
      eyebrow: 'Everything in one workspace', title: 'Useful crop-care tools, without a complicated interface.',
      body: 'Each feature uses Jamee’s existing secure services and your saved account history.',
      items: [
        { icon: 'image', title: 'AI crop image analysis', body: 'Upload a crop image and receive an AI-generated assessment of possible crop conditions.' },
        { icon: 'chat', title: 'Ask crop questions', body: 'Describe what you see and ask follow-up questions in the same conversation.' },
        { icon: 'voice', title: 'Voice questions', body: 'Speak naturally when typing is inconvenient.' },
        { icon: 'language', title: 'Multilingual support', body: 'Use Jamee in English, Hindi, or Marathi.' },
        { icon: 'history', title: 'Conversation history', body: 'Return to previous crop conversations and diagnosis records.' },
        { icon: 'telegram', title: 'Telegram integration', body: 'Link the official Jamee bot and continue from Telegram.' },
      ],
    },
    ways: {
      eyebrow: 'Ask Jamee your way', title: 'One assistant. Three natural ways to ask.',
      body: 'You do not need to decide which feature to open. Start in the composer and use what you have.',
      items: [
        { icon: 'photo', title: 'Photo', body: 'Show Jamee the crop problem.' },
        { icon: 'voice', title: 'Voice', body: 'Tell Jamee what you see.' },
        { icon: 'text', title: 'Text', body: 'Type a question and keep the conversation going.' },
      ],
    },
    languages: {
      eyebrow: 'Multilingual by design', title: 'Speak the way you’re comfortable.',
      body: 'Jamee is designed to make crop-care information easier to access in English, Hindi, and Marathi. AI wording can still vary, so review important guidance carefully.',
    },
    telegram: {
      eyebrow: 'Telegram', title: 'Take Jamee with you.',
      body: 'Securely connect your Telegram account, then continue crop-care conversations with the existing Jamee bot.',
      cta: 'Connect Telegram', website: 'Website', assistant: 'Jamee',
    },
    payment: {
      eyebrow: 'Telegram access', title: 'Simple access. ₹20 for 7 days.',
      body: 'The existing ₹20 recharge activates Jamee’s Telegram bot access for seven days. Recharging early extends the current access window.',
      detail: 'Checkout and payment verification use the project’s existing Razorpay flow. The current pilot configuration clearly identifies test-mode checkout when enabled.',
      cta: 'Get started',
    },
    why: {
      eyebrow: 'Why Jamee', title: 'Crop-care support that stays focused on the farmer.',
      body: 'Jamee brings the existing AI, account, history, and messaging capabilities into one calm product experience.',
      items: [
        { title: 'Simple', body: 'No complicated agricultural dashboard to learn.' },
        { title: 'Accessible', body: 'Ask with an image, your voice, or text.' },
        { title: 'Multilingual', body: 'Designed for English, Hindi, and Marathi.' },
        { title: 'Connected', body: 'Move between the website and Telegram.' },
        { title: 'Personal', body: 'Keep your own crop-care history in one secure workspace.' },
      ],
    },
    examples: {
      eyebrow: 'Questions you can ask', title: 'Start with what you notice.',
      body: 'These are example questions—not guaranteed diagnosis categories.',
      items: [
        'My tomato leaves are developing brown spots.',
        'Why are my chilli leaves turning yellow?',
        'What could be affecting this crop?',
        'How can I understand these symptoms?',
      ],
    },
    safety: {
      eyebrow: 'Responsible AI', title: 'Helpful guidance, with honest limits.',
      body: 'Jamee provides AI-generated crop-care guidance based on the information you provide. Results may be uncertain, especially when images are unclear. For important crop-management decisions, consult a qualified agricultural professional or local agricultural authority.',
    },
    final: {
      title: 'Ready to check your crop?', body: 'Start one conversation. Show a photo, speak, or type.',
      primary: 'Get started', secondary: 'Login',
    },
    footer: {
      description: 'AI crop-care assistant for photo, voice, and text conversations.',
      product: 'Product', account: 'Account', legal: 'Trust', privacy: 'Privacy', terms: 'Terms',
      disclaimer: 'Responsible AI', copyright: 'Jamee. Built for clearer crop-care conversations.',
    },
    login: {
      eyebrow: 'Your crop-care workspace', visualTitle: 'One conversation for every crop question.',
      visualBody: 'Upload a photo, speak naturally, or type. Your Jamee history stays with your Google account.',
      highlights: ['Existing Google authentication', 'Private MongoDB-backed history', 'Website and Telegram together'],
      welcome: 'Welcome to Jamee', body: 'Your crop-care workspace is one step away.',
      accountNote: 'Your account keeps your Jamee conversations and crop-care history together.', back: 'Back to home',
    },
    workspace: {
      newChat: 'New chat', startingChat: 'Starting…', history: 'History', connect: 'Connect', profile: 'My profile',
      recent: 'Recent conversations', today: 'Today', yesterday: 'Yesterday', older: 'Older',
      untitled: 'New crop conversation', noHistory: 'Your conversations will appear here.', openMenu: 'Open menu', closeMenu: 'Close menu',
      assistantSubtitle: 'Your AI crop-care assistant', emptyTitle: 'How can I help with your crop?',
      emptyBody: 'Upload a photo, ask a question, or speak naturally.',
      suggestions: ['Check a leaf', 'Why are my leaves turning yellow?', 'Help me understand a crop problem', 'How can I prevent crop disease?'],
      composerPlaceholder: 'Message Jamee…', addAttachment: 'Add a crop photo', uploadPhoto: 'Upload crop photo',
      takePhoto: 'Take photo', removePhoto: 'Remove selected photo', send: 'Send message', cropPhoto: 'Crop photo',
      historyTitle: 'Your crop-care history', historyBody: 'Review recent website and Telegram activity, then open any saved diagnosis.',
      connectTitle: 'Connect Jamee', connectBody: 'Link the official Telegram bot and manage the existing ₹20 access flow in one place.',
      connectNote: 'The public bot username is safe to share. Your bot token, payment secrets, and Telegram user ID remain on the server.',
      profileTitle: 'My profile', profileBody: 'Manage the name and language used across your Jamee workspace.',
      accountTitle: 'Account information', email: 'Email', signedInWithGoogle: 'Signed in securely with Google',
      chatFailed: 'Jamee could not complete that message. Your draft is still here.', imageReady: 'Photo ready to send',
      responsibleNote: 'AI guidance can be uncertain. Check important crop-management decisions with a qualified local professional.',
    },
    legal: {
      privacyTitle: 'Privacy at Jamee',
      privacyBody: [
        'Jamee uses your existing Google sign-in to identify your account. Crop conversations, profile settings, diagnosis records, Telegram-link status, and payment-access records are stored in the project’s existing MongoDB database.',
        'Crop photos and voice recordings are handled through authenticated server routes. Access checks use the signed-in account, and the application does not expose database credentials, provider keys, the Telegram bot token, or payment secrets to the browser.',
        'Only connect Telegram when you want website and bot activity associated with the same Jamee account. You can unlink Telegram from the Connect screen without deleting your conversations.',
      ],
      termsTitle: 'Using Jamee responsibly',
      termsBody: [
        'Jamee provides AI-generated crop-care information from the photo, voice, and text you submit. It is an assistant, not a guarantee of diagnosis or treatment outcome.',
        'Use the service lawfully and do not attempt to access another person’s account, conversations, media, payment information, or integration credentials.',
        'For important treatment, pesticide, food-safety, or crop-management decisions, verify the guidance with a qualified agricultural professional and follow applicable product labels and local rules.',
      ],
      back: 'Back to Jamee',
    },
  },
  hi: {
    nav: {
      home: 'होम', how: 'यह कैसे काम करता है', features: 'सुविधाएँ', languages: 'भाषाएँ',
      telegram: 'टेलीग्राम', about: 'जैमी के बारे में', login: 'लॉग इन', getStarted: 'शुरू करें', openMenu: 'नेविगेशन खोलें',
    },
    hero: {
      eyebrow: 'एआई फसल-देखभाल सहायक', title: 'अपनी फसल को समझें। अपनी उपज की रक्षा करें।',
      body: 'फसल की फोटो अपलोड करें, सवाल पूछें या स्वाभाविक रूप से बोलें। जैमी संभावित फसल समस्याएँ समझने और व्यावहारिक अगले कदम जानने में मदद करता है।',
      primary: 'फसल जाँचें', secondary: 'जैमी कैसे काम करता है',
      trust: ['फोटो, आवाज़ और टेक्स्ट', 'English, हिन्दी और मराठी', 'सारा इतिहास एक जगह'],
    },
    preview: {
      eyebrow: 'एक सरल बातचीत', title: 'समस्या दिखाएँ। आगे क्या करना है, पूछें।',
      body: 'जैमी फसल जाँच और आगे के सवाल एक साथ रखता है, इसलिए आपको अलग साधन चुनने की जरूरत नहीं पड़ती।',
      label: 'उदाहरण के लिए उत्पाद दृश्य', user: 'मेरे टमाटर के पत्तों पर ये धब्बे दिखाई दे रहे हैं।',
      response: 'फोटो के आधार पर यह एक संभावित मिलान है। दिखे हुए संकेत देखें और सलाह का सावधानी से उपयोग करें।',
      cropLabel: 'फसल', crop: 'टमाटर', conditionLabel: 'संभावित स्थिति', condition: 'Tomato Early Blight',
      observedLabel: 'क्या दिखाई दिया', observed: ['गहरे भूरे, छल्लेदार धब्बे', 'प्रभावित भाग के आसपास पीलापन'],
      guidanceLabel: 'सामान्य मार्गदर्शन', guidance: 'सत्यापित जानकारी पढ़ें, फसल पर नज़र रखें और महत्वपूर्ण उपचार निर्णय के लिए स्थानीय कृषि विशेषज्ञ से सलाह लें।',
    },
    how: {
      eyebrow: 'यह कैसे काम करता है', title: 'फसल की समस्या से अगले स्पष्ट कदम तक।',
      body: 'उस तरीके का उपयोग करें जो उस समय सबसे आसान हो। जैमी बातचीत को एक साथ रखता है।',
      steps: [
        { title: 'फोटो लें', body: 'अच्छी रोशनी में प्रभावित फसल की साफ फोटो लें।' },
        { title: 'पूछें', body: 'फोटो अपलोड करें, समस्या लिखें या सवाल बोलें।' },
        { title: 'समझें', body: 'एआई से बनी जाँच और देखे गए संकेत पढ़ें।' },
        { title: 'जारी रखें', body: 'वेबसाइट पर अगला सवाल पूछें या टेलीग्राम से बातचीत जारी रखें।' },
      ],
    },
    features: {
      eyebrow: 'एक ही कार्यक्षेत्र में सब कुछ', title: 'उपयोगी फसल-देखभाल साधन, बिना जटिल इंटरफेस के।',
      body: 'हर सुविधा जैमी की मौजूदा सुरक्षित सेवाओं और आपके सहेजे गए इतिहास का उपयोग करती है।',
      items: [
        { icon: 'image', title: 'एआई फसल फोटो जाँच', body: 'फसल की फोटो अपलोड करें और संभावित स्थिति का एआई-आधारित आकलन पाएँ।' },
        { icon: 'chat', title: 'फसल के सवाल पूछें', body: 'जो दिख रहा है उसे लिखें और उसी बातचीत में अगला सवाल पूछें।' },
        { icon: 'voice', title: 'आवाज़ से सवाल', body: 'टाइप करना कठिन हो तो स्वाभाविक रूप से बोलें।' },
        { icon: 'language', title: 'कई भाषाएँ', body: 'जैमी को अंग्रेज़ी, हिन्दी या मराठी में उपयोग करें।' },
        { icon: 'history', title: 'बातचीत का इतिहास', body: 'पुरानी बातचीत और फसल जाँच रिकॉर्ड फिर से खोलें।' },
        { icon: 'telegram', title: 'टेलीग्राम', body: 'आधिकारिक जैमी बॉट जोड़ें और टेलीग्राम से जारी रखें।' },
      ],
    },
    ways: {
      eyebrow: 'अपने तरीके से पूछें', title: 'एक सहायक। पूछने के तीन सहज तरीके।',
      body: 'आपको यह तय करने की जरूरत नहीं कि कौन-सी सुविधा खोलनी है। कंपोज़र से शुरू करें।',
      items: [
        { icon: 'photo', title: 'फोटो', body: 'जैमी को फसल की समस्या दिखाएँ।' },
        { icon: 'voice', title: 'आवाज़', body: 'जैमी को बताएँ कि आपको क्या दिख रहा है।' },
        { icon: 'text', title: 'टेक्स्ट', body: 'सवाल लिखें और बातचीत जारी रखें।' },
      ],
    },
    languages: {
      eyebrow: 'कई भाषाओं के लिए बनाया गया', title: 'जिस भाषा में सहज हों, उसी में बोलें।',
      body: 'जैमी अंग्रेज़ी, हिन्दी और मराठी में फसल-देखभाल जानकारी समझना आसान बनाने के लिए बनाया गया है। एआई की भाषा बदल सकती है, इसलिए महत्वपूर्ण सलाह ध्यान से जाँचें।',
    },
    telegram: {
      eyebrow: 'टेलीग्राम', title: 'जैमी को अपने साथ रखें।',
      body: 'अपने टेलीग्राम खाते को सुरक्षित रूप से जोड़ें और मौजूदा जैमी बॉट से फसल-देखभाल बातचीत जारी रखें।',
      cta: 'टेलीग्राम जोड़ें', website: 'वेबसाइट', assistant: 'जैमी',
    },
    payment: {
      eyebrow: 'टेलीग्राम पहुँच', title: 'सरल पहुँच। 7 दिनों के लिए ₹20।',
      body: 'मौजूदा ₹20 रीचार्ज सात दिनों के लिए जैमी टेलीग्राम बॉट की पहुँच चालू करता है। समय से पहले रीचार्ज करने पर मौजूदा अवधि आगे बढ़ती है।',
      detail: 'चेकआउट और भुगतान सत्यापन परियोजना के मौजूदा Razorpay प्रवाह का उपयोग करते हैं। पायलट में टेस्ट मोड चालू होने पर उसे साफ दिखाया जाता है।',
      cta: 'शुरू करें',
    },
    why: {
      eyebrow: 'जैमी क्यों', title: 'किसान पर केंद्रित फसल-देखभाल सहायता।',
      body: 'जैमी मौजूदा एआई, खाता, इतिहास और संदेश सुविधाओं को एक शांत अनुभव में जोड़ता है।',
      items: [
        { title: 'सरल', body: 'सीखने के लिए कोई जटिल कृषि डैशबोर्ड नहीं।' },
        { title: 'सुलभ', body: 'फोटो, आवाज़ या टेक्स्ट से पूछें।' },
        { title: 'बहुभाषी', body: 'अंग्रेज़ी, हिन्दी और मराठी के लिए बनाया गया।' },
        { title: 'जुड़ा हुआ', body: 'वेबसाइट और टेलीग्राम के बीच जारी रखें।' },
        { title: 'व्यक्तिगत', body: 'अपना फसल-देखभाल इतिहास सुरक्षित कार्यक्षेत्र में रखें।' },
      ],
    },
    examples: {
      eyebrow: 'आप क्या पूछ सकते हैं', title: 'जो दिखाई दे रहा है, वहीं से शुरू करें।',
      body: 'ये उदाहरण सवाल हैं—पक्की जाँच श्रेणियाँ नहीं।',
      items: ['मेरे टमाटर के पत्तों पर भूरे धब्बे आ रहे हैं।', 'मिर्च के पत्ते पीले क्यों हो रहे हैं?', 'इस फसल को क्या प्रभावित कर रहा हो सकता है?', 'मैं इन लक्षणों को कैसे समझूँ?'],
    },
    safety: {
      eyebrow: 'जिम्मेदार एआई', title: 'सहायक जानकारी, ईमानदार सीमाओं के साथ।',
      body: 'जैमी आपकी दी हुई जानकारी के आधार पर एआई-जनित फसल-देखभाल मार्गदर्शन देता है। धुंधली फोटो में परिणाम अनिश्चित हो सकते हैं। महत्वपूर्ण फसल प्रबंधन निर्णय के लिए योग्य कृषि विशेषज्ञ या स्थानीय कृषि विभाग से सलाह लें।',
    },
    final: {
      title: 'अपनी फसल जाँचने के लिए तैयार हैं?', body: 'एक बातचीत शुरू करें। फोटो दिखाएँ, बोलें या लिखें।',
      primary: 'शुरू करें', secondary: 'लॉग इन',
    },
    footer: {
      description: 'फोटो, आवाज़ और टेक्स्ट बातचीत के लिए एआई फसल-देखभाल सहायक।',
      product: 'उत्पाद', account: 'खाता', legal: 'विश्वास', privacy: 'गोपनीयता', terms: 'शर्तें',
      disclaimer: 'जिम्मेदार एआई', copyright: 'जैमी। स्पष्ट फसल-देखभाल बातचीत के लिए बनाया गया।',
    },
    login: {
      eyebrow: 'आपका फसल-देखभाल कार्यक्षेत्र', visualTitle: 'हर फसल सवाल के लिए एक बातचीत।',
      visualBody: 'फोटो अपलोड करें, बोलें या लिखें। आपका जैमी इतिहास आपके Google खाते के साथ रहता है।',
      highlights: ['मौजूदा Google प्रमाणीकरण', 'निजी MongoDB इतिहास', 'वेबसाइट और टेलीग्राम साथ में'],
      welcome: 'जैमी में आपका स्वागत है', body: 'आपका फसल-देखभाल कार्यक्षेत्र बस एक कदम दूर है।',
      accountNote: 'आपका खाता जैमी बातचीत और फसल-देखभाल इतिहास को एक साथ रखता है।', back: 'होम पर वापस जाएँ',
    },
    workspace: {
      newChat: 'नई बातचीत', startingChat: 'शुरू हो रही है…', history: 'इतिहास', connect: 'जोड़ें', profile: 'मेरी प्रोफाइल',
      recent: 'हाल की बातचीत', today: 'आज', yesterday: 'कल', older: 'पुरानी', untitled: 'नई फसल बातचीत',
      noHistory: 'आपकी बातचीत यहाँ दिखाई देगी।', openMenu: 'मेनू खोलें', closeMenu: 'मेनू बंद करें',
      assistantSubtitle: 'आपका एआई फसल-देखभाल सहायक', emptyTitle: 'मैं आपकी फसल में कैसे मदद कर सकता हूँ?',
      emptyBody: 'फोटो अपलोड करें, सवाल पूछें या स्वाभाविक रूप से बोलें।',
      suggestions: ['एक पत्ता जाँचें', 'मेरे पत्ते पीले क्यों हो रहे हैं?', 'फसल की समस्या समझने में मदद करें', 'फसल रोग कैसे रोकूँ?'],
      composerPlaceholder: 'जैमी को संदेश लिखें…', addAttachment: 'फसल की फोटो जोड़ें', uploadPhoto: 'फसल फोटो अपलोड करें',
      takePhoto: 'फोटो लें', removePhoto: 'चुनी हुई फोटो हटाएँ', send: 'संदेश भेजें', cropPhoto: 'फसल की फोटो',
      historyTitle: 'आपका फसल-देखभाल इतिहास', historyBody: 'वेबसाइट और टेलीग्राम की हाल की गतिविधि देखें और सहेजी गई जाँच खोलें।',
      connectTitle: 'जैमी को जोड़ें', connectBody: 'आधिकारिक टेलीग्राम बॉट जोड़ें और मौजूदा ₹20 पहुँच एक जगह संभालें।',
      connectNote: 'सार्वजनिक बॉट यूज़रनेम साझा करना सुरक्षित है। बॉट टोकन, भुगतान रहस्य और टेलीग्राम यूज़र आईडी सर्वर पर रहते हैं।',
      profileTitle: 'मेरी प्रोफाइल', profileBody: 'अपने जैमी कार्यक्षेत्र में उपयोग होने वाला नाम और भाषा संभालें।',
      accountTitle: 'खाता जानकारी', email: 'ईमेल', signedInWithGoogle: 'Google से सुरक्षित रूप से साइन इन',
      chatFailed: 'जैमी यह संदेश पूरा नहीं कर सका। आपका मसौदा अभी भी यहाँ है।', imageReady: 'फोटो भेजने के लिए तैयार',
      responsibleNote: 'एआई मार्गदर्शन अनिश्चित हो सकता है। महत्वपूर्ण निर्णय स्थानीय योग्य विशेषज्ञ से जाँचें।',
    },
    legal: {
      privacyTitle: 'जैमी में गोपनीयता',
      privacyBody: [
        'जैमी आपके खाते की पहचान के लिए मौजूदा Google साइन-इन का उपयोग करता है। बातचीत, प्रोफाइल सेटिंग, जाँच रिकॉर्ड, टेलीग्राम लिंक स्थिति और भुगतान पहुँच रिकॉर्ड मौजूदा MongoDB डेटाबेस में रखे जाते हैं।',
        'फसल फोटो और आवाज़ रिकॉर्डिंग प्रमाणित सर्वर मार्गों से संभाली जाती हैं। डेटाबेस पहचान, प्रदाता कुंजी, टेलीग्राम बॉट टोकन और भुगतान रहस्य ब्राउज़र में नहीं दिखाए जाते।',
        'टेलीग्राम तभी जोड़ें जब आप वेबसाइट और बॉट गतिविधि को एक ही जैमी खाते से जोड़ना चाहते हों। टेलीग्राम हटाने पर आपकी बातचीत नहीं मिटती।',
      ],
      termsTitle: 'जैमी का जिम्मेदारी से उपयोग',
      termsBody: [
        'जैमी आपकी फोटो, आवाज़ और टेक्स्ट के आधार पर एआई-जनित फसल-देखभाल जानकारी देता है। यह पक्की जाँच या उपचार परिणाम की गारंटी नहीं है।',
        'सेवा का वैध उपयोग करें और किसी अन्य व्यक्ति के खाते, बातचीत, मीडिया, भुगतान जानकारी या इंटीग्रेशन पहचान तक पहुँचने की कोशिश न करें।',
        'महत्वपूर्ण उपचार, कीटनाशक, खाद्य-सुरक्षा या फसल प्रबंधन निर्णय के लिए योग्य कृषि विशेषज्ञ से पुष्टि करें और स्थानीय नियम व उत्पाद लेबल मानें।',
      ],
      back: 'जैमी पर वापस जाएँ',
    },
  },
  mr: {
    nav: {
      home: 'मुख्यपृष्ठ', how: 'हे कसे काम करते', features: 'वैशिष्ट्ये', languages: 'भाषा',
      telegram: 'टेलिग्राम', about: 'जैमीविषयी', login: 'लॉग इन', getStarted: 'सुरू करा', openMenu: 'नेव्हिगेशन उघडा',
    },
    hero: {
      eyebrow: 'एआय पीक-देखभाल सहाय्यक', title: 'आपले पीक समजून घ्या. आपल्या उत्पादनाचे रक्षण करा.',
      body: 'पिकाचा फोटो अपलोड करा, प्रश्न विचारा किंवा सहज बोला. जैमी संभाव्य पीक समस्या समजून घेण्यास आणि पुढील व्यावहारिक पावले शोधण्यास मदत करते.',
      primary: 'पीक तपासा', secondary: 'जैमी कसे काम करते',
      trust: ['फोटो, आवाज आणि मजकूर', 'English, हिन्दी आणि मराठी', 'सगळा इतिहास एकाच ठिकाणी'],
    },
    preview: {
      eyebrow: 'एक सोपा संवाद', title: 'समस्या दाखवा. पुढे काय करायचे ते विचारा.',
      body: 'जैमी पीक तपासणी आणि पुढील प्रश्न एकत्र ठेवते, त्यामुळे वेगळे साधन निवडावे लागत नाही.',
      label: 'उदाहरणार्थ उत्पादन दृश्य', user: 'माझ्या टोमॅटोच्या पानांवर हे डाग दिसत आहेत.',
      response: 'फोटोवरून हा एक संभाव्य मेळ आहे. दिसलेली चिन्हे तपासा आणि मार्गदर्शन काळजीपूर्वक वापरा.',
      cropLabel: 'पीक', crop: 'टोमॅटो', conditionLabel: 'संभाव्य स्थिती', condition: 'Tomato Early Blight',
      observedLabel: 'काय दिसले', observed: ['गडद तपकिरी, वर्तुळाकार डाग', 'बाधित भागाभोवती पिवळेपणा'],
      guidanceLabel: 'सामान्य मार्गदर्शन', guidance: 'पडताळलेली माहिती वाचा, पिकाचे निरीक्षण सुरू ठेवा आणि महत्त्वाच्या उपचार निर्णयासाठी स्थानिक कृषितज्ज्ञांचा सल्ला घ्या.',
    },
    how: {
      eyebrow: 'हे कसे काम करते', title: 'पिकाच्या समस्येपासून स्पष्ट पुढील पावलापर्यंत.',
      body: 'त्या क्षणी जो मार्ग सोपा असेल तो वापरा. जैमी संवाद एकत्र ठेवते.',
      steps: [
        { title: 'फोटो घ्या', body: 'चांगल्या प्रकाशात बाधित पिकाचा स्पष्ट फोटो घ्या.' },
        { title: 'विचारा', body: 'फोटो अपलोड करा, समस्या लिहा किंवा प्रश्न बोला.' },
        { title: 'समजून घ्या', body: 'एआयने तयार केलेले मूल्यांकन आणि पाहिलेली चिन्हे वाचा.' },
        { title: 'पुढे बोला', body: 'वेबसाइटवर पुढील प्रश्न विचारा किंवा टेलिग्रामवर संवाद सुरू ठेवा.' },
      ],
    },
    features: {
      eyebrow: 'एका कार्यक्षेत्रात सर्व काही', title: 'उपयुक्त पीक-देखभाल साधने, गुंतागुंतीच्या इंटरफेसशिवाय.',
      body: 'प्रत्येक वैशिष्ट्य जैमीच्या विद्यमान सुरक्षित सेवा आणि जतन केलेला इतिहास वापरते.',
      items: [
        { icon: 'image', title: 'एआय पीक फोटो विश्लेषण', body: 'पिकाचा फोटो अपलोड करा आणि संभाव्य स्थितीचे एआय-निर्मित मूल्यांकन मिळवा.' },
        { icon: 'chat', title: 'पिकाचे प्रश्न विचारा', body: 'काय दिसते ते लिहा आणि त्याच संवादात पुढील प्रश्न विचारा.' },
        { icon: 'voice', title: 'आवाजातील प्रश्न', body: 'टाइप करणे गैरसोयीचे असेल तेव्हा सहज बोला.' },
        { icon: 'language', title: 'बहुभाषिक मदत', body: 'जैमी इंग्रजी, हिन्दी किंवा मराठीत वापरा.' },
        { icon: 'history', title: 'संवाद इतिहास', body: 'मागील पीक संवाद आणि तपासणी नोंदी पुन्हा उघडा.' },
        { icon: 'telegram', title: 'टेलिग्राम जोडणी', body: 'अधिकृत जैमी बॉट जोडा आणि टेलिग्रामवरून पुढे बोला.' },
      ],
    },
    ways: {
      eyebrow: 'आपल्या पद्धतीने विचारा', title: 'एक सहाय्यक. विचारण्याचे तीन सहज मार्ग.',
      body: 'कोणते वैशिष्ट्य उघडायचे हे ठरवावे लागत नाही. कंपोझरमधून सुरुवात करा.',
      items: [
        { icon: 'photo', title: 'फोटो', body: 'जैमीला पिकाची समस्या दाखवा.' },
        { icon: 'voice', title: 'आवाज', body: 'काय दिसते ते जैमीला सांगा.' },
        { icon: 'text', title: 'मजकूर', body: 'प्रश्न लिहा आणि संवाद सुरू ठेवा.' },
      ],
    },
    languages: {
      eyebrow: 'बहुभाषिक रचना', title: 'ज्या भाषेत सोयीचे वाटते त्या भाषेत बोला.',
      body: 'जैमी इंग्रजी, हिन्दी आणि मराठीत पीक-देखभाल माहिती अधिक सुलभ करण्यासाठी तयार केली आहे. एआयची मांडणी बदलू शकते, त्यामुळे महत्त्वाचे मार्गदर्शन काळजीपूर्वक तपासा.',
    },
    telegram: {
      eyebrow: 'टेलिग्राम', title: 'जैमीला सोबत ठेवा.',
      body: 'आपले टेलिग्राम खाते सुरक्षितपणे जोडा आणि विद्यमान जैमी बॉटसोबत पीक-देखभाल संवाद सुरू ठेवा.',
      cta: 'टेलिग्राम जोडा', website: 'वेबसाइट', assistant: 'जैमी',
    },
    payment: {
      eyebrow: 'टेलिग्राम प्रवेश', title: 'सोपा प्रवेश. 7 दिवसांसाठी ₹20.',
      body: 'विद्यमान ₹20 रिचार्ज सात दिवसांसाठी जैमी टेलिग्राम बॉटचा प्रवेश सुरू करतो. लवकर रिचार्ज केल्यास सध्याची मुदत पुढे वाढते.',
      detail: 'चेकआउट आणि पेमेंट पडताळणी प्रकल्पाचा विद्यमान Razorpay प्रवाह वापरतात. पायलटमध्ये टेस्ट मोड सुरू असल्यास तो स्पष्ट दाखवला जातो.',
      cta: 'सुरू करा',
    },
    why: {
      eyebrow: 'जैमी का', title: 'शेतकऱ्यावर केंद्रित पीक-देखभाल मदत.',
      body: 'जैमी विद्यमान एआय, खाते, इतिहास आणि संदेश सेवा एका शांत उत्पादन अनुभवात आणते.',
      items: [
        { title: 'सोपी', body: 'शिकण्यासाठी गुंतागुंतीचा कृषी डॅशबोर्ड नाही.' },
        { title: 'सुलभ', body: 'फोटो, आवाज किंवा मजकुरातून विचारा.' },
        { title: 'बहुभाषिक', body: 'इंग्रजी, हिन्दी आणि मराठीसाठी तयार.' },
        { title: 'जोडलेली', body: 'वेबसाइट आणि टेलिग्राम यांदरम्यान सुरू ठेवा.' },
        { title: 'वैयक्तिक', body: 'आपला पीक-देखभाल इतिहास एका सुरक्षित कार्यक्षेत्रात ठेवा.' },
      ],
    },
    examples: {
      eyebrow: 'तुम्ही काय विचारू शकता', title: 'तुम्हाला जे दिसते तिथून सुरुवात करा.',
      body: 'हे उदाहरण प्रश्न आहेत—खात्रीशीर निदान प्रकार नाहीत.',
      items: ['माझ्या टोमॅटोच्या पानांवर तपकिरी डाग येत आहेत.', 'मिरचीची पाने पिवळी का होत आहेत?', 'या पिकावर कशाचा परिणाम होत असावा?', 'ही लक्षणे मी कशी समजून घेऊ?'],
    },
    safety: {
      eyebrow: 'जबाबदार एआय', title: 'उपयुक्त मार्गदर्शन, प्रामाणिक मर्यादांसह.',
      body: 'जैमी तुम्ही दिलेल्या माहितीवर आधारित एआय-निर्मित पीक-देखभाल मार्गदर्शन देते. विशेषतः अस्पष्ट फोटोमध्ये निकाल अनिश्चित असू शकतात. महत्त्वाच्या पीक व्यवस्थापन निर्णयांसाठी पात्र कृषितज्ज्ञ किंवा स्थानिक कृषी अधिकाऱ्यांचा सल्ला घ्या.',
    },
    final: {
      title: 'आपले पीक तपासण्यासाठी तयार आहात?', body: 'एक संवाद सुरू करा. फोटो दाखवा, बोला किंवा लिहा.',
      primary: 'सुरू करा', secondary: 'लॉग इन',
    },
    footer: {
      description: 'फोटो, आवाज आणि मजकूर संवादासाठी एआय पीक-देखभाल सहाय्यक.',
      product: 'उत्पादन', account: 'खाते', legal: 'विश्वास', privacy: 'गोपनीयता', terms: 'अटी',
      disclaimer: 'जबाबदार एआय', copyright: 'जैमी. अधिक स्पष्ट पीक-देखभाल संवादासाठी तयार.',
    },
    login: {
      eyebrow: 'आपले पीक-देखभाल कार्यक्षेत्र', visualTitle: 'प्रत्येक पीक प्रश्नासाठी एक संवाद.',
      visualBody: 'फोटो अपलोड करा, सहज बोला किंवा लिहा. आपला जैमी इतिहास Google खात्यासोबत राहतो.',
      highlights: ['विद्यमान Google प्रमाणीकरण', 'खाजगी MongoDB इतिहास', 'वेबसाइट आणि टेलिग्राम एकत्र'],
      welcome: 'जैमीमध्ये स्वागत आहे', body: 'आपले पीक-देखभाल कार्यक्षेत्र फक्त एक पाऊल दूर आहे.',
      accountNote: 'आपले खाते जैमी संवाद आणि पीक-देखभाल इतिहास एकत्र ठेवते.', back: 'मुख्यपृष्ठावर परत जा',
    },
    workspace: {
      newChat: 'नवीन संवाद', startingChat: 'सुरू होत आहे…', history: 'इतिहास', connect: 'जोडा', profile: 'माझी प्रोफाइल',
      recent: 'अलीकडील संवाद', today: 'आज', yesterday: 'काल', older: 'जुने', untitled: 'नवीन पीक संवाद',
      noHistory: 'आपले संवाद येथे दिसतील.', openMenu: 'मेनू उघडा', closeMenu: 'मेनू बंद करा',
      assistantSubtitle: 'आपला एआय पीक-देखभाल सहाय्यक', emptyTitle: 'मी तुमच्या पिकासाठी कशी मदत करू?',
      emptyBody: 'फोटो अपलोड करा, प्रश्न विचारा किंवा सहज बोला.',
      suggestions: ['एक पान तपासा', 'माझी पाने पिवळी का होत आहेत?', 'पीक समस्या समजून घेण्यास मदत करा', 'पीक रोग कसा टाळू?'],
      composerPlaceholder: 'जैमीला संदेश लिहा…', addAttachment: 'पिकाचा फोटो जोडा', uploadPhoto: 'पीक फोटो अपलोड करा',
      takePhoto: 'फोटो घ्या', removePhoto: 'निवडलेला फोटो काढा', send: 'संदेश पाठवा', cropPhoto: 'पिकाचा फोटो',
      historyTitle: 'आपला पीक-देखभाल इतिहास', historyBody: 'वेबसाइट आणि टेलिग्रामवरील अलीकडील हालचाल पहा आणि जतन केलेली तपासणी उघडा.',
      connectTitle: 'जैमी जोडा', connectBody: 'अधिकृत टेलिग्राम बॉट जोडा आणि विद्यमान ₹20 प्रवेश एकाच ठिकाणी सांभाळा.',
      connectNote: 'सार्वजनिक बॉट यूझरनेम शेअर करणे सुरक्षित आहे. बॉट टोकन, पेमेंट गुपिते आणि टेलिग्राम यूझर आयडी सर्व्हरवरच राहतात.',
      profileTitle: 'माझी प्रोफाइल', profileBody: 'आपल्या जैमी कार्यक्षेत्रात वापरले जाणारे नाव आणि भाषा सांभाळा.',
      accountTitle: 'खाते माहिती', email: 'ईमेल', signedInWithGoogle: 'Google द्वारे सुरक्षितपणे साइन इन',
      chatFailed: 'जैमी हा संदेश पूर्ण करू शकली नाही. तुमचा मसुदा येथेच आहे.', imageReady: 'फोटो पाठवण्यासाठी तयार',
      responsibleNote: 'एआय मार्गदर्शन अनिश्चित असू शकते. महत्त्वाचे निर्णय पात्र स्थानिक तज्ज्ञांकडून तपासा.',
    },
    legal: {
      privacyTitle: 'जैमीमधील गोपनीयता',
      privacyBody: [
        'जैमी आपले खाते ओळखण्यासाठी विद्यमान Google साइन-इन वापरते. संवाद, प्रोफाइल सेटिंग्ज, तपासणी नोंदी, टेलिग्राम जोडणी स्थिती आणि पेमेंट प्रवेश नोंदी विद्यमान MongoDB डेटाबेसमध्ये साठवल्या जातात.',
        'पीक फोटो आणि आवाज रेकॉर्डिंग प्रमाणित सर्व्हर मार्गांनी हाताळले जातात. डेटाबेस ओळख, प्रदाता कळा, टेलिग्राम बॉट टोकन आणि पेमेंट गुपिते ब्राउझरमध्ये उघड केली जात नाहीत.',
        'वेबसाइट आणि बॉटची हालचाल एकाच जैमी खात्याशी जोडायची असेल तेव्हाच टेलिग्राम जोडा. टेलिग्राम काढल्यावर आपले संवाद हटत नाहीत.',
      ],
      termsTitle: 'जैमीचा जबाबदारीने वापर',
      termsBody: [
        'जैमी तुम्ही दिलेल्या फोटो, आवाज आणि मजकुरावर आधारित एआय-निर्मित पीक-देखभाल माहिती देते. ती खात्रीशीर निदान किंवा उपचार परिणामाची हमी नाही.',
        'सेवा कायदेशीरपणे वापरा आणि दुसऱ्या व्यक्तीचे खाते, संवाद, मीडिया, पेमेंट माहिती किंवा जोडणी ओळख मिळवण्याचा प्रयत्न करू नका.',
        'महत्त्वाच्या उपचार, कीटकनाशक, अन्न-सुरक्षा किंवा पीक व्यवस्थापन निर्णयांसाठी पात्र कृषितज्ज्ञांकडून पडताळणी करा आणि स्थानिक नियम व उत्पादन लेबल पाळा.',
      ],
      back: 'जैमीवर परत जा',
    },
  },
} as const satisfies Record<Language, ProductCopy>;

export function productCopy(language: Language): ProductCopy {
  return COPY[language];
}

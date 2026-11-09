# VIP MASTER APK BUILDER — मोबाइल से सेटअप

यह शुरुआती MVP प्रोजेक्ट है: मोबाइल ब्राउज़र में Builder UI + Android SDK/Gradle वाला Backend।
यह HTML/ZIP को Android WebView ऐप में पैक करके **debug-signed installable APK** बनाता है।

## जरूरी सच
- यह ZIP खुद APK नहीं है; यह APK बनाने वाला source project है।
- Backend को ऐसे Linux Docker host पर चलाना होगा जहाँ Docker उपलब्ध हो और पर्याप्त RAM/डिस्क हो।
- Free hosting अक्सर Android SDK/Gradle build के लिए पर्याप्त नहीं होती या sleep/limit करती है।
- इस MVP का APK debug key से signed होता है। Play Store के लिए अलग release keystore/signing setup चाहिए।
- केवल भरोसेमंद HTML/ZIP अपलोड करें। यह MVP सार्वजनिक multi-user service के लिए production-hardened नहीं है।

## फोन से क्या करना है
1. इस ZIP को डाउनलोड करके Extract करें।
2. GitHub पर नया private repository बनाएं।
3. Extract की हुई फाइलें GitHub repository में अपलोड करें (फोन के Chrome में github.com खोलें)।
4. Backend folder को Docker-capable hosting पर deploy करें। Host पर `backend/Dockerfile` इस्तेमाल करें।
5. Hosting environment में `BUILDER_API_KEY` नाम का secret बनाएं। कम-से-कम 32 अक्षरों का random secret रखें।
6. `PORT` host अपने-आप देगा। `BUILDER_API_KEY` जरूरी है।
7. Deploy होने के बाद backend URL खोलें। मोबाइल UI `/` पर मिलेगा।
8. UI में वही API key डालें। HTML paste करें या HTML/ZIP upload करें। App name/package ID भरें और Build दबाएं।
9. सफल होने पर APK डाउनलोड होगा।

## ZIP का ढांचा
- `frontend/index.html` — मोबाइल Builder UI
- `backend/server.js` — upload और build API
- `backend/Dockerfile` — Android SDK + JDK + Node build image
- `backend/template/` — Android WebView app का source template

## ZIP upload नियम
ZIP के अंदर `index.html` root में होना चाहिए। CSS/JS/images relative paths में रख सकते हैं।
एकल HTML फाइल भी सीधे upload/paste की जा सकती है।

## Limits
- Upload limit 20 MB.
- Build timeout 5 मिनट.
- Android target SDK 35, min SDK 23.
- WebView में JavaScript enabled है। ऐप को बाहरी links खोलने के लिए WebView behavior सीमित रखा गया है।
- यह वेबसाइट/PWA builder UI है, native Builder APK नहीं। इसे फोन के Chrome में खोलकर "Add to Home screen" कर सकते हैं। Native Builder APK wrapper अगला चरण है।

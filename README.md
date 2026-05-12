# LazNote

### One Pulse. Endless Filing. Perfectly Filed.

**LazNote** is a local-first Progressive Web App (PWA) designed to bridge the gap between messy thoughts and organized action. Speak it, type it, or snap it—LazNote drops every thought into the right stack and surfaces what's burning now, without a single tag, folder, or follow-up question.

**[Launch LazNote](https://www.google.com/search?q=https://johnlaz.github.io/laznote/app/index.html)** | **[Get a Groq Key](https://console.groq.com/keys)**

---

## ⚡ The Flow: One Button. Four Steps.

Most notes apps make you do the filing. LazNote handles the logistics the moment you finish talking.

1. **Pulse:** Long-press or talk. One target, anywhere in the app.
2. **Listen:** Live transcription powered by **Whisper** via Groq.
3. **Sort:** **Llama 3 (70b)** reads context and picks the right stack automatically.
4. **Surface:** The **Blade View** ranks notes by urgency, not date. "Now" is bright; "Later" fades.

## 🧠 Core Features

* **Voice-First Capture:** Segment long rants into individual, filed cards automatically.
* **Blade Prioritization:** A home view that earns its real estate. Urgency-based ranking (Now, Soon, Idle).
* **Airlock System:** Uncertain notes sit in the Airlock with AI reasoning for a one-tap confirmation.
* **BYO Groq:** Privacy-centric AI. Use your own API key for direct browser-to-inference speed.
* **Local-First:** Data stays in your browser's IndexedDB. No accounts, no servers, no tracking.

## 🛠 Tech Stack

* **Frontend:** React / Vite (Progressive Web App)
* **Database:** Local-first IndexedDB
* **Inference:** Groq Cloud API (Whisper & Llama 3)
* **Deployment:** GitHub Pages

## 🛡 Privacy by Default

Your notes never touch a server because there aren't any.

* **0 KB** leaves your device (except for direct API calls to Groq).
* **0 Accounts.** No sign-ups required.
* **0 Cookies.** No telemetry or third-party scripts.

## 📲 Installation

LazNote is a PWA and can be installed on any device directly from the browser:

* **iOS:** Share -> Add to Home Screen
* **Android/Chrome:** Settings -> Install App
* **Desktop:** Install icon in the address bar

---

*Built for those who need to empty their head and trust the system to handle the rest.*

# Artemis

A travel AI assistant built with React + Vite. Ask anything about travel and get instant local AI-powered responses.

## Features

- Natural language travel prompt input
- AI responses powered by OpenAI (gpt-3.5-turbo)
- Persistent chat history (saved to localStorage)
- Clear prompt and clear history controls
- Loading and error states
- Animated UI with a clean dark design

## Tech Stack

- React 18 + TypeScript
- Vite
- Motion (Framer Motion)
- OpenAI API (gpt-3.5-turbo)

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/your-username/artemis-ai.git
cd artemis-ai
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your OpenAI API key

```bash
cp .env.example .env
```

Open `.env` and replace `sk-...` with your actual key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Build

```bash
npm run build
```

### Android APK

```bash
npm run android:apk                                     # signed release APK for a phone (arm64)
npm run android:apk -- -Mode debug -Target x86_64       # debug APK for the emulator
```

The APK lands in `C:\build\artemis-out`. The build runs in a local copy of the repo (`C:\build\artemis`), never inside OneDrive, and signs with a key it creates once in `%USERPROFILE%\.artemis-android`. **Back that folder up**: a newer APK can only replace an older one if it is signed with the same key. It needs Android Studio (its JDK and SDK), the Android NDK and the Rust Android targets. On the phone, Iris's daily feed comes over her Hermes gateway on Tailscale (see `CLAUDE-REPLY-android-and-event-cards.md`).

### Inana (MarketGenius) numbers

The Daily tab's Inana panels read your local MarketGenius server (`http://localhost:8080`, start it yourself). There is no login or password: `npm run inana:token` gives Artemis its own long-lived access token for your MarketGenius owner account and saves it in `%APPDATA%\com.artemis.ai\inana.json`. It skips MarketGenius's `qa-…@example.com` test accounts (add `--email you@example.com` to choose one). Run it again if Artemis ever says its access has run out.

## Notes

- Your API key is never sent anywhere except directly to the OpenAI API.
- Chat history is stored only in your browser's localStorage — nothing is persisted server-side.

---

I really enjoyed building Artemis.

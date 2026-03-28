# Spotana.AI

A travel AI assistant built with React + Vite. Ask anything about travel and get instant AI-powered responses. Built as part of the Spotnana Frontend Engineer Technical Assessment.

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
git clone https://github.com/your-username/spotana-ai.git
cd spotana-ai
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

## Notes

- Your API key is never sent anywhere except directly to the OpenAI API.
- Chat history is stored only in your browser's localStorage — nothing is persisted server-side.

---

I really enjoyed working on this assignment and I look forward to working with Spotnana!

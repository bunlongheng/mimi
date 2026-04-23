# Mimi 耳 — Live Meeting Captions

Real-time karaoke-style transcription for meetings. iMessage-style bubbles, two channels (YOU + THEM), save raw transcript, Claude AI summary.

## Setup

```bash
npm install

# Download whisper model (required for system audio)
mkdir -p models
curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin" -o models/ggml-tiny.en.bin

# Add your Anthropic API key (for Summarize feature)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local

npm start
# → http://localhost:5757
```

## Requirements

- macOS (uses whisper-cli + ffmpeg for system audio)
- Chrome or Safari (Web Speech API)
- `brew install whisper-cpp ffmpeg`

## Features

- **Start Listening** — mic transcription (YOU, blue bubbles)
- **Capture System Audio** — share a tab/window to transcribe meeting audio (THEM, green bubbles)
- **Save** — raw transcript to Desktop
- **Summarize** — Claude API summary with action items + decisions

## Auto-start (macOS)

```bash
cp com.mimi.captions.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mimi.captions.plist
```

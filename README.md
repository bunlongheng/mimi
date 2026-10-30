# Mimi 耳

Live meeting transcription - karaoke captions + AI summary. Tap the mic once and Mimi listens on two channels at the same time: your voice through the browser, and everyone else's through the Mac's system audio.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-http%20server-339933?logo=node.js&logoColor=white)
![Swift](https://img.shields.io/badge/Swift-MimiBar-F05138?logo=swift&logoColor=white)
![whisper.cpp](https://img.shields.io/badge/whisper.cpp-ggml--tiny.en-4b5563)
![Claude](https://img.shields.io/badge/Claude-Sonnet%204.6-D97757?logo=anthropic&logoColor=white)
![platform](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)

## Features

- **Tap to start, both channels at once** - one tap grabs the mic and starts server-side system audio capture; no separate screen-share picker.
- **Karaoke-style live captions** - the last-recognized word pulses in the bottom bar as you speak, then lands as an iMessage-style bubble (blue = YOU, gray = THEM).
- **Two independent transcription engines** - YOU runs on the browser's Web Speech API (instant, no model download); THEM runs on-device through whisper.cpp for anything the system plays (Slack calls, Teams, YouTube).
- **Hallucination filtering** - strips whisper's bracketed noise artifacts (e.g. `(mumbling)`) before a line ever reaches the transcript.
- **Claude-generated meeting summary** - one click sends the merged transcript to Claude (`claude-sonnet-4-6`) and gets back a Summary / Action Items / Key Decisions writeup.
- **Save, copy, download** - the raw transcript writes straight to `~/Desktop`, or copies/downloads from the browser if the save endpoint is unreachable.
- **In-app setup and preflight checks** - live status for mic permission, screen-recording permission, whisper model presence, and Anthropic key, each with a one-tap fix (opens the right System Preferences pane, or an inline key field that writes `.env.local`).
- **MimiBar menu bar app** - a small Swift `NSStatusItem` app that polls the server every 4s and shows idle / capturing / stopped as a colored ear icon, with Open Mimi and Quit in its menu.
- **Launch at login** - `launchd` plists for both the transcription server and the menu bar app.

## How it works

Mimi runs two transcription paths in parallel and merges them into one timeline:

```mermaid
flowchart LR
    Mic["Browser mic"] -->|Web Speech API, live| YouBubbles["YOU bubbles (blue)"]

    SysAudio["System audio\n(Core Audio tap)"] -->|AudioTee| PCM["PCM buffered 4s"]
    PCM -->|ffmpeg: 48kHz stereo -> 16kHz mono| WAV["16kHz WAV"]
    WAV -->|whisper-cli + ggml-tiny.en| Text["Transcribed text"]
    Text -->|SSE /api/stream/them| ThemBubbles["THEM bubbles (gray)"]

    YouBubbles --> Transcript["Merged transcript"]
    ThemBubbles --> Transcript
    Transcript -->|POST /api/summary| Claude["Claude API\nclaude-sonnet-4-6"]
    Claude --> Summary["Summary + Action Items + Decisions"]
```

The server (`server.js`) is a single Node process with no framework: it serves `index.html`, keeps an `AudioTee` capture running continuously, and every 4 seconds pipes whatever system audio it buffered through `ffmpeg` (resample) and `whisper-cli` (transcribe), then pushes the result to the browser over Server-Sent Events. The mic channel never touches the server - `SpeechRecognition` runs entirely client-side in Chrome or Safari.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serves the single-page UI (`index.html`) |
| GET | `/api/stream/them` | SSE - pushes THEM (system audio) transcriptions as they finish |
| GET | `/api/session/status` | `capturing`, `modelReady`, `apiKeySet`, `audioTeeActive`, `uptime` - polled by MimiBar |
| POST | `/api/session/update` | Starts/stops the system-audio transcribe loop |
| POST | `/api/transcribe` | One-off webm -> wav -> whisper transcribe (mic fallback path) |
| POST | `/api/summary` | Sends the merged transcript to Claude, returns the summary |
| POST | `/api/save` | Writes a transcript to `~/Desktop` |
| GET | `/api/model-status` | Whether the whisper model file is present and large enough |
| POST | `/api/set-key` | Writes `ANTHROPIC_API_KEY` to `.env.local` from the in-app settings modal |
| POST | `/api/open-prefs` | Opens the macOS Privacy pane for microphone or screen recording |

## Tech stack

| Layer | Choice |
|-------|--------|
| Server | Plain Node.js `http` module, no framework (`server.js`) |
| YOU channel | Browser `SpeechRecognition` (Web Speech API) - client-side only |
| THEM channel | [`audiotee`](https://www.npmjs.com/package/audiotee) (Core Audio tap) -> `ffmpeg` (resample) -> `whisper-cli` with the `ggml-tiny.en` model ([whisper.cpp](https://github.com/ggerganov/whisper.cpp)) |
| Realtime push | Server-Sent Events (`/api/stream/them`) |
| AI summary | `@anthropic-ai/sdk`, model `claude-sonnet-4-6` |
| Frontend | One `index.html`, vanilla JS, no build step |
| Menu bar app | Swift (`MimiBar.swift`), `NSStatusItem`, polls `/api/session/status` every 4s |
| Persistence | None - transcripts write straight to `~/Desktop`; no database |
| Service | macOS `launchd` (`com.mimi.captions.plist` for the server, `com.mimi.menubar.plist` for MimiBar) |
| License | MIT |

## Getting started

Requirements: macOS, Chrome or Safari (Web Speech API), `whisper-cli` + `ffmpeg`.

```bash
git clone https://github.com/bunlongheng/mimi.git
cd mimi
npm install

brew install whisper-cpp ffmpeg

# whisper.cpp model for system audio transcription (~75MB)
mkdir -p models
curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin" -o models/ggml-tiny.en.bin

# Anthropic key, for the Summarize feature
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local

npm start
# → http://localhost:5757
```

`./start.sh` does the same `npm install` check, then opens the browser and starts the server in one step. First run will prompt for microphone and screen-recording permission (System Preferences > Privacy) - the in-app Settings panel shows the status of each requirement and links straight to the right pane if something is missing.

### MimiBar (menu bar status app)

A prebuilt `MimiBar` binary is checked into the repo. To rebuild it from `MimiBar.swift`:

```bash
swiftc MimiBar.swift -o MimiBar -framework Cocoa
```

### Launch at login

```bash
# transcription server
cp com.mimi.captions.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mimi.captions.plist

# menu bar app
cp com.mimi.menubar.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mimi.menubar.plist
```

Both plists point at a fixed `~/Sites/mimi` path and a specific user's home directory - edit the `ProgramArguments`, `WorkingDirectory`, and log paths to match your machine before loading them.

---

<div align="center">

<a href="https://bunlongheng.com"><img src="https://img.shields.io/badge/-bunlongheng.com-3A3A3C?style=for-the-badge&amp;labelColor=2A2A2C&amp;logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y%2BmAAADAFBMVEXx8vLq6v%2F19fX09PT8%2Ff309PT5%2BfnAwMBMaXHx8vL19fX5%2Bfny8vL09PT39%2Ff6%2Bfn6%2Bvr09PTx8fH4%2BPn%2F8vLy8%2FP09PTz8%2FPy8vL%2F%2F%2F%2Fz9PTz9PP19fby8vP19PXz8%2FT19%2Fb08%2FTx8vLy8vL09vby8%2FL29vf19fTv8PDz9vb7%2Bvn%2F%2Ff%2F9%2Ff3w8vH29fb%2F%2FP339%2Ff5%2Bfn59%2Ff19PT09PR7rao3VF3%2F%2Fv8AKDR6sqsBV1vv8fL4%2BPiux8b8%2Bvq90NDy8%2FR%2BlpppnZyZqrACLTxclZJSkI9en5ssZ2luqaUAeWgqbW4BX1gCfG0%2Fa3QaVG0MN0UKNUKUpKsGpYMAKjoRQ1UDf3AQRloJqIgEm32d0cUBg3ElbnQIln8eVWgrmIdP0KzF5d5s2acdfHwppJCP5MMXl4Tz8%2FLv8%2FP39%2FiewL5%2BqahYf4IrTFZkk5KlxsREiIYAHiqDnKFmnJowc3IdVllvpKK7zc3D2tnk5%2BmuycdwpKKuub2yv8Ly%2B%2FkAMT7z%2Bvjq7e09gH93q6kGdWpGgoJZmJSlw8M7c3WwyceTw76w1M8mYmpFfX8lW2AFOEpGiYhxqqRrqaRb2rdIsZ8AVE91jpU7d3t3saqBoKhako4AWVEcUlg3aWwDupAHb2YwmIkPP1ERSVA7WmZ8tq8HT14oZW%2BYuLsMl3wQT10ROksENUc8Z3MJSGVLh4dqpJ%2BXr7U51awUgHM4v6ad1MkPuJZAiowVd3IEhnZH0aoYrI05p5sDtYwkzZ8EPViYxsRel5USbHAIgmwIM0gQamzU4uF2malQi4oWQFQ1zaYrp4UXlYwfiHoyxqFE1q4qeX4yn5JIxKkdrX1b1rAbWGvd5Oh91sRijpomsJEVc3Ukc34dqIcwuJVKwZIXkoQZcXlNv5g%2BqZUZvpNl2rPG9N0WkIoNqouW4sVPwp%2BM0b6h0ssfq4d%2F1r8hpo%2Fh9e4AamUjnI9avaBixqgklYWSwL4xtItUxplYl5qZ58mq78wMgnYXfnlOmJaR1L%2Bj78ny9fS%2FrXQPAAAAFXRSTlP7Brvx%2FsJhAgD87r4U72C4uGH8vhRDodYHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAC6UlEQVQokS2Sd3BUVRSHb0KS3QRCiZw5t%2By9j33zXjZkyUs2uekhEAi9dwRCL4JUEQRFAQUs9A4WOopKU0GpFoqCBZUivaqoFKkWLIS5GX7%2FfnPO78yZj%2Fj8UTViK6HggvNgSGuluEZRKbZqlN9H%2FFWiWUzIFQK5fhjOIRTDoqv4ia86S4q3KSByHdSqIhxofBKr5iNxLMm2bQqWVkorJ%2BAkO46nkQJhceSRmCTDvKJIJBLJzMxMLU6POJ4eBPF1KpNEbdt2Cms4LCcnZ%2FX6D3d%2BsKJJ7VSlNLoqgbjUtmkKKxlVmpf3bsFXW3d1b77gueJAQIPQBCilkMKemNi23Ts9T35%2FaMe2rsvmTypylGUFCSIYWJLXrm2nUwOPfNO5w%2B73Okxnjqe0JigQEL3JizoeONr%2F2u99vju4fd1rdZnyspQmnGvAUBprWNqz348%2FhXN%2F6P1%2By4Uvs%2FJkpRQRwpJBRVn7vf16Dfitz5XevQqWt3yalXtKaRIUQmglWfsu5y7%2BMrDs0TMftWo1ZVy64xioOVpcIdt8%2Fvqvf9%2F859KJsrLmrzA%2BOKC0IkFEtJza7JOfr%2FYd0P9G98tdOxe0Hp9qJrOIBgDuOeEtp%2F%2B4d%2FvWX%2F%2F9u%2B%2FtlaUTmOWZg7SQEEyuFe52%2BML9O3cZO%2F5xl06zn2VcadOJUqJTzt7a82XfP7sx9vmGNm1m1MstV4IHCVAAoTLqL1372ddn%2Fz%2B2v%2FWq12c1fSpsaeQWAZAANntxzuI3e3zbo8XGpm%2FMnNqiXrh%2BljaPd6UUabkjps19tdGnX2zKb9b4pTFDCzOMLmYtpW5h%2BpCRTeYtyV%2BT36zx808OL4xYGoFrkqDTbJpSXLdRgwbPZL%2BQnT129OOPFVEEsAMJpHKdeKMJgJSAiALdjJANQKnRJI4R6boAKEwLCiGoBBegQjBftQo1KQWOlplFKSV9qGaF1NpAE7QQESTlMSy6pp%2F4%2FFFVYxMNRBTaiM0tkImxNaL8vgfDR8gvoYRaxgAAAABJRU5ErkJggg%3D%3D" alt="bunlongheng.com"></a>
<a href="https://www.linkedin.com/in/bunlongheng/"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"></a>
<a href="https://www.instagram.com/ibunlong/"><img src="https://img.shields.io/badge/Instagram-C13584?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram"></a>
<a href="mailto:bheng.code@gmail.com"><img src="https://img.shields.io/badge/Email-2E7D32?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"></a>

<br>

Built by **[Bunlong](https://bunlongheng.com)** &nbsp;&middot;&nbsp; [more apps](https://bunlongheng.com/projects)

</div>

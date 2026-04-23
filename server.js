const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const PORT    = 5757;
const MODEL   = path.join(__dirname, 'models/ggml-tiny.en.bin');
const WHISPER = '/opt/homebrew/bin/whisper-cli';
const FFMPEG  = '/opt/homebrew/bin/ffmpeg';

const session = { capturing: false, startedAt: null };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── SSE clients ────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(text) {
  const msg = `data: ${JSON.stringify({ text })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// ── Server-side system audio capture (AudioTee — no browser picker needed) ─
let audioTee    = null;
let pcmChunks   = [];
let captureLoop = null;
const modelReady = () => fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1_000_000;

function startAudioCapture() {
  if (audioTee) return;
  try {
    const { AudioTee } = require('audiotee');
    audioTee = new AudioTee();
    audioTee.on('data', chunk => { if (session.capturing) pcmChunks.push(chunk.data); });
    audioTee.on('error', e => console.error('AudioTee:', e.message));
    audioTee.start();
    console.log('耳  System audio capture started (AudioTee)');
  } catch (e) {
    console.error('耳  AudioTee failed:', e.message);
  }

  captureLoop = setInterval(async () => {
    if (!session.capturing || !modelReady() || pcmChunks.length < 10) {
      pcmChunks = [];
      return;
    }
    const pcm = Buffer.concat(pcmChunks);
    pcmChunks = [];

    const tmpPcm = path.join(os.tmpdir(), `mimi-sys-${Date.now()}.raw`);
    const tmpWav = path.join(os.tmpdir(), `mimi-sys-${Date.now()}.wav`);
    try {
      fs.writeFileSync(tmpPcm, pcm);
      // AudioTee: f32le stereo 48kHz → 16kHz mono s16 for whisper
      execSync(
        `"${FFMPEG}" -y -f f32le -ar 48000 -ac 2 -i "${tmpPcm}" -ar 16000 -ac 1 -sample_fmt s16 "${tmpWav}" 2>/dev/null`,
        { timeout: 10000 }
      );
      const raw = execSync(`"${WHISPER}" -m "${MODEL}" -f "${tmpWav}" -np -nt 2>/dev/null`, { timeout: 30000 }).toString();
      const text = raw.split('\n').map(l => l.replace(/^\[.*?\]\s*/, '').trim()).filter(Boolean).join(' ').trim();
      if (text) {
        console.log('耳  [them]', text.slice(0, 80));
        broadcast(text);
      }
    } catch {}
    finally {
      try { fs.unlinkSync(tmpPcm); } catch {}
      try { fs.unlinkSync(tmpWav); } catch {}
    }
  }, 4000);
}

function stopAudioCapture() {
  if (captureLoop) { clearInterval(captureLoop); captureLoop = null; }
  if (audioTee)    { try { audioTee.stop(); } catch {} audioTee = null; }
  pcmChunks = [];
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = req.url.split('?')[0];

  // Serve UI
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  // SSE — browser subscribes to receive "them" transcriptions
  if (req.method === 'GET' && url === '/api/stream/them') {
    res.writeHead(200, {
      ...cors,
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Session status
  if (req.method === 'GET' && url === '/api/session/status') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      capturing: session.capturing,
      modelReady: modelReady(),
      apiKeySet: !!(process.env.ANTHROPIC_API_KEY?.startsWith('sk-')),
      uptime: process.uptime(),
      audioTeeActive: !!audioTee,
    }));
    return;
  }

  // Update session state — starts/stops server-side audio capture
  if (req.method === 'POST' && url === '/api/session/update') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const { capturing } = JSON.parse(body);
      session.capturing  = capturing;
      session.startedAt  = capturing ? (session.startedAt || Date.now()) : null;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Open macOS System Preferences
  if (req.method === 'POST' && url === '/api/open-prefs') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const { type } = JSON.parse(body);
      const map = {
        microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        screen:     'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      };
      try {
        execSync(`open "${map[type] || 'x-apple.systempreferences:'}"`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Set API key
  if (req.method === 'POST' && url === '/api/set-key') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const { key } = JSON.parse(body);
      if (!key?.startsWith('sk-ant-')) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Must start with sk-ant-' }));
        return;
      }
      fs.writeFileSync(path.join(__dirname, '.env.local'), `ANTHROPIC_API_KEY=${key}\n`);
      process.env.ANTHROPIC_API_KEY = key;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Model status
  if (req.method === 'GET' && url === '/api/model-status') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: modelReady() }));
    return;
  }

  // Transcribe audio chunk (mic fallback / manual use)
  if (req.method === 'POST' && url === '/api/transcribe') {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '' })); return;
      }
      const tmpIn  = path.join(os.tmpdir(), `mimi-${Date.now()}.webm`);
      const tmpWav = path.join(os.tmpdir(), `mimi-${Date.now()}.wav`);
      try {
        fs.writeFileSync(tmpIn, buf);
        execSync(`"${FFMPEG}" -y -i "${tmpIn}" -ar 16000 -ac 1 -sample_fmt s16 "${tmpWav}" 2>/dev/null`, { timeout: 10000 });
        const raw = execSync(`"${WHISPER}" -m "${MODEL}" -f "${tmpWav}" -np -nt 2>/dev/null`, { timeout: 30000 }).toString();
        const text = raw.split('\n').map(l => l.replace(/^\[.*?\]\s*/, '').trim()).filter(Boolean).join(' ').trim();
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpWav); } catch {}
      }
    });
    return;
  }

  // Save transcript
  if (req.method === 'POST' && url === '/api/save') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { transcript, filename } = JSON.parse(body);
        const dest = path.join(process.env.HOME, 'Desktop', filename);
        fs.writeFileSync(dest, transcript, 'utf8');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: dest }));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Claude summary
  if (req.method === 'POST' && url === '/api/summary') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { transcript } = JSON.parse(body);
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 2048,
          messages: [{ role: 'user', content: `Analyze this meeting transcript:\n\n## Summary\n3-5 bullet points.\n\n## Action Items\nWho + what. "None" if none.\n\n## Key Decisions\n"None" if none.\n\nTranscript:\n${transcript}` }],
        });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: msg.content[0].text }));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, cors); res.end('Not found');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`耳  Mimi already running on :${PORT}`); process.exit(1); }
  else throw e;
});

server.listen(PORT, () => {
  console.log(`\n耳  Mimi → http://localhost:${PORT}`);
  console.log(`   model : ${modelReady() ? '✓ ready' : '⚠ missing'}`);
  console.log(`   ffmpeg: ${fs.existsSync(FFMPEG) ? '✓ ready' : '✗ missing'}\n`);
  startAudioCapture(); // always-on system audio — no browser picker needed
});

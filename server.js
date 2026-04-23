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

// In-memory session state (menu bar polls this)
const session = { capturing: false, startedAt: null };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── Serve UI ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  // ── Session status (menu bar + preflight) ─────────────────────────────
  if (req.method === 'GET' && url === '/api/session/status') {
    const modelReady = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1_000_000;
    const apiKeySet  = !!(process.env.ANTHROPIC_API_KEY?.startsWith('sk-'));
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ capturing: session.capturing, modelReady, apiKeySet, uptime: process.uptime() }));
    return;
  }

  // ── Update session state (browser → server) ────────────────────────────
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

  // ── Open macOS System Preferences ──────────────────────────────────────
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

  // ── Set API key inline ─────────────────────────────────────────────────
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

  // ── Model status ───────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/model-status') {
    const ready = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1_000_000;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready }));
    return;
  }

  // ── Transcribe audio chunk ─────────────────────────────────────────────
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

  // ── Save transcript ────────────────────────────────────────────────────
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

  // ── Claude summary ─────────────────────────────────────────────────────
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
  const modelReady = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1_000_000;
  console.log(`\n耳  Mimi → http://localhost:${PORT}`);
  console.log(`   model : ${modelReady ? '✓ ready' : '⚠ missing (download needed)'}`);
  console.log(`   ffmpeg: ${fs.existsSync(FFMPEG) ? '✓ ready' : '✗ missing (brew install ffmpeg)'}\n`);
});

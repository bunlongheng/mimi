const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const PORT = 5757;
const MODEL = path.join(__dirname, 'models/ggml-tiny.en.bin');
const WHISPER = '/opt/homebrew/bin/whisper-cli';
const FFMPEG  = '/opt/homebrew/bin/ffmpeg';

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  // ── Serve UI ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Model status ───────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/model-status') {
    const ready = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1000000;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready, model: MODEL }));
    return;
  }

  // ── Transcribe audio chunk (system audio via getDisplayMedia) ──────────
  if (req.method === 'POST' && req.url === '/api/transcribe') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '' }));
        return;
      }

      const tmpIn  = path.join(os.tmpdir(), `mimi-${Date.now()}.webm`);
      const tmpWav = path.join(os.tmpdir(), `mimi-${Date.now()}.wav`);

      try {
        fs.writeFileSync(tmpIn, buf);

        // Convert to 16kHz mono WAV
        execSync(`"${FFMPEG}" -y -i "${tmpIn}" -ar 16000 -ac 1 -sample_fmt s16 "${tmpWav}" 2>/dev/null`, { timeout: 10000 });

        // Transcribe
        const raw = execSync(
          `"${WHISPER}" -m "${MODEL}" -f "${tmpWav}" -np -nt 2>/dev/null`,
          { timeout: 30000 }
        ).toString();

        // Strip timestamp lines, clean up
        const text = raw
          .split('\n')
          .map(l => l.replace(/^\[.*?\]\s*/, '').trim())
          .filter(l => l && !l.startsWith('[') && l !== '')
          .join(' ')
          .trim();

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
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', c => body += c);
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
  if (req.method === 'POST' && req.url === '/api/summary') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { transcript } = JSON.parse(body);
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: `Analyze this meeting transcript and return three sections:\n\n## Summary\n3-5 bullet points of main topics.\n\n## Action Items\nBullet list (who + what). Write "None identified" if none.\n\n## Key Decisions\nBullet list. Write "None identified" if none.\n\nTranscript:\n${transcript}`,
          }],
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

  res.writeHead(404, cors);
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n耳  Mimi already running on port ${PORT} — not starting a second instance.\n`);
    process.exit(1);
  } else {
    throw e;
  }
});

server.listen(PORT, () => {
  const modelReady = fs.existsSync(MODEL) && fs.statSync(MODEL).size > 1000000;
  console.log(`\n耳  Mimi → http://localhost:${PORT}`);
  console.log(`   Whisper model: ${modelReady ? 'ready' : 'still downloading...'}`);
  console.log(`   ffmpeg: ${fs.existsSync(FFMPEG) ? 'ready' : 'missing'}\n`);
});

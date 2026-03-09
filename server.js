'use strict';
const express  = require('express');
const multer   = require('multer');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── CORS — set manually on EVERY response ──────────────────────────────────
// Render's proxy strips cors() middleware headers on error responses (502 etc).
// Hardcoding headers in a global middleware is the only reliable fix.
const ALLOWED_ORIGINS = [
  'https://tonymcsauce.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function setCors(req, res) {
  const origin  = req.headers.origin;
  const allowed = !origin || ALLOWED_ORIGINS.includes(origin);
  res.set('Access-Control-Allow-Origin',   allowed ? (origin || '*') : 'null');
  res.set('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers',  'Content-Type, Accept, X-Requested-With');
  res.set('Access-Control-Expose-Headers', 'Content-Disposition');
  res.set('Vary', 'Origin');
}

// Answer preflight immediately — before Render proxy can interfere
app.options('*', (req, res) => {
  setCors(req, res);
  res.set('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// Inject CORS on every request
app.use((req, res, next) => { setCors(req, res); next(); });
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ── Streaming converter ───────────────────────────────────────────────────
// Render free tier kills idle connections after ~25s.
// Fix: open a chunked stream immediately and send a space byte every 5s
// while Python converts. This keeps Render's proxy from issuing a 502.
// Response is a single JSON object at the end containing base64 file data.
function convertWithKeepAlive(req, res, type, ext) {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ ok: false, error: 'PDF files only.' });
  }

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), `pdf${type}-`));
  const inFile  = path.join(tmpDir, 'input.pdf');
  const outFile = path.join(tmpDir, `output.${ext}`);

  console.log(`[${type}] ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
  fs.writeFileSync(inFile, req.file.buffer);

  // Open a chunked stream so Render proxy sees data flowing right away
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx buffering on Render
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();                           // push headers to client NOW

  // Heartbeat: write a space every 5 seconds to prevent idle timeout
  const heartbeat = setInterval(() => {
    try { res.write(' '); } catch (_) { clearInterval(heartbeat); }
  }, 5000);

  const cmd = `python3 "${path.join(__dirname, 'convert.py')}" ${type} "${inFile}" "${outFile}"`;
  console.log(`[cmd] ${cmd}`);

  exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
    clearInterval(heartbeat);
    if (stdout) console.log(`[stdout] ${stdout}`);
    if (stderr) console.log(`[stderr] ${stderr}`);

    if (err || !fs.existsSync(outFile)) {
      const errMsg = stderr?.trim() || err?.message || 'Conversion failed';
      console.error(`[error] ${errMsg}`);
      cleanup(tmpDir);
      res.end(JSON.stringify({ ok: false, error: errMsg }));
      return;
    }

    try {
      const fileBytes = fs.readFileSync(outFile);
      // Sanitize filename — decode buffer as latin1 to preserve bytes,
      // then re-encode properly. Also strip non-ASCII for safe Content-Disposition.
      const rawName   = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const safeName  = rawName.replace(/\.pdf$/i, `.${ext}`);
      cleanup(tmpDir);

      // Send the file as base64 inside JSON — avoids binary streaming issues
      const payload = JSON.stringify({
        ok:       true,
        filename: safeName,
        mime:     MIME[ext],
        data:     fileBytes.toString('base64'),
      });
      res.end(payload);
      console.log(`[done] ${safeName} (${(fileBytes.length / 1024).toFixed(1)} KB)`);
    } catch (readErr) {
      cleanup(tmpDir);
      res.end(JSON.stringify({ ok: false, error: readErr.message }));
    }
  });
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PDF Studio Server', version: '3.0.0' });
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/convert/word',  upload.single('file'), (req, res) => {
  convertWithKeepAlive(req, res, 'word', 'docx');
});

app.post('/convert/excel', upload.single('file'), (req, res) => {
  convertWithKeepAlive(req, res, 'excel', 'xlsx');
});

app.post('/convert/pptx', (req, res) => {
  res.status(501).json({ ok: false, error: 'PDF to PowerPoint coming soon.' });
});

// ── Encrypt PDF ────────────────────────────────────────────────────────────
app.post('/encrypt', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ ok: false, error: 'PDF files only.' });

  const userPwd  = (req.body.userPassword  || '').trim();
  const ownerPwd = (req.body.ownerPassword || userPwd).trim();
  if (!userPwd) return res.status(400).json({ ok: false, error: 'User password required.' });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfenc-'));
  const inFile  = path.join(tmpDir, 'input.pdf');
  const outFile = path.join(tmpDir, 'encrypted.pdf');
  fs.writeFileSync(inFile, req.file.buffer);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(' '); } catch (_) { clearInterval(heartbeat); }
  }, 5000);

  const scriptPath = path.join(__dirname, 'convert.py');
  // Pass passwords as JSON-escaped CLI args — safe for all special chars
  const cmd = `python3 "${scriptPath}" encrypt "${inFile}" "${outFile}" ${JSON.stringify(userPwd)} ${JSON.stringify(ownerPwd)}`;

  exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
    clearInterval(heartbeat);
    if (err || !fs.existsSync(outFile)) {
      cleanup(tmpDir);
      res.end(JSON.stringify({ ok: false, error: stderr?.trim() || err?.message || 'Encryption failed' }));
      return;
    }
    try {
      const fileBytes = fs.readFileSync(outFile);
      cleanup(tmpDir);
      res.end(JSON.stringify({ ok: true, data: fileBytes.toString('base64'), filename: 'protected.pdf', mime: 'application/pdf' }));
    } catch (e) {
      cleanup(tmpDir);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PDF Studio Server v3 running on port ${PORT}`);
});

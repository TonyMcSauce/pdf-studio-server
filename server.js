'use strict';
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── CORS — must be first, before everything else ──
const ALLOWED_ORIGINS = [
  'https://tonymcsauce.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  exposedHeaders: ['Content-Disposition'],
  credentials: false,
  optionsSuccessStatus: 200, // IE11 chokes on 204
};

// Handle ALL OPTIONS preflight requests immediately — before multer, before anything
app.options('*', (req, res) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.set('Access-Control-Max-Age', '86400'); // cache preflight for 24h
  res.sendStatus(200);
});

app.use(cors(corsOptions));
app.use(express.json());

// ── Keep-alive ping endpoint (call from frontend every 10 min to prevent spin-down) ──
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));


function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'PDF Studio Server', version: '2.0.0' }));

app.get('/test', (req, res) => {
  exec('python3 --version && python3 -c "import pdf2docx; print(\'pdf2docx ok\')"', (err, stdout, stderr) => {
    res.json({ ok: !err, python: stdout.trim(), error: err?.message, stderr: stderr?.trim() });
  });
});

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

app.post('/convert/word', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'PDF only.' });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfword-'));
  const inFile  = path.join(tmpDir, 'input.pdf');
  const outFile = path.join(tmpDir, 'output.docx');

  console.log(`[word] ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB)`);
  fs.writeFileSync(inFile, req.file.buffer);

  const cmd = `python3 "${path.join(__dirname, 'convert.py')}" word "${inFile}" "${outFile}"`;
  console.log(`[cmd] ${cmd}`);

  exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
    console.log(`[stdout] ${stdout}`);
    if (stderr) console.log(`[stderr] ${stderr}`);
    if (err || !fs.existsSync(outFile)) {
      cleanup(tmpDir);
      return res.status(500).json({ error: stderr?.trim() || err?.message || 'Conversion failed' });
    }
    const result = fs.readFileSync(outFile);
    const outName = req.file.originalname.replace(/\.pdf$/i, '.docx');
    cleanup(tmpDir);
    res.set({ 'Content-Type': MIME.docx, 'Content-Disposition': `attachment; filename="${outName}"`, 'Content-Length': result.length });
    res.send(result);
    console.log(`[done] ${outName} (${(result.length/1024).toFixed(1)} KB)`);
  });
});

app.post('/convert/excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'PDF only.' });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfexcel-'));
  const inFile  = path.join(tmpDir, 'input.pdf');
  const outFile = path.join(tmpDir, 'output.xlsx');

  console.log(`[excel] ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} KB)`);
  fs.writeFileSync(inFile, req.file.buffer);

  const cmd = `python3 "${path.join(__dirname, 'convert.py')}" excel "${inFile}" "${outFile}"`;
  console.log(`[cmd] ${cmd}`);

  exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
    console.log(`[stdout] ${stdout}`);
    if (stderr) console.log(`[stderr] ${stderr}`);
    if (err || !fs.existsSync(outFile)) {
      cleanup(tmpDir);
      return res.status(500).json({ error: stderr?.trim() || err?.message || 'Conversion failed' });
    }
    const result = fs.readFileSync(outFile);
    const outName = req.file.originalname.replace(/\.pdf$/i, '.xlsx');
    cleanup(tmpDir);
    res.set({ 'Content-Type': MIME.xlsx, 'Content-Disposition': `attachment; filename="${outName}"`, 'Content-Length': result.length });
    res.send(result);
    console.log(`[done] ${outName}`);
  });
});

app.post('/convert/pptx', upload.single('file'), (req, res) => {
  res.status(501).json({ error: 'PDF to PowerPoint coming soon. Use PDF to Word for now.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF Studio Server v2 running on port ${PORT}`);
});

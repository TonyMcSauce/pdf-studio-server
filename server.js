const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow requests from your GitHub Pages / any frontend
// Change this to your actual frontend URL once deployed, e.g.:
// 'https://yourusername.github.io'
const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  /\.github\.io$/,        // any github pages site
  /\.netlify\.app$/,      // netlify
  /\.vercel\.app$/,       // vercel
];
app.use(cors({
  origin(origin, cb) {
    // allow non-browser tools (curl, Postman) and matched origins
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.some(p =>
      typeof p === 'string' ? origin.startsWith(p) : p.test(origin)
    );
    cb(ok ? null : new Error('CORS blocked'), ok);
  }
}));

app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PDF Studio Server', version: '1.0.0' });
});

// ── LIBREOFFICE DETECTION ─────────────────────────────────────────────────────
function getLibreOfficePath() {
  // Try these in order — Docker container has it at /usr/bin/libreoffice
  const candidates = [
    '/usr/bin/libreoffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    'libreoffice',
    'soffice',
  ];
  for (const p of candidates) {
    try {
      if (p.startsWith('/') && fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return candidates[0]; // fallback
}

// ── CONVERT HELPER ────────────────────────────────────────────────────────────
function convertWithLibreOffice(pdfBuffer, format) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfconv-'));
    const inFile  = path.join(tmpDir, 'input.pdf');
    const outFile = path.join(tmpDir, `input.${format}`);

    // Ensure temp dir is fully writable
    fs.chmodSync(tmpDir, 0o777);
    fs.writeFileSync(inFile, pdfBuffer);

    // Use a separate output dir so LibreOffice has a clean writable target
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir, { mode: 0o777 });

    const profileDir = path.join(tmpDir, 'lo-profile');
    fs.mkdirSync(profileDir, { mode: 0o777 });

    const lo = getLibreOfficePath();
    const loEnv = `-env:UserInstallation=file://${profileDir}`;

    let cmd;
    if (format === 'pptx') {
      cmd = `${lo} --headless ${loEnv} --infilter=impress_pdf_import --convert-to pptx --outdir "${outDir}" "${inFile}"`;
    } else if (format === 'xlsx') {
      cmd = `${lo} --headless ${loEnv} --convert-to "xlsx:Calc MS Excel 2007 XML" --outdir "${outDir}" "${inFile}"`;
    } else {
      cmd = `${lo} --headless ${loEnv} --convert-to "docx:MS Word 2007 XML" --outdir "${outDir}" "${inFile}"`;
    }

    console.log(`[cmd] ${cmd}`);

    exec(cmd, { 
      timeout: 120000, 
      env: { 
        ...process.env, 
        HOME: tmpDir,
        JAVA_HOME: process.env.JAVA_HOME || '/usr/lib/jvm/default-java',
      } 
    }, (err, stdout, stderr) => {
      console.log(`[stdout] ${stdout}`);
      if (stderr) console.log(`[stderr] ${stderr}`);

      if (err) {
        cleanup(tmpDir);
        return reject(new Error(`LibreOffice error: ${stderr || err.message}`));
      }

      // Scan outDir for the converted file (skip directories)
      let outActual = null;
      try {
        const files = fs.readdirSync(outDir).filter(f => {
          const full = path.join(outDir, f);
          return fs.statSync(full).isFile();
        });
        console.log(`[output files] ${files.join(', ') || 'none'}`);
        if (files.length > 0) outActual = path.join(outDir, files[0]);
      } catch (e) {
        console.error(`[scan error] ${e.message}`);
      }

      if (!outActual || !fs.existsSync(outActual)) {
        cleanup(tmpDir);
        return reject(new Error('Conversion produced no output file. The PDF may be scanned/image-only or corrupted.'));
      }

      const result = fs.readFileSync(outActual);
      cleanup(tmpDir);
      resolve(result);
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── MIME TYPES ────────────────────────────────────────────────────────────────
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ── TEST ENDPOINT ─────────────────────────────────────────────────────────────
// GET /test — checks LibreOffice is installed and returns its version
app.get('/test', (req, res) => {
  const lo = getLibreOfficePath();
  exec(`${lo} --version`, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        ok: false,
        error: err.message,
        stderr,
        tried: lo,
      });
    }
    res.json({
      ok: true,
      libreoffice: stdout.trim(),
      path: lo,
    });
  });
});

// ── TEST CONVERT ──────────────────────────────────────────────────────────────
// GET /test-convert — runs a real conversion with a minimal PDF, shows all output
app.get('/test-convert', (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftest-'));
  const inFile = path.join(tmpDir, 'input.pdf');
  const profileDir = path.join(tmpDir, 'lo-profile');
  fs.mkdirSync(profileDir);

  // Minimal valid single-page PDF with text
  const minPdf = Buffer.from(
    '255044462d312e340a31203020' +
    '6f626a3c3c2f547970652f4361' +
    '74616c6f672f5061676573203220' +
    '3020523e3e656e646f626a0a32' +
    '203020636f626a3c3c2f547970652f50616765732f4b6964735b3320' +
    '3020525d2f436f756e7420313e3e656e646f626a0a33203020' +
    '6f626a3c3c2f547970652f506167652f4d65646961426f785b30203020363132203739325d2f506172656e7420' +
    '3220302052202f436f6e74656e74732034203020522f5265736f75726365733c3c2f466f6e743c3c2f463120' +
    '3520302052' + '>>' + '>>' + '>>' +
    'endobj', 'hex'
  );

  // Just write a simple text file as PDF-like for testing the command
  fs.writeFileSync(inFile, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF');

  const lo = getLibreOfficePath();
  const loEnv = `-env:UserInstallation=file://${profileDir}`;
  const cmd = `${lo} --headless ${loEnv} --convert-to "docx:MS Word 2007 XML" --outdir "${tmpDir}" "${inFile}"`;

  exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
    const allFiles = fs.readdirSync(tmpDir);
    const outFiles = allFiles.filter(f => f !== 'input.pdf' && !f.includes('lo-profile'));
    cleanup(tmpDir);
    res.json({
      cmd,
      ok: !err && outFiles.length > 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      error: err?.message || null,
      outputFiles: outFiles,
      allFiles,
    });
  });
});

// POST /convert/word   → PDF → DOCX
// POST /convert/excel  → PDF → XLSX
// POST /convert/pptx   → PDF → PPTX
['word', 'excel', 'pptx'].forEach(route => {
  const formatMap = { word: 'docx', excel: 'xlsx', pptx: 'pptx' };
  const format    = formatMap[route];

  app.post(`/convert/${route}`, upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Send a PDF as multipart field "file".' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are accepted.' });
    }

    console.log(`[${new Date().toISOString()}] Converting ${req.file.originalname} → ${format} (${(req.file.size/1024).toFixed(1)} KB)`);

    try {
      const converted = await convertWithLibreOffice(req.file.buffer, format);
      const outName   = req.file.originalname.replace(/\.pdf$/i, '') + '.' + format;

      res.set({
        'Content-Type':        MIME[format],
        'Content-Disposition': `attachment; filename="${outName}"`,
        'Content-Length':      converted.length,
      });
      res.send(converted);
      console.log(`[${new Date().toISOString()}] Done → ${outName} (${(converted.length/1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error('Conversion failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF Studio Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/word`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/excel`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/pptx`);
});

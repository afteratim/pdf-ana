const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PASSWORD = process.env.APP_PASSWORD || "";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_PAGES = Number(process.env.MAX_PAGES || 100);
const MAX_OCR_PAGES = Number(process.env.MAX_OCR_PAGES || 10);
const OCR_DPI = Number(process.env.OCR_DPI || 110);
const TEMP_DIR = process.env.TEMP_DIR || "/tmp/pdf-analyzer";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 60000);

fs.mkdirSync(TEMP_DIR, { recursive: true });
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function runCommand(command, args, timeout = 120000, maxOutput = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = "", settled = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${command} timed out`)); }, timeout);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > maxOutput) {
        child.kill("SIGKILL");
        return finish(new Error("Command output limit exceeded"));
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", chunk => { if (stderr.length < 12000) stderr += chunk.toString(); });
    child.on("error", error => finish(error));
    child.on("close", code => code !== 0
      ? finish(new Error(stderr || `${command} exited with code ${code}`))
      : finish(null, { stdout: stdout.toString("utf8"), stderr }));
  });
}

function authenticate(req, res, next) {
  if (!PASSWORD) return res.status(503).json({ error: "APP_PASSWORD is not configured." });
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expected = Buffer.from(PASSWORD), received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ error: "Authentication required." });
  }
  next();
}

app.get("/api/health", (req, res) => res.json({
  status: "ok", application: "Personal PDF Analyzer", version: "2.1.0",
  uptime_seconds: Math.floor(process.uptime()),
  memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024), platform: "Render"
}));

app.post("/api/login", (req, res) => {
  if (!PASSWORD) return res.status(503).json({ error: "APP_PASSWORD is not configured." });
  const supplied = String(req.body.password || "");
  const a = Buffer.from(PASSWORD), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  res.json({ success: true, token: PASSWORD });
});

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, TEMP_DIR),
  filename: (req, file, callback) => callback(null, crypto.randomUUID() + ".pdf")
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith(".pdf")) return callback(new Error("Only PDF files are accepted."));
    callback(null, true);
  }
});

async function removeFile(filePath) {
  if (!filePath) return;
  try { await fs.promises.rm(filePath, { force: true }); } catch (_) {}
}

function countMatches(text, regex) { return [...text.matchAll(regex)].length; }
function inspectPageText(text) {
  const gstins = [...text.matchAll(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi)].map(m => m[0].toUpperCase());
  const dates = [...text.matchAll(/\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:20)?\d{2}\b/g)].map(m => m[0]);
  const billNos = [];
  const billRegex = /(?:invoice|bill|voucher|eway\s*bill|e-way\s*bill)\s*(?:no\.?|number|#|num\.?|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})/gi;
  for (const m of text.matchAll(billRegex)) billNos.push(m[1]);
  const amounts = [...text.matchAll(/(?:grand\s*total|invoice\s*value|net\s*amount|total\s*amount|taxable\s*value|total)\s*[:\-]?\s*(?:₹|rs\.?\s*)?([0-9][0-9,]*(?:\.\d{1,2})?)/gi)].map(m => m[1]);
  return { gstins, dates, billNos, amounts };
}

async function extractPdf(filePath) {
  const info = await runCommand("pdfinfo", [filePath], 30000, 256 * 1024);
  const pagesMatch = info.stdout.match(/^Pages:\s+(\d+)/m);
  const encryptedMatch = info.stdout.match(/^Encrypted:\s+(.+)$/m);
  const pageCount = pagesMatch ? Number(pagesMatch[1]) : 0;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("Unable to determine PDF page count. The PDF may be damaged or encrypted.");
  if (pageCount > MAX_PAGES) throw new Error(`PDF contains ${pageCount} pages. Maximum allowed: ${MAX_PAGES}.`);
  if (encryptedMatch && !/^no/i.test(encryptedMatch[1].trim())) throw new Error("This PDF appears to be password-protected. Remove its password and upload again.");

  const result = await runCommand("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"], 180000, 15 * 1024 * 1024);
  const pageTexts = result.stdout.split("\f").slice(0, pageCount);
  const pages = [];
  let ocrCount = 0, scannedCount = 0, unreadableCount = 0;

  for (let i = 0; i < pageCount; i++) {
    let text = (pageTexts[i] || "").trim();
    let source = text.length >= 30 ? "native" : "unreadable";
    const pageNumber = i + 1;
    if (text.length < 30) {
      scannedCount++;
      if (ocrCount < MAX_OCR_PAGES) {
        const prefix = path.join(TEMP_DIR, crypto.randomUUID());
        const imagePath = prefix + ".png";
        try {
          await runCommand("pdftoppm", ["-f", String(pageNumber), "-l", String(pageNumber), "-r", String(OCR_DPI), "-scale-to", "1600", "-singlefile", "-png", filePath, prefix], 90000, 64 * 1024);
          const ocr = await runCommand("tesseract", [imagePath, "stdout", "-l", "eng", "--psm", "6"], 90000, 2 * 1024 * 1024);
          if (ocr.stdout.trim()) { text = ocr.stdout.trim(); source = "ocr"; }
          ocrCount++;
        } catch (error) {
          console.error(`OCR failed on page ${pageNumber}:`, error.message);
        } finally { await removeFile(imagePath); }
      }
    }
    if (!text || text.length < 10) unreadableCount++;
    const fields = inspectPageText(text);
    const tableLike = text.split(/\r?\n/).filter(line => (line.match(/\s{2,}|\|/g) || []).length >= 2).length >= 3;
    pages.push({
      page: pageNumber,
      text: text || "[No readable text detected]",
      source,
      characterCount: text.length,
      tableLike,
      extracted: { gstinCount: fields.gstins.length, dateCount: fields.dates.length, billNumberCount: fields.billNos.length, amountCount: fields.amounts.length },
      warnings: source === "unreadable" ? ["No readable text was extracted from this page."] : source === "ocr" ? ["Text was extracted using OCR; verify important values against the page image."] : []
    });
  }

  const allText = pages.map(p => p.text).join("\n");
  const fields = inspectPageText(allText);
  const tablePages = pages.filter(p => p.tableLike).length;
  const nativePages = pages.filter(p => p.source === "native").length;
  const ocrPages = pages.filter(p => p.source === "ocr").length;
  const warnings = [];
  if (unreadableCount) warnings.push(`${unreadableCount} page(s) contain little or no readable text.`);
  if (scannedCount > MAX_OCR_PAGES) warnings.push(`OCR limit reached: only ${MAX_OCR_PAGES} scanned pages can be processed per document in this version.`);
  if (ocrPages) warnings.push("OCR results may contain recognition errors. Verify bill numbers, GSTINs and amounts against the original PDF.");
  if (!tablePages) warnings.push("No table-like text layout was confidently detected. This does not mean the PDF contains no tables.");
  const quality = unreadableCount > 0 || scannedCount > MAX_OCR_PAGES ? "review" : "good";

  return {
    pageCount, scannedPages: scannedCount, ocrPagesProcessed: ocrPages, unreadablePages: unreadableCount,
    nativePages, tablePages,
    report: {
      status: quality,
      pdfIntegrity: "passed",
      textExtraction: nativePages + ocrPages > 0 ? "passed" : "review",
      totalPages: pageCount,
      nativePages, ocrPages, unreadablePages: unreadableCount,
      tableLikePages: tablePages,
      fieldCounts: { billNumbers: fields.billNos.length, gstins: fields.gstins.length, dates: fields.dates.length, labelledAmounts: fields.amounts.length },
      warnings
    },
    pages
  };
}

app.post("/api/analyze", authenticate, upload.single("pdf"), async (req, res) => {
  let filePath;
  try {
    if (!req.file) return res.status(400).json({ error: "Please upload a PDF file." });
    filePath = req.file.path;
    const handle = await fs.promises.open(filePath, "r");
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, 5, 0);
      if (header.toString() !== "%PDF-") throw new Error("Invalid PDF file signature.");
    } finally { await handle.close(); }
    const result = await extractPdf(filePath);
    res.json({ success: true, filename: req.file.originalname, size_mb: Number((req.file.size / 1024 / 1024).toFixed(2)), ...result });
  } catch (error) {
    console.error("PDF processing error:", error.message);
    const clientError = /Invalid PDF|Maximum allowed|Only PDF|password-protected/i.test(error.message);
    if (!res.headersSent) res.status(clientError ? 400 : 500).json({ error: error.message || "PDF processing failed." });
  } finally { await removeFile(filePath); }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: status === 413 ? `Maximum upload size is ${MAX_UPLOAD_MB} MB.` : error.message });
  }
  console.error("Request error:", error.message);
  if (!res.headersSent) res.status(400).json({ error: error.message || "Request failed." });
});

// One-minute self-ping. PING_URLS accepts comma-separated URLs.
const configuredUrls = (process.env.PING_URLS || "").split(",").map(url => url.trim()).filter(Boolean);
const selfUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/api/health` : "";
const pingUrls = configuredUrls.length ? configuredUrls : (selfUrl ? [selfUrl] : []);
let pingRunning = false;
async function pingUrlsNow() {
  if (pingRunning || !pingUrls.length) return;
  pingRunning = true;
  try {
    for (const url of pingUrls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Personal-PDF-Analyzer-KeepAlive" } });
        console.log(`[SELF-PING] ${url} -> ${response.status}`);
        await response.body?.cancel();
      } catch (error) { console.error(`[SELF-PING] Failed: ${url} - ${error.message}`); }
    }
  } finally { pingRunning = false; }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PDF Analyzer running on port ${PORT}`);
  console.log(`Maximum upload: ${MAX_UPLOAD_MB} MB; OCR pages: ${MAX_OCR_PAGES}; self-ping: ${PING_INTERVAL_MS} ms`);
  console.log(`Ping targets: ${pingUrls.length}`);
  if (pingUrls.length) setInterval(pingUrlsNow, PING_INTERVAL_MS);
});

(async () => {
  try {
    const files = await fs.promises.readdir(TEMP_DIR);
    for (const file of files) await removeFile(path.join(TEMP_DIR, file));
  } catch (_) {}
})();

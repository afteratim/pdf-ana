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
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = Buffer.alloc(0);
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error(`${command} timed out`));
        }, timeout);

        function finish(error, result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(result);
        }

        child.stdout.on("data", chunk => {
            if (stdout.length + chunk.length > maxOutput) {
                child.kill("SIGKILL");
                return finish(new Error("Command output limit exceeded"));
            }
            stdout = Buffer.concat([stdout, chunk]);
        });

        child.stderr.on("data", chunk => {
            if (stderr.length < 12000) stderr += chunk.toString();
        });

        child.on("error", error => finish(error));

        child.on("close", code => {
            if (code !== 0) {
                return finish(new Error(stderr || `${command} exited with code ${code}`));
            }
            finish(null, { stdout: stdout.toString("utf8"), stderr });
        });
    });
}

function authenticate(req, res, next) {
    if (!PASSWORD) {
        return res.status(503).json({ error: "APP_PASSWORD is not configured." });
    }

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const expected = Buffer.from(PASSWORD);
    const received = Buffer.from(token);

    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
        return res.status(401).json({ error: "Authentication required." });
    }
    next();
}

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        application: "Personal PDF Analyzer",
        version: "1.0.0",
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        platform: "Render"
    });
});

app.post("/api/login", (req, res) => {
    if (!PASSWORD) {
        return res.status(503).json({ error: "APP_PASSWORD is not configured." });
    }

    const supplied = String(req.body.password || "");
    const a = Buffer.from(PASSWORD);
    const b = Buffer.from(supplied);

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
        if (!file.originalname.toLowerCase().endsWith(".pdf")) {
            return callback(new Error("Only PDF files are accepted."));
        }
        callback(null, true);
    }
});

async function removeFile(filePath) {
    if (!filePath) return;
    try {
        await fs.promises.rm(filePath, { force: true });
    } catch (_) {}
}

async function extractPdf(filePath) {
    const info = await runCommand("pdfinfo", [filePath], 30000, 256 * 1024);
    const pagesMatch = info.stdout.match(/^Pages:\s+(\d+)/m);

    if (!pagesMatch) throw new Error("Unable to determine PDF page count.");

    const pageCount = Number(pagesMatch[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error("Invalid PDF page count.");
    }
    if (pageCount > MAX_PAGES) {
        throw new Error(`PDF contains ${pageCount} pages. Maximum allowed: ${MAX_PAGES}.`);
    }

    const result = await runCommand(
        "pdftotext",
        ["-layout", "-enc", "UTF-8", filePath, "-"],
        180000,
        15 * 1024 * 1024
    );

    const pageTexts = result.stdout.split("\f").slice(0, pageCount);
    const output = [];
    let ocrCount = 0;
    let scannedCount = 0;

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
                    await runCommand(
                        "pdftoppm",
                        [
                            "-f", String(pageNumber),
                            "-l", String(pageNumber),
                            "-r", String(OCR_DPI),
                            "-scale-to", "1600",
                            "-singlefile",
                            "-png",
                            filePath,
                            prefix
                        ],
                        90000,
                        64 * 1024
                    );

                    const ocr = await runCommand(
                        "tesseract",
                        [imagePath, "stdout", "-l", "eng", "--psm", "6"],
                        90000,
                        2 * 1024 * 1024
                    );

                    if (ocr.stdout.trim()) {
                        text = ocr.stdout.trim();
                        source = "ocr";
                    }
                    ocrCount++;
                } catch (error) {
                    console.error(`OCR failed on page ${pageNumber}:`, error.message);
                } finally {
                    await removeFile(imagePath);
                }
            }
        }

        output.push({
            page: pageNumber,
            text: text || "[No readable text detected]",
            source
        });
    }

    return {
        pageCount,
        scannedPages: scannedCount,
        ocrPagesProcessed: ocrCount,
        pages: output
    };
}

app.post("/api/analyze", authenticate, upload.single("pdf"), async (req, res) => {
    let filePath;

    try {
        if (!req.file) {
            return res.status(400).json({ error: "Please upload a PDF file." });
        }

        filePath = req.file.path;
        const handle = await fs.promises.open(filePath, "r");

        try {
            const header = Buffer.alloc(5);
            await handle.read(header, 0, 5, 0);
            if (header.toString() !== "%PDF-") {
                throw new Error("Invalid PDF file signature.");
            }
        } finally {
            await handle.close();
        }

        const result = await extractPdf(filePath);

        res.json({
            success: true,
            filename: req.file.originalname,
            size_mb: Number((req.file.size / 1024 / 1024).toFixed(2)),
            ...result
        });
    } catch (error) {
        console.error("PDF processing error:", error.message);

        const status =
            error.message.includes("Invalid PDF") ||
            error.message.includes("Maximum allowed") ||
            error.message.includes("Only PDF")
                ? 400
                : 500;

        if (!res.headersSent) {
            res.status(status).json({ error: error.message || "PDF processing failed." });
        }
    } finally {
        await removeFile(filePath);
    }
});

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({
            error: status === 413
                ? `Maximum upload size is ${MAX_UPLOAD_MB} MB.`
                : error.message
        });
    }

    console.error("Request error:", error.message);
    if (!res.headersSent) {
        res.status(400).json({ error: error.message || "Request failed." });
    }
});

// One-minute self-ping. PING_URLS is comma-separated.
// If empty, use this Render service's own public health endpoint.
const configuredUrls = (process.env.PING_URLS || "")
    .split(",")
    .map(url => url.trim())
    .filter(Boolean);

const selfUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/api/health`
    : "";

const pingUrls = configuredUrls.length ? configuredUrls : (selfUrl ? [selfUrl] : []);
let pingRunning = false;

async function pingUrlsNow() {
    if (pingRunning || pingUrls.length === 0) return;
    pingRunning = true;

    try {
        for (const url of pingUrls) {
            try {
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(10000),
                    headers: { "User-Agent": "Personal-PDF-Analyzer-KeepAlive" }
                });
                console.log(`[SELF-PING] ${url} -> ${response.status}`);
                await response.body?.cancel();
            } catch (error) {
                console.error(`[SELF-PING] Failed: ${url} - ${error.message}`);
            }
        }
    } finally {
        pingRunning = false;
    }
}

app.listen(PORT, "0.0.0.0", () => {
    console.log(`PDF Analyzer running on port ${PORT}`);
    console.log(`Maximum upload: ${MAX_UPLOAD_MB} MB`);
    console.log(`Self-ping interval: ${PING_INTERVAL_MS} ms`);
    console.log(`Ping targets: ${pingUrls.length}`);

    if (pingUrls.length) {
        setInterval(pingUrlsNow, PING_INTERVAL_MS);
    }
});

// Remove temporary files left behind by interrupted requests.
(async () => {
    try {
        const files = await fs.promises.readdir(TEMP_DIR);
        for (const file of files) {
            await removeFile(path.join(TEMP_DIR, file));
        }
    } catch (_) {}
})();
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_BYTES = 500 * 1024 * 1024;
const WORKER_TOKEN = String(process.env.YOUTUBE_WORKER_TOKEN || "").trim();

if (!WORKER_TOKEN) {
  console.error("[youtube-worker] YOUTUBE_WORKER_TOKEN is required.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

function tokenValid(value) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(WORKER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireWorkerToken(req, res, next) {
  if (!tokenValid(req.get("X-NanoFetch-Worker-Token"))) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker request." });
  }
  next();
}

function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function safeExt(value, fallback = "mp4") {
  const ext = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return ext || fallback;
}

function baseFlags() {
  return {
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 20,
    retries: 2,
    fragmentRetries: 2,
    extractorRetries: 2,
    sleepRequests: 1
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, role: "nanofetch-youtube-render-worker", region: process.env.RENDER_REGION || "render" });
});

app.post("/v1/inspect", requireWorkerToken, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  try {
    if (!isYouTubeUrl(url)) throw new Error("Only public YouTube URLs are accepted by this worker.");
    const output = await youtubedl(url, {
      ...baseFlags(),
      dumpSingleJson: true,
      skipDownload: true
    }, { timeout: 120000 });
    const text = typeof output === "string" ? output : JSON.stringify(output);
    res.json({ ok: true, output: text });
  } catch (err) {
    console.error(`[youtube-worker] inspect failed: ${err?.message || err}`);
    res.status(400).json({ ok: false, error: err?.message || "Worker inspect failed." });
  }
});

app.post("/v1/download", requireWorkerToken, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const selector = String(req.body?.selector || "").trim();
  const requestedExt = safeExt(req.body?.ext, /^ba(?:\[|\/|$)/i.test(selector) ? "m4a" : "mp4");
  const token = `nanofetch-worker-${randomUUID()}`;
  const template = path.join(os.tmpdir(), `${token}.%(ext)s`);
  let files = [];

  try {
    if (!isYouTubeUrl(url)) throw new Error("Only public YouTube URLs are accepted by this worker.");
    if (!selector || selector.length > 800) throw new Error("Invalid media selector.");

    await youtubedl(url, {
      ...baseFlags(),
      format: selector,
      output: template,
      mergeOutputFormat: requestedExt === "mp4" ? "mp4" : undefined,
      maxFilesize: "500M",
      concurrentFragments: 1
    }, { timeout: 6 * 60 * 1000 });

    files = (await fsp.readdir(os.tmpdir()))
      .filter(x => x.startsWith(`${token}.`) && !/\.(part|ytdl|temp)$/i.test(x))
      .map(x => path.join(os.tmpdir(), x));

    if (!files.length) throw new Error("Worker did not create a media file.");
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    const filePath = files[0];
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_BYTES) throw new Error("Prepared file exceeds the 500 MB limit.");

    const ext = safeExt(path.extname(filePath).slice(1), requestedExt);
    res.setHeader("Content-Type", ext === "m4a" ? "audio/mp4" : "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("X-NanoFetch-Ext", ext);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(filePath);
    const cleanup = async () => Promise.all(files.map(f => fsp.rm(f, { force: true }).catch(() => {})));
    stream.on("error", async () => { await cleanup(); if (!res.headersSent) res.status(500).end(); });
    res.on("finish", cleanup);
    res.on("close", cleanup);
    stream.pipe(res);
  } catch (err) {
    await Promise.all(files.map(f => fsp.rm(f, { force: true }).catch(() => {})));
    console.error(`[youtube-worker] download failed: ${err?.message || err}`);
    if (!res.headersSent) res.status(400).json({ ok: false, error: err?.message || "Worker download failed." });
    else res.destroy();
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));
app.listen(PORT, "0.0.0.0", () => console.log(`[youtube-worker] listening on 0.0.0.0:${PORT}`));

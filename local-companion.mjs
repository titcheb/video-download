import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const HOST = "127.0.0.1";
const PORT = Number(process.env.NANOFETCH_COMPANION_PORT || 17345);
const MAX_BYTES = 500 * 1024 * 1024;
const SESSION = randomBytes(24).toString("hex");
const DEFAULT_ORIGINS = new Set([
  "https://neonfetch-x.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
for (const origin of String(process.env.NANOFETCH_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean)) DEFAULT_ORIGINS.add(origin);

app.disable("x-powered-by");
app.use(express.json({ limit: "24kb" }));

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return DEFAULT_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-NanoFetch-Session");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ ok: false, error: "Origin is not allowed by NanoFetch Local Companion." });
  next();
});

function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function safeName(value, fallback = "youtube-video") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

function sessionValid(value) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(SESSION);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSession(req, res, next) {
  const token = req.get("X-NanoFetch-Session") || req.query.session;
  if (!sessionValid(token)) return res.status(401).json({ ok: false, error: "Local Companion session expired. Refresh NanoFetch and try again." });
  next();
}

function ytBaseFlags() {
  const flags = {
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 20,
    retries: 3,
    fragmentRetries: 3,
    extractorRetries: 3,
    jsRuntimes: "node"
  };
  const browser = String(process.env.NANOFETCH_BROWSER || "").trim();
  const cookieFile = String(process.env.NANOFETCH_COOKIES_FILE || "").trim();
  if (cookieFile && fs.existsSync(cookieFile)) flags.cookies = cookieFile;
  else if (browser) flags.cookiesFromBrowser = browser;
  return flags;
}

async function inspectYouTube(url) {
  const output = await youtubedl(url, {
    ...ytBaseFlags(),
    dumpSingleJson: true,
    skipDownload: true
  }, { timeout: 90000 });
  const info = typeof output === "string" ? JSON.parse(output) : output;
  if (!info) throw new Error("yt-dlp returned no YouTube metadata.");
  if (info?._type === "playlist" || Array.isArray(info?.entries)) throw new Error("Playlists are not supported by Local Companion yet.");
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) throw new Error("Live streams are not supported.");
  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) throw new Error("Private, paid, or subscriber-only media is not supported.");
  if (Number(info?.age_limit || 0) >= 18) throw new Error("Age-restricted media requires an authenticated local workflow.");

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(formats
    .filter(f => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none")
    .map(f => Number(f.height || 0))
    .filter(Boolean))]
    .sort((a, b) => b - a)
    .slice(0, 8);

  const title = safeName(info.title || "YouTube video");
  const origin = `http://${HOST}:${PORT}`;
  const resultFormats = heights.map(height => ({
    id: `local-${height}`,
    label: `${height}p · Local Companion`,
    quality: `${height}p`,
    ext: "mp4",
    size: null,
    type: "video",
    downloadUrl: `${origin}/download?session=${encodeURIComponent(SESSION)}&mode=video&height=${height}&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - ${height}p.mp4`)}`
  }));

  if (formats.some(f => f?.url && !f.has_drm && f.acodec && f.acodec !== "none")) {
    resultFormats.push({
      id: "local-audio",
      label: "Best audio · Local Companion",
      quality: "Audio",
      ext: "m4a",
      size: null,
      type: "audio",
      downloadUrl: `${origin}/download?session=${encodeURIComponent(SESSION)}&mode=audio&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - audio.m4a`)}`
    });
  }
  if (!resultFormats.length) throw new Error("No non-DRM downloadable formats were exposed by YouTube.");

  return {
    ok: true,
    engine: "nanofetch-local-companion",
    localCompanion: true,
    title,
    uploader: safeName(info.uploader || info.channel || "YouTube", "YouTube"),
    thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null,
    duration: Number(info.duration || 0) || null,
    sourceHost: "YouTube · LOCAL CONNECTION",
    formats: resultFormats
  };
}

async function prepareDownload(url, mode, height) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nanofetch-local-"));
  const template = path.join(dir, "media.%(ext)s");
  const common = {
    ...ytBaseFlags(),
    output: template,
    newline: true,
    restrictFilenames: false
  };

  if (mode === "audio") {
    await youtubedl(url, {
      ...common,
      format: "ba/b",
      extractAudio: true,
      audioFormat: "m4a",
      audioQuality: 0
    }, { timeout: 10 * 60 * 1000 });
  } else {
    const h = Math.max(144, Math.min(4320, Number(height || 1080)));
    await youtubedl(url, {
      ...common,
      format: `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`,
      mergeOutputFormat: "mp4"
    }, { timeout: 10 * 60 * 1000 });
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || /\.(part|ytdl|temp)$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fsp.stat(filePath);
    files.push({ filePath, size: stat.size });
  }
  files.sort((a, b) => b.size - a.size);
  if (!files.length) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error("Local Companion finished without creating a media file.");
  }
  if (files[0].size > MAX_BYTES) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error("Prepared file is larger than the 500 MB limit.");
  }
  return { dir, ...files[0] };
}

app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "NanoFetch Local Companion",
    version: "1.0.0",
    session: SESSION,
    youtube: true,
    ffmpeg: Boolean(ffmpegPath)
  });
});

app.post("/inspect", requireSession, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  try {
    if (!isYouTubeUrl(url)) throw new Error("Local Companion only accepts HTTPS YouTube URLs.");
    res.json(await inspectYouTube(url));
  } catch (err) {
    console.error("[local-companion][inspect]", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || "Local YouTube inspection failed." });
  }
});

app.get("/download", requireSession, async (req, res) => {
  const url = String(req.query.url || "").trim();
  const mode = req.query.mode === "audio" ? "audio" : "video";
  const height = Number(req.query.height || 1080);
  const requestedName = safeName(req.query.name || (mode === "audio" ? "youtube-audio.m4a" : "youtube-video.mp4"));
  let prepared = null;
  try {
    if (!isYouTubeUrl(url)) throw new Error("Local Companion only accepts HTTPS YouTube URLs.");
    prepared = await prepareDownload(url, mode, height);
    const ext = path.extname(prepared.filePath) || (mode === "audio" ? ".m4a" : ".mp4");
    const filename = requestedName.replace(/\.[^.]+$/, "") + ext;
    res.setHeader("Cache-Control", "no-store");
    res.download(prepared.filePath, filename, async () => {
      await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (err) {
    if (prepared?.dir) await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
    console.error("[local-companion][download]", err?.message || err);
    if (!res.headersSent) res.status(400).send(err?.message || "Local YouTube download failed.");
  }
});

app.listen(PORT, HOST, () => {
  console.log("");
  console.log("NanoFetch Local Companion is READY");
  console.log(`Listening only on this computer: http://${HOST}:${PORT}`);
  console.log("Keep this window open while using YouTube on NeonFetch X.");
  console.log("Press Ctrl+C to stop.");
  console.log("");
});

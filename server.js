import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_FORMATS = 18;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now > entry.reset) entry = { count: 0, reset: now + windowMs };
    entry.count += 1;
    buckets.set(key, entry);
    if (entry.count > limit) {
      return res.status(429).json({ ok: false, error: "Too many requests. Try again shortly." });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of buckets) if (now > value.reset) buckets.delete(key);
}, 10 * 60 * 1000).unref();

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/favicon.svg", (req, res) => res.sendFile(path.join(__dirname, "favicon.svg")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "NeonFetch X",
    mode: "authorized-public-media",
    extractor: "yt-dlp",
    ffmpeg: Boolean(ffmpegPath),
    storage: "temporary-ephemeral",
    timestamp: new Date().toISOString()
  });
});

const allowedContentPrefixes = ["video/", "audio/", "image/", "application/octet-stream"];
const blockedHostFragments = ["localhost", "metadata.google.internal", "169.254.169.254"];

const QUALITY_PRESETS = {
  q2160: {
    label: "4K / 2160p",
    ext: "mp4",
    selector: "bv*[height<=2160][ext=mp4]+ba[ext=m4a]/b[height<=2160][ext=mp4]/b[height<=2160]"
  },
  q1440: {
    label: "1440p",
    ext: "mp4",
    selector: "bv*[height<=1440][ext=mp4]+ba[ext=m4a]/b[height<=1440][ext=mp4]/b[height<=1440]"
  },
  q1080: {
    label: "1080p",
    ext: "mp4",
    selector: "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]"
  },
  q720: {
    label: "720p",
    ext: "mp4",
    selector: "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]"
  },
  q480: {
    label: "480p",
    ext: "mp4",
    selector: "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/b[height<=480]"
  },
  q360: {
    label: "360p",
    ext: "mp4",
    selector: "bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360][ext=mp4]/b[height<=360]"
  },
  audio: {
    label: "Best audio",
    ext: "m4a",
    selector: "ba[ext=m4a]/ba"
  }
};

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
  }
  return true;
}

async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (u.username || u.password) throw new Error("URLs containing embedded credentials are not allowed.");
  const host = u.hostname.toLowerCase();
  if (blockedHostFragments.some(x => host === x || host.endsWith(`.${x}`))) throw new Error("This host is not allowed.");
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error("Local/private network URLs are not allowed.");
  return u;
}

function safeFilename(input, contentType = "", title = "") {
  let base = title || "download";
  try {
    const u = new URL(input);
    const fromUrl = decodeURIComponent(path.basename(u.pathname));
    if (!title && fromUrl) base = fromUrl;
  } catch {}
  base = String(base)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "download";
  if (!path.extname(base)) {
    const extMap = {
      "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
      "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav",
      "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"
    };
    base += extMap[contentType.split(";")[0].trim()] || "";
  }
  return base;
}

function formatBytes(n) {
  if (!n || !Number.isFinite(Number(n))) return null;
  const value = Number(n);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function fetchHeadOrProbe(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });
  } catch {}
  if (!response?.ok || !response.headers.get("content-type")) {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(10000)
    });
  }
  return response;
}

function directMediaMeta(response, rawUrl) {
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const len = Number(response.headers.get("content-length") || 0);
  if (!allowedContentPrefixes.some(prefix => type.startsWith(prefix))) return null;
  if (len && len > MAX_BYTES) throw new Error("File is larger than the 500 MB limit.");
  const name = safeFilename(rawUrl, type);
  return {
    ok: true,
    engine: "direct",
    title: name,
    uploader: new URL(rawUrl).hostname,
    thumbnail: null,
    duration: null,
    sourceHost: new URL(rawUrl).hostname,
    formats: [{
      id: "direct",
      label: type.startsWith("audio/") ? "Original audio" : type.startsWith("image/") ? "Original image" : "Original quality",
      ext: path.extname(name).replace(".", "") || type.split("/")[1] || "file",
      quality: "Original",
      size: formatBytes(len),
      type: type || "application/octet-stream",
      downloadUrl: `/api/download?mode=direct&url=${encodeURIComponent(rawUrl)}`
    }]
  };
}

function normalizeInfo(output) {
  if (!output) throw new Error("No media information returned.");
  if (typeof output === "string") return JSON.parse(output);
  return output;
}

function makePresetFormats(info, rawUrl) {
  const source = Array.isArray(info.formats) ? info.formats : [];
  const usableVideo = source.filter(f => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none");
  const usableAudio = source.some(f => f?.url && !f.has_drm && f.acodec && f.acodec !== "none");
  const heights = usableVideo.map(f => Number(f.height || 0)).filter(Boolean);
  const maxHeight = heights.length ? Math.max(...heights) : 0;
  const filenameBase = safeFilename(rawUrl, "", info.title || "media").replace(/\.[^.]+$/, "");
  const presets = [];

  const candidates = [
    [2160, "q2160"],
    [1440, "q1440"],
    [1080, "q1080"],
    [720, "q720"],
    [480, "q480"],
    [360, "q360"]
  ];

  if (usableAudio) {
    for (const [height, id] of candidates) {
      if (maxHeight < height) continue;
      const preset = QUALITY_PRESETS[id];
      presets.push({
        id,
        label: preset.label,
        quality: preset.label,
        ext: preset.ext,
        size: null,
        type: "video",
        downloadUrl: `/api/download?mode=preset&url=${encodeURIComponent(rawUrl)}&preset=${id}&name=${encodeURIComponent(`${filenameBase} - ${preset.label}.${preset.ext}`)}`
      });
    }

    const audioPreset = QUALITY_PRESETS.audio;
    presets.push({
      id: "audio",
      label: audioPreset.label,
      quality: "Audio",
      ext: audioPreset.ext,
      size: null,
      type: "audio",
      downloadUrl: `/api/download?mode=preset&url=${encodeURIComponent(rawUrl)}&preset=audio&name=${encodeURIComponent(`${filenameBase} - audio.${audioPreset.ext}`)}`
    });
  }

  return presets;
}

function chooseNativeFormats(info, rawUrl) {
  const source = Array.isArray(info.formats) ? info.formats : [];
  const clean = source.filter(f => {
    if (!f?.format_id || !f?.url || f.has_drm) return false;
    const hasVideo = f.vcodec && f.vcodec !== "none";
    const hasAudio = f.acodec && f.acodec !== "none";
    return (hasVideo && hasAudio) || (!hasVideo && hasAudio);
  });

  const seen = new Set();
  const video = [];
  const audio = [];

  for (const f of clean) {
    const hasVideo = f.vcodec && f.vcodec !== "none";
    const h = Number(f.height || 0);
    const ext = String(f.ext || "mp4").toLowerCase();
    const size = Number(f.filesize || f.filesize_approx || 0);
    const quality = hasVideo
      ? (h ? `${h}p` : String(f.format_note || "Video"))
      : `${Math.round(Number(f.abr || f.tbr || 0)) || ""} kbps`.trim();
    const key = `${hasVideo ? "v" : "a"}:${quality}:${ext}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filenameBase = safeFilename(rawUrl, "", info.title || "media").replace(/\.[^.]+$/, "");
    const outName = `${filenameBase}${quality ? ` - ${quality}` : ""}.${ext}`;
    const item = {
      id: String(f.format_id),
      label: hasVideo ? quality : `Audio ${quality}`,
      quality,
      ext,
      size: formatBytes(size),
      type: hasVideo ? "video" : "audio",
      downloadUrl: `/api/download?mode=extract&url=${encodeURIComponent(rawUrl)}&format=${encodeURIComponent(String(f.format_id))}&ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(outName)}`
    };
    (hasVideo ? video : audio).push(item);
  }

  video.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  audio.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  return [...video.slice(0, 8), ...audio.slice(0, 3)];
}

function chooseFormats(info, rawUrl) {
  const presets = makePresetFormats(info, rawUrl);
  const native = chooseNativeFormats(info, rawUrl);
  const seen = new Set();
  return [...presets, ...native].filter(item => {
    const key = `${item.type}:${item.label}:${item.ext}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_FORMATS);
}

async function inspectWithExtractor(rawUrl) {
  const output = await youtubedl(rawUrl, {
    dumpSingleJson: true,
    skipDownload: true,
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 15,
    retries: 1,
    fragmentRetries: 1
  }, { timeout: 35000 });

  const info = normalizeInfo(output);
  if (info?._type === "playlist" || Array.isArray(info?.entries)) {
    throw new Error("Playlists and bulk downloads are not supported.");
  }

  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) {
    throw new Error("Private, paid, subscriber-only, or login-required media is not supported.");
  }
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) {
    throw new Error("Live streams are not supported. Try again after the stream is published as a normal video.");
  }
  if (Number(info?.age_limit || 0) >= 18) {
    throw new Error("Age-restricted media is not supported without an official authenticated workflow.");
  }

  const formats = chooseFormats(info, rawUrl);
  if (!formats.length) {
    throw new Error("No downloadable non-DRM video/audio format was found without account access.");
  }

  return {
    ok: true,
    engine: "extractor",
    title: String(info.title || "Media").slice(0, 180),
    uploader: String(info.uploader || info.channel || new URL(rawUrl).hostname).slice(0, 120),
    thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null,
    duration: Number(info.duration || 0) || null,
    sourceHost: new URL(rawUrl).hostname,
    formats
  };
}

app.post("/api/inspect", rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    if (!rawUrl) throw new Error("Paste a video or media URL first.");
    const u = await validateUrl(rawUrl);

    try {
      const upstream = await fetchHeadOrProbe(u);
      const direct = directMediaMeta(upstream, rawUrl);
      if (direct) return res.json(direct);
    } catch (err) {
      if (/500 MB/.test(String(err?.message))) throw err;
    }

    const data = await inspectWithExtractor(rawUrl);
    res.json(data);
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || "Unable to inspect this URL." });
  }
});

function contentTypeForExt(ext) {
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav"
  };
  return map[String(ext).toLowerCase()] || "application/octet-stream";
}

async function downloadPresetToTemp(url, presetId) {
  const preset = QUALITY_PRESETS[presetId];
  if (!preset) throw new Error("Invalid quality preset.");

  const token = `neonfetch-${randomUUID()}`;
  const template = path.join(os.tmpdir(), `${token}.%(ext)s`);

  await youtubedl(url, {
    format: preset.selector,
    output: template,
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    mergeOutputFormat: presetId === "audio" ? undefined : "mp4",
    maxFilesize: "500M",
    socketTimeout: 25,
    retries: 1,
    fragmentRetries: 1,
    concurrentFragments: 2
  }, { timeout: 180000 });

  const files = (await fsp.readdir(os.tmpdir()))
    .filter(name => name.startsWith(token + "."))
    .map(name => path.join(os.tmpdir(), name));

  if (!files.length) throw new Error("The selected quality could not be prepared.");
  const filePath = files[0];
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_BYTES) {
    await Promise.all(files.map(file => fsp.unlink(file).catch(() => {})));
    throw new Error("Prepared file is larger than the 500 MB limit.");
  }

  return { filePath, cleanupFiles: files, ext: path.extname(filePath).slice(1) || preset.ext };
}

app.get("/api/download", rateLimit(40, 10 * 60 * 1000), async (req, res) => {
  const mode = String(req.query.mode || "");
  const rawUrl = String(req.query.url || "").trim();
  try {
    if (!rawUrl) throw new Error("Missing media URL.");
    const u = await validateUrl(rawUrl);

    if (mode === "direct") {
      const upstream = await fetch(u, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(30000)
      });
      if (!upstream.ok) throw new Error(`Remote server returned ${upstream.status}.`);
      const meta = directMediaMeta(upstream, rawUrl);
      if (!meta) throw new Error("The URL is not a direct media file.");
      const format = meta.formats[0];
      res.setHeader("Content-Type", format.type || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(rawUrl, format.type)}"`);
      res.setHeader("Cache-Control", "no-store");
      if (!upstream.body) throw new Error("No response body.");
      return Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
    }

    if (mode === "preset") {
      const presetId = String(req.query.preset || "");
      const preset = QUALITY_PRESETS[presetId];
      if (!preset) throw new Error("Invalid quality preset.");

      const requestedName = String(req.query.name || `media.${preset.ext}`)
        .replace(/[\r\n"\\/]/g, "_")
        .slice(0, 140);

      const prepared = await downloadPresetToTemp(u.href, presetId);
      const finalExt = prepared.ext || preset.ext;
      const baseName = requestedName.replace(/\.[^.]+$/, "");
      const finalName = `${baseName}.${finalExt}`;

      res.setHeader("Content-Type", contentTypeForExt(finalExt));
      res.setHeader("Content-Disposition", `attachment; filename="${finalName}"`);
      res.setHeader("Content-Length", String((await fsp.stat(prepared.filePath)).size));
      res.setHeader("Cache-Control", "no-store");

      const stream = fs.createReadStream(prepared.filePath);
      const cleanup = () => Promise.all(prepared.cleanupFiles.map(file => fsp.unlink(file).catch(() => {})));
      stream.on("error", async () => {
        await cleanup();
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.on("close", cleanup);
      return stream.pipe(res);
    }

    if (mode !== "extract") throw new Error("Invalid download mode.");
    const formatId = String(req.query.format || "");
    if (!/^[a-zA-Z0-9._+-]{1,80}$/.test(formatId)) throw new Error("Invalid format selection.");
    const ext = String(req.query.ext || "mp4").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "mp4";
    const name = String(req.query.name || `media.${ext}`).replace(/[\r\n"\\/]/g, "_").slice(0, 140);

    res.setHeader("Content-Type", contentTypeForExt(ext));
    res.setHeader("Content-Disposition", `attachment; filename="${name || `media.${ext}`}"`);
    res.setHeader("Cache-Control", "no-store");

    const child = youtubedl.exec(u.href, {
      format: formatId,
      output: "-",
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      ffmpegLocation: ffmpegPath || undefined,
      socketTimeout: 20,
      retries: 1,
      fragmentRetries: 1,
      concurrentFragments: 2
    });

    let errText = "";
    child.stderr?.on("data", chunk => {
      if (errText.length < 4000) errText += chunk.toString();
    });
    child.on("error", err => {
      if (!res.headersSent) res.status(502).json({ ok: false, error: err.message || "Download failed." });
      else res.destroy();
    });
    child.on("close", code => {
      if (code && !res.writableEnded) {
        if (!res.headersSent) {
          res.status(502).json({ ok: false, error: errText.trim() || "The selected media format could not be downloaded." });
        } else {
          res.end();
        }
      }
    });
    req.on("close", () => { try { child.kill("SIGKILL"); } catch {} });
    child.stdout.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ ok: false, error: err?.message || "Download failed." });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NeonFetch X listening on 0.0.0.0:${PORT}`);
});
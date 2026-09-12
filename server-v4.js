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
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 500 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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
    entry.count++;
    buckets.set(key, entry);
    if (entry.count > limit) return res.status(429).json({ ok: false, error: "Too many requests. Try again shortly." });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of buckets) if (now > value.reset) buckets.delete(key);
}, 10 * 60 * 1000).unref();

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/favicon.svg", (req, res) => res.sendFile(path.join(__dirname, "favicon.svg")));
app.get("/api/health", (req, res) => res.json({
  ok: true,
  service: "NeonFetch X",
  version: "4.0.0",
  dailymotionNative: true,
  dailymotionHlsFallback: "yt-dlp-native",
  ffmpeg: Boolean(ffmpegPath),
  timestamp: new Date().toISOString()
}));

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
  if (["localhost", "metadata.google.internal", "169.254.169.254"].some(x => host === x || host.endsWith(`.${x}`))) throw new Error("This host is not allowed.");
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error("Local/private network URLs are not allowed.");
  return u;
}

function safeName(value, fallback = "media") {
  return String(value || fallback).replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 110) || fallback;
}
function formatBytes(n) {
  if (!n || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}
function contentTypeForExt(ext) {
  return ({ mp4: "video/mp4", webm: "video/webm", m4a: "audio/mp4", mp3: "audio/mpeg", ts: "video/mp2t" })[String(ext).toLowerCase()] || "application/octet-stream";
}
function extractDailymotionId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host === "dai.ly" || host.endsWith(".dai.ly")) return u.pathname.split("/").filter(Boolean)[0] || null;
    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) return u.pathname.match(/\/video\/([a-zA-Z0-9]+)/i)?.[1] || null;
  } catch {}
  return null;
}

async function fetchDmMetadata(id) {
  const pageUrl = `https://www.dailymotion.com/video/${encodeURIComponent(id)}`;
  const metaUrl = `https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(id)}?embedder=${encodeURIComponent("https://www.dailymotion.com")}`;
  const response = await fetch(metaUrl, {
    headers: { "User-Agent": UA, "Accept": "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": pageUrl },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Dailymotion metadata returned ${response.status}.`);
  const data = await response.json();
  if (data?.error) throw new Error(`Dailymotion video is unavailable (${data.error.code || data.error.type || "unavailable"}).`);
  return data;
}
function bestDmPoster(posters) {
  if (!posters || typeof posters !== "object") return null;
  for (const key of Object.keys(posters).sort((a, b) => Number(b) - Number(a))) {
    if (/^https?:\/\//i.test(String(posters[key] || ""))) return posters[key];
  }
  return null;
}
function pickDmEntry(entries = []) {
  if (!Array.isArray(entries)) return null;
  return entries.find(x => x?.url && /mp4/i.test(`${x.type || ""} ${x.url}`) && !/m3u8/i.test(String(x.url))) ||
    entries.find(x => x?.url && /mpegurl|m3u8/i.test(`${x.type || ""} ${x.url}`)) ||
    entries.find(x => x?.url) || null;
}

async function inspectDailymotion(id) {
  const data = await fetchDmMetadata(id);
  const qualities = data?.qualities && typeof data.qualities === "object" ? data.qualities : {};
  const title = safeName(data?.title || `Dailymotion ${id}`);
  const formats = Object.keys(qualities).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => b - a).map(q => {
    const e = pickDmEntry(qualities[String(q)]);
    if (!e?.url) return null;
    return { id: `dm-${q}`, label: `${q}p`, quality: `${q}p`, ext: "mp4", size: null, type: "video", downloadUrl: `/api/download?mode=dailymotion&id=${encodeURIComponent(id)}&quality=${q}&name=${encodeURIComponent(`${title} - ${q}p.mp4`)}` };
  }).filter(Boolean);
  if (!formats.length && pickDmEntry(qualities.auto)) formats.push({ id: "dm-auto", label: "Best available", quality: "Auto", ext: "mp4", size: null, type: "video", downloadUrl: `/api/download?mode=dailymotion&id=${encodeURIComponent(id)}&quality=auto&name=${encodeURIComponent(`${title}.mp4`)}` });
  if (!formats.length) throw new Error("Dailymotion did not expose a downloadable public stream for this video.");
  return { ok: true, engine: "dailymotion-native-v4", title, uploader: safeName(data?.owner?.screenname || data?.owner?.username || "Dailymotion", "Dailymotion"), thumbnail: bestDmPoster(data?.posters), duration: Number(data?.duration || 0) || null, sourceHost: "dailymotion.com", formats };
}

async function inspectDirect(rawUrl) {
  let r;
  try { r = await fetch(rawUrl, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) }); } catch {}
  if (!r?.ok || !r.headers.get("content-type")) return null;
  const type = String(r.headers.get("content-type") || "").toLowerCase();
  if (!/^(video|audio|image)\//.test(type) && !type.startsWith("application/octet-stream")) return null;
  const len = Number(r.headers.get("content-length") || 0);
  if (len && len > MAX_BYTES) throw new Error("File is larger than the 500 MB limit.");
  const u = new URL(rawUrl);
  const filename = safeName(decodeURIComponent(path.basename(u.pathname)) || "download");
  return { ok: true, engine: "direct", title: filename, uploader: u.hostname, thumbnail: null, duration: null, sourceHost: u.hostname, formats: [{ id: "direct", label: "Original quality", quality: "Original", ext: path.extname(filename).slice(1) || "file", size: formatBytes(len), type: type.startsWith("audio/") ? "audio" : "video", downloadUrl: `/api/download?mode=direct&url=${encodeURIComponent(rawUrl)}` }] };
}

async function inspectGeneric(rawUrl) {
  const output = await youtubedl(rawUrl, { dumpSingleJson: true, skipDownload: true, noPlaylist: true, noWarnings: true, quiet: true, ffmpegLocation: ffmpegPath || undefined, socketTimeout: 15, retries: 1, fragmentRetries: 1 }, { timeout: 35000 });
  const info = typeof output === "string" ? JSON.parse(output) : output;
  if (!info) throw new Error("No media information returned.");
  if (info?._type === "playlist" || Array.isArray(info?.entries)) throw new Error("Playlists and bulk downloads are not supported.");
  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) throw new Error("Private, paid, subscriber-only, or login-required media is not supported.");
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) throw new Error("Live streams are not supported.");
  if (Number(info?.age_limit || 0) >= 18) throw new Error("Age-restricted media is not supported without an official authenticated workflow.");
  const src = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(src.filter(f => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none").map(f => Number(f.height || 0)).filter(Boolean))].sort((a, b) => b - a).slice(0, 8);
  const title = safeName(info.title || "media");
  const formats = heights.map(h => ({ id: `best-${h}`, label: `${h}p`, quality: `${h}p`, ext: "mp4", size: null, type: "video", downloadUrl: `/api/download?mode=generic&url=${encodeURIComponent(rawUrl)}&height=${h}&name=${encodeURIComponent(`${title} - ${h}p.mp4`)}` }));
  if (src.some(f => f?.url && !f.has_drm && f.acodec && f.acodec !== "none")) formats.push({ id: "audio", label: "Best audio", quality: "Audio", ext: "m4a", size: null, type: "audio", downloadUrl: `/api/download?mode=generic-audio&url=${encodeURIComponent(rawUrl)}&name=${encodeURIComponent(`${title} - audio.m4a`)}` });
  if (!formats.length) throw new Error("No downloadable non-DRM format was found.");
  return { ok: true, engine: "yt-dlp", title, uploader: safeName(info.uploader || info.channel || new URL(rawUrl).hostname), thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null, duration: Number(info.duration || 0) || null, sourceHost: new URL(rawUrl).hostname, formats };
}

app.post("/api/inspect", rateLimit(30, 10 * 60 * 1000), async (req, res) => {
  const rawUrl = String(req.body?.url || "").trim();
  try {
    if (!rawUrl) throw new Error("Paste a video or media URL first.");
    await validateUrl(rawUrl);
    const dmId = extractDailymotionId(rawUrl);
    if (dmId) return res.json(await inspectDailymotion(dmId));
    const direct = await inspectDirect(rawUrl).catch(() => null);
    if (direct) return res.json(direct);
    return res.json(await inspectGeneric(rawUrl));
  } catch (err) {
    console.error(`[inspect] ${rawUrl}:`, err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || "Unable to inspect this URL." });
  }
});

async function sendFileAndCleanup(filePath, filename, res, cleanupFiles = [filePath]) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_BYTES) throw new Error("Prepared file is larger than the 500 MB limit.");
  const ext = path.extname(filePath).slice(1) || "bin";
  const base = safeName(filename || `media.${ext}`).replace(/\.[^.]+$/, "");
  const finalName = `${base}.${ext}`;
  res.setHeader("Content-Type", contentTypeForExt(ext));
  res.setHeader("Content-Disposition", `attachment; filename="${finalName}"`);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-store");
  const stream = fs.createReadStream(filePath);
  const cleanup = () => Promise.all(cleanupFiles.map(f => fsp.unlink(f).catch(() => {})));
  stream.on("error", async () => { await cleanup(); if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.on("close", cleanup);
  return stream.pipe(res);
}

async function proxyDirect(rawUrl, res, filenameOverride = null, referer = null) {
  const headers = { "User-Agent": UA };
  if (referer) headers.Referer = referer;
  const upstream = await fetch(rawUrl, { method: "GET", redirect: "follow", headers, signal: AbortSignal.timeout(60000) });
  if (!upstream.ok) throw new Error(`Remote server returned ${upstream.status}.`);
  const len = Number(upstream.headers.get("content-length") || 0);
  if (len && len > MAX_BYTES) throw new Error("File is larger than the 500 MB limit.");
  const type = upstream.headers.get("content-type") || "application/octet-stream";
  const filename = safeName(filenameOverride || path.basename(new URL(rawUrl).pathname) || "download");
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  if (!upstream.body) throw new Error("No response body.");
  return Readable.fromWeb(upstream.body).pipe(res);
}

async function runFfmpegToFile(inputUrl, outputPath, referer) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  await new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-user_agent", UA,
      "-headers", `Referer: ${referer}\r\nOrigin: https://www.dailymotion.com\r\n`,
      "-i", inputUrl,
      "-map", "0:v?", "-map", "0:a?",
      "-c", "copy", "-movflags", "+faststart", "-y", outputPath
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { if (err.length < 8000) err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${err.trim() || "FFmpeg terminated"} (code=${code}, signal=${signal || "none"})`)));
  });
}

async function runYtdlpHlsNative(inputUrl, referer, filename, res) {
  const token = `neonfetch-hls-${randomUUID()}`;
  const template = path.join(os.tmpdir(), `${token}.%(ext)s`);
  let files = [];
  try {
    console.log(`[download] HLS native fallback: ${inputUrl.slice(0, 100)}`);
    await youtubedl(inputUrl, {
      output: template,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      hlsPreferNative: true,
      fixup: "never",
      retries: 3,
      fragmentRetries: 3,
      concurrentFragments: 1,
      maxFilesize: "500M",
      addHeader: [`Referer:${referer}`, "Origin:https://www.dailymotion.com", `User-Agent:${UA}`]
    }, { timeout: 180000 });
    files = (await fsp.readdir(os.tmpdir())).filter(x => x.startsWith(`${token}.`) && !x.endsWith(".part")).map(x => path.join(os.tmpdir(), x));
    if (!files.length) throw new Error("Native HLS downloader produced no file.");
    return sendFileAndCleanup(files[0], filename, res, files);
  } catch (err) {
    if (!files.length) files = (await fsp.readdir(os.tmpdir()).catch(() => [])).filter(x => x.startsWith(`${token}.`)).map(x => path.join(os.tmpdir(), x));
    await Promise.all(files.map(f => fsp.unlink(f).catch(() => {})));
    throw err;
  }
}

async function runYtdlpToFile(url, selector, ext, name, res) {
  const token = `neonfetch-${randomUUID()}`;
  const template = path.join(os.tmpdir(), `${token}.%(ext)s`);
  let files = [];
  try {
    await youtubedl(url, { format: selector, output: template, noPlaylist: true, noWarnings: true, quiet: true, ffmpegLocation: ffmpegPath || undefined, mergeOutputFormat: ext === "mp4" ? "mp4" : undefined, maxFilesize: "500M", socketTimeout: 25, retries: 2, fragmentRetries: 2, concurrentFragments: 1 }, { timeout: 180000 });
    files = (await fsp.readdir(os.tmpdir())).filter(x => x.startsWith(`${token}.`) && !x.endsWith(".part")).map(x => path.join(os.tmpdir(), x));
    if (!files.length) throw new Error("The selected quality could not be prepared.");
    return sendFileAndCleanup(files[0], name, res, files);
  } catch (err) {
    if (!files.length) files = (await fsp.readdir(os.tmpdir()).catch(() => [])).filter(x => x.startsWith(`${token}.`)).map(x => path.join(os.tmpdir(), x));
    await Promise.all(files.map(f => fsp.unlink(f).catch(() => {})));
    throw err;
  }
}

async function downloadDm(id, quality, name, res) {
  const data = await fetchDmMetadata(id);
  const q = String(quality || "auto");
  const entry = pickDmEntry(data?.qualities?.[q] || (q === "auto" ? data?.qualities?.auto : null));
  if (!entry?.url) throw new Error(`Dailymotion quality ${q} is no longer available.`);
  const referer = `https://www.dailymotion.com/video/${id}`;
  const filename = safeName(name || `${safeName(data?.title || id)} - ${q}.mp4`);
  const isHls = /\.m3u8(?:\?|$)/i.test(entry.url) || /mpegurl/i.test(String(entry.type || ""));
  if (!isHls) return proxyDirect(entry.url, res, filename, referer);

  const token = `neonfetch-dm-${randomUUID()}`;
  const outputPath = path.join(os.tmpdir(), `${token}.mp4`);
  try {
    console.log(`[download] Dailymotion ${id}: FFmpeg ${q}`);
    await runFfmpegToFile(entry.url, outputPath, referer);
    return await sendFileAndCleanup(outputPath, filename, res, [outputPath]);
  } catch (ffErr) {
    await fsp.unlink(outputPath).catch(() => {});
    console.error(`[download] Dailymotion ${id}: FFmpeg failed: ${ffErr?.message || ffErr}`);
    if (res.headersSent) throw ffErr;
    try {
      return await runYtdlpHlsNative(entry.url, referer, filename, res);
    } catch (hlsErr) {
      throw new Error(`Dailymotion FFmpeg failed: ${ffErr?.message || ffErr}; HLS-native fallback failed: ${hlsErr?.message || hlsErr}`);
    }
  }
}

app.get("/api/download", rateLimit(50, 10 * 60 * 1000), async (req, res) => {
  const mode = String(req.query.mode || "");
  try {
    if (mode === "dailymotion") {
      const id = String(req.query.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
      if (!id) throw new Error("Missing Dailymotion video ID.");
      return await downloadDm(id, String(req.query.quality || "auto"), String(req.query.name || ""), res);
    }
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl) throw new Error("Missing media URL.");
    await validateUrl(rawUrl);
    if (mode === "direct") return proxyDirect(rawUrl, res);
    if (mode === "generic") {
      const h = Math.max(144, Math.min(2160, Number(req.query.height || 720)));
      return runYtdlpToFile(rawUrl, `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]`, "mp4", String(req.query.name || ""), res);
    }
    if (mode === "generic-audio") return runYtdlpToFile(rawUrl, "ba[ext=m4a]/ba", "m4a", String(req.query.name || ""), res);
    throw new Error("Invalid download mode.");
  } catch (err) {
    console.error(`[download] ${mode}:`, err?.message || err);
    if (!res.headersSent) res.status(400).json({ ok: false, error: err?.message || "Download failed." });
    else res.destroy();
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));
app.listen(PORT, "0.0.0.0", () => console.log(`NeonFetch X v4 listening on 0.0.0.0:${PORT}`));

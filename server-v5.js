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
  version: "5.0.0",
  dailymotionEngine: "node-native-hls",
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

function getCookieHeader(headers) {
  try {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    if (values.length) return values.map(v => v.split(";", 1)[0]).join("; ");
  } catch {}
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=\s*[^;,]+=)/).map(v => v.split(";", 1)[0]).join("; ") : "";
}

async function fetchDmMetadata(id) {
  const pageUrl = `https://www.dailymotion.com/video/${encodeURIComponent(id)}`;
  const metaUrl = `https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(id)}?embedder=${encodeURIComponent("https://www.dailymotion.com")}`;
  const response = await fetch(metaUrl, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": pageUrl
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Dailymotion metadata returned ${response.status}.`);
  const data = await response.json();
  if (data?.error) throw new Error(`Dailymotion video is unavailable (${data.error.code || data.error.type || "unavailable"}).`);
  return { data, cookie: getCookieHeader(response.headers) };
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
  const { data } = await fetchDmMetadata(id);
  const qualities = data?.qualities && typeof data.qualities === "object" ? data.qualities : {};
  const title = safeName(data?.title || `Dailymotion ${id}`);
  const formats = Object.keys(qualities).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => b - a).map(q => {
    const e = pickDmEntry(qualities[String(q)]);
    if (!e?.url) return null;
    return { id: `dm-${q}`, label: `${q}p`, quality: `${q}p`, ext: "mp4", size: null, type: "video", downloadUrl: `/api/download?mode=dailymotion&id=${encodeURIComponent(id)}&quality=${q}&name=${encodeURIComponent(`${title} - ${q}p.mp4`)}` };
  }).filter(Boolean);
  if (!formats.length && pickDmEntry(qualities.auto)) formats.push({ id: "dm-auto", label: "Best available", quality: "Auto", ext: "mp4", size: null, type: "video", downloadUrl: `/api/download?mode=dailymotion&id=${encodeURIComponent(id)}&quality=auto&name=${encodeURIComponent(`${title}.mp4`)}` });
  if (!formats.length) throw new Error("Dailymotion did not expose a downloadable public stream for this video.");
  return { ok: true, engine: "dailymotion-node-hls", title, uploader: safeName(data?.owner?.screenname || data?.owner?.username || "Dailymotion", "Dailymotion"), thumbnail: bestDmPoster(data?.posters), duration: Number(data?.duration || 0) || null, sourceHost: "dailymotion.com", formats };
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
  const cleanup = () => Promise.all(cleanupFiles.map(f => fsp.rm(f, { recursive: true, force: true }).catch(() => {})));
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

function dmResourceHeaders(referer, cookie = "") {
  const h = {
    "User-Agent": UA,
    "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,video/mp4,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": referer,
    "Origin": "https://www.dailymotion.com"
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

async function fetchDmResource(rawUrl, referer, cookie = "", extraHeaders = {}, maxRedirects = 5) {
  let current = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    await validateUrl(current);
    const response = await fetch(current, {
      headers: { ...dmResourceHeaders(referer, cookie), ...extraHeaders },
      redirect: "manual",
      signal: AbortSignal.timeout(30000)
    });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) throw new Error(`Dailymotion redirect ${response.status} had no Location header.`);
      current = new URL(loc, current).href;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("Too many Dailymotion redirects.");
}

function parseAttrList(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(input))) out[m[1].toUpperCase()] = String(m[2] || "").replace(/^"|"$/g, "");
  return out;
}

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(x => x.trim());
  const audioGroups = new Map();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const attrs = parseAttrList(line.slice("#EXT-X-MEDIA:".length));
    if (String(attrs.TYPE || "").toUpperCase() === "AUDIO" && attrs["GROUP-ID"] && attrs.URI) {
      const list = audioGroups.get(attrs["GROUP-ID"]) || [];
      list.push({ uri: new URL(attrs.URI, baseUrl).href, isDefault: String(attrs.DEFAULT || "").toUpperCase() === "YES" });
      audioGroups.set(attrs["GROUP-ID"], list);
    }
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttrList(lines[i].slice("#EXT-X-STREAM-INF:".length));
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j]) continue;
      if (!lines[j].startsWith("#")) { uri = new URL(lines[j], baseUrl).href; break; }
    }
    if (!uri) continue;
    const res = String(attrs.RESOLUTION || "").match(/(\d+)x(\d+)/i);
    variants.push({
      uri,
      height: res ? Number(res[2]) : 0,
      bandwidth: Number(attrs.BANDWIDTH || 0),
      audioGroup: attrs.AUDIO || null
    });
  }
  return { variants, audioGroups };
}

function chooseVariant(variants, quality) {
  if (!variants.length) return null;
  const sorted = [...variants].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  if (!/^\d+$/.test(String(quality))) return sorted[0];
  const target = Number(quality);
  return sorted.find(v => v.height && v.height <= target) || sorted.at(-1);
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(x => x.trim());
  let initUrl = null;
  let pendingRange = null;
  let previousRangeEnd = 0;
  const segments = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
      if (String(attrs.METHOD || "NONE").toUpperCase() !== "NONE") throw new Error("Encrypted HLS is not supported.");
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) initUrl = new URL(attrs.URI, baseUrl).href;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = line.slice("#EXT-X-BYTERANGE:".length).trim();
    } else if (!line.startsWith("#")) {
      let range = null;
      if (pendingRange) {
        const [lenRaw, offRaw] = pendingRange.split("@");
        const length = Number(lenRaw);
        const offset = offRaw !== undefined ? Number(offRaw) : previousRangeEnd;
        if (Number.isFinite(length) && Number.isFinite(offset) && length > 0) {
          range = { start: offset, end: offset + length - 1 };
          previousRangeEnd = offset + length;
        }
        pendingRange = null;
      }
      segments.push({ url: new URL(line, baseUrl).href, range });
    }
  }
  return { initUrl, segments };
}

async function fetchTextDm(url, referer, cookie) {
  const { response, finalUrl } = await fetchDmResource(url, referer, cookie);
  if (!response.ok) throw new Error(`Dailymotion HLS returned ${response.status} for ${new URL(finalUrl).hostname}.`);
  return { text: await response.text(), finalUrl };
}

async function appendDmObject(url, outputPath, referer, cookie, state, range = null) {
  const extra = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
  const { response, finalUrl } = await fetchDmResource(url, referer, cookie, extra);
  if (!response.ok && response.status !== 206) throw new Error(`Dailymotion segment returned ${response.status} from ${new URL(finalUrl).hostname}.`);
  const buf = Buffer.from(await response.arrayBuffer());
  state.total += buf.length;
  if (state.total > MAX_BYTES) throw new Error("Prepared file is larger than the 500 MB limit.");
  await fsp.appendFile(outputPath, buf);
  if (!state.contentType) state.contentType = response.headers.get("content-type") || "";
}

async function downloadMediaPlaylist(mediaUrl, referer, cookie, workDir, label) {
  const { text, finalUrl } = await fetchTextDm(mediaUrl, referer, cookie);
  if (text.includes("#EXT-X-STREAM-INF")) throw new Error("Unexpected nested HLS master playlist.");
  const parsed = parseMediaPlaylist(text, finalUrl);
  if (!parsed.segments.length) throw new Error("Dailymotion HLS playlist contained no media segments.");

  const firstPath = new URL(parsed.segments[0].url).pathname.toLowerCase();
  const likelyFmp4 = Boolean(parsed.initUrl) || /\.(m4s|mp4)$/.test(firstPath);
  const ext = likelyFmp4 ? "mp4" : "ts";
  const outputPath = path.join(workDir, `${label}.${ext}`);
  await fsp.writeFile(outputPath, Buffer.alloc(0));
  const state = { total: 0, contentType: "" };
  if (parsed.initUrl) await appendDmObject(parsed.initUrl, outputPath, referer, cookie, state);
  for (let i = 0; i < parsed.segments.length; i++) {
    await appendDmObject(parsed.segments[i].url, outputPath, referer, cookie, state, parsed.segments[i].range);
    if ((i + 1) % 25 === 0) console.log(`[download] Dailymotion HLS ${label}: ${i + 1}/${parsed.segments.length} segments`);
  }
  return { filePath: outputPath, ext, bytes: state.total };
}

async function runLocalRemux(videoPath, audioPath, outputPath) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for local remux.");
  await new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-i", videoPath];
    if (audioPath) args.push("-i", audioPath, "-map", "0:v?", "-map", "1:a?");
    else args.push("-map", "0:v?", "-map", "0:a?");
    args.push("-c", "copy", "-movflags", "+faststart", "-y", outputPath);
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { if (err.length < 8000) err += d.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${err.trim() || "FFmpeg local remux terminated"} (code=${code}, signal=${signal || "none"})`)));
  });
}

async function downloadHlsNative(entryUrl, quality, referer, cookie, filename, res) {
  const workDir = path.join(os.tmpdir(), `neonfetch-dm-${randomUUID()}`);
  await fsp.mkdir(workDir, { recursive: true });
  try {
    const first = await fetchTextDm(entryUrl, referer, cookie);
    let videoUrl = first.finalUrl;
    let audioUrl = null;
    let firstText = first.text;
    if (firstText.includes("#EXT-X-STREAM-INF")) {
      const master = parseMasterPlaylist(firstText, first.finalUrl);
      const selected = chooseVariant(master.variants, quality);
      if (!selected) throw new Error("Dailymotion HLS master had no playable variants.");
      videoUrl = selected.uri;
      if (selected.audioGroup && master.audioGroups.has(selected.audioGroup)) {
        const options = master.audioGroups.get(selected.audioGroup);
        audioUrl = (options.find(x => x.isDefault) || options[0])?.uri || null;
      }
      console.log(`[download] Dailymotion HLS selected ${selected.height || "auto"}p audio=${Boolean(audioUrl)}`);
    }

    const video = await downloadMediaPlaylist(videoUrl, referer, cookie, workDir, "video");
    let audio = null;
    if (audioUrl) audio = await downloadMediaPlaylist(audioUrl, referer, cookie, workDir, "audio");

    if (video.ext === "mp4" && !audio) return sendFileAndCleanup(video.filePath, filename, res, [workDir]);

    const mp4Path = path.join(workDir, "final.mp4");
    try {
      await runLocalRemux(video.filePath, audio?.filePath || null, mp4Path);
      return sendFileAndCleanup(mp4Path, filename, res, [workDir]);
    } catch (remuxErr) {
      console.error(`[download] local remux failed: ${remuxErr?.message || remuxErr}`);
      if (audio) throw new Error(`Downloaded HLS video/audio but local MP4 remux failed: ${remuxErr?.message || remuxErr}`);
      return sendFileAndCleanup(video.filePath, String(filename || "video.mp4").replace(/\.mp4$/i, ".ts"), res, [workDir]);
    }
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
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
    await Promise.all(files.map(f => fsp.rm(f, { recursive: true, force: true }).catch(() => {})));
    throw err;
  }
}

async function downloadDm(id, quality, name, res) {
  const { data, cookie } = await fetchDmMetadata(id);
  const q = String(quality || "auto");
  const entry = pickDmEntry(data?.qualities?.[q] || (q === "auto" ? data?.qualities?.auto : null));
  if (!entry?.url) throw new Error(`Dailymotion quality ${q} is no longer available.`);
  const referer = `https://www.dailymotion.com/video/${id}`;
  const filename = safeName(name || `${safeName(data?.title || id)} - ${q}.mp4`);
  const isHls = /\.m3u8(?:\?|$)/i.test(entry.url) || /mpegurl/i.test(String(entry.type || ""));
  if (!isHls) return proxyDirect(entry.url, res, filename, referer);
  console.log(`[download] Dailymotion ${id}: Node HLS ${q}`);
  return downloadHlsNative(entry.url, q, referer, cookie, filename, res);
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
app.listen(PORT, "0.0.0.0", () => console.log(`NeonFetch X v5 listening on 0.0.0.0:${PORT}`));

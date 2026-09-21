import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const previousYtdlp = require(modulePath);

function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function readWorkerUrl() {
  const raw = String(process.env.YOUTUBE_DENO_WORKER || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") throw new Error("worker must use HTTPS");
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch (err) {
    console.error(`[deno-youtube] YOUTUBE_DENO_WORKER ignored: ${err?.message || err}`);
    return "";
  }
}

const WORKER = readWorkerUrl();
if (WORKER) console.log(`[deno-youtube] Deno YouTube worker enabled (${new URL(WORKER).hostname}).`);
else console.log("[deno-youtube] Deno YouTube worker not configured; Render YouTube engine remains active.");

function workerToYtdlpInfo(data) {
  const formats = [];
  for (const item of Array.isArray(data?.formats) ? data.formats : []) {
    const height = Number(String(item?.quality || item?.label || "").match(/(\d{3,4})p/i)?.[1] || 0);
    if (item?.type === "audio") {
      formats.push({
        format_id: item.id || "deno-audio",
        url: item.downloadUrl,
        ext: item.ext === "file" ? "m4a" : (item.ext || "m4a"),
        vcodec: "none",
        acodec: "aac"
      });
    } else if (height) {
      formats.push({
        format_id: item.id || `deno-${height}`,
        url: item.downloadUrl,
        ext: item.ext || "mp4",
        height,
        vcodec: "h264",
        acodec: "aac"
      });
    }
  }
  return {
    id: "deno-youtube",
    title: data?.title || "YouTube video",
    uploader: data?.uploader || "YouTube",
    channel: data?.uploader || "YouTube",
    thumbnail: data?.thumbnail || null,
    duration: data?.duration || null,
    availability: "public",
    webpage_url_domain: "youtube.com",
    formats
  };
}

async function fetchJson(url, init, timeout = 90000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Deno worker returned non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok || !data?.ok) throw new Error(data?.error || `Deno worker returned HTTP ${response.status}.`);
  return data;
}

async function inspectThroughDeno(url) {
  console.warn("[deno-youtube] Routing YouTube inspection through Deno Deploy.");
  const data = await fetchJson(`${WORKER}/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  }, 100000);
  return JSON.stringify(workerToYtdlpInfo(data));
}

function downloadMode(flags = {}) {
  const selector = String(flags.format || "");
  const audio = /^ba(?:\[|\/|$)/i.test(selector.trim()) && !/bv/i.test(selector);
  const height = Number(selector.match(/height<=([0-9]+)/i)?.[1] || 720);
  return { audio, height: Math.max(144, Math.min(4320, height || 720)) };
}

function extFromResponse(response, audio) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?[^";]+\.([a-z0-9]{2,5})/i);
  if (match) return match[1].toLowerCase();
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("audio/mp4")) return "m4a";
  if (type.includes("webm")) return "webm";
  if (type.includes("video/mp4")) return "mp4";
  return audio ? "m4a" : "mp4";
}

async function downloadThroughDeno(url, flags = {}) {
  const outputTemplate = String(flags.output || "");
  if (!outputTemplate) throw new Error("Deno YouTube download requires an output template.");
  const { audio, height } = downloadMode(flags);
  const endpoint = new URL(`${WORKER}/download`);
  endpoint.searchParams.set("url", String(url));
  endpoint.searchParams.set("mode", audio ? "audio" : "video");
  if (!audio) endpoint.searchParams.set("height", String(height));
  endpoint.searchParams.set("name", audio ? "youtube-audio.m4a" : `youtube-${height}p.mp4`);

  console.warn(`[deno-youtube] Routing YouTube ${audio ? "audio" : `${height}p video`} download through Deno Deploy.`);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(9 * 60 * 1000) });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let message = text;
    try { message = JSON.parse(text)?.error || text; } catch {}
    throw new Error(message || `Deno download failed with HTTP ${response.status}.`);
  }

  const ext = extFromResponse(response, audio);
  const filePath = outputTemplate.includes("%(ext)s")
    ? outputTemplate.replace(/%\(ext\)s/g, ext)
    : outputTemplate;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  return filePath;
}

async function patchedYtdlp(url, flags = {}, options = {}) {
  if (!WORKER || !isYouTubeUrl(url)) return previousYtdlp(url, flags, options);
  try {
    if (flags.dumpSingleJson || flags.skipDownload) return await inspectThroughDeno(url);
    return await downloadThroughDeno(url, flags);
  } catch (err) {
    console.error(`[deno-youtube] Deno route failed, falling back to Render engine: ${err?.message || err}`);
    return previousYtdlp(url, flags, options);
  }
}

Object.assign(patchedYtdlp, previousYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

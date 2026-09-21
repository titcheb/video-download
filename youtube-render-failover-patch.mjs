import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const previousYtdlp = require(modulePath);

const MAX_BYTES = 500 * 1024 * 1024;
const workerToken = String(process.env.YOUTUBE_WORKER_TOKEN || "").trim();
const workers = String(process.env.YOUTUBE_RENDER_WORKERS || "")
  .split(",")
  .map(x => x.trim().replace(/\/+$/, ""))
  .filter(x => /^https:\/\/[a-z0-9.-]+$/i.test(x));

function isYouTubeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function shortText(value, max = 280) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function responseError(response) {
  const text = await response.text().catch(() => "");
  try {
    const data = JSON.parse(text);
    return String(data?.error || text || `HTTP ${response.status}`);
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

function safeExt(value, fallback = "mp4") {
  const ext = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return ext || fallback;
}

function requestExt(flags = {}) {
  if (flags.mergeOutputFormat) return safeExt(flags.mergeOutputFormat, "mp4");
  const selector = String(flags.format || "");
  if (/^ba(?:\[|\/|$)/i.test(selector.trim()) && !/bv/i.test(selector)) return "m4a";
  return "mp4";
}

async function inspectViaWorker(base, url, options = {}) {
  const timeout = Math.max(Number(options?.timeout || 0), 150000);
  const response = await fetch(`${base}/v1/inspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-NanoFetch-Worker-Token": workerToken
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  if (!data?.ok || typeof data.output !== "string" || !data.output.trim()) {
    throw new Error("Render worker returned invalid YouTube metadata.");
  }
  return data.output;
}

async function downloadViaWorker(base, url, flags = {}, options = {}) {
  const selector = String(flags.format || "").trim();
  const outputTemplate = String(flags.output || "").trim();
  if (!selector || !outputTemplate) throw new Error("Render worker download requires format and output parameters.");

  const ext = requestExt(flags);
  const timeout = Math.max(Number(options?.timeout || 0), 7 * 60 * 1000);
  const response = await fetch(`${base}/v1/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-NanoFetch-Worker-Token": workerToken
    },
    body: JSON.stringify({ url, selector, ext }),
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error("Render worker returned an empty download stream.");

  const length = Number(response.headers.get("content-length") || 0);
  if (length && length > MAX_BYTES) throw new Error("Render worker file exceeds the 500 MB limit.");

  const returnedExt = safeExt(response.headers.get("x-nanofetch-ext"), ext);
  const targetPath = outputTemplate.includes("%(ext)s")
    ? outputTemplate.replace("%(ext)s", returnedExt)
    : outputTemplate;

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.rm(targetPath, { force: true }).catch(() => {});

  let total = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > MAX_BYTES) callback(new Error("Render worker stream exceeded the 500 MB limit."));
      else callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(targetPath));
  } catch (err) {
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    throw err;
  }

  return "";
}

async function runWorker(base, url, flags = {}, options = {}) {
  const inspectMode = Boolean(flags.dumpSingleJson || flags.skipDownload);
  return inspectMode
    ? inspectViaWorker(base, url, options)
    : downloadViaWorker(base, url, flags, options);
}

async function patchedYtdlp(url, flags = {}, options = {}) {
  if (!isYouTubeUrl(url) || !workers.length || !workerToken) {
    return previousYtdlp(url, flags, options);
  }

  const errors = [];
  for (const worker of workers) {
    try {
      console.warn(`[youtube-render] Trying YouTube through Render failover worker ${new URL(worker).hostname}.`);
      const result = await runWorker(worker, url, flags, options);
      console.log(`[youtube-render] YouTube request succeeded through ${new URL(worker).hostname}.`);
      return result;
    } catch (err) {
      errors.push(`${new URL(worker).hostname}: ${shortText(err?.message || err)}`);
      console.warn(`[youtube-render] Worker failed: ${shortText(err?.message || err, 360)}`);
    }
  }

  console.warn(`[youtube-render] All configured workers failed; falling back to primary Render region. ${errors.join(" | ")}`);
  return previousYtdlp(url, flags, options);
}

Object.assign(patchedYtdlp, previousYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

if (workers.length && workerToken) {
  console.log(`[youtube-render] Multi-region YouTube failover enabled with ${workers.length} worker(s).`);
}

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_BYTES = 500 * 1024 * 1024;
const WORKER_TOKEN = String(process.env.YOUTUBE_WORKER_TOKEN || "").trim();
const PYDEPS = path.join(process.cwd(), "pydeps");
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

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

function shortError(err, max = 260) {
  const text = String(err?.stderr || err?.message || err || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function pythonEnv() {
  return {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${PYDEPS}${path.delimiter}${process.env.PYTHONPATH}` : PYDEPS,
    YTDLP_NO_PLUGINS: "1"
  };
}

function toCliFlag(key) {
  return `--${String(key).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase()}`;
}

function flagsToArgs(flags = {}) {
  const args = ["--ignore-config", "--no-cache-dir"];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = toCliFlag(key);
    if (value === true) args.push(flag);
    else if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else args.push(flag, String(value));
  }
  return args;
}

function spawnCaptured(command, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: pythonEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const max = 24 * 1024 * 1024;
    child.stdout.on("data", d => { if (stdout.length < max) stdout += d.toString(); });
    child.stderr.on("data", d => { if (stderr.length < max) stderr += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", err => {
      clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const err = new Error(stderr.trim() || `${command} exited with code ${code}${signal ? ` (${signal})` : ""}`);
      err.stderr = stderr;
      err.stdout = stdout;
      err.exitCode = code;
      reject(err);
    });
  });
}

function baseFlags() {
  return {
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    userAgent: DEFAULT_UA,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 20,
    retries: 2,
    fragmentRetries: 2,
    extractorRetries: 2,
    sleepRequests: 1
  };
}

async function runYtdlp(url, flags, timeout) {
  return spawnCaptured("python3", ["-m", "yt_dlp", ...flagsToArgs(flags), String(url)], timeout);
}

function routeFlags(route, requested = {}) {
  const common = { ...baseFlags(), ...requested };
  if (route === "chrome") return { ...common, impersonate: "chrome" };
  if (route === "safari") return {
    ...common,
    userAgent: SAFARI_UA,
    impersonate: "safari",
    extractorArgs: "youtube:player_client=web_safari"
  };
  if (route === "embedded") return {
    ...common,
    impersonate: "chrome",
    extractorArgs: "youtube:player_client=web_embedded"
  };
  if (route === "android-vr") return {
    ...common,
    impersonate: "chrome",
    extractorArgs: "youtube:player_client=android_vr"
  };
  return common;
}

async function runWithRoutes(url, requested, timeout) {
  const routes = ["chrome", "safari", "embedded", "android-vr"];
  const failures = [];
  for (const route of routes) {
    try {
      console.log(`[youtube-worker] trying ${route} route.`);
      const result = await runYtdlp(url, routeFlags(route, requested), timeout);
      console.log(`[youtube-worker] ${route} route succeeded.`);
      return result;
    } catch (err) {
      failures.push(`${route}: ${shortError(err, 150)}`);
      console.warn(`[youtube-worker] ${route} failed: ${shortError(err)}`);
    }
  }
  throw new Error(`Oregon YouTube worker failed all routes. ${failures.join(" | ")}`);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, role: "nanofetch-youtube-render-worker", region: "oregon", engine: "yt-dlp-curl-cffi" });
});

app.post("/v1/inspect", requireWorkerToken, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  try {
    if (!isYouTubeUrl(url)) throw new Error("Only public YouTube URLs are accepted by this worker.");
    const output = await runWithRoutes(url, {
      dumpSingleJson: true,
      skipDownload: true
    }, 70000);
    if (!output) throw new Error("Worker returned no YouTube metadata.");
    res.json({ ok: true, output });
  } catch (err) {
    console.error(`[youtube-worker] inspect failed: ${shortError(err, 700)}`);
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

    await runWithRoutes(url, {
      format: selector,
      output: template,
      mergeOutputFormat: requestedExt === "mp4" ? "mp4" : undefined,
      maxFilesize: "500M",
      concurrentFragments: 1
    }, 6 * 60 * 1000);

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
    if (!files.length) files = (await fsp.readdir(os.tmpdir()).catch(() => []))
      .filter(x => x.startsWith(`${token}.`))
      .map(x => path.join(os.tmpdir(), x));
    await Promise.all(files.map(f => fsp.rm(f, { force: true }).catch(() => {})));
    console.error(`[youtube-worker] download failed: ${shortError(err, 700)}`);
    if (!res.headersSent) res.status(400).json({ ok: false, error: err?.message || "Worker download failed." });
    else res.destroy();
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));
app.listen(PORT, "0.0.0.0", () => console.log(`[youtube-worker] standalone Oregon worker listening on 0.0.0.0:${PORT}`));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import chromium from "@sparticuz/chromium";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const previousYtdlp = require(modulePath);

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const PYDEPS = path.join(process.cwd(), "pydeps");
const PYTUBEFIX_BRIDGE = path.join(process.cwd(), "pytubefix_bridge.py");

function isYouTubeUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || "")).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host.endsWith(".youtu.be");
  } catch {
    return false;
  }
}

function normalizeCookieText(text) {
  const value = String(text || "").replace(/\\n/g, "\n").trim();
  if (!value) return "";
  if (/^# Netscape HTTP Cookie File/m.test(value)) return `${value}\n`;
  return `# Netscape HTTP Cookie File\n${value}\n`;
}

function cookieTextFromEnvironment() {
  const encoded = String(process.env.YOUTUBE_COOKIES_B64 || "").trim();
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      if (decoded.trim()) return normalizeCookieText(decoded);
    } catch {
      console.error("[youtube-auth] YOUTUBE_COOKIES_B64 could not be decoded.");
    }
  }
  const raw = String(process.env.YOUTUBE_COOKIES || "").trim();
  return raw ? normalizeCookieText(raw) : "";
}

function prepareCookieFile() {
  const text = cookieTextFromEnvironment();
  if (!text) return null;
  const filePath = path.join(os.tmpdir(), "nanofetch-youtube-cookies.txt");
  try {
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
    console.log("[youtube-auth] Authenticated YouTube cookies enabled.");
    return filePath;
  } catch (err) {
    console.error(`[youtube-auth] Could not prepare cookie file: ${err?.message || err}`);
    return null;
  }
}

function readYouTubeProxy() {
  const raw = String(process.env.YOUTUBE_PROXY || "").trim();
  if (!raw) return "";
  if (!/^(?:https?|socks4a?|socks5h?):\/\//i.test(raw)) {
    console.error("[youtube-auth] YOUTUBE_PROXY ignored: expected http://, https://, socks4://, socks4a://, socks5:// or socks5h:// URL.");
    return "";
  }
  try {
    const u = new URL(raw);
    console.log(`[youtube-auth] YouTube proxy enabled (${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}).`);
  } catch {
    console.log("[youtube-auth] YouTube proxy enabled.");
  }
  return raw;
}

const youtubeCookieFile = prepareCookieFile();
const youtubeProxy = readYouTubeProxy();

let wpcBrowserPath = "";
try {
  wpcBrowserPath = await chromium.executablePath();
  if (wpcBrowserPath && fs.existsSync(wpcBrowserPath)) {
    console.log(`[youtube-auth] Headless Chromium ready for isolated WPC fallback (${wpcBrowserPath}).`);
  } else {
    wpcBrowserPath = "";
  }
} catch (err) {
  console.warn(`[youtube-auth] Could not prepare headless Chromium for WPC: ${err?.message || err}`);
  wpcBrowserPath = "";
}

function pythonEnv({ allowPlugins = false } = {}) {
  const env = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${PYDEPS}${path.delimiter}${process.env.PYTHONPATH}` : PYDEPS
  };

  // yt-dlp imports every discovered plugin at startup. The WPC dependency currently
  // has a Python 3.14 import problem on Render, so normal YouTube routes must not
  // import it. Only the dedicated WPC attempt opts back into plugin loading.
  if (allowPlugins) delete env.YTDLP_NO_PLUGINS;
  else env.YTDLP_NO_PLUGINS = "1";

  return env;
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
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const max = 24 * 1024 * 1024;

    child.stdout.on("data", chunk => { if (stdout.length < max) stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { if (stderr.length < max) stderr += chunk.toString(); });

    const timeoutMs = Number(options.timeout || 180000);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

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

function runPythonYtdlp(url, flags = {}, options = {}) {
  const args = ["-m", "yt_dlp", ...flagsToArgs(flags), String(url)];
  return spawnCaptured("python3", args, {
    env: pythonEnv({ allowPlugins: options.allowPlugins === true }),
    timeout: Number(options?.timeout || 180000)
  });
}

function pytubefixMode(flags = {}) {
  const selector = String(flags.format || "");
  const audioOnly = /^ba(?:\[|\/|$)/i.test(selector.trim()) && !/bv/i.test(selector);
  const heightMatch = selector.match(/height<=([0-9]+)/i);
  return {
    audioOnly,
    maxHeight: heightMatch ? Math.max(144, Math.min(2160, Number(heightMatch[1]))) : 720
  };
}

async function runPytubefix(url, flags = {}, options = {}) {
  if (!fs.existsSync(PYTUBEFIX_BRIDGE)) {
    throw new Error(`pytubefix bridge is unavailable at ${PYTUBEFIX_BRIDGE}`);
  }

  const inspectMode = Boolean(flags.dumpSingleJson || flags.skipDownload);
  const args = [PYTUBEFIX_BRIDGE];
  if (inspectMode) {
    args.push("inspect", String(url));
  } else {
    const output = String(flags.output || "");
    if (!output) throw new Error("pytubefix fallback requires an output template");
    const { audioOnly, maxHeight } = pytubefixMode(flags);
    args.push("download", String(url), output, audioOnly ? "audio" : "video", String(maxHeight));
  }

  console.warn(`[youtube-auth] Fallback: pytubefix (${inspectMode ? "inspect" : "download"})${youtubeProxy ? " through YOUTUBE_PROXY" : ""}.`);
  return spawnCaptured("python3", args, {
    env: pythonEnv(),
    timeout: Math.max(Number(options?.timeout || 180000), inspectMode ? 60000 : 180000)
  });
}

function errorText(err) {
  return String(err?.stderr || err?.message || err || "");
}

function shortError(err, max = 180) {
  const text = errorText(err).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isPlayerAvailabilityError(err) {
  return /video unavailable|page needs to be reloaded|playability status|this content isn.?t available|try again later/i.test(errorText(err));
}

function isAuthenticationError(err) {
  return /sign in to confirm you.?re not a bot|confirm you.?re not a bot|detected as a bot|login required|use --cookies|cookies-from-browser|authentication|account.?required|please sign in/i.test(errorText(err));
}

function isBotDetectionError(err) {
  return /detected as a bot|confirm you.?re not a bot|sign in to confirm you.?re not a bot/i.test(errorText(err));
}

function isInfrastructureError(err) {
  return /error while importing module|syntaxerror|non-utf-8 code|modulenotfounderror|traceback \(most recent call last\)/i.test(errorText(err));
}

function isFallbackCandidateError(err) {
  return isAuthenticationError(err) || isPlayerAvailabilityError(err) || /http error 403|forbidden|po token|proof of origin|no video formats found|requested format is not available|failed to extract/i.test(errorText(err));
}

function flagsForClient(baseFlags, client, authenticated, impersonate = "") {
  const next = {
    ...baseFlags,
    extractorArgs: `youtube:player_client=${client}`
  };
  if (!authenticated) delete next.cookies;
  if (client === "web_safari") next.userAgent = SAFARI_UA;
  if (impersonate) next.impersonate = impersonate;
  return next;
}

async function runClientFallback(url, baseFlags, options, client, authenticated = false, label = client, impersonate = "") {
  const flags = flagsForClient(baseFlags, client, authenticated, impersonate);
  const route = `${label}${impersonate ? ` + ${impersonate} TLS` : ""}${authenticated ? " + cookies" : " public"}`;
  console.warn(`[youtube-auth] Fallback: yt-dlp ${route} (plugins disabled).`);
  return runPythonYtdlp(url, flags, {
    ...options,
    allowPlugins: false,
    timeout: Math.max(Number(options?.timeout || 0), 45000)
  });
}

async function runChromeFallback(url, baseFlags, options, authenticated = false) {
  const flags = {
    ...baseFlags,
    impersonate: "chrome"
  };
  if (!authenticated) delete flags.cookies;
  console.warn(`[youtube-auth] Fallback: default YouTube client + Chrome TLS${authenticated ? " + cookies" : " public"} (plugins disabled).`);
  return runPythonYtdlp(url, flags, {
    ...options,
    allowPlugins: false,
    timeout: Math.max(Number(options?.timeout || 0), 45000)
  });
}

async function runWpcFallback(url, baseFlags, options, authenticated = false) {
  if (!wpcBrowserPath || !fs.existsSync(wpcBrowserPath)) {
    throw new Error("WPC browser fallback is unavailable because headless Chromium could not be prepared.");
  }

  const flags = {
    ...baseFlags,
    extractorArgs: [
      "youtube:player_client=mweb",
      `youtubepot-wpc:browser_path=${wpcBrowserPath}`
    ]
  };
  if (!authenticated) delete flags.cookies;

  console.warn(`[youtube-auth] Fallback: isolated mweb + WPC browser PO token${authenticated ? " + cookies" : " public"}.`);
  return runPythonYtdlp(url, flags, {
    ...options,
    allowPlugins: true,
    timeout: Math.max(Number(options?.timeout || 0), 90000)
  });
}

async function runPublicFallback(url, baseFlags, options, impersonate = "chrome") {
  const publicFlags = {
    ...baseFlags,
    extractorArgs: "youtube:player_client=tv,web_embedded,android_vr"
  };
  delete publicFlags.cookies;
  if (impersonate) publicFlags.impersonate = impersonate;
  console.warn(`[youtube-auth] Fallback: public legacy clients${impersonate ? ` + ${impersonate} TLS` : ""} (plugins disabled).`);
  return runPythonYtdlp(url, publicFlags, {
    ...options,
    allowPlugins: false,
    timeout: Math.max(Number(options?.timeout || 0), 45000)
  });
}

function rewriteYouTubeError(primaryErr, failures = []) {
  const allErrors = [primaryErr, ...failures.map(x => x.error)].filter(Boolean);
  const botCount = allErrors.filter(isBotDetectionError).length;
  const infrastructureCount = allErrors.filter(isInfrastructureError).length;

  if (botCount >= 2 && infrastructureCount === 0) {
    const methods = failures.map(x => x.name).join(", ");
    const message = youtubeProxy
      ? `YouTube rejected every NanoFetch fallback through the configured route (${methods || "all methods"}). The current egress/proxy session is still being detected as automated traffic.`
      : `YouTube is detecting the Render egress as automated traffic after the working extractor routes were tried (${methods || "all methods"}).`;
    const wrapped = new Error(message);
    wrapped.cause = failures.at(-1)?.error || primaryErr;
    return wrapped;
  }

  if (/requested format is not available/i.test(errorText(primaryErr)) && !failures.length) {
    const wrapped = new Error("The requested YouTube quality is not available for this video. Try another quality.");
    wrapped.cause = primaryErr;
    return wrapped;
  }

  if (failures.length) {
    const summary = failures.slice(-6).map(x => `${x.name}: ${shortError(x.error, 110)}`).join(" | ");
    const wrapped = new Error(`YouTube failed after NanoFetch Render fallbacks. ${summary}`);
    wrapped.cause = failures.at(-1)?.error || primaryErr;
    return wrapped;
  }

  return primaryErr;
}

async function runYouTube(url, flags = {}, options = {}) {
  const userAgent = String(process.env.YOUTUBE_USER_AGENT || "").trim() || DEFAULT_UA;
  const baseFlags = {
    ...flags,
    userAgent: flags.userAgent || userAgent,
    retries: Math.max(Number(flags.retries || 0), 3),
    fragmentRetries: Math.max(Number(flags.fragmentRetries || 0), 3),
    extractorRetries: 3,
    sleepRequests: flags.sleepRequests ?? 1
  };

  if (youtubeCookieFile) baseFlags.cookies = youtubeCookieFile;
  if (youtubeProxy && !baseFlags.proxy) baseFlags.proxy = youtubeProxy;

  try {
    // Critical: normal yt-dlp runs with all third-party plugins disabled so a
    // broken optional WPC plugin cannot poison the normal YouTube extractor.
    return await runPythonYtdlp(url, baseFlags, { ...options, allowPlugins: false });
  } catch (firstErr) {
    if (!isFallbackCandidateError(firstErr) && !isInfrastructureError(firstErr)) throw rewriteYouTubeError(firstErr);

    const failures = [];
    const attempt = async (name, fn) => {
      try {
        return { ok: true, value: await fn() };
      } catch (error) {
        failures.push({ name, error });
        console.warn(`[youtube-auth] ${name} failed: ${shortError(error, 320)}`);
        return { ok: false };
      }
    };

    if (youtubeCookieFile) {
      const chromeAuth = await attempt("chrome-tls+cookies", () => runChromeFallback(url, baseFlags, options, true));
      if (chromeAuth.ok) return chromeAuth.value;
    }

    const chromePublic = await attempt("chrome-tls", () => runChromeFallback(url, baseFlags, options, false));
    if (chromePublic.ok) return chromePublic.value;

    if (youtubeCookieFile) {
      const safariAuth = await attempt("web_safari+safari-tls+cookies", () => runClientFallback(url, baseFlags, options, "web_safari", true, "web_safari HLS", "safari"));
      if (safariAuth.ok) return safariAuth.value;
    }

    const safariPublic = await attempt("web_safari+safari-tls", () => runClientFallback(url, baseFlags, options, "web_safari", false, "web_safari HLS", "safari"));
    if (safariPublic.ok) return safariPublic.value;

    const embedded = await attempt("web_embedded+chrome-tls", () => runClientFallback(url, baseFlags, options, "web_embedded", false, "web_embedded", "chrome"));
    if (embedded.ok) return embedded.value;

    const legacy = await attempt("legacy-public+chrome-tls", () => runPublicFallback(url, baseFlags, options, "chrome"));
    if (legacy.ok) return legacy.value;

    const pytubefix = await attempt("pytubefix", () => runPytubefix(url, baseFlags, options));
    if (pytubefix.ok) return pytubefix.value;

    // WPC is isolated and deliberately last. If its Python dependency is broken,
    // it cannot affect any of the normal yt-dlp routes above.
    const wpcPublic = await attempt("mweb+wpc", () => runWpcFallback(url, baseFlags, options, false));
    if (wpcPublic.ok) return wpcPublic.value;

    if (youtubeCookieFile) {
      const wpcAuth = await attempt("mweb+wpc+cookies", () => runWpcFallback(url, baseFlags, options, true));
      if (wpcAuth.ok) return wpcAuth.value;
    }

    throw rewriteYouTubeError(firstErr, failures);
  }
}

function patchedYtdlp(url, flags = {}, options = {}) {
  if (!isYouTubeUrl(url)) return previousYtdlp(url, flags, options);
  return runYouTube(url, flags, options);
}

Object.assign(patchedYtdlp, previousYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

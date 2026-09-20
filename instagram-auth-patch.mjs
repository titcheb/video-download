import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const originalYtdlp = require(modulePath);

const IG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const PYDEPS = path.join(process.cwd(), "pydeps");

function isInstagramUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || "")).hostname.toLowerCase();
    return host === "instagram.com" || host === "www.instagram.com" || host.endsWith(".instagram.com");
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
  const encoded = String(process.env.INSTAGRAM_COOKIES_B64 || "").trim();
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      if (decoded.trim()) return normalizeCookieText(decoded);
    } catch {
      console.error("[instagram-auth] INSTAGRAM_COOKIES_B64 could not be decoded.");
    }
  }

  const raw = String(process.env.INSTAGRAM_COOKIES || "").trim();
  if (raw) return normalizeCookieText(raw);

  const sessionId = String(process.env.INSTAGRAM_SESSIONID || "").trim();
  if (!sessionId) return "";

  const csrfToken = String(process.env.INSTAGRAM_CSRFTOKEN || "").trim();
  const dsUserId = String(process.env.INSTAGRAM_DS_USER_ID || "").trim();
  const expiry = Math.floor(Date.now() / 1000) + (180 * 24 * 60 * 60);
  const lines = [
    "# Netscape HTTP Cookie File",
    `.instagram.com\tTRUE\t/\tTRUE\t${expiry}\tsessionid\t${sessionId}`
  ];
  if (csrfToken) lines.push(`.instagram.com\tTRUE\t/\tTRUE\t${expiry}\tcsrftoken\t${csrfToken}`);
  if (dsUserId) lines.push(`.instagram.com\tTRUE\t/\tTRUE\t${expiry}\tds_user_id\t${dsUserId}`);
  return `${lines.join("\n")}\n`;
}

function prepareCookieFile() {
  const text = cookieTextFromEnvironment();
  if (!text) return null;
  const filePath = path.join(os.tmpdir(), "nanofetch-instagram-cookies.txt");
  try {
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
    console.log("[instagram-auth] Authenticated Instagram cookies enabled.");
    return filePath;
  } catch (err) {
    console.error(`[instagram-auth] Could not prepare cookie file: ${err?.message || err}`);
    return null;
  }
}

const instagramCookieFile = prepareCookieFile();

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

function runPythonYtdlp(url, flags = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-m", "yt_dlp", ...flagsToArgs(flags), String(url)];
    const env = {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH ? `${PYDEPS}${path.delimiter}${process.env.PYTHONPATH}` : PYDEPS
    };
    const child = spawn("python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const max = 24 * 1024 * 1024;

    child.stdout.on("data", chunk => {
      if (stdout.length < max) stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < max) stderr += chunk.toString();
    });

    const timeoutMs = Number(options?.timeout || 180000);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", err => {
      clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const err = new Error(stderr.trim() || `yt-dlp exited with code ${code}${signal ? ` (${signal})` : ""}`);
      err.stderr = stderr;
      err.stdout = stdout;
      err.exitCode = code;
      reject(err);
    });
  });
}

function rewriteInstagramError(err) {
  const message = String(err?.stderr || err?.message || err || "");
  if (/failed to parse json|jsondecodeerror/i.test(message)) {
    const wrapped = new Error("Instagram returned an invalid API response. NanoFetch retried with the current yt-dlp engine, but Instagram still rejected the request. Refresh the Instagram cookies if this continues.");
    wrapped.cause = err;
    return wrapped;
  }
  if (/empty media response|redirected to the login page|rate-?limit|login required|use --cookies|cookies-from-browser/i.test(message)) {
    const friendly = instagramCookieFile
      ? "Instagram rejected the authenticated request. Export fresh Instagram cookies and update INSTAGRAM_COOKIES_B64, then retry."
      : "Instagram is rate-limiting anonymous server requests. Configure INSTAGRAM_COOKIES_B64 on the server.";
    const wrapped = new Error(friendly);
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

async function runInstagram(url, flags = {}, options = {}) {
  const baseFlags = {
    ...flags,
    userAgent: flags.userAgent || IG_UA,
    sleepRequests: flags.sleepRequests ?? 1,
    retries: Math.max(Number(flags.retries || 0), 3),
    fragmentRetries: Math.max(Number(flags.fragmentRetries || 0), 3)
  };

  if (instagramCookieFile) baseFlags.cookies = instagramCookieFile;

  try {
    return await runPythonYtdlp(url, baseFlags, options);
  } catch (firstErr) {
    const msg = String(firstErr?.stderr || firstErr?.message || "");
    const canRetryAnonymous = Boolean(instagramCookieFile) && /failed to parse json|jsondecodeerror|empty media response/i.test(msg);
    if (canRetryAnonymous) {
      console.warn("[instagram-auth] Authenticated extractor response failed; retrying public fallback once.");
      const fallbackFlags = { ...baseFlags };
      delete fallbackFlags.cookies;
      try {
        return await runPythonYtdlp(url, fallbackFlags, options);
      } catch (fallbackErr) {
        throw rewriteInstagramError(fallbackErr);
      }
    }
    throw rewriteInstagramError(firstErr);
  }
}

function patchedYtdlp(url, flags = {}, options = {}) {
  if (!isInstagramUrl(url)) return originalYtdlp(url, flags, options);
  return runInstagram(url, flags, options);
}

Object.assign(patchedYtdlp, originalYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const previousYtdlp = require(modulePath);

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const PYDEPS = path.join(process.cwd(), "pydeps");

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

const youtubeCookieFile = prepareCookieFile();

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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

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

function errorText(err) {
  return String(err?.stderr || err?.message || err || "");
}

function isPlayerAvailabilityError(err) {
  return /video unavailable|page needs to be reloaded|playability status|this content isn.?t available|try again later/i.test(errorText(err));
}

function isAuthenticationError(err) {
  return /sign in to confirm you.?re not a bot|confirm you.?re not a bot|login required|use --cookies|cookies-from-browser|authentication|account.?required|please sign in/i.test(errorText(err));
}

function rewriteYouTubeError(err) {
  const message = errorText(err);
  if (isAuthenticationError(err)) {
    const friendly = youtubeCookieFile
      ? "YouTube rejected both the authenticated request and NanoFetch's public fallback. For account-only videos, export fresh YouTube cookies using the incognito/robots.txt method and update YOUTUBE_COOKIES_B64 in Render."
      : "YouTube is requiring authentication. Configure YOUTUBE_COOKIES_B64 in Render using fresh cookies exported from the browser where YouTube works.";
    const wrapped = new Error(friendly);
    wrapped.cause = err;
    return wrapped;
  }
  if (/requested format is not available/i.test(message)) {
    const wrapped = new Error("The requested YouTube quality is not available for this video. Try another quality.");
    wrapped.cause = err;
    return wrapped;
  }
  if (isPlayerAvailabilityError(err)) {
    const wrapped = new Error("YouTube reported this video as unavailable after NanoFetch retried alternate authenticated and public player clients.");
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

async function runPublicFallback(url, baseFlags, options) {
  const publicFlags = {
    ...baseFlags,
    extractorArgs: "youtube:player_client=default,web_embedded,android_vr"
  };
  delete publicFlags.cookies;
  console.warn("[youtube-auth] Retrying YouTube without account cookies using public player clients.");
  return runPythonYtdlp(url, publicFlags, options);
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

  try {
    return await runPythonYtdlp(url, baseFlags, options);
  } catch (firstErr) {
    // Public videos often work better without account cookies when YouTube rejects
    // a datacenter-origin authenticated session. Try public clients before failing.
    if (youtubeCookieFile && isAuthenticationError(firstErr)) {
      try {
        return await runPublicFallback(url, baseFlags, options);
      } catch (publicErr) {
        throw rewriteYouTubeError(publicErr);
      }
    }

    if (!isPlayerAvailabilityError(firstErr)) throw rewriteYouTubeError(firstErr);

    // Logged-in yt-dlp sessions may select a client that returns false UNPLAYABLE.
    console.warn("[youtube-auth] Default player client reported unavailable; retrying default,web_embedded.");
    try {
      return await runPythonYtdlp(url, {
        ...baseFlags,
        extractorArgs: "youtube:player_client=default,web_embedded"
      }, options);
    } catch (secondErr) {
      if (!isPlayerAvailabilityError(secondErr) && !isAuthenticationError(secondErr)) {
        throw rewriteYouTubeError(secondErr);
      }

      if (youtubeCookieFile) {
        try {
          return await runPublicFallback(url, baseFlags, options);
        } catch (thirdErr) {
          throw rewriteYouTubeError(thirdErr);
        }
      }
      throw rewriteYouTubeError(secondErr);
    }
  }
}

function patchedYtdlp(url, flags = {}, options = {}) {
  if (!isYouTubeUrl(url)) return previousYtdlp(url, flags, options);
  return runYouTube(url, flags, options);
}

Object.assign(patchedYtdlp, previousYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

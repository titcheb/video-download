import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("youtube-dl-exec");
const originalYtdlp = require(modulePath);

const IG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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

function rewriteInstagramError(err) {
  const message = String(err?.stderr || err?.message || err || "");
  if (/redirected to the login page|rate-?limit|login required|use --cookies|cookies-from-browser/i.test(message)) {
    const friendly = instagramCookieFile
      ? "Instagram temporarily rejected this authenticated request. Refresh the Instagram cookie secret and try again."
      : "Instagram is rate-limiting anonymous server requests. Configure INSTAGRAM_SESSIONID or INSTAGRAM_COOKIES_B64 on the server.";
    const wrapped = new Error(friendly);
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

function patchedYtdlp(url, flags = {}, options = {}) {
  if (!isInstagramUrl(url)) return originalYtdlp(url, flags, options);

  const nextFlags = {
    ...flags,
    userAgent: flags.userAgent || IG_UA,
    sleepRequests: flags.sleepRequests ?? 1,
    retries: Math.max(Number(flags.retries || 0), 2),
    fragmentRetries: Math.max(Number(flags.fragmentRetries || 0), 2)
  };

  if (instagramCookieFile) nextFlags.cookies = instagramCookieFile;

  try {
    const result = originalYtdlp(url, nextFlags, options);
    return result && typeof result.catch === "function"
      ? result.catch(err => { throw rewriteInstagramError(err); })
      : result;
  } catch (err) {
    throw rewriteInstagramError(err);
  }
}

Object.assign(patchedYtdlp, originalYtdlp);
require.cache[modulePath].exports = patchedYtdlp;

import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "NeonFetch X", mode: "direct-media", storage: "ephemeral", timestamp: new Date().toISOString() });
});

const allowedContentPrefixes = [
  "video/",
  "audio/",
  "application/octet-stream"
];

const blockedHosts = [
  "youtube.com", "www.youtube.com", "youtu.be",
  "dailymotion.com", "www.dailymotion.com",
  "vimeo.com", "www.vimeo.com",
  "tiktok.com", "www.tiktok.com"
];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
  }
  return true;
}

async function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Only http/https URLs are supported.");
  }

  const host = u.hostname.toLowerCase();
  if (blockedHosts.some(h => host === h || host.endsWith("." + h))) {
    throw new Error("This demo does not bypass platform download restrictions. Use a direct media-file URL you own or are allowed to download.");
  }

  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    throw new Error("Local/private network URLs are not allowed.");
  }

  return u;
}

function safeFilename(input, contentType = "") {
  let base = "download";
  try {
    const u = new URL(input);
    base = decodeURIComponent(path.basename(u.pathname)) || "download";
  } catch {}
  base = base.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120);

  if (!path.extname(base)) {
    const extMap = {
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "video/quicktime": ".mov",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/ogg": ".ogg"
    };
    base += extMap[contentType.split(";")[0].trim()] || ".bin";
  }
  return base;
}

async function fetchHeadOrProbe(url) {
  let res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok || !res.headers.get("content-type")) {
    res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" }
    });
  }
  return res;
}

app.post("/api/inspect", async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    const u = await validateUrl(rawUrl);

    const upstream = await fetchHeadOrProbe(u);
    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(`Remote server returned ${upstream.status}.`);
    }

    const type = (upstream.headers.get("content-type") || "").toLowerCase();
    const len = Number(upstream.headers.get("content-length") || 0);

    if (!allowedContentPrefixes.some(p => type.startsWith(p))) {
      throw new Error("The URL does not appear to be a direct downloadable media file.");
    }
    if (len && len > MAX_BYTES) {
      throw new Error("File is larger than the 500 MB demo limit.");
    }

    res.json({
      ok: true,
      filename: safeFilename(rawUrl, type),
      contentType: type || "unknown",
      size: len || null,
      downloadUrl: `/api/download?url=${encodeURIComponent(rawUrl)}`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Unable to inspect URL." });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    const u = await validateUrl(rawUrl);

    const upstream = await fetch(u, { method: "GET", redirect: "follow" });
    if (!upstream.ok) {
      throw new Error(`Remote server returned ${upstream.status}.`);
    }

    const type = (upstream.headers.get("content-type") || "").toLowerCase();
    const len = Number(upstream.headers.get("content-length") || 0);

    if (!allowedContentPrefixes.some(p => type.startsWith(p))) {
      throw new Error("The URL does not appear to be a direct downloadable media file.");
    }
    if (len && len > MAX_BYTES) {
      throw new Error("File is larger than the 500 MB demo limit.");
    }

    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(rawUrl, type)}"`);
    if (len) res.setHeader("Content-Length", String(len));
    res.setHeader("Cache-Control", "no-store");

    if (!upstream.body) throw new Error("No response body.");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Download failed." });
  }
});

app.listen(PORT, () => {
  console.log(`NeonFetch running on http://localhost:${PORT}`);
});

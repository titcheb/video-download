import express from "express";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "NeonFetch X",
    mode: "direct-media",
    storage: "ephemeral",
    timestamp: new Date().toISOString()
  });
});

const allowedContentPrefixes = [
  "video/",
  "audio/",
  "image/",
  "application/octet-stream"
];

const blockedHosts = [
  "youtube.com", "www.youtube.com", "youtu.be",
  "dailymotion.com", "www.dailymotion.com", "dai.ly",
  "vimeo.com", "www.vimeo.com",
  "tiktok.com", "www.tiktok.com"
];

function isPrivateIp(ip) {
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a >= 224)
    );
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe80:")
    );
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
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (u.username || u.password) {
    throw new Error("URLs containing embedded credentials are not allowed.");
  }

  const host = u.hostname.toLowerCase();
  if (blockedHosts.some(h => host === h || host.endsWith("." + h))) {
    throw new Error(
      "Platform webpage URLs are not supported. Use a direct media-file URL you own or are authorized to download."
    );
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
      "audio/ogg": ".ogg",
      "audio/wav": ".wav",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif"
    };
    base += extMap[contentType.split(";")[0].trim()] || ".bin";
  }

  return base;
}

async function fetchHeadOrProbe(url) {
  let response = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok || !response.headers.get("content-type")) {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(15000)
    });
  }

  return response;
}

function validateMediaResponse(response) {
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const len = Number(response.headers.get("content-length") || 0);

  if (!allowedContentPrefixes.some(prefix => type.startsWith(prefix))) {
    throw new Error("The URL does not appear to be a direct downloadable media file.");
  }

  if (len && len > MAX_BYTES) {
    throw new Error("File is larger than the 500 MB demo limit.");
  }

  return { type, len };
}

app.post("/api/inspect", async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || "").trim();
    if (!rawUrl) throw new Error("Paste a media URL first.");

    const u = await validateUrl(rawUrl);
    const upstream = await fetchHeadOrProbe(u);

    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(`Remote server returned ${upstream.status}.`);
    }

    const { type, len } = validateMediaResponse(upstream);

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
    if (!rawUrl) throw new Error("Missing media URL.");

    const u = await validateUrl(rawUrl);
    const upstream = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok) {
      throw new Error(`Remote server returned ${upstream.status}.`);
    }

    const { type, len } = validateMediaResponse(upstream);

    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(rawUrl, type)}"`
    );
    if (len) res.setHeader("Content-Length", String(len));
    res.setHeader("Cache-Control", "no-store");

    if (!upstream.body) throw new Error("No response body.");

    Readable.fromWeb(upstream.body).on("error", () => {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ ok: false, error: err.message || "Download failed." });
    }
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NeonFetch X listening on 0.0.0.0:${PORT}`);
});

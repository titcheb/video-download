import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const injectedApps = new WeakSet();

function safeName(value, fallback = "dailymotion-video") {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110) || fallback;
}

function streamlinkEnv() {
  return {
    ...process.env,
    PYTHONPATH: [path.join(__dirname, "pydeps"), process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
    PYTHONUNBUFFERED: "1",
  };
}

function spawnStreamlink(url, streamName) {
  const args = [
    "-m", "streamlink",
    "--no-config",
    "--loglevel", "warning",
    "--stdout",
    url,
    streamName,
  ];
  return spawn("python3", args, {
    env: streamlinkEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function pipeStreamlinkToResponse(url, streamName, res, fallbackToBest = false) {
  return await new Promise((resolve, reject) => {
    const child = spawnStreamlink(url, streamName);
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);

    child.stderr.on("data", chunk => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });

    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (!res.write(chunk)) child.stdout.pause();
    });
    res.on("drain", () => child.stdout.resume());

    const stop = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    res.on("close", stop);

    child.on("error", err => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      res.off("close", stop);
      if (settled) return;
      settled = true;

      if (code === 0 && bytes > 0) {
        if (!res.writableEnded) res.end();
        return resolve({ bytes, streamName });
      }

      // A requested exact quality can be unavailable. Only retry before any
      // response body has been sent; once bytes have been streamed we cannot
      // safely restart the download.
      if (fallbackToBest && bytes === 0 && !res.headersSent) {
        try {
          return resolve(await pipeStreamlinkToResponse(url, "best", res, false));
        } catch (err) {
          return reject(err);
        }
      }

      reject(new Error(`${stderr.trim() || "Streamlink failed"} (code=${code}, signal=${signal || "none"}, bytes=${bytes})`));
    });
  });
}

async function downloadDailymotionWithStreamlink(req, res) {
  const id = String(req.query.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
  if (!id) return res.status(400).json({ ok: false, error: "Missing Dailymotion video ID." });

  const quality = String(req.query.quality || "auto");
  const requestedName = safeName(String(req.query.name || ""), `dailymotion-${id}`);
  const url = `https://www.dailymotion.com/video/${id}`;
  const preferred = /^\d+$/.test(quality) ? `${quality}p` : "best";
  const base = requestedName.replace(/\.[^.]+$/i, "");
  const filename = `${base}.ts`;

  try {
    console.log(`[streamlink] Dailymotion ${id}: streaming ${preferred}`);

    // Stream directly from Streamlink to the client. This avoids writing the
    // entire video to Render's ephemeral disk and removes the old artificial
    // 500 MB prepared-file limit. No third-party signed CDN URL is exposed.
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-NeonFetch-Engine", "streamlink-dailymotion-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const result = await pipeStreamlinkToResponse(url, preferred, res, preferred !== "best");
    console.log(`[streamlink] Dailymotion ${id}: completed ${result.bytes} bytes via ${result.streamName}`);
    return;
  } catch (err) {
    console.error(`[streamlink] Dailymotion ${id}: ${err?.message || err}`);
    if (!res.headersSent) {
      return res.status(400).json({ ok: false, error: `Streamlink Dailymotion failed: ${err?.message || err}` });
    }
    if (!res.writableEnded) res.destroy();
  }
}

function installRoute(app) {
  if (injectedApps.has(app)) return;
  injectedApps.add(app);
  app.get("/api/download", async (req, res, next) => {
    if (String(req.query.mode || "") !== "dailymotion") return next();
    return downloadDailymotionWithStreamlink(req, res);
  });
}

const originalUse = express.application.use;
express.application.use = function streamlinkPatchedUse(...args) {
  installRoute(this);
  return originalUse.apply(this, args);
};

import express from "express";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 500 * 1024 * 1024;
const injectedApps = new WeakSet();

function safeName(value, fallback = "dailymotion-video") {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110) || fallback;
}

function runStreamlink(url, streamName, outputPath) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PYTHONPATH: [path.join(__dirname, "pydeps"), process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
      PYTHONUNBUFFERED: "1",
    };
    const args = [
      "-m", "streamlink",
      "--no-config",
      "--loglevel", "warning",
      "--force",
      "--output", outputPath,
      url,
      streamName,
    ];
    const child = spawn("python3", args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stderr.on("data", chunk => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });
    child.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      reject(new Error(`${stderr.trim() || "Streamlink failed"} (code=${code}, signal=${signal || "none"})`));
    });
  });
}

async function downloadDailymotionWithStreamlink(req, res) {
  const id = String(req.query.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 30);
  if (!id) return res.status(400).json({ ok: false, error: "Missing Dailymotion video ID." });

  const quality = String(req.query.quality || "auto");
  const requestedName = safeName(String(req.query.name || ""), `dailymotion-${id}`);
  const url = `https://www.dailymotion.com/video/${id}`;
  const dir = path.join(os.tmpdir(), `neonfetch-streamlink-${randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  const outputPath = path.join(dir, "video.ts");

  try {
    const preferred = /^\d+$/.test(quality) ? `${quality}p` : "best";
    console.log(`[streamlink] Dailymotion ${id}: ${preferred}`);
    try {
      await runStreamlink(url, preferred, outputPath);
    } catch (firstErr) {
      if (preferred === "best") throw firstErr;
      console.warn(`[streamlink] ${preferred} unavailable, retrying best: ${firstErr.message}`);
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      await runStreamlink(url, "best", outputPath);
    }

    const stat = await fsp.stat(outputPath);
    if (!stat.size) throw new Error("Streamlink created an empty file.");
    if (stat.size > MAX_BYTES) throw new Error("Prepared file is larger than the 500 MB limit.");

    const base = requestedName.replace(/\.[^.]+$/i, "");
    const filename = `${base}.ts`;
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-NeonFetch-Engine", "streamlink-dailymotion");

    const stream = fs.createReadStream(outputPath);
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    stream.on("error", async () => {
      await cleanup();
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Unable to stream prepared file." });
      else res.destroy();
    });
    stream.on("close", cleanup);
    return stream.pipe(res);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    console.error(`[streamlink] Dailymotion ${id}: ${err?.message || err}`);
    if (!res.headersSent) {
      return res.status(400).json({ ok: false, error: `Streamlink Dailymotion failed: ${err?.message || err}` });
    }
    return res.destroy();
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

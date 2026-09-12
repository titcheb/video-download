import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const app = express();
const HOST = "127.0.0.1";
const PORT = 3333;
const workDir = path.join(os.tmpdir(), "neonfetch-drm-lab");
const plainPath = path.join(workDir, "sample.mp4");
const encPath = path.join(workDir, "sample.enc");
const secret = crypto.randomBytes(32);
const contentKey = crypto.randomBytes(32);
let iv;

fs.mkdirSync(workDir, { recursive: true });

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: "Invalid or expired license session." });
  req.session = payload;
  next();
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => err += d.toString());
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(err || `${cmd} exited ${code}`)));
  });
}

async function prepareMedia() {
  if (!ffmpegPath) throw new Error("ffmpeg-static is required for the lab.");
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
    "-t", "6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    "-y", plainPath
  ]);

  const plain = fs.readFileSync(plainPath);
  iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(encPath, Buffer.concat([encrypted, tag]));
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NeonFetch DRM Lab</title>
<style>body{margin:0;background:#071018;color:#eaf7ff;font-family:system-ui;padding:32px}.card{max-width:900px;margin:auto;background:#0d1b28;border:1px solid #1f4158;border-radius:20px;padding:24px}button{padding:12px 18px;border:0;border-radius:12px;font-weight:700;cursor:pointer}video{width:100%;margin-top:18px;border-radius:14px;background:#000}pre{white-space:pre-wrap;background:#071018;padding:14px;border-radius:12px}.ok{color:#69f0ae}.bad{color:#ff8a80}</style></head>
<body><div class="card"><h1>NeonFetch — Local DRM Lab</h1><p>Custom AES-256-GCM encrypted media + short-lived license token. This is a legal local lab, not Widevine/PlayReady/FairPlay bypass.</p><button id="start">Start licensed playback</button><pre id="log">Idle.</pre><video id="v" controls></video></div>
<script>
const log = (m,c='') => { const e=document.querySelector('#log'); e.className=c; e.textContent=m; };
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
document.querySelector('#start').onclick = async () => {
  try {
    log('1/4 Creating short-lived license session...');
    const s = await fetch('/api/session').then(r=>r.json());
    if(!s.ok) throw new Error(s.error);
    const headers = {Authorization:'Bearer '+s.token};
    log('2/4 Fetching encrypted media...');
    const mediaResp = await fetch('/media/encrypted',{headers});
    if(!mediaResp.ok) throw new Error(await mediaResp.text());
    const iv = b64ToBytes(mediaResp.headers.get('x-content-iv'));
    const cipher = await mediaResp.arrayBuffer();
    log('3/4 Requesting license key...');
    const lic = await fetch('/api/license',{headers}).then(r=>r.json());
    if(!lic.ok) throw new Error(lic.error);
    const rawKey = b64ToBytes(lic.key);
    const key = await crypto.subtle.importKey('raw', rawKey, {name:'AES-GCM'}, false, ['decrypt']);
    log('4/4 Decrypting in browser and creating playable MP4...');
    const clear = await crypto.subtle.decrypt({name:'AES-GCM', iv, tagLength:128}, key, cipher);
    const blob = new Blob([clear], {type:'video/mp4'});
    const url = URL.createObjectURL(blob);
    const v = document.querySelector('#v');
    v.src = url;
    await v.play();
    log('LICENSE OK — encrypted media decrypted and playing.', 'ok');
  } catch (e) {
    log('FAILED: '+e.message, 'bad');
  }
};
</script></body></html>`);
});

app.get("/api/session", (_req, res) => {
  const token = signToken({ sid: crypto.randomUUID(), exp: Date.now() + 60_000 });
  res.json({ ok: true, token, expiresInSeconds: 60 });
});

app.get("/api/license", auth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, algorithm: "AES-256-GCM", key: contentKey.toString("base64") });
});

app.get("/media/encrypted", auth, (_req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Content-IV", iv.toString("base64"));
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(encPath).pipe(res);
});

await prepareMedia();
app.listen(PORT, HOST, () => {
  console.log(`NeonFetch DRM Lab: http://${HOST}:${PORT}`);
  console.log("Bound to localhost only; not exposed by the production Render start command.");
});

import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = 47891;
const HOST = "127.0.0.1";

app.use(express.json({ limit: "16kb" }));

function isYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function safeName(value, fallback = "youtube-video") {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110) || fallback;
}

function assertPublic(info) {
  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) {
    throw new Error("This video requires private, paid, subscriber, or authenticated access and is not supported.");
  }
  if (Number(info?.age_limit || 0) >= 18) {
    throw new Error("Age-restricted YouTube videos are not supported in local public mode.");
  }
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) {
    throw new Error("Live YouTube streams are not supported in this local VOD helper.");
  }
}

async function inspectYouTube(url) {
  const out = await youtubedl(url, {
    dumpSingleJson: true,
    skipDownload: true,
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 20,
    retries: 1,
  }, { timeout: 45000 });

  const info = typeof out === "string" ? JSON.parse(out) : out;
  if (!info) throw new Error("No YouTube media information returned.");
  if (info?._type === "playlist" || Array.isArray(info?.entries)) throw new Error("Playlists are not supported.");
  assertPublic(info);

  const src = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(src
    .filter(f => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none")
    .map(f => Number(f.height || 0))
    .filter(Boolean))]
    .sort((a, b) => b - a)
    .slice(0, 10);

  if (!heights.length) throw new Error("No downloadable public non-DRM video formats were found.");

  return {
    ok: true,
    title: safeName(info.title || "YouTube video"),
    uploader: safeName(info.uploader || info.channel || "YouTube"),
    thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null,
    duration: Number(info.duration || 0) || null,
    formats: heights.map(h => ({ height: h, label: `${h}p` })),
  };
}

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NeonFetch Local YouTube</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07101b;color:#eef7ff;font-family:Inter,system-ui,sans-serif;min-height:100vh}.wrap{width:min(900px,calc(100% - 28px));margin:auto;padding:48px 0}.brand{font-weight:900;letter-spacing:-.03em;font-size:24px}.sub{color:#7f91a9;margin:8px 0 28px}.card{border:1px solid #203044;background:#0b1726;border-radius:22px;padding:18px}.row{display:flex;gap:10px}input{flex:1;border:1px solid #263950;background:#08121e;color:#fff;border-radius:14px;padding:15px;font:inherit}button,a.btn{border:0;border-radius:14px;padding:14px 18px;font-weight:800;background:linear-gradient(135deg,#58e2ff,#9e84ff);color:#07101b;cursor:pointer;text-decoration:none;display:inline-block}.status{margin-top:14px;color:#8ba0bb}.result{margin-top:18px;display:none}.result.show{display:block}.head{display:grid;grid-template-columns:160px 1fr;gap:16px}.head img{width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:14px;background:#16263a}.formats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:16px}.fmt{border:1px solid #203044;border-radius:14px;padding:12px;display:flex;justify-content:space-between;align-items:center;gap:12px}.err{color:#ff9db0}.note{margin-top:18px;color:#70849f;font-size:13px;line-height:1.55}@media(max-width:650px){.row{flex-direction:column}.head{grid-template-columns:1fr}.head img{width:100%}.formats{grid-template-columns:1fr}}
</style></head><body><div class="wrap"><div class="brand">NeonFetch Local YouTube</div><div class="sub">Public/non-DRM YouTube helper running only on this computer.</div><div class="card"><div class="row"><input id="u" placeholder="Paste a YouTube URL"><button id="go">Analyze</button></div><div id="s" class="status">Ready.</div><div id="r" class="result"><div class="head"><img id="t"><div><h2 id="title"></h2><div id="meta" class="status"></div></div></div><div id="f" class="formats"></div></div><div class="note">No cookies, no PO token, no login bypass. If YouTube itself requires sign-in from your current IP, this helper will stop instead of circumventing that check.</div></div></div>
<script>
const u=document.getElementById('u'),go=document.getElementById('go'),s=document.getElementById('s'),r=document.getElementById('r'),t=document.getElementById('t'),title=document.getElementById('title'),meta=document.getElementById('meta'),f=document.getElementById('f');
go.onclick=async()=>{const url=u.value.trim();r.className='result';s.className='status';s.textContent='Analyzing…';go.disabled=true;try{const q=await fetch('/api/inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const d=await q.json();if(!q.ok||!d.ok)throw new Error(d.error||'Analyze failed');title.textContent=d.title;meta.textContent=d.uploader;t.src=d.thumbnail||'';f.innerHTML='';for(const x of d.formats){const row=document.createElement('div');row.className='fmt';row.innerHTML='<strong>'+x.label+'</strong>';const a=document.createElement('a');a.className='btn';a.textContent='Download MP4';a.href='/api/download?url='+encodeURIComponent(url)+'&height='+x.height+'&name='+encodeURIComponent(d.title+' - '+x.label+'.mp4');row.appendChild(a);f.appendChild(row)}r.className='result show';s.textContent='Ready.'}catch(e){s.className='status err';s.textContent=e.message}finally{go.disabled=false}};
</script></body></html>`);
});

app.post("/api/inspect", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  try {
    if (!isYouTubeUrl(url)) throw new Error("Paste a valid YouTube URL.");
    res.json(await inspectYouTube(url));
  } catch (err) {
    const msg = String(err?.message || err || "Unable to inspect YouTube URL.");
    res.status(400).json({ ok: false, error: msg.includes("Sign in to confirm you’re not a bot") ? "YouTube is asking this IP to sign in to confirm it is not a bot. Local public mode will not bypass that challenge." : msg });
  }
});

app.get("/api/download", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const height = Math.max(144, Math.min(4320, Number(req.query.height || 720)));
  const name = safeName(String(req.query.name || `youtube-${height}p.mp4`));
  if (!isYouTubeUrl(url)) return res.status(400).json({ ok: false, error: "Invalid YouTube URL." });

  const token = randomUUID();
  const dir = path.join(os.tmpdir(), `neonfetch-youtube-${token}`);
  const template = path.join(dir, "video.%(ext)s");
  await fsp.mkdir(dir, { recursive: true });

  try {
    const infoRaw = await youtubedl(url, { dumpSingleJson: true, skipDownload: true, noPlaylist: true, noWarnings: true, quiet: true }, { timeout: 45000 });
    const info = typeof infoRaw === "string" ? JSON.parse(infoRaw) : infoRaw;
    assertPublic(info);

    await youtubedl(url, {
      format: `bv*[height<=${height}]+ba/b[height<=${height}]`,
      output: template,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      ffmpegLocation: ffmpegPath || undefined,
      mergeOutputFormat: "mp4",
      retries: 2,
      fragmentRetries: 2,
      concurrentFragments: 1,
      socketTimeout: 25,
    }, { timeout: 30 * 60 * 1000 });

    const files = (await fsp.readdir(dir)).filter(x => !x.endsWith(".part"));
    if (!files.length) throw new Error("YouTube download produced no file.");
    const filePath = path.join(dir, files[0]);
    const stat = await fsp.stat(filePath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/\.mp4$/i, "")}.mp4"`);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(filePath);
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    stream.on("close", cleanup);
    stream.on("error", async () => { await cleanup(); if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    const msg = String(err?.message || err || "YouTube download failed.");
    if (!res.headersSent) res.status(400).json({ ok: false, error: msg.includes("Sign in to confirm you’re not a bot") ? "YouTube is asking this IP to sign in to confirm it is not a bot. Local public mode will not bypass that challenge." : msg });
    else res.destroy();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`NeonFetch Local YouTube: http://${HOST}:${PORT}`);
});

import express from "express";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const HOST = "127.0.0.1";
const PORT = Number(process.env.NANOFETCH_COMPANION_PORT || 17345);
const MAX_BYTES = 500 * 1024 * 1024;
const SESSION = randomBytes(24).toString("hex");
const DEFAULT_ORIGINS = new Set([
  "https://neonfetch-x.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
for (const origin of String(process.env.NANOFETCH_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean)) DEFAULT_ORIGINS.add(origin);

app.disable("x-powered-by");
app.use(express.json({ limit: "24kb" }));

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return DEFAULT_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-NanoFetch-Session");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }
  if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ ok: false, error: "Origin is not allowed by NanoFetch Local Companion." });
  next();
});

function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function safeName(value, fallback = "youtube-video") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

function sessionValid(value) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(SESSION);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSession(req, res, next) {
  const token = req.get("X-NanoFetch-Session") || req.query.session;
  if (!sessionValid(token)) return res.status(401).json({ ok: false, error: "Local Companion session expired. Refresh NanoFetch Local Companion and try again." });
  next();
}

function ytBaseFlags() {
  const flags = {
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    ffmpegLocation: ffmpegPath || undefined,
    socketTimeout: 20,
    retries: 3,
    fragmentRetries: 3,
    extractorRetries: 3,
    jsRuntimes: "node"
  };
  const browser = String(process.env.NANOFETCH_BROWSER || "").trim();
  const cookieFile = String(process.env.NANOFETCH_COOKIES_FILE || "").trim();
  if (cookieFile && fs.existsSync(cookieFile)) flags.cookies = cookieFile;
  else if (browser) flags.cookiesFromBrowser = browser;
  return flags;
}

async function inspectYouTube(url) {
  const output = await youtubedl(url, {
    ...ytBaseFlags(),
    dumpSingleJson: true,
    skipDownload: true
  }, { timeout: 90000 });
  const info = typeof output === "string" ? JSON.parse(output) : output;
  if (!info) throw new Error("yt-dlp returned no YouTube metadata.");
  if (info?._type === "playlist" || Array.isArray(info?.entries)) throw new Error("Playlists are not supported by Local Companion yet.");
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) throw new Error("Live streams are not supported.");
  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) throw new Error("Private, paid, or subscriber-only media is not supported.");
  if (Number(info?.age_limit || 0) >= 18) throw new Error("Age-restricted media requires an authenticated local workflow.");

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(formats
    .filter(f => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none")
    .map(f => Number(f.height || 0))
    .filter(Boolean))]
    .sort((a, b) => b - a)
    .slice(0, 8);

  const title = safeName(info.title || "YouTube video");
  const origin = `http://${HOST}:${PORT}`;
  const resultFormats = heights.map(height => ({
    id: `local-${height}`,
    label: `${height}p · Local Companion`,
    quality: `${height}p`,
    ext: "mp4",
    size: null,
    type: "video",
    downloadUrl: `${origin}/download?session=${encodeURIComponent(SESSION)}&mode=video&height=${height}&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - ${height}p.mp4`)}`
  }));

  if (formats.some(f => f?.url && !f.has_drm && f.acodec && f.acodec !== "none")) {
    resultFormats.push({
      id: "local-audio",
      label: "Best audio · Local Companion",
      quality: "Audio",
      ext: "m4a",
      size: null,
      type: "audio",
      downloadUrl: `${origin}/download?session=${encodeURIComponent(SESSION)}&mode=audio&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - audio.m4a`)}`
    });
  }
  if (!resultFormats.length) throw new Error("No non-DRM downloadable formats were exposed by YouTube.");

  return {
    ok: true,
    engine: "nanofetch-local-companion",
    localCompanion: true,
    title,
    uploader: safeName(info.uploader || info.channel || "YouTube", "YouTube"),
    thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null,
    duration: Number(info.duration || 0) || null,
    sourceHost: "YouTube · LOCAL CONNECTION",
    formats: resultFormats
  };
}

async function prepareDownload(url, mode, height) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nanofetch-local-"));
  const template = path.join(dir, "media.%(ext)s");
  const common = {
    ...ytBaseFlags(),
    output: template,
    newline: true,
    restrictFilenames: false
  };

  if (mode === "audio") {
    await youtubedl(url, {
      ...common,
      format: "ba/b",
      extractAudio: true,
      audioFormat: "m4a",
      audioQuality: 0
    }, { timeout: 10 * 60 * 1000 });
  } else {
    const h = Math.max(144, Math.min(4320, Number(height || 1080)));
    await youtubedl(url, {
      ...common,
      format: `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]`,
      mergeOutputFormat: "mp4"
    }, { timeout: 10 * 60 * 1000 });
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || /\.(part|ytdl|temp)$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fsp.stat(filePath);
    files.push({ filePath, size: stat.size });
  }
  files.sort((a, b) => b.size - a.size);
  if (!files.length) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error("Local Companion finished without creating a media file.");
  }
  if (files[0].size > MAX_BYTES) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error("Prepared file is larger than the 500 MB limit.");
  }
  return { dir, ...files[0] };
}

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NanoFetch Local Companion</title>
<style>
:root{color-scheme:dark;--bg:#06101a;--panel:#0d1828;--line:rgba(255,255,255,.1);--text:#f6fbff;--muted:#8998ad;--cyan:#5ce7ff;--violet:#8f72ff;--green:#43e6a5;--red:#ff758b}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0%,rgba(92,231,255,.14),transparent 28%),radial-gradient(circle at 85% 10%,rgba(143,114,255,.15),transparent 30%),var(--bg);font-family:Inter,system-ui,sans-serif;color:var(--text)}.wrap{width:min(900px,calc(100% - 28px));margin:0 auto;padding:40px 0 70px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:34px}.brand{font-weight:900;font-size:20px}.brand small{display:block;font-size:10px;color:var(--muted);letter-spacing:.13em;margin-top:4px}.status{border:1px solid var(--line);border-radius:999px;padding:8px 11px;color:var(--green);font-size:11px}.hero{border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.018));border-radius:24px;padding:24px;box-shadow:0 30px 90px rgba(0,0,0,.3)}h1{font-size:clamp(30px,7vw,56px);line-height:1;margin:0 0 12px;letter-spacing:-.05em}.lead{color:var(--muted);line-height:1.65;margin:0 0 22px}.row{display:flex;gap:10px}.row input{flex:1;background:#07101b;border:1px solid var(--line);border-radius:13px;color:#fff;padding:15px;outline:none}.row input:focus{border-color:rgba(92,231,255,.4)}button{border:0;border-radius:13px;padding:0 20px;background:linear-gradient(135deg,var(--cyan),#b9f8ff);color:#061018;font-weight:900;cursor:pointer;min-height:50px}button:disabled{opacity:.55;cursor:not-allowed}.msg{margin-top:16px;padding:13px 14px;border:1px solid var(--line);border-radius:12px;color:var(--muted);display:none}.msg.show{display:block}.msg.err{border-color:rgba(255,117,139,.35);color:#ffd6de;background:rgba(255,117,139,.06)}.media{display:none;margin-top:18px;border-top:1px solid var(--line);padding-top:20px}.media.show{display:block}.head{display:flex;gap:16px;align-items:center}.thumb{width:150px;aspect-ratio:16/9;object-fit:cover;background:#142136;border-radius:12px}.meta h2{margin:0 0 7px;font-size:19px}.meta p{margin:0;color:var(--muted);font-size:12px}.formats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:18px}.f{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:13px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025)}.f strong{font-size:13px}.f span{display:block;color:var(--muted);font-size:10px;margin-top:3px}.f a{background:linear-gradient(135deg,var(--violet),#b19cff);color:#fff;padding:9px 11px;border-radius:9px;text-decoration:none;font-size:10px;font-weight:900}.back{display:inline-block;margin-top:22px;color:var(--cyan);text-decoration:none;font-size:12px}@media(max-width:650px){.row{flex-direction:column}.formats{grid-template-columns:1fr}.head{align-items:flex-start}.thumb{width:105px}.top{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="wrap"><div class="top"><div class="brand">NanoFetch Local Companion<small>YOUTUBE THROUGH YOUR OWN CONNECTION</small></div><div class="status">● LOCAL ENGINE READY</div></div><main class="hero"><h1>Local YouTube mode.</h1><p class="lead">This page runs entirely on your computer at 127.0.0.1. YouTube traffic does not pass through Render.</p><div class="row"><input id="url" placeholder="Paste YouTube URL..."><button id="go">Analyze</button></div><div id="msg" class="msg"></div><section id="media" class="media"><div class="head"><img id="thumb" class="thumb" alt="Thumbnail"><div class="meta"><h2 id="title"></h2><p id="meta"></p></div></div><div id="formats" class="formats"></div></section><a class="back" href="https://neonfetch-x.onrender.com/">← Back to NanoFetch X</a></main></div>
<script>
const $=id=>document.getElementById(id),url=$('url'),go=$('go'),msg=$('msg'),media=$('media'),thumb=$('thumb'),title=$('title'),meta=$('meta'),formats=$('formats');let session='';
const initial=new URLSearchParams(location.search).get('url')||'';url.value=initial;
function show(text,error=false){msg.textContent=text;msg.className='msg show'+(error?' err':'')}
async function boot(){try{const r=await fetch('/health',{cache:'no-store'});const d=await r.json();if(!d.ok||!d.session)throw new Error('Companion health check failed.');session=d.session;show('Local Companion is ready.');if(initial) analyze();}catch(e){show(e.message||'Local Companion is unavailable.',true)}}
async function analyze(){const value=url.value.trim();if(!value)return show('Paste a YouTube URL first.',true);go.disabled=true;go.textContent='Analyzing…';media.classList.remove('show');show('Reading YouTube through your local connection…');try{const r=await fetch('/inspect',{method:'POST',headers:{'Content-Type':'application/json','X-NanoFetch-Session':session},body:JSON.stringify({url:value})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Unable to analyze this YouTube URL.');thumb.src=d.thumbnail||'';title.textContent=d.title||'YouTube video';meta.textContent=[d.uploader,d.sourceHost].filter(Boolean).join(' · ');formats.innerHTML='';(d.formats||[]).forEach(f=>{const row=document.createElement('div');row.className='f';const left=document.createElement('div');const s=document.createElement('strong');s.textContent=f.label||f.quality||'Download';const x=document.createElement('span');x.textContent=[String(f.ext||'').toUpperCase(),f.type==='audio'?'Audio':'Video'].join(' · ');left.append(s,x);const a=document.createElement('a');a.href=f.downloadUrl;a.textContent='DOWNLOAD ↓';row.append(left,a);formats.append(row)});media.classList.add('show');show('Choose a quality below. Download is prepared locally.');}catch(e){show(e.message||'Local YouTube analysis failed.',true)}finally{go.disabled=false;go.textContent='Analyze'}}
go.addEventListener('click',analyze);url.addEventListener('keydown',e=>{if(e.key==='Enter')analyze()});boot();
</script></body></html>`);
});

app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "NanoFetch Local Companion",
    version: "1.1.0",
    session: SESSION,
    youtube: true,
    ffmpeg: Boolean(ffmpegPath)
  });
});

app.post("/inspect", requireSession, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  try {
    if (!isYouTubeUrl(url)) throw new Error("Local Companion only accepts HTTPS YouTube URLs.");
    res.json(await inspectYouTube(url));
  } catch (err) {
    console.error("[local-companion][inspect]", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || "Local YouTube inspection failed." });
  }
});

app.get("/download", requireSession, async (req, res) => {
  const url = String(req.query.url || "").trim();
  const mode = req.query.mode === "audio" ? "audio" : "video";
  const height = Number(req.query.height || 1080);
  const requestedName = safeName(req.query.name || (mode === "audio" ? "youtube-audio.m4a" : "youtube-video.mp4"));
  let prepared = null;
  try {
    if (!isYouTubeUrl(url)) throw new Error("Local Companion only accepts HTTPS YouTube URLs.");
    prepared = await prepareDownload(url, mode, height);
    const ext = path.extname(prepared.filePath) || (mode === "audio" ? ".m4a" : ".mp4");
    const filename = requestedName.replace(/\.[^.]+$/, "") + ext;
    res.setHeader("Cache-Control", "no-store");
    res.download(prepared.filePath, filename, async () => {
      await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (err) {
    if (prepared?.dir) await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {});
    console.error("[local-companion][download]", err?.message || err);
    if (!res.headersSent) res.status(400).send(err?.message || "Local YouTube download failed.");
  }
});

app.listen(PORT, HOST, () => {
  console.log("");
  console.log("NanoFetch Local Companion is READY");
  console.log(`Open: http://${HOST}:${PORT}`);
  console.log("Keep this window open while using YouTube on NanoFetch X.");
  console.log("Press Ctrl+C to stop.");
  console.log("");
});
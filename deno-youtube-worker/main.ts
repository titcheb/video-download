const MAX_BYTES = 500 * 1024 * 1024;
const MAX_DOWNLOADS = 2;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const YTDLP = Deno.build.arch === "aarch64" ? "./bin/yt-dlp_linux_aarch64" : "./bin/yt-dlp_linux";

try { await Deno.chmod(YTDLP, 0o755); } catch {}

let ffmpegPath = "";
try {
  const mod = await import("npm:@ffmpeg-installer/ffmpeg@1.1.0");
  const pkg: any = (mod as any).default || mod;
  ffmpegPath = String(pkg?.path || "");
  if (ffmpegPath) {
    try { await Deno.chmod(ffmpegPath, 0o755); } catch {}
    console.log(`[deno-youtube] ffmpeg ready: ${ffmpegPath}`);
  }
} catch (err) {
  console.warn(`[deno-youtube] ffmpeg unavailable; progressive formats will still work: ${err?.message || err}`);
}

function normalizeCookieText(text: string) {
  const value = String(text || "").replace(/\\n/g, "\n").trim();
  if (!value) return "";
  if (/^# Netscape HTTP Cookie File/m.test(value)) return `${value}\n`;
  return `# Netscape HTTP Cookie File\n${value}\n`;
}

let cookieFile = "";
try {
  let cookieText = String(Deno.env.get("YOUTUBE_COOKIES") || "").trim();
  const encoded = String(Deno.env.get("YOUTUBE_COOKIES_B64") || "").trim();
  if (encoded) {
    const raw = atob(encoded);
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    cookieText = new TextDecoder().decode(bytes);
  }
  cookieText = normalizeCookieText(cookieText);
  if (cookieText) {
    cookieFile = "/tmp/nanofetch-youtube-cookies.txt";
    await Deno.writeTextFile(cookieFile, cookieText);
    try { await Deno.chmod(cookieFile, 0o600); } catch {}
    console.log("[deno-youtube] YouTube cookies enabled.");
  }
} catch (err) {
  console.warn(`[deno-youtube] Could not prepare cookies: ${err?.message || err}`);
}

function isYouTubeUrl(raw: string) {
  try {
    const u = new URL(String(raw || ""));
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
  } catch {
    return false;
  }
}

function safeName(value: string, fallback = "youtube-video") {
  return String(value || fallback)
    .replace(/[<>:\"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://neonfetch-x.onrender.com",
      "x-content-type-options": "nosniff"
    }
  });
}

function baseArgs(authenticated = true) {
  const args = [
    "--ignore-config",
    "--no-cache-dir",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--socket-timeout", "20",
    "--retries", "3",
    "--fragment-retries", "3",
    "--extractor-retries", "3",
    "--js-runtimes", `deno:${Deno.execPath()}`,
    "--user-agent", UA
  ];
  if (authenticated && cookieFile) args.push("--cookies", cookieFile);
  return args;
}

async function runYtdlp(args: string[], timeoutMs = 90000) {
  const child = new Deno.Command(YTDLP, {
    args,
    stdout: "piped",
    stderr: "piped"
  }).spawn();

  const stdoutP = new Response(child.stdout).text();
  const stderrP = new Response(child.stderr).text();
  let timer = 0;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
  });

  try {
    const status = await Promise.race([child.status, timeoutP]);
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    if (!status.success) throw new Error(stderr.trim() || `yt-dlp exited with code ${status.code}`);
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

function validateInfo(info: any) {
  if (!info) throw new Error("yt-dlp returned no YouTube metadata.");
  if (info?._type === "playlist" || Array.isArray(info?.entries)) throw new Error("Playlists are not supported.");
  if (info?.is_live || ["is_live", "is_upcoming"].includes(String(info?.live_status || ""))) throw new Error("Live streams are not supported.");
  if (Number(info?.age_limit || 0) >= 18) throw new Error("Age-restricted media is not supported by this public worker.");
  const availability = String(info?.availability || "public").toLowerCase();
  if (["private", "premium_only", "subscriber_only", "needs_auth"].includes(availability)) throw new Error("Private, paid, subscriber-only, or login-required media is not supported.");
}

async function inspectYouTube(url: string, origin: string) {
  const attempts: Array<{ name: string; args: string[] }> = [];
  if (cookieFile) attempts.push({ name: "cookies", args: [...baseArgs(true), "--dump-single-json", "--skip-download", url] });
  attempts.push({ name: "public", args: [...baseArgs(false), "--dump-single-json", "--skip-download", url] });
  attempts.push({ name: "web_safari", args: [...baseArgs(false), "--extractor-args", "youtube:player_client=web_safari", "--dump-single-json", "--skip-download", url] });
  attempts.push({ name: "web_embedded", args: [...baseArgs(false), "--extractor-args", "youtube:player_client=web_embedded", "--dump-single-json", "--skip-download", url] });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      console.log(`[deno-youtube] inspect via ${attempt.name}`);
      const { stdout } = await runYtdlp(attempt.args, 70000);
      const info = JSON.parse(stdout);
      validateInfo(info);
      const formats = Array.isArray(info.formats) ? info.formats : [];
      const videoFormats = formats.filter((f: any) => f?.url && !f.has_drm && f.vcodec && f.vcodec !== "none");
      const candidateVideo = ffmpegPath
        ? videoFormats
        : videoFormats.filter((f: any) => f.acodec && f.acodec !== "none");
      const heights = [...new Set(candidateVideo.map((f: any) => Number(f.height || 0)).filter(Boolean))]
        .sort((a: number, b: number) => b - a)
        .slice(0, 8);
      const title = safeName(info.title || "YouTube video");
      const resultFormats = heights.map((height: number) => ({
        id: `deno-${height}`,
        label: `${height}p · Deno`,
        quality: `${height}p`,
        ext: "mp4",
        size: null,
        type: "video",
        downloadUrl: `${origin}/download?mode=video&height=${height}&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - ${height}p.mp4`)}`
      }));
      if (formats.some((f: any) => f?.url && !f.has_drm && f.acodec && f.acodec !== "none")) {
        resultFormats.push({
          id: "deno-audio",
          label: "Best audio · Deno",
          quality: "Audio",
          ext: ffmpegPath ? "m4a" : "file",
          size: null,
          type: "audio",
          downloadUrl: `${origin}/download?mode=audio&url=${encodeURIComponent(url)}&name=${encodeURIComponent(`${title} - audio.m4a`)}`
        });
      }
      if (!resultFormats.length) throw new Error("No downloadable non-DRM formats were exposed by YouTube.");
      return {
        ok: true,
        engine: "deno-yt-dlp",
        title,
        uploader: safeName(info.uploader || info.channel || "YouTube", "YouTube"),
        thumbnail: /^https?:\/\//i.test(String(info.thumbnail || "")) ? info.thumbnail : null,
        duration: Number(info.duration || 0) || null,
        sourceHost: "youtube.com · DENO",
        formats: resultFormats
      };
    } catch (err) {
      lastError = err;
      console.warn(`[deno-youtube] ${attempt.name} failed: ${String(err?.message || err).replace(/\s+/g, " ").slice(0, 350)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("YouTube inspection failed on Deno.");
}

let activeDownloads = 0;

async function prepareDownload(url: string, mode: string, height: number) {
  if (activeDownloads >= MAX_DOWNLOADS) throw new Error("Deno worker is busy. Try again in a moment.");
  activeDownloads++;
  const dir = await Deno.makeTempDir({ prefix: "nanofetch-deno-" });
  const output = `${dir}/media.%(ext)s`;
  try {
    const args = [...baseArgs(Boolean(cookieFile))];
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    if (mode === "audio") {
      if (ffmpegPath) args.push("-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a");
      else args.push("-f", "ba[ext=m4a]/ba");
    } else {
      const h = Math.max(144, Math.min(4320, Number(height || 720)));
      if (ffmpegPath) {
        args.push("-f", `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]`, "--merge-output-format", "mp4");
      } else {
        args.push("-f", `b[height<=${h}][ext=mp4]/b[height<=${h}]`);
      }
    }
    args.push("-o", output, url);
    await runYtdlp(args, 8 * 60 * 1000);

    const files: Array<{ path: string; size: number }> = [];
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || /\.(part|ytdl|temp)$/i.test(entry.name)) continue;
      const filePath = `${dir}/${entry.name}`;
      const stat = await Deno.stat(filePath);
      files.push({ path: filePath, size: stat.size });
    }
    files.sort((a, b) => b.size - a.size);
    if (!files.length) throw new Error("yt-dlp completed without creating a media file.");
    if (files[0].size > MAX_BYTES) throw new Error("Prepared file is larger than the 500 MB limit.");
    return { dir, ...files[0] };
  } catch (err) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw err;
  } finally {
    activeDownloads--;
  }
}

async function streamFile(filePath: string, dir: string, filename: string) {
  const stat = await Deno.stat(filePath);
  const ext = filePath.split(".").pop() || "bin";
  const file = await Deno.open(filePath, { read: true });
  const reader = file.readable.getReader();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { reader.releaseLock(); } catch {}
    try { file.close(); } catch {}
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await cleanup();
        } else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        await cleanup();
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch {}
      await cleanup();
    }
  });
  const finalName = safeName(filename || `youtube.${ext}`).replace(/\.[^.]+$/, "") + `.${ext}`;
  return new Response(stream, {
    headers: {
      "content-type": ext === "mp4" ? "video/mp4" : ext === "m4a" ? "audio/mp4" : ext === "webm" ? "video/webm" : "application/octet-stream",
      "content-disposition": `attachment; filename="${finalName.replace(/\"/g, "")}"`,
      "content-length": String(stat.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

const rate = new Map<string, { count: number; reset: number }>();
function rateAllowed(req: Request, limit = 40) {
  const now = Date.now();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "global";
  const key = `${ip}:${new URL(req.url).pathname}`;
  let item = rate.get(key);
  if (!item || now > item.reset) item = { count: 0, reset: now + 60_000 };
  item.count++;
  rate.set(key, item);
  return item.count <= limit;
}

Deno.serve(async (req) => {
  const requestUrl = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": "https://neonfetch-x.onrender.com",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    }});
  }
  if (requestUrl.pathname === "/health") {
    return json({ ok: true, service: "NanoFetch Deno YouTube Worker", engine: "yt-dlp", arch: Deno.build.arch, ffmpeg: Boolean(ffmpegPath), cookies: Boolean(cookieFile), timestamp: new Date().toISOString() });
  }
  if (!rateAllowed(req)) return json({ ok: false, error: "Too many requests. Try again shortly." }, 429);

  try {
    if (requestUrl.pathname === "/inspect" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const url = String((body as any)?.url || "").trim();
      if (!isYouTubeUrl(url)) throw new Error("Only public YouTube HTTPS URLs are accepted.");
      return json(await inspectYouTube(url, requestUrl.origin));
    }

    if (requestUrl.pathname === "/download" && req.method === "GET") {
      const url = String(requestUrl.searchParams.get("url") || "").trim();
      if (!isYouTubeUrl(url)) throw new Error("Only public YouTube HTTPS URLs are accepted.");
      const mode = requestUrl.searchParams.get("mode") === "audio" ? "audio" : "video";
      const height = Number(requestUrl.searchParams.get("height") || 720);
      const name = safeName(requestUrl.searchParams.get("name") || (mode === "audio" ? "youtube-audio.m4a" : "youtube-video.mp4"));
      const prepared = await prepareDownload(url, mode, height);
      return await streamFile(prepared.path, prepared.dir, name);
    }

    return json({ ok: false, error: "Not found." }, 404);
  } catch (err) {
    console.error(`[deno-youtube] ${requestUrl.pathname}: ${err?.message || err}`);
    return json({ ok: false, error: String(err?.message || "YouTube worker failed.") }, 400);
  }
});
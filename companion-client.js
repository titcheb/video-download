(() => {
  const nativeFetch = window.fetch.bind(window);
  const LOCAL_UI = "http://127.0.0.1:17345/";

  function isYouTubeUrl(raw) {
    try {
      const u = new URL(String(raw || ""));
      const h = u.hostname.toLowerCase();
      return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
    } catch {
      return false;
    }
  }

  function requestPath(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).pathname;
      if (input instanceof Request) return new URL(input.url, location.href).pathname;
    } catch {}
    return "";
  }

  function localLauncherResponse(url) {
    const openUrl = `${LOCAL_UI}?url=${encodeURIComponent(url)}`;
    const data = {
      ok: true,
      engine: "nanofetch-local-launcher",
      localCompanion: true,
      title: "YouTube · Local Companion",
      uploader: "Runs through your own internet connection",
      thumbnail: null,
      duration: null,
      sourceHost: "LOCAL MODE · NO RENDER IP",
      formats: [{
        id: "open-local-companion",
        label: "OPEN LOCAL COMPANION",
        quality: "Local",
        ext: "LOCAL",
        size: null,
        type: "video",
        downloadUrl: openUrl
      }]
    };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  window.fetch = async function(input, init = {}) {
    const path = requestPath(input);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (path === "/api/inspect" && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
        const url = String(body?.url || "").trim();
        if (isYouTubeUrl(url)) return localLauncherResponse(url);
      } catch {}
    }

    return nativeFetch(input, init);
  };

  const live = document.querySelector(".live");
  if (live) {
    live.innerHTML = "<i></i> LOCAL YOUTUBE MODE";
    live.title = "YouTube opens in NanoFetch Local Companion to avoid datacenter IP blocks.";
  }
})();

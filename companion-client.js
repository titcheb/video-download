(() => {
  const nativeFetch = window.fetch.bind(window);
  const endpoints = ["http://127.0.0.1:17345", "http://localhost:17345"];
  let companion = null;
  let checkedAt = 0;

  function isYouTubeUrl(raw) {
    try {
      const u = new URL(String(raw || ""));
      const h = u.hostname.toLowerCase();
      return u.protocol === "https:" && (h === "youtube.com" || h.endsWith(".youtube.com") || h === "youtu.be" || h.endsWith(".youtu.be"));
    } catch {
      return false;
    }
  }

  function updateStatus(ready) {
    const live = document.querySelector(".live");
    if (!live) return;
    if (ready) {
      live.innerHTML = "<i></i> LOCAL COMPANION READY";
      live.title = "YouTube requests use your local internet connection.";
    } else if (live.textContent.includes("LOCAL COMPANION")) {
      live.innerHTML = "<i></i> ENGINE ONLINE";
      live.title = "";
    }
  }

  async function pingCompanion(force = false) {
    const now = Date.now();
    if (!force && companion && now - checkedAt < 30000) return companion;
    checkedAt = now;
    companion = null;

    for (const base of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        const response = await nativeFetch(`${base}/health`, {
          method: "GET",
          mode: "cors",
          cache: "no-store",
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.ok && data?.session) {
          companion = { base, session: data.session };
          updateStatus(true);
          return companion;
        }
      } catch {}
    }

    updateStatus(false);
    return null;
  }

  async function localInspect(url) {
    const local = await pingCompanion(true);
    if (!local) return null;
    const response = await nativeFetch(`${local.base}/inspect`, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-NanoFetch-Session": local.session
      },
      body: JSON.stringify({ url })
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Local Companion returned an invalid response." }));
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  function requestPath(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).pathname;
      if (input instanceof Request) return new URL(input.url, location.href).pathname;
    } catch {}
    return "";
  }

  window.fetch = async function(input, init = {}) {
    const path = requestPath(input);
    const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (path === "/api/inspect" && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
        const url = String(body?.url || "").trim();
        if (isYouTubeUrl(url)) {
          const local = await localInspect(url);
          if (local) return local;
        }
      } catch {}
    }

    const response = await nativeFetch(input, init);

    if (path === "/api/inspect" && method === "POST" && !response.ok) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        if (/no-proxy NanoFetch fallback|automated traffic|detected as a bot|Render server/i.test(String(data?.error || ""))) {
          data.error = "YouTube is blocking the Render server. Start NanoFetch Local Companion on this computer, then press Download again. Command: npm run companion";
          return new Response(JSON.stringify(data), {
            status: response.status,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
          });
        }
      } catch {}
    }

    return response;
  };

  pingCompanion(true);
  setInterval(() => pingCompanion(true), 20000);
})();

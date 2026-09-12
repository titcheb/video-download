import express from "express";
import { randomUUID } from "node:crypto";

const links = new Map();
const TTL_MS = 15 * 60 * 1000;
const injectedApps = new WeakSet();

function cleanupExpired() {
  const now = Date.now();
  for (const [token, item] of links) {
    if (!item || item.expiresAt <= now) links.delete(token);
  }
}
setInterval(cleanupExpired, 60_000).unref();

function createDirectLink(target, meta = {}) {
  const token = randomUUID().replace(/-/g, "");
  links.set(token, {
    target,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    ...meta,
  });
  return `/d/${token}`;
}

function installDirectRoute(app) {
  if (injectedApps.has(app)) return;
  injectedApps.add(app);

  app.get("/d/:token", (req, res) => {
    const token = String(req.params?.token || "");
    const item = links.get(token);
    if (!item || item.expiresAt <= Date.now()) {
      links.delete(token);
      return res.status(410).json({ ok: false, error: "This direct download link has expired. Analyze the media again to create a new link." });
    }

    // Only redirect to NeonFetch's own already-generated download path.
    // This never exposes a third-party signed CDN URL and does not bypass
    // DRM, login, private access, subscriptions, age gates, or access controls.
    if (typeof item.target !== "string" || !item.target.startsWith("/api/download?")) {
      links.delete(token);
      return res.status(400).json({ ok: false, error: "Invalid direct download link." });
    }

    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.redirect(302, item.target);
  });
}

const originalUse = express.application.use;
express.application.use = function patchedUse(...args) {
  // server-v5 calls app.use() before registering its routes. Injecting here
  // guarantees /d/:token is registered before the final 404 middleware.
  installDirectRoute(this);
  return originalUse.apply(this, args);
};

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path === "/api/inspect" && handlers.length) {
    const lastIndex = handlers.length - 1;
    const originalHandler = handlers[lastIndex];

    handlers[lastIndex] = function directLinkInspectWrapper(req, res, next) {
      const originalJson = res.json.bind(res);
      res.json = body => {
        if (body?.ok && Array.isArray(body.formats)) {
          body.formats = body.formats.map(format => {
            if (!format || typeof format.downloadUrl !== "string" || !format.downloadUrl.startsWith("/api/download?")) return format;
            const target = format.downloadUrl;
            const directLink = createDirectLink(target, {
              sourceHost: body.sourceHost || null,
              title: body.title || null,
              quality: format.quality || format.label || null,
              originalFormat: format.ext || null,
              type: format.type || "video",
            });
            return {
              ...format,
              originalDownloadUrl: target,
              downloadUrl: directLink,
              directLink,
              directLinkExpiresIn: 900,
            };
          });
          body.directLinks = true;
          body.directLinkExpiresIn = 900;
        }
        return originalJson(body);
      };
      return originalHandler(req, res, next);
    };
  }
  return originalPost.call(this, path, ...handlers);
};

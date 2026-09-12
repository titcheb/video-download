# NeonFetch X — High-Tech Direct Media Engine

A polished, futuristic, responsive direct-media downloader for files you own or are authorized to download.

## Highlights

- Premium high-tech UI with animated particle field, scan line, telemetry, orbit core and glass panels
- Responsive design for mobile, tablet, desktop and ultrawide screens
- Animated media inspection workflow
- Direct-file support for common video/audio MIME types
- Browser-local recent history (localStorage)
- Clipboard paste / source copy controls
- Glow-reduction toggle
- Streaming backend with no permanent media-file storage
- Basic SSRF/private-network protection
- 500 MB demo limit
- `/api/health` endpoint
- Major platform pages (YouTube, Dailymotion, Vimeo, TikTok) intentionally blocked so this build does not bypass their download restrictions

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Production hardening

Before public deployment, add a reverse proxy/HTTPS, rate limiting, request timeouts, stricter DNS rebinding protection, bandwidth quotas, monitoring, abuse prevention, and a privacy/terms page appropriate to your jurisdiction.

## Usage

Use only for media you own, public-domain media, or media you are explicitly authorized to download.

# NeonFetch X — Direct Media Engine

A responsive Node.js/Express web app for inspecting and streaming direct media-file URLs that you own or are authorized to download.

## Deploy on Render

This repository is ready to deploy as a **Render Web Service**.

### Recommended: Blueprint

The repository includes `render.yaml`.

In Render:

1. Sign in with GitHub.
2. Choose **New > Blueprint**.
3. Select the GitHub repository `titcheb/video-download`.
4. Render reads `render.yaml` automatically.
5. Create the service.

The Blueprint uses:

- Runtime: Node
- Plan: Free
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Auto deploy: enabled for commits

### Manual Web Service setup

If you create the service manually instead:

- Repository: `titcheb/video-download`
- Branch: `main`
- Language/Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

Do not set a fixed port. Render supplies the `PORT` environment variable automatically and `server.js` listens on it.

## Features

- High-tech responsive UI
- Node.js + Express backend
- `/api/inspect` media inspection endpoint
- `/api/download` streaming download endpoint
- `/api/health` health endpoint
- Direct video, audio and image content support
- No permanent media-file storage by design
- 500 MB demo limit
- Private/local network URL blocking
- Major platform webpage URLs intentionally rejected

## Local development

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Responsible use

Use only for your own files, public-domain media, creator-provided downloads, or content you are explicitly authorized to download.

The app does not intentionally bypass DRM, authentication, paywalls, subscription controls, or platform download restrictions.

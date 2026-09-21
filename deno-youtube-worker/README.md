# NanoFetch Deno YouTube Worker

This worker moves only YouTube extraction/download traffic away from Render and runs it on Deno Deploy.

## Deploy

Use the new Deno Deploy platform at `console.deno.com`.

Create a dynamic app from this repository and set the app directory to:

`deno-youtube-worker`

The included `deno.json` config runs:

- Build: `deno task build`
- Entrypoint: `./main.ts`
- Runtime: dynamic

The build downloads the latest official standalone `yt-dlp` Linux binaries for x64 and arm64. At runtime the worker selects the correct binary automatically.

Optional environment variables:

- `YOUTUBE_COOKIES_B64`: base64-encoded Netscape-format YouTube cookies
- `YOUTUBE_COOKIES`: raw Netscape-format YouTube cookies

For public videos, try without cookies first.

## Verify

Open:

`https://YOUR-DENO-WORKER/health`

Expected response contains:

`{"ok":true,"service":"NanoFetch Deno YouTube Worker"...}`

## Connect Render

Set this environment variable on the main NanoFetch Render service:

`YOUTUBE_DENO_WORKER=https://YOUR-DENO-WORKER`

Then redeploy/restart the Render service. The `deno-youtube-patch.mjs` preload routes YouTube inspect/download requests through Deno and falls back to the existing Render engines if the worker is unavailable.

## Limits

- YouTube HTTPS URLs only
- No playlists
- No live streams
- No private/paid/subscriber-only media
- Public worker file limit: 500 MB
- Two simultaneous prepared downloads per Deno instance

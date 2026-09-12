# NeonFetch Local DRM Lab

This lab demonstrates a real encrypted-media + license workflow without bypassing any third-party DRM.

## What it does

1. Generates a 6-second local MP4 test video with FFmpeg.
2. Encrypts the whole MP4 using AES-256-GCM.
3. Exposes a short-lived signed session token.
4. Requires that token to fetch both the encrypted media and the license key.
5. Decrypts the media in the browser with WebCrypto and plays it as MP4.

This demonstrates the same architectural concepts used by commercial DRM systems: protected media, authorization, license acquisition, content key delivery, expiry, and controlled playback. It is **not** Widevine, PlayReady, or FairPlay, and it does not extract or bypass keys from any platform.

## Run locally

```bash
npm install
node drm-lab-server.js
```

Open:

```text
http://127.0.0.1:3333
```

Click **Start licensed playback**.

The lab server intentionally binds only to `127.0.0.1` and is not used by the production Render start command.

## Flow

```text
Browser -> /api/session -> signed 60-second token
Browser -> /media/encrypted + Bearer token -> AES-GCM ciphertext + IV
Browser -> /api/license + Bearer token -> AES content key
Browser -> WebCrypto AES-GCM decrypt -> Blob(video/mp4) -> playback
```

## Security properties demonstrated

- short-lived authorization token
- HMAC-signed sessions
- separate encrypted media and license endpoints
- AES-256-GCM authenticated encryption
- random content key and IV generated at runtime
- no key committed to GitHub
- localhost-only server binding
- no third-party media or DRM involved

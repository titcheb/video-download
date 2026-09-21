# NanoFetch Local Companion

NanoFetch Local Companion is the preferred YouTube path when YouTube rejects Render datacenter traffic.

It runs only on `127.0.0.1:17345` on your computer. The public NeonFetch website stays on Render, but YouTube inspection and downloads use your own internet connection.

## Windows

1. Install Node.js 22 or newer.
2. Download or clone this repository.
3. Double-click `START-NANOFETCH-COMPANION-WINDOWS.bat`.
4. Keep the terminal window open.
5. Open `https://neonfetch-x.onrender.com` in the browser on the same computer.
6. When the navigation badge says `LOCAL COMPANION READY`, paste a YouTube URL and use NanoFetch normally.

## macOS / Linux

```bash
chmod +x START-NANOFETCH-COMPANION.sh
./START-NANOFETCH-COMPANION.sh
```

## Optional authenticated local workflow

For public videos, no browser cookies should normally be required. If a video you are authorized to access requires your local YouTube session, start the companion with one of these environment variables:

- `NANOFETCH_BROWSER=chrome` to let yt-dlp read your local Chrome profile.
- `NANOFETCH_COOKIES_FILE=/path/to/cookies.txt` to use an explicit Netscape-format cookies file.

Do not share cookie files or session credentials.

## Security

- Binds only to `127.0.0.1`, not your LAN.
- Only accepts HTTPS YouTube URLs.
- Uses a random per-process session token.
- Browser API access is restricted to the NanoFetch Render origin plus explicitly configured origins.
- Temporary downloaded files are deleted after delivery.
- Maximum prepared file size is 500 MB.

To add another website origin, set `NANOFETCH_ORIGINS` to a comma-separated list before starting the companion.

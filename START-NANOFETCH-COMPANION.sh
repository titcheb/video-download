#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  exit 1
fi

export NANOFETCH_LOCAL_INSTALL=1
if [ ! -d node_modules/youtube-dl-exec ]; then
  echo "Installing NanoFetch Local Companion dependencies..."
  npm install
fi

echo "Starting NanoFetch Local Companion..."
echo "Keep this terminal open while downloading YouTube videos."
npm run companion

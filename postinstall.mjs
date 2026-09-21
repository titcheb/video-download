import { spawnSync } from "node:child_process";

if (process.env.NANOFETCH_LOCAL_INSTALL === "1") {
  console.log("[postinstall] Local Companion install detected; skipping Render-only Python/WPC setup.");
  process.exit(0);
}

function run(command, args) {
  console.log(`[postinstall] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

try {
  run("python3", [
    "-m", "pip", "install",
    "--disable-pip-version-check",
    "--no-cache-dir",
    "--upgrade",
    "--pre",
    "--target", "./pydeps",
    "streamlink==8.5.0",
    "yt-dlp[default]",
    "pytubefix==11.1.0",
    "yt-dlp-getpot-wpc==1.1.2"
  ]);
  run(process.execPath, ["./setup-youtube-wpc.mjs"]);
} catch (err) {
  console.error(`[postinstall] Failed: ${err?.message || err}`);
  process.exit(1);
}

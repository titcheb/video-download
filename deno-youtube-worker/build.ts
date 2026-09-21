const targets = [
  ["yt-dlp_linux", "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"],
  ["yt-dlp_linux_aarch64", "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"],
] as const;

await Deno.mkdir("bin", { recursive: true });

for (const [name, url] of targets) {
  console.log(`[build] downloading ${name}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  const file = `bin/${name}`;
  await Deno.writeFile(file, data);
  await Deno.chmod(file, 0o755);
  console.log(`[build] ${name}: ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
}

console.log("[build] yt-dlp binaries ready for x64 and arm64");
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const providerDir = path.join(root, ".pot-provider");
const serverDir = path.join(providerDir, "server");
const scriptPath = path.join(serverDir, "build", "generate_once.js");

function run(command, args, cwd = root) {
  console.log(`[youtube-pot-setup] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

try {
  fs.rmSync(providerDir, { recursive: true, force: true });
  run("git", [
    "clone",
    "--depth", "1",
    "--single-branch",
    "--branch", "2.0.0",
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git",
    providerDir
  ]);
  run("npm", ["ci", "--no-audit", "--no-fund"], serverDir);
  run("npx", ["tsc"], serverDir);

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`PO token generator was not built at ${scriptPath}`);
  }

  console.log(`[youtube-pot-setup] PO token provider ready: ${scriptPath}`);
} catch (err) {
  console.error(`[youtube-pot-setup] Failed: ${err?.message || err}`);
  process.exit(1);
}

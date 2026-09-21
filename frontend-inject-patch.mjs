import fs from "node:fs";
import path from "node:path";
import express from "express";

const originalSendFile = express.response.sendFile;
const companionClientPath = path.join(process.cwd(), "companion-client.js");

express.response.sendFile = function patchedSendFile(filePath, ...args) {
  try {
    const resolved = path.resolve(String(filePath || ""));
    if (path.basename(resolved).toLowerCase() === "index.html" && fs.existsSync(resolved) && fs.existsSync(companionClientPath)) {
      const html = fs.readFileSync(resolved, "utf8");
      const client = fs.readFileSync(companionClientPath, "utf8");
      const injected = html.replace("</body>", `<script>${client}</script>\n</body>`);
      this.type("html");
      this.setHeader("Cache-Control", "no-cache");
      return this.send(injected);
    }
  } catch (err) {
    console.warn(`[frontend-inject] Could not inject Local Companion client: ${err?.message || err}`);
  }
  return originalSendFile.call(this, filePath, ...args);
};

console.log("[frontend-inject] Local Companion browser bridge enabled.");

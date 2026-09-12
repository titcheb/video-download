import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3333;
const HOST = "127.0.0.1"; // local-only by design

app.use(express.json());
app.use(express.static(__dirname));

// This lab intentionally simulates a protected-media flow with content we generate ourselves.
// It is NOT Widevine, FairPlay, PlayReady, or any real platform DRM implementation.
const TEST_TOKEN = "lab-token-2026";
const CONTENT_KEY = crypto.randomBytes(32); // AES-256 key generated at startup
const IV = crypto.randomBytes(12);

const PLAINTEXT = Buffer.from(
  "NEONFETCH LAB MEDIA SEGMENT\nThis synthetic payload represents media bytes you own.\n",
  "utf8"
);

function encryptSample() {
  const cipher = crypto.createCipheriv("aes-256-gcm", CONTENT_KEY, IV);
  const ciphertext = Buffer.concat([cipher.update(PLAINTEXT), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ciphertext, tag]);
}

const ENCRYPTED_SEGMENT = encryptSample();

app.get("/api/lab/manifest", (req, res) => {
  res.json({
    ok: true,
    type: "mock-protected-media",
    algorithm: "AES-256-GCM",
    segmentUrl: "/api/lab/segment",
    licenseUrl: "/api/lab/license",
    iv: IV.toString("base64"),
    authRequired: true,
    note: "Synthetic training content only; not a real DRM manifest."
  });
});

app.get("/api/lab/segment", (req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.send(ENCRYPTED_SEGMENT);
});

app.post("/api/lab/license", (req, res) => {
  const auth = String(req.headers.authorization || "");
  if (auth !== `Bearer ${TEST_TOKEN}`) {
    return res.status(401).json({ ok: false, error: "Invalid lab token." });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    algorithm: "AES-256-GCM",
    contentKey: CONTENT_KEY.toString("base64"),
    note: "Training key for synthetic local content only."
  });
});

app.get("/api/lab/info", (req, res) => {
  res.json({
    ok: true,
    tokenForThisLocalLab: TEST_TOKEN,
    flow: [
      "1. Fetch manifest",
      "2. Fetch encrypted segment",
      "3. Send authorized license request",
      "4. Receive test content key",
      "5. Decrypt segment locally with WebCrypto",
      "6. Save the recovered synthetic bytes"
    ]
  });
});

app.listen(PORT, HOST, () => {
  console.log(`NeonFetch learning lab: http://${HOST}:${PORT}/`);
  console.log("Local-only mock DRM flow. This does not connect to real DRM/license systems.");
});

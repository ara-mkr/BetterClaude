/**
 * Cross-Device Clipboard Bridge — crypto only, no Node/Electron APIs.
 * Uses the WebCrypto API (`globalThis.crypto.subtle`), which is available
 * both in the renderer (browser `crypto`) and in the Electron main process
 * (Node 20+ exposes the same global), so this module works unmodified from
 * either side — same "platform-agnostic core" contract as the rest of
 * /core. The actual relay HTTP calls and clipboard read/write are Electron-
 * specific wiring left to electron/main.js, matching Native File Watcher
 * Sync's split (chokidar lives in main.js; core/file-sync-indicator.js only
 * builds text blocks).
 *
 * A self-hosted (or any HTTP-reachable) relay only ever sees:
 *   - `channel`: a one-way SHA-256 digest of the passphrase, domain-
 *     separated from the encryption key below so the relay operator can't
 *     derive one from the other.
 *   - `iv` + `ciphertext`: AES-GCM output. The key is PBKDF2-derived from
 *     the same passphrase but with a different domain-separation string.
 * The passphrase itself never leaves the device, and the relay can't read
 * clipboard contents even if it's fully malicious — only deny availability.
 */

const CHANNEL_SALT = "betterclaude-clipboard-bridge:channel";
const KEY_SALT = "betterclaude-clipboard-bridge:key";
const PBKDF2_ITERATIONS = 100000;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

function fromBase64(b64) {
  const binary = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto is unavailable in this context.");
  return c.subtle;
}

async function deriveChannelId(passphrase) {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(CHANNEL_SALT + passphrase));
  return toBase64(digest).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

async function deriveKey(passphrase) {
  const baseKey = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode(KEY_SALT), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(plainText, passphrase) {
  const key = await deriveKey(passphrase);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText));
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

async function decryptText({ iv, ciphertext }, passphrase) {
  const key = await deriveKey(passphrase);
  const plainBuffer = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(plainBuffer);
}

module.exports = { deriveChannelId, deriveKey, encryptText, decryptText };

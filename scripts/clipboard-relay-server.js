#!/usr/bin/env node
/**
 * Minimal reference relay for the Cross-Device Clipboard Bridge (Settings ->
 * Clipboard Bridge). Self-host this (a spare machine, a small VPS, a
 * Raspberry Pi — anywhere reachable by every device you want to sync) and
 * point BetterClaude's "Relay URL" setting at it. Any server implementing
 * the same three endpoints works instead of this one.
 *
 * This server only ever sees ciphertext plus a one-way "channel" id derived
 * from the shared passphrase (electron/main.js / core/clipboard-bridge.js
 * encrypt client-side before anything is sent) — it cannot read clipboard
 * contents. Storage is in-memory only, per channel, and self-expires by TTL,
 * so nothing here is a durable store of anyone's clipboard history.
 *
 * Protocol:
 *   POST /put   { channel, id, iv, ciphertext, deviceName, ts, ttlSeconds }
 *               -> 200 { ok: true }
 *   GET  /pull?channel=<id>&after=<ts>
 *               -> 200 { items: [{ id, iv, ciphertext, deviceName, ts }, ...] }
 *   GET  /health
 *               -> 200 { ok: true, name: "betterclaude-clipboard-relay" }
 *
 * Usage:
 *   node scripts/clipboard-relay-server.js [--port 8787]
 *
 * This is a reference implementation, not a hardened production service —
 * put it behind HTTPS (a reverse proxy is the easiest route) before relaying
 * anything over an untrusted network, since without TLS a network observer
 * could see who's syncing with whom (channel ids) even though the clipboard
 * content itself stays encrypted.
 */
const http = require("http");
const { URL } = require("url");

const args = process.argv.slice(2);
const portFlagIdx = args.indexOf("--port");
const PORT = portFlagIdx !== -1 ? Number(args[portFlagIdx + 1]) : Number(process.env.PORT) || 8787;
const MAX_ITEMS_PER_CHANNEL = 50;
const MAX_BODY_BYTES = 256 * 1024;

// channel -> Array<{ id, iv, ciphertext, deviceName, ts, expiresAt }>
const channels = new Map();

function purgeExpired(channel) {
  const list = channels.get(channel);
  if (!list) return [];
  const now = Date.now();
  const kept = list.filter((item) => item.expiresAt > now);
  if (kept.length === 0) channels.delete(channel);
  else channels.set(channel, kept);
  return kept;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, name: "betterclaude-clipboard-relay" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/put") {
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch (_e) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const { channel, id, iv, ciphertext, deviceName, ts, ttlSeconds } = data || {};
    if (!channel || !id || !iv || !ciphertext || !ts) {
      sendJson(res, 400, { error: "Missing required fields" });
      return;
    }
    const list = purgeExpired(channel);
    list.push({
      id: String(id),
      iv: String(iv),
      ciphertext: String(ciphertext),
      deviceName: deviceName ? String(deviceName).slice(0, 80) : "unknown device",
      ts: Number(ts),
      expiresAt: Date.now() + Math.max(30, Math.min(3600, Number(ttlSeconds) || 300)) * 1000,
    });
    // Cap per-channel history rather than let an idle/misbehaving client fill memory.
    channels.set(channel, list.slice(-MAX_ITEMS_PER_CHANNEL));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pull") {
    const channel = url.searchParams.get("channel");
    const after = Number(url.searchParams.get("after") || 0);
    if (!channel) {
      sendJson(res, 400, { error: "Missing channel" });
      return;
    }
    const items = purgeExpired(channel)
      .filter((item) => item.ts > after)
      .map(({ id, iv, ciphertext, deviceName, ts }) => ({ id, iv, ciphertext, deviceName, ts }));
    sendJson(res, 200, { items });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[betterclaude-clipboard-relay] listening on http://localhost:${PORT}`);
  console.log("Point Settings -> Clipboard Bridge -> Relay URL at this address (behind HTTPS for real use).");
});

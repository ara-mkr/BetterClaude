/**
 * Content-script <-> background messaging bridge — the direct analog of
 * electron/preload.js's `ipcRenderer.invoke`/`.on`. Exposed as
 * `window.BetterClaudeBridge` so content-script.js can be a near-line-for-
 * line port of preload.js's bootstrap(): `bg(type, payload)` replaces every
 * `ipcRenderer.invoke("type", payload)` call, and `onBroadcast(type, cb)`
 * replaces every `ipcRenderer.on("type", cb)` call.
 */
(function () {
  function bg(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error(`No response for "${type}"`));
          return;
        }
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error || `"${type}" failed`));
      });
    });
  }

  const broadcastHandlers = new Map(); // type -> Set<cb>
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !broadcastHandlers.has(message.type)) return;
    broadcastHandlers.get(message.type).forEach((cb) => {
      try { cb(message.payload); } catch (err) { console.error("[BetterClaude] broadcast handler failed", err); }
    });
  });

  function onBroadcast(type, cb) {
    if (!broadcastHandlers.has(type)) broadcastHandlers.set(type, new Set());
    broadcastHandlers.get(type).add(cb);
  }

  window.BetterClaudeBridge = { bg, onBroadcast };
})();

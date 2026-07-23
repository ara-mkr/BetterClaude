/**
 * Native File Watcher Sync — extension port. electron/main.js used chokidar
 * (fs.watch) from the main process; a browser extension's content script
 * has no filesystem access of its own at all, only the File System Access
 * API (`window.showOpenFilePicker`), which hands back a FileSystemFileHandle
 * good for repeated reads/writes but requires an explicit user gesture to
 * obtain and (after a browser restart) to re-confirm permission on.
 *
 * There is no fs.watch/chokidar equivalent for a handle, so "watching" here
 * is honest polling: re-`getFile()` every few seconds and compare
 * `lastModified`. Handles aren't structured-cloneable across the
 * extension's own message-passing boundary, so they're kept in this page's
 * IndexedDB (same origin as claude.ai, shared by every BetterClaude surface
 * on this tab) rather than round-tripped through the service worker at all —
 * this feature needed no background involvement, unlike the Electron
 * version.
 *
 * Exposed as `window.BetterClaudeFileWatcher` for content-script.js.
 */
(function () {
  const DB_NAME = "betterclaude-file-watcher";
  const STORE = "handles";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  const watchers = new Map(); // id -> { handle, lastModified, timer }

  async function ensurePermission(handle) {
    if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  }

  // Requires a user gesture (call this directly from a click handler).
  async function pickFile() {
    if (!window.showOpenFilePicker) throw new Error("This browser doesn't support the File System Access API.");
    const [handle] = await window.showOpenFilePicker();
    const file = await handle.getFile();
    const id = `fw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await idbSet(id, handle);
    return { id, name: file.name, content: await file.text() };
  }

  function start(id, onChange) {
    if (watchers.has(id)) return;
    const entry = { handle: null, lastModified: 0, timer: null };
    watchers.set(id, entry);
    (async () => {
      const handle = await idbGet(id);
      if (!handle || !(await ensurePermission(handle))) { watchers.delete(id); return; }
      entry.handle = handle;
      const file = await handle.getFile();
      entry.lastModified = file.lastModified;
      entry.timer = setInterval(async () => {
        try {
          const f = await entry.handle.getFile();
          if (f.lastModified === entry.lastModified) return;
          entry.lastModified = f.lastModified;
          onChange(await f.text());
        } catch (_e) { /* file briefly unreadable mid-write, or deleted — skip this tick */ }
      }, 3000);
    })();
  }

  function stop(id) {
    const entry = watchers.get(id);
    if (entry && entry.timer) clearInterval(entry.timer);
    watchers.delete(id);
  }

  async function readFile(id) {
    const handle = watchers.has(id) ? watchers.get(id).handle : await idbGet(id);
    if (!handle) throw new Error("File handle not found — re-pick the file.");
    return (await handle.getFile()).text();
  }

  async function writeFile(id, content) {
    const handle = watchers.has(id) ? watchers.get(id).handle : await idbGet(id);
    if (!handle) throw new Error("File handle not found — re-pick the file.");
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  function forget(id) {
    stop(id);
    idbDelete(id).catch(() => {});
  }

  window.BetterClaudeFileWatcher = { pickFile, start, stop, readFile, writeFile, forget };
})();

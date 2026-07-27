/**
 * Plugin loader — DOM-only, no Node/Electron APIs.
 *
 * Host responsibility (electron/preload.js today, a browser-extension
 * content script later) is to discover plugin source files and evaluate
 * them into `{ name, version, onLoad(api), onUnload() }` module objects
 * (Electron does this with Node's `require` in a controlled directory;
 * an extension would fetch text and eval/import it). Everything past that
 * point — lifecycle management, the api surface plugins see, enable/disable
 * bookkeeping — lives here so it's identical on both platforms.
 *
 * Plugin contract:
 *   module.exports = {
 *     name: "My Plugin",
 *     version: "1.0.0",
 *     onLoad(api) { ... },
 *     onUnload() {}
 *   };
 */

const DOCK_ID = "betterclaude-plugin-dock";
const DOCK_STYLE_ID = "betterclaude-plugin-dock-style";
const { insertIntoComposer } = require("./compose-insert");

// Drag-reorder state for the plugin dock (§3 "drag-and-drop reordering on
// any listable UI"). Module-level rather than per-plugin: only one drag can
// be in flight at a time regardless of which plugin's button started it.
let dragSrcPluginId = null;

// Reorders the dock's current children to match a saved id order (extra/
// unknown ids just keep their existing relative position at the end).
function reorderDockChildren(dock, order) {
  if (!dock || !order || !order.length) return;
  const byId = new Map();
  Array.from(dock.children).forEach((child) => {
    if (child.dataset && child.dataset.bcPluginId) byId.set(child.dataset.bcPluginId, child);
  });
  order.forEach((id) => {
    const child = byId.get(id);
    if (child) dock.appendChild(child);
  });
}

// A single shared row of icon buttons, docked below the title bar. Plugins
// that want a persistent toggle/launcher button (focus mode, snippet
// library, conversation search, ...) go through api.mountToolbarButton()
// instead of each picking its own `position: fixed` coordinates — that's
// what let three unrelated plugins stack directly on top of each other.
// The dock auto-flows left from the right edge, so N buttons just add up
// instead of overlapping.
function ensureDock() {
  let dock = document.getElementById(DOCK_ID);
  if (!dock) {
    dock = document.createElement("div");
    dock.id = DOCK_ID;
    document.body.appendChild(dock);
  }
  if (!document.getElementById(DOCK_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = DOCK_STYLE_ID;
    style.textContent = `
      #${DOCK_ID} {
        position: fixed;
        /* claude.ai's own "Focus Mode" button sits at roughly top:44px,
           right:16px in the composer header — the same corner this dock
           used to claim, so the two painted on top of each other. Dropping
           below it clears that native control instead of covering it. */
        top: 88px;
        right: 16px;
        z-index: 2147482900;
        display: flex;
        gap: 8px;
      }
      #${DOCK_ID} .bc-dock-btn {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(20,16,31,0.85);
        color: #ece7fb;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      @media (hover: hover) and (pointer: fine) {
        #${DOCK_ID} .bc-dock-btn:hover {
          background: rgba(139,92,246,0.35);
          border-color: rgba(139,92,246,0.5);
        }
      }
      #${DOCK_ID} .bc-dock-btn.bc-active {
        background: var(--bc-accent, #8b5cf6);
        border-color: var(--bc-accent, #8b5cf6);
        color: var(--btn-primary-fg, #fff);
      }
      #${DOCK_ID} .bc-dock-btn svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `;
    document.head.appendChild(style);
  }
  return dock;
}

function createPluginAPI({ id, themeEngine, hud, getSettings, setSetting, host }) {
  const injectedStyleId = `betterclaude-plugin-style-${id}`;
  const messageHandlers = [];
  const dockButtons = [];

  return {
    id,

    insertIntoComposer(text, options) {
      return insertIntoComposer(text, options);
    },

    injectCSS(css) {
      let tag = document.getElementById(injectedStyleId);
      if (!tag) {
        tag = document.createElement("style");
        tag.id = injectedStyleId;
        document.head.appendChild(tag);
      }
      tag.textContent = css;
    },

    removeCSS() {
      const tag = document.getElementById(injectedStyleId);
      if (tag) tag.remove();
    },

    /**
     * Adds an icon button to the shared plugin toolbar dock (top-right,
     * below the title bar) instead of a plugin-owned `position: fixed`
     * element. `icon` is a small inline SVG string (stroke: currentColor,
     * so it follows the active theme's text color); `label` doubles as the
     * title/aria-label. Returns { setActive(bool), remove() }.
     */
    mountToolbarButton({ icon, label, active = false, onClick } = {}) {
      const dock = ensureDock();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bc-dock-btn";
      btn.innerHTML = icon || "";
      btn.dataset.bcPluginId = id;
      if (label) {
        btn.title = label;
        btn.setAttribute("aria-label", label);
      }
      if (active) btn.classList.add("bc-active");
      if (onClick) btn.addEventListener("click", (e) => onClick(e));

      // Drag-and-drop reordering: users can rearrange dock icons directly,
      // persisted as an ordered list of plugin ids (settings.cursor.dockOrder)
      // so the arrangement survives restarts.
      btn.draggable = true;
      btn.addEventListener("dragstart", (e) => {
        dragSrcPluginId = id;
        btn.classList.add("bc-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", id);
        }
      });
      btn.addEventListener("dragend", () => btn.classList.remove("bc-dragging"));
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      });
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        const draggedId = dragSrcPluginId;
        if (!draggedId || draggedId === id) return;
        const draggedEl = dock.querySelector(`[data-bc-plugin-id="${draggedId}"]`);
        if (!draggedEl) return;
        dock.insertBefore(draggedEl, btn);
        const newOrder = Array.from(dock.children)
          .map((c) => c.dataset.bcPluginId)
          .filter(Boolean);
        setSetting("cursor.dockOrder", newOrder);
      });

      dock.appendChild(btn);
      dockButtons.push(btn);

      const settings = getSettings();
      reorderDockChildren(dock, settings.cursor && settings.cursor.dockOrder);

      return {
        el: btn,
        setActive(isActive) {
          btn.classList.toggle("bc-active", !!isActive);
        },
        remove() {
          btn.remove();
          const idx = dockButtons.indexOf(btn);
          if (idx >= 0) dockButtons.splice(idx, 1);
          if (dock.children.length === 0) dock.remove();
        },
      };
    },

    /** Register a callback fired with { role, text, node } for new messages. */
    onMessage(handler) {
      messageHandlers.push(handler);
      return () => {
        const idx = messageHandlers.indexOf(handler);
        if (idx >= 0) messageHandlers.splice(idx, 1);
      };
    },

    /** Host calls this to fan a detected message out to plugin handlers. */
    _dispatchMessage(payload) {
      messageHandlers.forEach((h) => {
        try {
          h(payload);
        } catch (err) {
          console.error(`[BetterClaude plugin:${id}] onMessage handler threw`, err);
        }
      });
    },

    /** Register a value under settings.plugins.data[id][key], persisted by the host. */
    registerSetting(key, defaultValue) {
      const settings = getSettings();
      const pluginData = (settings.plugins.data && settings.plugins.data[id]) || {};
      if (!(key in pluginData)) {
        setSetting(`plugins.data.${id}.${key}`, defaultValue);
        return defaultValue;
      }
      return pluginData[key];
    },

    getSetting(key) {
      const settings = getSettings();
      const pluginData = (settings.plugins.data && settings.plugins.data[id]) || {};
      return pluginData[key];
    },

    setSetting(key, value) {
      setSetting(`plugins.data.${id}.${key}`, value);
    },

    getTheme() {
      return themeEngine.settings ? themeEngine.settings.appearance.activeTheme : null;
    },

    getUsage() {
      return host.getLastUsage ? host.getLastUsage() : null;
    },

    /** DOM query helper scoped to document, exposed so plugins don't need `window`. */
    query(selector) {
      return document.querySelector(selector);
    },
    queryAll(selector) {
      return Array.from(document.querySelectorAll(selector));
    },

    /** Minimal toast/notification affordance shared by plugins. */
    notify(message, { timeout = 3000 } = {}) {
      host.notify ? host.notify(message, { timeout }) : console.log(`[BetterClaude:${id}]`, message);
    },

    /** Host calls this on unload as a safety net for buttons a plugin forgot to remove(). */
    _removeDockButtons() {
      const dock = document.getElementById(DOCK_ID);
      dockButtons.splice(0).forEach((btn) => btn.remove());
      if (dock && dock.children.length === 0) dock.remove();
    },
  };
}

class PluginLoader {
  constructor({ themeEngine, hud, getSettings, setSetting, host = {} }) {
    this.themeEngine = themeEngine;
    this.hud = hud;
    this.getSettings = getSettings;
    this.setSetting = setSetting;
    this.host = host;
    this.loaded = new Map(); // id -> { module, api }
  }

  /** moduleObj is the already-evaluated {name, version, onLoad, onUnload}. */
  load(id, moduleObj) {
    if (this.loaded.has(id)) this.unload(id);
    const api = createPluginAPI({
      id,
      themeEngine: this.themeEngine,
      hud: this.hud,
      getSettings: this.getSettings,
      setSetting: this.setSetting,
      host: this.host,
    });

    try {
      moduleObj.onLoad && moduleObj.onLoad(api);
      this.loaded.set(id, { module: moduleObj, api });
      return true;
    } catch (err) {
      console.error(`[BetterClaude] plugin "${id}" failed to load`, err);
      return false;
    }
  }

  unload(id) {
    const entry = this.loaded.get(id);
    if (!entry) return;
    try {
      entry.module.onUnload && entry.module.onUnload();
    } catch (err) {
      console.error(`[BetterClaude] plugin "${id}" threw during onUnload`, err);
    }
    entry.api.removeCSS();
    entry.api._removeDockButtons();
    this.loaded.delete(id);
  }

  unloadAll() {
    Array.from(this.loaded.keys()).forEach((id) => this.unload(id));
  }

  dispatchMessage(payload) {
    this.loaded.forEach((entry) => entry.api._dispatchMessage(payload));
  }

  list() {
    return Array.from(this.loaded.entries()).map(([id, entry]) => ({
      id,
      name: entry.module.name,
      version: entry.module.version,
    }));
  }

  isLoaded(id) {
    return this.loaded.has(id);
  }
}

module.exports = { PluginLoader, createPluginAPI };

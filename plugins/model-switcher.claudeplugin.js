/**
 * Model Switcher — pick the Code tab's model (Default, Fable, Opus, Sonnet,
 * Haiku) for its next message without opening the Code tab.
 *
 * Off by default (Settings → Widgets). Themed with the --bc-* tokens, so it
 * follows every theme, dark or light.
 */
const ICON = `<svg viewBox="0 0 24 24"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>`;

// --- shared widget shell (same in every BetterClaude widget) ---------------
// A dock button toggling a themed popover. The panel carries data-bc-own so
// the page theme's global button/text resets leave it alone; colours come
// from the --bc-* tokens, so it follows every theme, dark or light. Escape
// closes it. `refresh` runs on open and every `pollMs` only WHILE open.
function widgetShell(api, { id, title, icon, label, pollMs = 0, refresh, width = 260 }) {
  api.injectCSS(`
    #${id} { position: fixed; top: calc(var(--bc-dock-bottom, 120px) + 8px); right: 16px; width: ${width}px; max-height: calc(100vh - var(--bc-dock-bottom, 120px) - 24px); overflow: auto;
      z-index: 2147482950; display: none; flex-direction: column; gap: 8px; padding: 14px;
      background: var(--bc-bg-elevated, #1c1630) !important; color: var(--bc-text, #ece7fb) !important;
      border: 1px solid var(--bc-border, #2c2347); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.28);
      font: 12px/1.45 var(--bc-ui-font, -apple-system, sans-serif); }
    #${id}.bc-open { display: flex; }
    #${id} * { color: inherit !important; }
    #${id} .bc-w-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #${id} .bc-w-title { font-weight: 600; font-size: 13px; }
    #${id} .bc-w-muted { color: var(--bc-text-muted, #a99bd1) !important; }
    #${id} .bc-w-big { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
    #${id} .bc-w-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    #${id} .bc-w-bar { height: 6px; border-radius: 3px; overflow: hidden;
      background: color-mix(in srgb, var(--bc-text, #ece7fb) 14%, transparent); }
    #${id} .bc-w-bar > i { display: block; height: 100%; background: var(--bc-accent, #6059e6); }
    #${id} .bc-w-bar[data-level="warn"] > i { background: var(--ansi-yellow, #d9a400); }
    #${id} .bc-w-bar[data-level="high"] > i { background: var(--bc-danger, #ef4444); }
    #${id} .bc-w-empty { color: var(--bc-text-muted, #a99bd1) !important; font-style: italic; }
    #${id} button { font: inherit !important; padding: 5px 9px !important; border-radius: 7px !important;
      border: 1px solid var(--bc-border, #2c2347) !important; background: transparent !important;
      color: var(--bc-text, #ece7fb) !important; cursor: pointer; }
    #${id} button:hover { border-color: var(--bc-accent, #6059e6) !important; }
    #${id} button:focus-visible { outline: 2px solid var(--bc-accent, #6059e6); outline-offset: 1px; }
    #${id} button.bc-on { background: var(--bc-accent, #6059e6) !important; color: #fff !important; border-color: transparent !important; }
    #${id} .bc-w-close { padding: 0 6px !important; border: 0 !important; font-size: 15px !important; line-height: 1 !important; }
  `);
  const panel = document.createElement("div");
  panel.id = id;
  panel.dataset.bcOwn = "";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = "bc-w-head";
  const h = document.createElement("span");
  h.className = "bc-w-title";
  h.textContent = title;
  const close = document.createElement("button");
  close.className = "bc-w-close";
  close.type = "button";
  close.setAttribute("aria-label", `Close ${title}`);
  close.textContent = "×";
  head.append(h, close);
  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:8px";
  panel.append(head, body);
  document.body.appendChild(panel);

  let timer = null;
  const w = {
    panel, body, open: false,
    setOpen(open) {
      w.open = open;
      panel.classList.toggle("bc-open", open);
      if (w.btn) w.btn.setActive(open);
      clearInterval(timer);
      timer = null;
      if (open) {
        // One card at a time: they all open in the same corner.
        document.dispatchEvent(new CustomEvent("bc-widget-open", { detail: id }));
        if (refresh) refresh();
        if (pollMs && refresh) timer = setInterval(refresh, pollMs);
      }
    },
    toggle() { w.setOpen(!w.open); },
    destroy() { clearInterval(timer); document.removeEventListener("bc-widget-open", onOther); panel.remove(); if (w.btn) w.btn.remove(); },
  };
  close.addEventListener("click", () => w.setOpen(false));
  const onOther = (e) => { if (e.detail !== id && w.open) w.setOpen(false); };
  document.addEventListener("bc-widget-open", onOther);
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); w.setOpen(false); } });
  w.btn = api.mountToolbarButton({ icon, label, onClick: () => w.toggle() });
  return w;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function bar(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const b = el("div", "bc-w-bar");
  b.dataset.level = f >= 0.9 ? "high" : f >= 0.7 ? "warn" : "ok";
  const i = document.createElement("i");
  i.style.width = `${Math.round(f * 100)}%`;
  b.appendChild(i);
  return b;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

module.exports = {
  name: "Model Switcher",
  version: "1.0.0",

  onLoad(api) {
    this.current = api.registerSetting("model", "default");
    this.w = widgetShell(api, { id: "bc-w-model", title: "Code tab model", label: "Model switcher", icon: ICON, pollMs: 3000, refresh: () => this.render(api), width: 240 });
  },
  async render(api) {
    // The Code tab's picker is the authority; the dock only mirrors it.
    const live = await api.widgetData("code-model");
    if (live && live.model) this.current = live.model;
    const b = this.w.body;
    b.textContent = "";
    const CHOICES = [["default", "Default", "Your plan's default"], ["fable", "Fable", "Newest, most capable"], ["opus", "Opus", "Deep reasoning"], ["sonnet", "Sonnet", "Everyday pick"], ["haiku", "Haiku", "Fastest, lightest"]];
    for (const [id, label, hint] of CHOICES) {
      const btn = el("button", id === this.current ? "bc-on" : "", null);
      btn.type = "button";
      btn.setAttribute("aria-pressed", id === this.current ? "true" : "false");
      btn.style.cssText = "display:flex;justify-content:space-between;gap:8px;text-align:left";
      const hintEl = el("span", "", hint);
      hintEl.style.opacity = "0.75";
      btn.append(el("span", "", label), hintEl);
      btn.addEventListener("click", async () => {
        const ok = await api.setCodeModel(id);
        if (!ok) { api.notify("Open the Code tab once, then try again."); return; }
        this.current = id;
        api.setSetting("model", id);
        this.render(api);
      });
      b.appendChild(btn);
    }
    b.appendChild(el("div", "bc-w-muted", "Applies from the Code tab's next message."));
  },

  onUnload() {
    
    if (this.w) this.w.destroy();
  },
};

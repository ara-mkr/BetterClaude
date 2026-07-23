/**
 * Conversation Search — full-text search across messages seen this session
 * and previous ones. Builds its index purely from api.onMessage (the real
 * per-message event, not a bespoke MutationObserver), persisted via
 * api.registerSetting so the index survives restarts. Capped in size since
 * it's stored inside the settings JSON, not a separate file.
 */

const MAX_INDEXED_MESSAGES = 800;
const MAX_TEXT_LENGTH = 4000;

const SEARCH_ICON = `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

module.exports = {
  name: "Conversation Search",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.index = api.registerSetting("index", []);
    this.query = "";

    this._unsubscribe = api.onMessage(({ role, text }) => {
      const trimmed = (text || "").trim();
      if (!trimmed) return;
      this.index.push({
        role,
        text: trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) : trimmed,
        url: window.location.href,
        title: document.title,
        ts: Date.now(),
      });
      if (this.index.length > MAX_INDEXED_MESSAGES) {
        this.index.splice(0, this.index.length - MAX_INDEXED_MESSAGES);
      }
      api.setSetting("index", this.index);
    });

    api.injectCSS(`
      #bc-search-panel {
        position: fixed;
        top: 88px;
        right: 16px;
        width: 340px;
        max-height: 70vh;
        z-index: 2147482950;
        background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 10px;
        display: none;
        flex-direction: column;
        font: 12px -apple-system, sans-serif;
        color: #ece7fb;
        overflow: hidden;
      }
      #bc-search-panel.bc-open { display: flex; }
      .bc-cs-toolbar { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .bc-cs-toolbar input {
        width: 100%; background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 6px 8px; font: inherit;
      }
      .bc-cs-count { opacity: 0.5; padding: 4px 10px 0; font-size: 10px; }
      .bc-cs-list { overflow-y: auto; flex: 1; padding: 6px; }
      .bc-cs-item { padding: 8px 10px; border-radius: 8px; margin-bottom: 4px; background: rgba(255,255,255,0.03); }
      .bc-cs-item-meta { display: flex; justify-content: space-between; opacity: 0.55; font-size: 10px; margin-bottom: 3px; }
      .bc-cs-item-text { white-space: pre-wrap; }
      .bc-cs-item mark { background: rgba(139,92,246,0.5); color: #fff; border-radius: 2px; }
      .bc-cs-item-link { color: #a78bfa; cursor: pointer; text-decoration: underline; font-size: 10px; }
      .bc-cs-empty { opacity: 0.5; text-align: center; padding: 20px 10px; }
    `);

    this._dockBtn = api.mountToolbarButton({
      icon: SEARCH_ICON,
      label: "Search conversations",
      onClick: () => this.toggle(),
    });

    const panel = document.createElement("div");
    panel.id = "bc-search-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this.render();
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
    if (open) {
      this._searchInput && this._searchInput.focus();
      this.renderResults();
    }
  },

  escapeHTML(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  },

  highlight(text, query) {
    const escaped = this.escapeHTML(text);
    if (!query) return escaped;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(new RegExp(`(${escapedQuery})`, "ig"), "<mark>$1</mark>");
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "bc-cs-toolbar";
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search all messages…";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderResults();
    });
    toolbar.appendChild(search);
    panel.appendChild(toolbar);
    this._searchInput = search;

    const count = document.createElement("div");
    count.className = "bc-cs-count";
    panel.appendChild(count);
    this._count = count;

    const list = document.createElement("div");
    list.className = "bc-cs-list";
    panel.appendChild(list);
    this._list = list;

    this.renderResults();
  },

  renderResults() {
    const q = this.query.trim().toLowerCase();
    const matches = q
      ? this.index.filter((m) => m.text.toLowerCase().includes(q)).slice(-100).reverse()
      : this.index.slice(-30).reverse();

    this._count.textContent = q
      ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
      : `${this.index.length} messages indexed · showing most recent`;

    this._list.innerHTML = "";
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-cs-empty";
      empty.textContent = q ? "No matches." : "Nothing indexed yet — send a few messages.";
      this._list.appendChild(empty);
      return;
    }

    matches.forEach((m) => {
      const item = document.createElement("div");
      item.className = "bc-cs-item";

      const meta = document.createElement("div");
      meta.className = "bc-cs-item-meta";
      const roleSpan = document.createElement("span");
      roleSpan.textContent = `${m.role === "user" ? "You" : "Assistant"} · ${new Date(m.ts).toLocaleString()}`;
      meta.appendChild(roleSpan);
      if (m.url && m.url !== window.location.href) {
        const link = document.createElement("span");
        link.className = "bc-cs-item-link";
        link.textContent = "Open →";
        link.addEventListener("click", () => {
          window.location.href = m.url;
        });
        meta.appendChild(link);
      }
      item.appendChild(meta);

      const textDiv = document.createElement("div");
      textDiv.className = "bc-cs-item-text";
      const snippet = m.text.length > 300 ? `…${m.text.slice(Math.max(0, m.text.toLowerCase().indexOf(q) - 100), m.text.toLowerCase().indexOf(q) + 200)}…` : m.text;
      textDiv.innerHTML = this.highlight(q && m.text.toLowerCase().includes(q) ? snippet : m.text.slice(0, 300), q);
      item.appendChild(textDiv);

      this._list.appendChild(item);
    });
  },

  onUnload() {
    if (this._unsubscribe) this._unsubscribe();
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

/**
 * Semantic Search overlay — DOM-only, no Node/Electron APIs. Searches the
 * locally-built chat history index (electron/main.js's search:query IPC):
 * hybrid TF-IDF keyword ranking, blended with a hosted-embeddings cosine
 * score when the user has configured one. Modeled on
 * core/skill-marketplace.js's mount/open/close/toggle pattern, simplified
 * (no detail pane — just result rows with a snippet and a jump-to link).
 *
 * `host`:
 *   host.query({ query, limit }) -> Promise<item[]>
 *   host.jumpToResult(item)
 */

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class SemanticSearchOverlay {
  constructor(host) {
    this.host = host;
    this.el = null;
    this._searchTimer = null;
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-semantic-search-overlay";
    overlay.innerHTML = `
      <div class="bc-ss-box">
        <input type="text" class="bc-ss-input" placeholder="Search all indexed chats…" data-bc-ss-input />
        <div class="bc-ss-list" data-bc-ss-list></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });

    const input = overlay.querySelector("[data-bc-ss-input]");
    input.addEventListener("input", () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._runQuery(input.value), 300);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    return overlay;
  }

  open() {
    if (!this.el) this.mount();
    this.el.classList.add("bc-open");
    const input = this.el.querySelector("[data-bc-ss-input]");
    input.value = "";
    this.el.querySelector("[data-bc-ss-list]").innerHTML = `<div class="bc-ss-empty">Type to search everything indexed so far.</div>`;
    setTimeout(() => input.focus(), 0);
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  async _runQuery(query) {
    const list = this.el.querySelector("[data-bc-ss-list]");
    const q = query.trim();
    if (!q) {
      list.innerHTML = `<div class="bc-ss-empty">Type to search everything indexed so far.</div>`;
      return;
    }
    list.innerHTML = `<div class="bc-ss-loading">Searching…</div>`;
    try {
      const results = await this.host.query({ query: q, limit: 20 });
      this._renderResults(results);
    } catch (err) {
      list.innerHTML = `<div class="bc-ss-error">${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  _renderResults(results) {
    const list = this.el.querySelector("[data-bc-ss-list]");
    list.innerHTML = "";
    if (!results || results.length === 0) {
      list.innerHTML = `<div class="bc-ss-empty">No matches — only conversations you've actually opened in BetterClaude get indexed.</div>`;
      return;
    }
    results.forEach((r) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "bc-ss-item";
      item.innerHTML = `
        <div class="bc-ss-item-head">
          <span class="bc-ss-item-title">${escapeHtml(r.title)}</span>
          <span class="bc-ss-item-role">${r.role === "user" ? "You" : "Assistant"}</span>
        </div>
        <div class="bc-ss-item-snippet">${escapeHtml(r.snippet)}</div>
      `;
      item.addEventListener("click", () => {
        this.close();
        this.host.jumpToResult(r);
      });
      list.appendChild(item);
    });
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { SemanticSearchOverlay };

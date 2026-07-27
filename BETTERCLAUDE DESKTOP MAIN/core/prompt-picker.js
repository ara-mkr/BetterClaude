/**
 * Prompt Picker overlay — DOM-only, no Node/Electron APIs. Modeled directly
 * on core/command-palette.js's mount/open/close/toggle pattern: a searchable
 * list of Prompt Library entries that either inserts immediately (no
 * {{variables}}) or swaps to a small fill-in form first.
 *
 * `host`:
 *   host.getPrompts() -> prompt[]              (sync, reads local settings)
 *   host.insertIntoComposer(text) -> boolean
 *   host.notify(message)
 *   host.onInsert({promptId, values, filledText})  (optional — Macro
 *     Recorder's capture hook, see electron/preload.js)
 */

const { extractVariables, fillTemplate } = require("./prompt-vars");

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class PromptPicker {
  constructor(host) {
    this.host = host;
    this.el = null;
    this._filtered = [];
    this._activeIndex = 0;
    this._capturedSelection = "";
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-prompt-picker-overlay";
    overlay.innerHTML = `<div class="bc-pp-box" data-bc-pp-box></div>`;
    document.body.appendChild(overlay);
    this.el = overlay;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    return overlay;
  }

  // promptId: optional — used by the global per-prompt keyboard shortcut to
  // jump straight to one prompt's fill form instead of the search list.
  open(promptId) {
    // Captured before anything here steals focus, so a real text selection
    // on the page is still available to prefill a {{selection}} variable.
    this._capturedSelection = (window.getSelection && window.getSelection().toString()) || "";
    if (!this.el) this.mount();
    this.el.classList.add("bc-open");
    const prompt = promptId && this.host.getPrompts().find((p) => p.id === promptId);
    if (prompt) this._selectPrompt(prompt);
    else this._showList("");
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  _showList(query) {
    const box = this.el.querySelector("[data-bc-pp-box]");
    box.innerHTML = `
      <input type="text" class="bc-pp-input" placeholder="Search prompts…" data-bc-pp-input />
      <div class="bc-pp-list" data-bc-pp-list></div>
    `;
    const input = box.querySelector("[data-bc-pp-input]");
    input.value = query || "";
    input.addEventListener("input", () => this._renderList(input.value));
    input.addEventListener("keydown", (e) => this._onInputKeydown(e));
    setTimeout(() => input.focus(), 0);
    this._renderList(query || "");
  }

  _renderList(query) {
    const list = this.el.querySelector("[data-bc-pp-list]");
    if (!list) return;
    list.innerHTML = "";
    const q = query.trim().toLowerCase();
    const prompts = this.host.getPrompts() || [];
    this._filtered = prompts.filter((p) => {
      if (!q) return true;
      return (p.title || "").toLowerCase().includes(q)
        || (p.folder || "").toLowerCase().includes(q)
        || (p.tags || []).some((t) => t.toLowerCase().includes(q));
    });
    this._activeIndex = 0;

    if (this._filtered.length === 0) {
      list.innerHTML = `<div class="bc-pp-empty">No prompts found. Add some in Settings → Prompt Library.</div>`;
      return;
    }

    this._filtered.forEach((p, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `bc-pp-item${i === 0 ? " bc-active" : ""}`;
      const tagsLabel = (p.tags || []).join(", ");
      item.innerHTML = `
        <span class="bc-pp-item-title">${escapeHtml(p.title)}</span>
        <span class="bc-pp-item-meta">${escapeHtml(p.folder || "General")}${tagsLabel ? ` · ${escapeHtml(tagsLabel)}` : ""}</span>
      `;
      item.addEventListener("click", () => this._selectPrompt(p));
      list.appendChild(item);
    });
  }

  _onInputKeydown(e) {
    const items = Array.from(this.el.querySelectorAll(".bc-pp-item"));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._activeIndex = Math.min(items.length - 1, this._activeIndex + 1);
      this._highlight(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this._activeIndex = Math.max(0, this._activeIndex - 1);
      this._highlight(items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = this._filtered[this._activeIndex];
      if (p) this._selectPrompt(p);
    } else if (e.key === "Escape") {
      this.close();
    }
  }

  _highlight(items) {
    items.forEach((el, i) => el.classList.toggle("bc-active", i === this._activeIndex));
    if (items[this._activeIndex]) items[this._activeIndex].scrollIntoView({ block: "nearest" });
  }

  _selectPrompt(prompt) {
    const vars = extractVariables(prompt.body);
    if (vars.length === 0) {
      this._insert(prompt.body, { promptId: prompt.id, values: {} });
      return;
    }
    this._renderForm(prompt, vars);
  }

  _renderForm(prompt, vars) {
    const box = this.el.querySelector("[data-bc-pp-box]");
    box.innerHTML = `
      <div class="bc-pp-form-header">${escapeHtml(prompt.title)}</div>
      <div class="bc-pp-form" data-bc-pp-form></div>
      <div class="bc-pp-form-actions">
        <button type="button" class="bc-pp-form-cancel" data-bc-pp-cancel>Back</button>
        <button type="button" class="bc-pp-form-save" data-bc-pp-insert>Insert</button>
      </div>
    `;
    const form = box.querySelector("[data-bc-pp-form]");
    const inputs = {};
    vars.forEach((name) => {
      const row = document.createElement("label");
      row.className = "bc-pp-form-row";
      const labelEl = document.createElement("span");
      labelEl.textContent = `{{${name}}}`;
      const input = document.createElement("textarea");
      input.rows = 2;
      input.dataset.varName = name;
      row.appendChild(labelEl);
      row.appendChild(input);
      form.appendChild(row);
      inputs[name] = input;

      if (name === "selection") {
        input.value = this._capturedSelection || "";
      } else if (name === "clipboard") {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((text) => { input.value = text || ""; }).catch(() => {});
        }
      }
    });

    box.querySelector("[data-bc-pp-cancel]").addEventListener("click", () => this._showList(""));
    box.querySelector("[data-bc-pp-insert]").addEventListener("click", () => {
      const values = {};
      vars.forEach((name) => { values[name] = inputs[name].value; });
      this._insert(fillTemplate(prompt.body, values), { promptId: prompt.id, values });
    });

    const first = form.querySelector("textarea");
    if (first) setTimeout(() => first.focus(), 0);
  }

  // `meta` (optional) is {promptId, values} — used only by the Macro
  // Recorder's capture hook (electron/preload.js) to record this insertion
  // as a re-resolvable prompt step rather than opaque literal text.
  _insert(text, meta) {
    const ok = this.host.insertIntoComposer(text);
    if (ok && meta && this.host.onInsert) this.host.onInsert({ ...meta, filledText: text });
    this.close();
    if (!ok && this.host.notify) this.host.notify("Couldn't find claude.ai's composer.");
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { PromptPicker };

/**
 * Snippet Library — full CRUD prompt/snippet manager. A superset of
 * Quick Prompts: categories, search, and a keyboard shortcut to open a
 * quick-insert palette, with everything persisted via api.registerSetting.
 */

const LIBRARY_ICON = `<svg viewBox="0 0 24 24"><path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z"/></svg>`;

const DEFAULT_LIBRARY = {
  snippets: [
    { id: "s1", category: "General", title: "ELI5", text: "Explain this like I'm five." },
    { id: "s2", category: "General", title: "Summarize", text: "Summarize the above in 3 bullet points." },
    { id: "s3", category: "Review", title: "Tradeoffs", text: "What are the tradeoffs here?" },
    { id: "s4", category: "Review", title: "Concise rewrite", text: "Rewrite this more concisely." },
  ],
};

const OPEN_SHORTCUT = { key: "l", meta: true, shift: true }; // Cmd/Ctrl+Shift+L

function uid() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = {
  name: "Snippet Library",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.library = api.registerSetting("library", DEFAULT_LIBRARY);
    if (!this.library.snippets) this.library.snippets = [];
    this.query = "";
    this.categoryFilter = "All";
    this.formOpen = false;

    api.injectCSS(`
      #bc-snippet-panel {
        position: fixed;
        top: 88px;
        right: 16px;
        width: 320px;
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
      #bc-snippet-panel.bc-open { display: flex; }
      .bc-sl-toolbar { display: flex; gap: 6px; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .bc-sl-toolbar input, .bc-sl-toolbar select {
        background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 5px 8px; font: inherit;
      }
      .bc-sl-toolbar input { flex: 1; min-width: 0; }
      .bc-sl-list { overflow-y: auto; flex: 1; padding: 6px; }
      .bc-sl-item {
        padding: 8px 10px; border-radius: 8px; margin-bottom: 4px;
        background: rgba(255,255,255,0.03); cursor: pointer;
      }
      .bc-sl-item:hover { background: rgba(139,92,246,0.2); }
      .bc-sl-item-title { font-weight: 600; display: flex; justify-content: space-between; gap: 6px; }
      .bc-sl-item-cat { opacity: 0.55; font-size: 10px; }
      .bc-sl-item-text { opacity: 0.7; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bc-sl-item-actions { display: flex; gap: 4px; flex-shrink: 0; }
      .bc-sl-item-actions button {
        background: none; border: none; color: #a99bd1; cursor: pointer; font-size: 11px; padding: 0 2px;
      }
      .bc-sl-item-actions button:hover { color: #ece7fb; }
      .bc-sl-footer { padding: 8px; border-top: 1px solid rgba(255,255,255,0.1); }
      .bc-sl-footer button {
        width: 100%; padding: 7px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.25);
        background: transparent; color: #ece7fb; cursor: pointer; font: inherit;
      }
      .bc-sl-footer button:hover { background: rgba(255,255,255,0.06); }
      .bc-sl-form { padding: 10px; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid rgba(255,255,255,0.1); }
      .bc-sl-form input, .bc-sl-form textarea {
        background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 6px 8px; font: inherit; resize: vertical;
      }
      .bc-sl-form-row { display: flex; gap: 6px; }
      .bc-sl-form-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .bc-sl-form-actions button {
        padding: 5px 10px; border-radius: 6px; border: none; cursor: pointer; font: inherit;
      }
      .bc-sl-form-save { background: var(--bc-accent, #8b5cf6); color: var(--btn-primary-fg, #fff); }
      .bc-sl-form-cancel { background: transparent; color: #ece7fb; border: 1px solid #3a2e5c !important; }
      .bc-sl-empty { opacity: 0.5; text-align: center; padding: 20px 10px; }
    `);

    this._dockBtn = api.mountToolbarButton({
      icon: LIBRARY_ICON,
      label: "Snippet Library (Cmd/Ctrl+Shift+L)",
      onClick: () => this.toggle(),
    });

    const panel = document.createElement("div");
    panel.id = "bc-snippet-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this._onKeydown = (e) => {
      if (e.key.toLowerCase() === OPEN_SHORTCUT.key && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        this.toggle();
      }
    };
    document.addEventListener("keydown", this._onKeydown);

    this.render();
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
    if (open) this.render();
  },

  persist() {
    this.api.setSetting("library", this.library);
  },

  insertSnippet(text) {
    if (!this.api.insertIntoComposer(text, { append: true })) {
      this.api.notify("Couldn't find the composer.");
      return;
    }
    this._panel.classList.remove("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(false);
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    const categories = ["All", ...new Set(this.library.snippets.map((s) => s.category || "General"))];

    const toolbar = document.createElement("div");
    toolbar.className = "bc-sl-toolbar";
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search snippets…";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    const catSelect = document.createElement("select");
    categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
    catSelect.value = this.categoryFilter;
    catSelect.addEventListener("change", () => {
      this.categoryFilter = catSelect.value;
      this.renderList();
    });
    toolbar.appendChild(search);
    toolbar.appendChild(catSelect);
    panel.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "bc-sl-list";
    panel.appendChild(list);
    this._list = list;
    this.renderList();

    const footer = document.createElement("div");
    footer.className = "bc-sl-footer";
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ New Snippet";
    addBtn.addEventListener("click", () => this.renderForm());
    footer.appendChild(addBtn);
    panel.appendChild(footer);
    this._footer = footer;
  },

  renderList() {
    const list = this._list;
    list.innerHTML = "";
    const q = this.query.trim().toLowerCase();
    const filtered = this.library.snippets.filter((s) => {
      const matchesCat = this.categoryFilter === "All" || (s.category || "General") === this.categoryFilter;
      const matchesQuery = !q || s.title.toLowerCase().includes(q) || s.text.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-sl-empty";
      empty.textContent = "No snippets found.";
      list.appendChild(empty);
      return;
    }

    filtered.forEach((s) => {
      const item = document.createElement("div");
      item.className = "bc-sl-item";

      const titleRow = document.createElement("div");
      titleRow.className = "bc-sl-item-title";
      const titleSpan = document.createElement("span");
      titleSpan.textContent = s.title;
      const actions = document.createElement("div");
      actions.className = "bc-sl-item-actions";
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Edit";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.renderForm(s);
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.library.snippets = this.library.snippets.filter((x) => x.id !== s.id);
        this.persist();
        this.renderList();
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      titleRow.appendChild(titleSpan);
      titleRow.appendChild(actions);

      const catSpan = document.createElement("div");
      catSpan.className = "bc-sl-item-cat";
      catSpan.textContent = s.category || "General";

      const textDiv = document.createElement("div");
      textDiv.className = "bc-sl-item-text";
      textDiv.textContent = s.text;

      item.appendChild(titleRow);
      item.appendChild(catSpan);
      item.appendChild(textDiv);
      item.addEventListener("click", () => this.insertSnippet(s.text));
      list.appendChild(item);
    });
  },

  renderForm(existing) {
    const prevForm = this._panel.querySelector(".bc-sl-form");
    if (prevForm) prevForm.remove();

    const form = document.createElement("div");
    form.className = "bc-sl-form";

    const row = document.createElement("div");
    row.className = "bc-sl-form-row";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Title";
    titleInput.value = existing ? existing.title : "";
    titleInput.style.flex = "1";
    const catInput = document.createElement("input");
    catInput.type = "text";
    catInput.placeholder = "Category";
    catInput.value = existing ? (existing.category || "General") : "General";
    catInput.style.width = "100px";
    row.appendChild(titleInput);
    row.appendChild(catInput);

    const textArea = document.createElement("textarea");
    textArea.rows = 3;
    textArea.placeholder = "Prompt text";
    textArea.value = existing ? existing.text : "";

    const actionsRow = document.createElement("div");
    actionsRow.className = "bc-sl-form-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "bc-sl-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => form.remove());
    const saveBtn = document.createElement("button");
    saveBtn.className = "bc-sl-form-save";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const title = titleInput.value.trim();
      const text = textArea.value.trim();
      if (!title || !text) return;
      if (existing) {
        existing.title = title;
        existing.category = catInput.value.trim() || "General";
        existing.text = text;
      } else {
        this.library.snippets.push({ id: uid(), title, category: catInput.value.trim() || "General", text });
      }
      this.persist();
      form.remove();
      this.render();
    });
    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(saveBtn);

    form.appendChild(row);
    form.appendChild(textArea);
    form.appendChild(actionsRow);
    this._panel.appendChild(form);
    titleInput.focus();
  },

  onUnload() {
    document.removeEventListener("keydown", this._onKeydown);
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

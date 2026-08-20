/**
 * Sticky Notes — a small corkboard of freeform notes, distinct from
 * Snippet Library (which manages reusable prompt text): these are personal
 * scratch notes, not meant for insertion into the composer.
 */
const NOTES_ICON = `<svg viewBox="0 0 24 24"><path d="M4 4h16v11l-5 5H4V4Z"/><path d="M15 20v-5h5"/></svg>`;

function uid() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const NOTE_COLORS = ["#f5c518", "#8b5cf6", "#22c55e", "#38bdf8", "#f97316"];

module.exports = {
  name: "Sticky Notes",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.notes = api.registerSetting("notes", []);

    api.injectCSS(`
      #bc-sticky-panel {
        position: fixed; top: 88px; right: 16px; width: 260px; max-height: 70vh;
        overflow-y: auto; z-index: 2147482950; background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
        display: none; flex-direction: column; gap: 8px; padding: 12px;
        font: 12px -apple-system, sans-serif;
      }
      #bc-sticky-panel.bc-open { display: flex; }
      .bc-sticky-note { border-radius: 8px; padding: 10px; position: relative; color: #14101f; }
      .bc-sticky-note textarea {
        width: 100%; min-height: 60px; border: none; background: transparent;
        resize: vertical; font: inherit; color: inherit; box-sizing: border-box;
      }
      .bc-sticky-note textarea:focus { outline: none; }
      .bc-sticky-del {
        position: absolute; top: 4px; right: 6px; border: none; background: none;
        cursor: pointer; opacity: 0.55; font-size: 12px; color: #14101f;
      }
      .bc-sticky-del:hover { opacity: 1; }
      .bc-sticky-add {
        border: 1px dashed rgba(255,255,255,0.3); border-radius: 8px; padding: 8px;
        background: transparent; color: #ece7fb; cursor: pointer; font: inherit;
      }
      .bc-sticky-add:hover { background: rgba(255,255,255,0.06); }
      .bc-sticky-empty { color: #ece7fb; opacity: 0.55; text-align: center; padding: 16px 4px; }
    `);

    this._dockBtn = api.mountToolbarButton({ icon: NOTES_ICON, label: "Sticky Notes", onClick: () => this.toggle() });

    const panel = document.createElement("div");
    panel.id = "bc-sticky-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this.render();
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
    if (open) this.render();
  },

  persist() {
    this.api.setSetting("notes", this.notes);
  },

  addNote() {
    this.notes.push({ id: uid(), text: "", color: NOTE_COLORS[this.notes.length % NOTE_COLORS.length] });
    this.persist();
    this.render();
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    if (this.notes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-sticky-empty";
      empty.textContent = "No notes yet — add your first one below.";
      panel.appendChild(empty);
    }

    this.notes.forEach((note) => {
      const card = document.createElement("div");
      card.className = "bc-sticky-note";
      card.style.background = note.color;

      const del = document.createElement("button");
      del.className = "bc-sticky-del";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        this.notes = this.notes.filter((n) => n.id !== note.id);
        this.persist();
        this.render();
      });
      card.appendChild(del);

      const textarea = document.createElement("textarea");
      textarea.value = note.text;
      textarea.placeholder = "Write something…";
      let debounce = null;
      textarea.addEventListener("input", () => {
        note.text = textarea.value;
        clearTimeout(debounce);
        debounce = setTimeout(() => this.persist(), 300);
      });
      card.appendChild(textarea);

      panel.appendChild(card);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "bc-sticky-add";
    addBtn.textContent = "+ New Note";
    addBtn.addEventListener("click", () => this.addNote());
    panel.appendChild(addBtn);
  },

  onUnload() {
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

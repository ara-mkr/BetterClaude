/**
 * Quote of the Day — mixes real quotes with joke ones on purpose, plus a
 * small "add your own" affordance so the pool is user-editable. Rerolls
 * once per calendar day automatically; the dock popover also offers a
 * manual reroll.
 */
const QUOTE_ICON = `<svg viewBox="0 0 24 24"><path d="M7 7h4v4a4 4 0 0 1-4 4H6v-2h1a2 2 0 0 0 2-2H7V7Zm8 0h4v4a4 4 0 0 1-4 4h-1v-2h1a2 2 0 0 0 2-2h-2V7Z"/></svg>`;

const DEFAULT_QUOTES = {
  real: [
    "The best way to predict the future is to invent it. — Alan Kay",
    "Simplicity is the soul of efficiency. — Austin Freeman",
    "Make it work, make it right, make it fast. — Kent Beck",
    "The only way to go fast is to go well. — Robert C. Martin",
  ],
  joke: [
    "99 little bugs in the code, 99 little bugs. Take one down, patch it around — 127 little bugs in the code.",
    "There are only 10 types of people: those who understand binary and those who don't.",
    "I would tell you a UDP joke, but you might not get it.",
    "A SQL query walks into a bar, walks up to two tables and asks: “Can I join you?”",
  ],
  custom: [],
};

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

module.exports = {
  name: "Quote of the Day",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.quotes = Object.assign({}, DEFAULT_QUOTES, api.registerSetting("quotes", DEFAULT_QUOTES));
    this.cache = api.registerSetting("cache", { date: "", text: "" });

    api.injectCSS(`
      #bc-quote-panel {
        position: fixed; top: 88px; right: 16px; width: 260px;
        z-index: 2147482950; background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
        display: none; flex-direction: column; gap: 10px; padding: 14px;
        font: 12px -apple-system, sans-serif; color: #ece7fb;
      }
      #bc-quote-panel.bc-open { display: flex; }
      .bc-quote-text { line-height: 1.5; font-style: italic; }
      .bc-quote-row { display: flex; gap: 6px; }
      .bc-quote-row button, .bc-quote-add button {
        padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
        background: transparent; color: #ece7fb; cursor: pointer; font: inherit;
      }
      .bc-quote-row button:hover, .bc-quote-add button:hover { background: rgba(139,92,246,0.25); }
      .bc-quote-add { display: flex; gap: 6px; }
      .bc-quote-add input {
        flex: 1; background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 6px 8px; font: inherit;
      }
    `);

    this._dockBtn = api.mountToolbarButton({ icon: QUOTE_ICON, label: "Quote of the Day", onClick: () => this.toggle() });

    const panel = document.createElement("div");
    panel.id = "bc-quote-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this._ensureTodayQuote();
    this.render();
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
    if (open) this.render();
  },

  _pool() {
    return [...this.quotes.real, ...this.quotes.joke, ...(this.quotes.custom || [])];
  },

  _ensureTodayQuote() {
    const today = dateKey();
    if (this.cache.date === today && this.cache.text) return;
    const pool = this._pool();
    const text = pool[Math.floor(Math.random() * pool.length)] || "No quotes yet — add one below.";
    this.cache = { date: today, text };
    this.api.setSetting("cache", this.cache);
  },

  reroll() {
    const pool = this._pool();
    if (!pool.length) return;
    this.cache = { date: dateKey(), text: pool[Math.floor(Math.random() * pool.length)] };
    this.api.setSetting("cache", this.cache);
    this.render();
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    const text = document.createElement("div");
    text.className = "bc-quote-text";
    text.textContent = this.cache.text;
    panel.appendChild(text);

    const row = document.createElement("div");
    row.className = "bc-quote-row";
    const rerollBtn = document.createElement("button");
    rerollBtn.textContent = "Another";
    rerollBtn.addEventListener("click", () => this.reroll());
    row.appendChild(rerollBtn);
    panel.appendChild(row);

    const addRow = document.createElement("div");
    addRow.className = "bc-quote-add";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add your own quote or tip…";
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
    const addBtn = document.createElement("button");
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return;
      this.quotes.custom = [...(this.quotes.custom || []), value];
      this.api.setSetting("quotes", this.quotes);
      input.value = "";
      this.api.notify("Added to your quote pool.");
    });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    panel.appendChild(addRow);
  },

  onUnload() {
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

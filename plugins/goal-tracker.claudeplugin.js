/**
 * Goal Tracker — a simple checklist with a progress bar. Ships a real,
 * code-generated empty-state illustration (no image asset/hotlink) rather
 * than just an empty list, per the brief's "custom illustration for empty
 * states" — scoped here to a widget BetterClaude fully owns.
 */
const GOAL_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>`;

function uid() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const EMPTY_STATE_SVG = `
<svg viewBox="0 0 120 90" width="120" height="90">
  <ellipse cx="60" cy="78" rx="40" ry="6" fill="rgba(255,255,255,0.06)"/>
  <path d="M30 60c0-22 14-38 30-38s30 16 30 38" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 6" opacity="0.5"/>
  <circle cx="60" cy="34" r="6" fill="currentColor" opacity="0.5"/>
  <path d="M45 60l10-10 8 8 12-16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
</svg>`;

module.exports = {
  name: "Goal Tracker",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.goals = api.registerSetting("goals", []);

    api.injectCSS(`
      #bc-goal-panel {
        position: fixed; top: 88px; right: 16px; width: 280px; max-height: 70vh;
        overflow-y: auto; z-index: 2147482950; background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
        display: none; flex-direction: column; gap: 10px; padding: 14px;
        font: 12px -apple-system, sans-serif; color: #ece7fb;
      }
      #bc-goal-panel.bc-open { display: flex; }
      .bc-goal-empty { text-align: center; color: #cbbdf0; padding: 12px 4px; }
      .bc-goal-empty svg { color: #8b5cf6; margin-bottom: 6px; }
      .bc-goal-row { display: flex; align-items: center; gap: 8px; }
      .bc-goal-row input[type="checkbox"] { flex-shrink: 0; }
      .bc-goal-label { flex: 1; }
      .bc-goal-label.bc-done { text-decoration: line-through; opacity: 0.5; }
      .bc-goal-del { background: none; border: none; color: #a99bd1; cursor: pointer; }
      .bc-goal-del:hover { color: #ef4444; }
      .bc-goal-progress { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
      .bc-goal-progress-fill { height: 100%; background: #8b5cf6; transition: width 200ms ease; }
      .bc-goal-add { display: flex; gap: 6px; }
      .bc-goal-add input {
        flex: 1; background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 6px 8px; font: inherit;
      }
      .bc-goal-add button {
        padding: 6px 10px; border-radius: 6px; border: none; background: #8b5cf6; color: #fff; cursor: pointer;
      }
    `);

    this._dockBtn = api.mountToolbarButton({ icon: GOAL_ICON, label: "Goal Tracker", onClick: () => this.toggle() });

    const panel = document.createElement("div");
    panel.id = "bc-goal-panel";
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
    this.api.setSetting("goals", this.goals);
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    if (this.goals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-goal-empty";
      empty.innerHTML = `${EMPTY_STATE_SVG}<div>No goals yet. Add one below to start tracking progress.</div>`;
      panel.appendChild(empty);
    } else {
      const done = this.goals.filter((g) => g.done).length;
      const progress = document.createElement("div");
      progress.className = "bc-goal-progress";
      const fill = document.createElement("div");
      fill.className = "bc-goal-progress-fill";
      fill.style.width = `${Math.round((done / this.goals.length) * 100)}%`;
      progress.appendChild(fill);
      panel.appendChild(progress);

      this.goals.forEach((goal) => {
        const row = document.createElement("div");
        row.className = "bc-goal-row";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = !!goal.done;
        check.addEventListener("change", () => {
          goal.done = check.checked;
          this.persist();
          this.render();
        });
        const label = document.createElement("span");
        label.className = `bc-goal-label${goal.done ? " bc-done" : ""}`;
        label.textContent = goal.text;
        const del = document.createElement("button");
        del.className = "bc-goal-del";
        del.textContent = "✕";
        del.addEventListener("click", () => {
          this.goals = this.goals.filter((g) => g.id !== goal.id);
          this.persist();
          this.render();
        });
        row.appendChild(check);
        row.appendChild(label);
        row.appendChild(del);
        panel.appendChild(row);
      });
    }

    const addRow = document.createElement("div");
    addRow.className = "bc-goal-add";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "New goal…";
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
    const addBtn = document.createElement("button");
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      this.goals.push({ id: uid(), text, done: false });
      this.persist();
      input.value = "";
      this.render();
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

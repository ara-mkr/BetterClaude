/**
 * Settings -> File Watcher. Native File Watcher Sync: watches a local file
 * on disk (electron/main.js, chokidar) and keeps a labeled fenced-code-block
 * copy of it in the composer in sync. Doesn't fake claude.ai's own native
 * upload UI — see core/file-sync-indicator.js.
 */

const { el, toggleField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "Never inserted";
  return new Date(ts).toLocaleString();
}

module.exports = {
  _renderFileWatcher() {
    const { settings } = this;
    const fw = settings.fileWatcher;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "File Watcher" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Watch a local file and keep a copy of it in the composer as a labeled code block. \"Auto-reattach\" "
        + "find-and-replaces that block in place while the message is still unsent; once sent, a changed file is "
        + "just marked stale with a one-click re-insert — this never rewrites an already-sent message.",
    }));

    wrap.appendChild(toggleField("Enable File Watcher", fw.enabled, (v) => this._set("fileWatcher.enabled", v)));

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "Watch a file…",
      onclick: async () => {
        await this.host.pickWatchedFile();
        this.settings = this.host.getSettings();
        this.renderSection();
      },
    }));

    wrap.appendChild(el("h2", { text: "Watched files", class: "bc-ae-subhead" }));
    const list = el("div", { class: "bc-plugin-list" });
    if (fw.watched.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "Not watching any files yet." }));
    fw.watched.forEach((w) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: w.label }),
        el("span", { class: "bc-plugin-version", text: `${w.path}` }),
        el("span", {
          class: "bc-plugin-version",
          text: `${w.stale ? "Changed — not yet synced" : "In sync"} · ${formatWhen(w.lastSyncedAt)}`,
        }),
      ]));

      const autoToggle = el("input", { type: "checkbox" });
      autoToggle.checked = !!w.autoReattach;
      autoToggle.title = "Auto-reattach on change";
      autoToggle.addEventListener("change", () => this.host.setAutoReattach(w.id, autoToggle.checked));

      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(autoToggle);
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: w.lastSyncedAt ? "Re-insert" : "Insert",
        onclick: () => {
          this.host.insertWatchedFile(w.id);
          this.settings = this.host.getSettings();
          this.renderSection();
        },
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete",
        text: "✕",
        title: "Stop watching",
        onclick: async () => {
          await this.host.stopWatchingFile(w.id);
          this.settings = this.host.getSettings();
          this.renderSection();
        },
      }));
      row.appendChild(actions);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    this.contentEl.appendChild(wrap);
  },
};

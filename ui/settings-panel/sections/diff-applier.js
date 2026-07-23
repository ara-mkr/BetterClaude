/**
 * Settings -> Diff Applier. Inline Diff Applier for Code Blocks: when a
 * response's code block matches a file watched by Native File Watcher Sync
 * (Settings → File Watcher), a "Diff & Apply" button floats over it —
 * confirm the target file, review a line diff against its real current
 * contents, then apply to overwrite it on disk. See core/diff-applier.js
 * for how (fuzzy) matching and its confidence levels work.
 */

const { el, toggleField } = require("../dom-helpers");

module.exports = {
  _renderDiffApplier() {
    const { settings } = this;
    const da = settings.diffApplier;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Diff Applier" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "When a response's code block matches a file you're watching, a \"Diff & Apply\" button appears over "
        + "it. It always shows a file picker and a confidence note before you apply — filename-mention matches are "
        + "\"exact\", extension-only matches are flagged so you can confirm (or correct) the guess first. Apply "
        + "diffs against the file's real current contents (read fresh from disk) and overwrites it.",
    }));

    wrap.appendChild(toggleField("Enable Diff Applier", da.enabled, (v) => this._set("diffApplier.enabled", v)));

    const watchedCount = (settings.fileWatcher.watched || []).length;
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: watchedCount === 0
        ? "Not watching any files yet — this stays invisible until you add one in Settings → File Watcher."
        : `Watching ${watchedCount} file${watchedCount === 1 ? "" : "s"} — matching code blocks will show the button.`,
    }));

    this.contentEl.appendChild(wrap);
  },
};

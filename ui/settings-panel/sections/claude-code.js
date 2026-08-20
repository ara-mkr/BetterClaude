/**
 * Settings panel section: Claude Code — the embedded terminal pane.
 * Mixed onto SettingsPanel.prototype by panel.js.
 *
 * Every preference under `codeWindow` in core/settings-schema.js is surfaced
 * here. Two of them (claudePath, fontSizePx) had existed in the schema and
 * been read at runtime for some time with NO user interface anywhere — stored
 * settings nobody could set, which is indistinguishable from a broken feature
 * from the outside.
 */

const { el, rangeField, toggleField, textField } = require("../dom-helpers");

module.exports = {
  _renderClaudeCode() {
    const { settings } = this;
    const code = settings.codeWindow || {};
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Claude Code" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Runs the claude CLI installed on this machine, in a real terminal beside the chat — not Anthropic's hosted Code surface.",
    }));

    wrap.appendChild(toggleField(
      "Show the CLI tab",
      code.tabEnabled !== false,
      (v) => this._set("codeWindow.tabEnabled", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Adds a CLI pill next to Claude's own Home and Code tabs. Turning it off only hides the pill — the tray item, the app menu and ⌘⇧K still open the terminal.",
    }));

    wrap.appendChild(rangeField("Terminal font size", {
      min: 9,
      max: 24,
      value: Number(code.fontSizePx) || 13,
      format: (v) => `${v}px`,
      onInput: (v) => this._set("codeWindow.fontSizePx", v),
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "The terminal's font family follows the code font set under Fonts.",
    }));

    wrap.appendChild(textField(
      "Path to the claude executable",
      code.claudePath || "",
      // Empty string means "resolve it the way a shell would" — stored as null
      // rather than "" so it matches the schema default exactly instead of
      // being a second, subtly different flavour of unset.
      (v) => this._set("codeWindow.claudePath", v.trim() || null),
      { placeholder: "Leave blank to find claude on your PATH" }
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Only needed for a version-managed or non-standard install that a GUI app's PATH doesn't reach. This is a path to an executable — never a config or credential file.",
    }));

    this.contentEl.appendChild(wrap);
  },
};

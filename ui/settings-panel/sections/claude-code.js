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
      text: "The CLI and Code tabs run the claude CLI installed on this machine — a real terminal, and a chat on your Claude plan — not Anthropic's hosted Code surface.",
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

    wrap.appendChild(toggleField(
      "Session mesh (sessions talk to each other)",
      code.teamMesh !== false,
      (v) => this._set("codeWindow.teamMesh", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Every CLI session automatically joins its folder's shared team hub: each one can see what the others are working on, message them, and hand tasks back and forth. The Live wire on the right edge of the terminal shows the traffic. Off = only sessions explicitly started as teammates cooperate.",
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

    // --- Code tab chats (electron/ide-chat.js) -------------------------------
    const chat = code.chat || {};
    wrap.appendChild(el("h3", { text: "Code tab chats" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Each Code tab conversation is a real Claude Code session on your Claude plan. These change how new sessions start; one that is already open picks them up from your next message.",
    }));

    wrap.appendChild(toggleField(
      "Load my ~/.claude settings",
      chat.loadUserSettings === true,
      (v) => this._set("codeWindow.chat.loadUserSettings", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Your global permission rules, hooks and plugins, like a terminal claude. It also applies that file's env block: if it points Claude Code at another endpoint or token, chats stop before sending anything (see below). The project's own .claude settings always load.",
    }));

    wrap.appendChild(toggleField(
      "Start MCP servers",
      chat.loadMcpServers === true,
      (v) => this._set("codeWindow.chat.loadMcpServers", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off: sessions start with Claude Code's built-in tools only. Each configured MCP server launches per session and can add seconds to the first reply.",
    }));

    wrap.appendChild(toggleField(
      "Allow chats that don't bill my Claude plan",
      chat.allowApiKeyBilling === true,
      (v) => this._set("codeWindow.chat.allowApiKeyBilling", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off: a chat whose Claude Code settings would use an API key, an auth token or another base URL, a cloud provider, or an apiKeyHelper is stopped before its first request.",
    }));

    wrap.appendChild(toggleField(
      "Offer the Bypass permissions mode",
      chat.allowBypassMode === true,
      (v) => this._set("codeWindow.chat.allowBypassMode", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Adds Bypass to the composer's mode menu: every tool runs without asking. Auto (Claude Code's own safety classifier) is the safer hands-off choice.",
    }));

    // --- Free models (electron/openrouter.js) ---------------------------------
    const free = code.freeModels || {};
    wrap.appendChild(el("h3", { text: "Free models" }));
    wrap.appendChild(toggleField(
      "Free models in the Code tab",
      free.enabled !== false,
      (v) => this._set("codeWindow.freeModels.enabled", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Lists no-cost models in the composer's model menu. They never use your Claude plan and can't edit files or run commands. OpenRouter's need a free key, added in that menu.",
    }));
    wrap.appendChild(toggleField(
      "Switch to a free model when Claude hits its limit",
      free.autoFailover !== false,
      (v) => this._set("codeWindow.freeModels.autoFailover", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Only for a turn that hadn't run any tools yet — the free model answers that one message with the conversation so far.",
    }));

    this.contentEl.appendChild(wrap);
  },
};

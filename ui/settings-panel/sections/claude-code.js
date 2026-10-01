/**
 * Settings panel section: Claude Code — the embedded terminal pane.
 * Mixed onto SettingsPanel.prototype by panel.js.
 *
 * Every preference under `codeWindow` in core/settings-schema.js is surfaced
 * here. Two of them (claudePath, fontSizePx) had existed in the schema and
 * been read at runtime for some time with NO user interface anywhere — stored
 * settings nobody could set, which is indistinguishable from a broken feature
 * from the outside.
 *
 * "Full IDE" also manages the Code tab's VS Code engine and its extensions
 * (host.workbench — electron/preload.js → electron/workbench.js). Only the
 * main window's host has it; elsewhere the section says where to go.
 */

const { el, rangeField, selectField, toggleField, textField } = require("../dom-helpers");

const mb = (bytes) => `${(Number(bytes) / 1e6).toFixed(0)} MB`;

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

    wrap.appendChild(toggleField(
      "Load my ~/.claude settings in CLI tabs",
      !(code.cli && code.cli.loadUserSettings === false),
      (v) => this._set("codeWindow.cli.loadUserSettings", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "On: a CLI tab is your claude exactly as in a terminal — your permission rules, hooks, plugins, and the file's env block, which can point Claude Code at another endpoint or token. Off: project and local settings only, on your Claude plan login, like Code-tab chats. Applies to tabs opened or restarted after the change.",
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

    this._renderFullIde(wrap, code.ide || {});

    this.contentEl.appendChild(wrap);
  },

  // --- Full IDE (electron/workbench.js; docs/ADR-0001-full-ide-workbench.md) --
  _renderFullIde(wrap, ide) {
    wrap.appendChild(el("h3", { text: "Full IDE" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A real VS Code workbench — VSCodium, the open-source build — beside the Code tab's chat: explorer, editors and splits, terminals, source control and extensions from Open VSX. It runs on this machine only (127.0.0.1, a random port, a secret token) and shares no cookies or storage with claude.ai.",
    }));

    wrap.appendChild(selectField("In the Code tab", [
      { value: "full", label: "Offer the full IDE (⌘⌥I)" },
      { value: "lightweight", label: "Lightweight editor only" },
    ], ide.engine === "lightweight" ? "lightweight" : "full", (v) => this._set("codeWindow.ide.engine", v)));
    wrap.appendChild(selectField("Layout for a new project", [
      { value: "chat", label: "Chat first" },
      { value: "ide", label: "Full IDE" },
    ], ide.defaultLayout === "ide" ? "ide" : "chat", (v) => this._set("codeWindow.ide.defaultLayout", v)));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Each project remembers the layout you leave it in. Lightweight keeps the Code tab to its built-in files, changes and terminal panel and never starts the IDE engine.",
    }));

    wrap.appendChild(toggleField(
      "Font ligatures in the IDE editor",
      ide.fontLigatures !== false,
      (v) => this._set("codeWindow.ide.fontLigatures", v)
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Its editor and terminal use the code font set under Fonts. Its colours follow your BetterClaude theme until you pick another colour theme inside the IDE.",
    }));

    const box = el("div", { class: "bc-wb-box" });
    wrap.appendChild(box);
    if (this.host.workbench) this._renderWorkbenchEngine(box);
    else box.appendChild(el("p", { class: "bc-hint", text: "The IDE engine and its extensions are managed from Settings in the main window." }));

    const telemetry = toggleField("Telemetry", false, () => {});
    telemetry.querySelector("input").disabled = true;
    wrap.appendChild(telemetry);
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Always off: the engine starts with --telemetry-level off, and there is no switch for it.",
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Shortcuts: VS Code's own keybindings apply inside the IDE, where BetterClaude's ⌘K palette and ⌘⇧P prompt picker don't listen. A keyboard shortcut you give a prompt in the Prompt Library is system-wide, though, and wins over the IDE's key for the same combination.",
    }));
  },

  /** The engine's state and its actions, filled in from main. */
  async _renderWorkbenchEngine(box) {
    const wb = this.host.workbench;
    const rerender = () => this._renderWorkbenchEngine(box);
    box.replaceChildren(el("p", { class: "bc-hint", text: "Checking the IDE engine…" }));
    let info = null;
    try { info = await wb.info(); } catch { /* shown below */ }
    box.replaceChildren();
    if (!info) {
      box.appendChild(el("p", { class: "bc-hint", text: "The IDE engine's state isn't available right now." }));
      return;
    }
    if (!info.supported) {
      box.appendChild(el("p", { class: "bc-wb-line", text: "Engine: VSCodium publishes no server build for this platform, so the Code tab keeps its lightweight editor." }));
      return;
    }
    const status = el("p", { class: "bc-wb-status", role: "status" });
    if (!info.installed) {
      box.appendChild(el("p", { class: "bc-wb-line", text: "Engine: not installed — the Code tab uses its lightweight editor." }));
      box.appendChild(el("div", { class: "bc-wb-actions" }, [
        el("button", { class: "bc-btn", text: "Install the full IDE…", onclick: () => this._confirmEngineDownload(box, status, "Install", rerender) }),
      ]));
      box.appendChild(status);
      return;
    }

    box.appendChild(el("p", {
      class: "bc-wb-line",
      text: `Engine: VSCodium ${info.version} · ${info.running ? "running" : "starts when you open the full IDE"}`,
    }));
    const confirmRow = el("div", { class: "bc-wb-actions" });
    box.appendChild(el("div", { class: "bc-wb-actions" }, [
      el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Check for updates",
        onclick: async () => {
          status.textContent = "Asking GitHub for VSCodium's latest release…";
          const res = await wb.checkUpdate();
          if (!res || res.error) { status.textContent = (res && res.error) || "The update check failed."; return; }
          if (!res.newer) { status.textContent = `Up to date — ${res.current} is VSCodium's latest release.`; return; }
          const breaks = res.breaks.map((x) => `${x.displayName} (needs VS Code ${x.engine})`);
          status.textContent = `VSCodium ${res.latest} is available (${mb(res.size)}).${breaks.length ? ` It would stop these extensions from loading: ${breaks.join(", ")}.` : " Every installed extension supports it."}`;
          confirmRow.replaceChildren(el("button", { class: "bc-btn", text: `Update to ${res.latest}…`, onclick: () => this._confirmEngineDownload(box, status, "Update", rerender) }));
        },
      }),
      el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Uninstall…",
        onclick: () => {
          confirmRow.replaceChildren(
            el("span", { class: "bc-wb-note", text: "Remove the engine? Its extensions and settings stay for a reinstall." }),
            el("button", {
              class: "bc-btn",
              text: "Remove",
              onclick: async () => {
                status.textContent = "Removing the engine…";
                const res = await wb.uninstallEngine();
                if (res && res.ok) rerender();
                else status.textContent = (res && res.error) || "Couldn't remove the engine.";
              },
            }),
            el("button", { class: "bc-btn bc-btn-secondary", text: "Cancel", onclick: () => confirmRow.replaceChildren() }),
          );
        },
      }),
    ]));
    box.appendChild(confirmRow);
    box.appendChild(status);

    // --- Extensions -------------------------------------------------------
    box.appendChild(el("h4", { class: "bc-wb-subhead", text: "Extensions" }));
    box.appendChild(el("div", { class: "bc-wb-path" }, [
      el("code", { text: info.extensionsDir }),
      el("button", { class: "bc-btn bc-btn-secondary", text: "Reveal", onclick: () => wb.revealExtensions() }),
    ]));
    const names = info.extensions.map((x) => `${x.displayName} ${x.version}`);
    box.appendChild(el("p", {
      class: "bc-hint",
      text: names.length
        ? `Installed: ${names.join(" · ")}.`
        : "None yet. Browse and install them in the IDE's own Extensions view (Open VSX), or bring over the ones you use elsewhere:",
    }));
    const picker = el("div", { class: "bc-wb-picker", hidden: "" });
    const extStatus = el("p", { class: "bc-wb-status", role: "status" });
    box.appendChild(el("div", { class: "bc-wb-actions" }, [
      el("button", { class: "bc-btn", text: "Import from other editors…", onclick: () => this._renderImportPicker(picker, extStatus, rerender) }),
      el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Install from .vsix…",
        onclick: async () => {
          const res = await wb.installVsix((p) => { if (p.phase === "install") extStatus.textContent = "Installing…"; });
          if (!res) return; // cancelled
          if (!res.ok) { extStatus.textContent = res.error || "That package didn't install."; return; }
          extStatus.textContent = `Installed ${res.displayName} ${res.version || ""} (sha256 ${res.sha256.slice(0, 12)}…).`;
          setTimeout(rerender, 2500);
        },
      }),
    ]));
    box.appendChild(picker);
    box.appendChild(extStatus);
    box.appendChild(el("p", {
      class: "bc-hint",
      text: "Extensions run with your user's permissions, as in VS Code. Installs from here are checked against Open VSX's published sha256, and each shows its publisher and whether Open VSX has verified it.",
    }));
  },

  /** Shows the engine release (size, source) and downloads it only on the user's click. */
  async _confirmEngineDownload(box, status, verb, done) {
    const wb = this.host.workbench;
    status.textContent = "Looking up VSCodium's latest release…";
    const info = await wb.latest();
    if (!info || info.error) { status.textContent = (info && info.error) || "Couldn't reach GitHub releases — check your connection."; return; }
    const go = el("button", {
      class: "bc-btn",
      text: `Download ${mb(info.size)} and ${verb.toLowerCase()}`,
      onclick: async () => {
        go.disabled = true;
        const res = await wb.installEngine((p) => {
          const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
          status.textContent = p.phase === "download" ? `Downloading… ${pct}%` : p.phase === "verify" ? "Checking the sha256…" : p.phase === "unpack" ? "Unpacking…" : "Done.";
        });
        if (res && res.ok) done();
        else { go.disabled = false; status.textContent = (res && res.error) || "The install failed."; }
      },
    });
    status.replaceChildren(
      el("span", { text: `VSCodium ${info.version} (${info.name}), ${mb(info.size)} from ${info.source}. Checked against VSCodium's published sha256, kept in BetterClaude's data folder, and works offline afterwards. ` }),
      go,
    );
  },

  /** Pick which of the other editors' extensions to reinstall here from Open VSX. */
  async _renderImportPicker(picker, status, done) {
    const wb = this.host.workbench;
    picker.hidden = false;
    picker.replaceChildren(el("p", { class: "bc-hint", text: "Reading VS Code, Cursor, Antigravity and VS Code Insiders' extension folders…" }));
    let list = [];
    try { list = (await wb.importCandidates()) || []; } catch { /* empty */ }
    if (!list.length) {
      picker.replaceChildren(el("p", { class: "bc-hint", text: "No extensions found in VS Code, Cursor, Antigravity or VS Code Insiders." }));
      return;
    }
    const rows = new Map();
    const listEl = el("div", { class: "bc-wb-list" });
    list.forEach((x) => {
      const box = el("input", { type: "checkbox" });
      box.checked = !x.installed;
      const note = el("span", { class: "bc-wb-row-state", text: x.installed ? "already in the IDE" : "" });
      listEl.appendChild(el("label", { class: "bc-wb-row" }, [
        box,
        el("span", { class: "bc-wb-row-copy" }, [
          el("strong", { text: x.displayName }),
          el("small", { text: `${x.id} · ${x.version} · ${x.hosts.join(", ")}` }),
        ]),
        note,
      ]));
      rows.set(x.id, { box, note });
    });
    const setAll = (on) => rows.forEach(({ box }) => { box.checked = on; });
    const importBtn = el("button", { class: "bc-btn", text: "Import selected" });
    const cancelBtn = el("button", { class: "bc-btn bc-btn-secondary", text: "Cancel", onclick: () => { picker.hidden = true; picker.replaceChildren(); } });
    importBtn.addEventListener("click", async () => {
      const ids = [...rows].filter(([, r]) => r.box.checked).map(([id]) => id);
      if (!ids.length) { status.textContent = "Nothing selected."; return; }
      importBtn.disabled = true;
      cancelBtn.disabled = true;
      rows.forEach(({ box }) => { box.disabled = true; });
      status.textContent = `Importing ${ids.length} from Open VSX…`;
      const results = await wb.importExtensions(ids, (p) => {
        const row = rows.get(p.id);
        if (!row) return;
        if (p.phase === "download") row.note.textContent = p.total ? `downloading ${Math.round((p.received / p.total) * 100)}%` : "downloading…";
        else if (p.phase === "install") row.note.textContent = "installing…";
        else if (p.phase === "start") row.note.textContent = "looking up…";
      });
      let ok = 0;
      let missing = 0;
      let failed = 0;
      (results || []).forEach((r) => {
        const row = rows.get(r.id);
        if (r.ok) ok += 1;
        else if (r.notFound) missing += 1;
        else failed += 1;
        if (!row) return;
        row.note.textContent = r.ok
          ? `✓ ${r.version} · ${r.publisher}${r.verified ? " · verified" : " · unverified publisher"}`
          : r.notFound ? "not on Open VSX for this platform" : `✗ ${r.error || "failed"}`;
        row.note.dataset.state = r.ok ? "ok" : r.notFound ? "missing" : "failed";
      });
      status.textContent = `Imported ${ok}${missing ? ` · ${missing} not on Open VSX` : ""}${failed ? ` · ${failed} failed` : ""}. Nothing was copied from or written to the other editors.`;
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Done";
      cancelBtn.onclick = () => done();
    });
    picker.replaceChildren(
      el("div", { class: "bc-wb-picker-head" }, [
        el("span", { text: `${list.length} found` }),
        el("button", { class: "bc-btn bc-btn-secondary", text: "All", onclick: () => setAll(true) }),
        el("button", { class: "bc-btn bc-btn-secondary", text: "None", onclick: () => setAll(false) }),
      ]),
      listEl,
      el("p", { class: "bc-hint", text: "Each is reinstalled from Open VSX by its id and checked against Open VSX's sha256. Nothing is copied out of those editors, and nothing is written to them." }),
      el("div", { class: "bc-wb-actions" }, [importBtn, cancelBtn]),
    );
  },
};

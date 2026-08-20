/**
 * Settings -> Session Bundles (Team Sync 2.0). Export the local Claude Code
 * sessions recorded for this project into a `.bcbundle` file a teammate can
 * open, or import one they sent you.
 *
 * Lives only in the Code window's settings panel (see CODE_WINDOW_SECTIONS in
 * electron/code-preload.js), not the main window's — the read-only transcript
 * viewer below reuses the xterm.js instance/theme already loaded there
 * (window.BetterClaudeXterm, the same bundle ui/code-window/terminal.js
 * drives), and mounting a second copy of that bundle into claude.ai's own
 * page just to show this one section would mean injecting more into a live
 * claude.ai document than this app already does. The Team Sync section (main
 * window) links here via host.openSessionBundlesPanel() instead of
 * duplicating the UI.
 *
 * The redaction pass is not a client-side gate the panel can be talked out
 * of — electron/session-bundle.js re-scans every "include" session itself at
 * export time and refuses to write it if it finds a match, regardless of
 * what this file believes the state is. What happens here is choosing
 * "redact" or "exclude" for a flagged session so that re-scan passes.
 */

const { el, toggleField, textField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "unknown time";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleString();
}

function statusBadge(status) {
  const label = { included: "Included", redacted: "Redacted", excluded: "Excluded" }[status] || status;
  return el("span", { class: `bc-tag bc-tag-${status}`, text: label });
}

module.exports = {
  _renderSessionBundle() {
    const host = this.host;
    if (this._sbTab === undefined) this._sbTab = "export";
    if (this._sbDecisions === undefined) this._sbDecisions = {};
    if (this._sbFindings === undefined) this._sbFindings = {};

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Session Bundles" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Share what actually happened in a Claude Code session — not just the code diff. Export bundles up "
        + "your local session transcripts (read straight off disk, the same files the claude CLI itself wrote) "
        + "plus an optional git diff into a .bcbundle file. Every session is scanned for API keys, tokens, and "
        + "other secrets before it can be exported; a flagged session has to be redacted or excluded first — "
        + "there's no way to skip that check. This never reads or sends anything from claude.ai.",
    }));

    const tabs = el("div", { class: "bc-theme-toolbar" });
    ["export", "import"].forEach((tab) => {
      tabs.appendChild(el("button", {
        class: `bc-btn${this._sbTab === tab ? "" : " bc-btn-secondary"}`,
        text: tab === "export" ? "Export" : "Import",
        onclick: () => {
          this._sbTab = tab;
          this.renderSection();
        },
      }));
    });
    wrap.appendChild(tabs);

    this.contentEl.appendChild(wrap);

    if (this._sbTab === "export") this._renderSessionBundleExport(wrap);
    else this._renderSessionBundleImport(wrap);
  },

  _renderSessionBundleExport(wrap) {
    const host = this.host;

    if (this._sbSessions === undefined) {
      this._sbSessions = null;
      host.listSessionBundleSessions().then(({ cwd, sessions }) => {
        this._sbSessions = sessions;
        this._sbCwd = cwd;
        if (this._sbProjectName === undefined) {
          this._sbProjectName = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
        }
        sessions.forEach((s) => {
          if (!(s.sessionId in this._sbDecisions)) this._sbDecisions[s.sessionId] = "include";
        });
        // Redaction is mandatory, so it runs automatically rather than
        // waiting for the user to remember to press a "scan" button.
        const ids = sessions.map((s) => s.sessionId);
        if (ids.length > 0) {
          host.scanSessionBundle(ids).then((findings) => {
            this._sbFindings = findings;
            this.renderSection();
          });
        }
        this.renderSection();
      });
    }

    if (this._sbSessions === null) {
      wrap.appendChild(el("p", { class: "bc-hint", text: "Reading local session history…" }));
      return;
    }

    wrap.appendChild(textField("Project name", this._sbProjectName, (v) => { this._sbProjectName = v; }));

    if (this._sbSessions.length === 0) {
      wrap.appendChild(el("p", {
        class: "bc-hint",
        text: `No local Claude Code sessions found for ${this._sbCwd}. Open a Code session here first.`,
      }));
      return;
    }

    const list = el("div", { class: "bc-plugin-list" });
    this._sbSessions.forEach((s) => {
      const findings = this._sbFindings[s.sessionId];
      const decision = this._sbDecisions[s.sessionId] || "include";
      const flagged = Array.isArray(findings) && findings.length > 0;

      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: s.sessionId.slice(0, 8) }),
        el("span", {
          class: "bc-plugin-version",
          text: `${s.messageCount} messages · ${formatWhen(s.firstTimestamp)} – ${formatWhen(s.lastTimestamp)}`,
        }),
      ]));

      const actions = el("div", { class: "bc-theme-card-actions" });
      ["include", "redact", "exclude"].forEach((choice) => {
        if (choice === "include" && flagged) return; // blocked until redacted or excluded
        actions.appendChild(el("button", {
          class: `bc-theme-star${decision === choice ? " bc-active" : ""}`,
          text: choice[0].toUpperCase() + choice.slice(1),
          onclick: () => {
            this._sbDecisions[s.sessionId] = choice;
            this.renderSection();
          },
        }));
      });
      row.appendChild(actions);
      list.appendChild(row);

      if (flagged) {
        const warn = el("div", { class: "bc-hint bc-danger-text" });
        warn.appendChild(document.createTextNode(
          `⚠ ${findings.length} possible secret(s) found — `
            + `${[...new Set(findings.map((f) => f.label))].join(", ")}. `
        ));
        warn.appendChild(el("strong", {
          text: decision === "include"
            ? "Choose Redact or Exclude above to continue."
            : `Will be ${decision === "redact" ? "redacted" : "excluded"} on export.`,
        }));
        list.appendChild(warn);
        const detail = el("ul", { class: "bc-hint" });
        findings.slice(0, 8).forEach((f) => {
          detail.appendChild(el("li", { text: `Line ${f.line}: ${f.label} (${f.preview})` }));
        });
        if (findings.length > 8) detail.appendChild(el("li", { text: `…and ${findings.length - 8} more` }));
        list.appendChild(detail);
      }
    });
    wrap.appendChild(list);

    if (this._sbIncludeDiff === undefined) this._sbIncludeDiff = false;
    wrap.appendChild(toggleField("Include git diff snapshot", this._sbIncludeDiff, (v) => { this._sbIncludeDiff = v; }));

    const blockedCount = this._sbSessions.filter((s) => {
      const findings = this._sbFindings[s.sessionId];
      return Array.isArray(findings) && findings.length > 0 && (this._sbDecisions[s.sessionId] || "include") === "include";
    }).length;

    const exportBtn = el("button", {
      class: "bc-btn",
      text: blockedCount > 0 ? `Resolve ${blockedCount} flagged session(s) first` : "Export bundle…",
    });
    exportBtn.disabled = blockedCount > 0;
    exportBtn.addEventListener("click", async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = "Exporting…";
      try {
        const result = await host.exportSessionBundle({
          projectName: this._sbProjectName,
          decisions: this._sbDecisions,
          includeDiff: this._sbIncludeDiff,
        });
        if (result.canceled) {
          // User backed out of the save dialog — nothing to report.
        } else if (result.ok) {
          host.notify && host.notify(`Session bundle exported to ${result.path}`);
        } else if (result.blocked) {
          host.notify && host.notify(`Export blocked: session ${result.sessionId} still has unresolved secrets.`);
          this._sbFindings[result.sessionId] = result.findings;
        } else {
          host.notify && host.notify(`Export failed: ${result.error}`);
        }
      } finally {
        this.renderSection();
      }
    });
    wrap.appendChild(exportBtn);
  },

  _renderSessionBundleImport(wrap) {
    const host = this.host;

    const openBtn = el("button", {
      class: "bc-btn",
      text: "Choose bundle file…",
      onclick: async () => {
        const opened = await host.importOpenBundle();
        if (!opened) return;
        this._sbImport = opened;
        this._sbImportViewing = null;
        this.renderSection();
      },
    });
    wrap.appendChild(openBtn);

    if (!this._sbImport) {
      wrap.appendChild(el("p", { class: "bc-hint", text: "No bundle loaded yet." }));
      return;
    }

    const { manifest } = this._sbImport;
    wrap.appendChild(el("h2", { text: manifest.projectName || "Untitled project", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: `Exported ${formatWhen(manifest.generatedAt)} by ${manifest.author || "unknown"}`
        + `${manifest.cliVersion ? ` · claude ${manifest.cliVersion}` : ""}`
        + `${manifest.gitCommit ? ` · ${manifest.gitCommit.slice(0, 7)}` : ""}`,
    }));

    const list = el("div", { class: "bc-plugin-list" });
    (manifest.sessions || []).forEach((s) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: s.sessionId.slice(0, 8) }),
        statusBadge(s.status),
        s.redactionCount > 0
          ? el("span", { class: "bc-plugin-version", text: `${s.redactionCount} line(s) redacted` })
          : el("span", { class: "bc-plugin-version", text: s.messageCount != null ? `${s.messageCount} messages` : "" }),
      ]));

      if (s.status !== "excluded") {
        const actions = el("div", { class: "bc-theme-card-actions" });
        actions.appendChild(el("button", {
          class: "bc-theme-star",
          text: this._sbImportViewing === s.sessionId ? "Hide" : "View",
          onclick: () => {
            this._sbImportViewing = this._sbImportViewing === s.sessionId ? null : s.sessionId;
            this.renderSection();
          },
        }));
        actions.appendChild(el("button", {
          class: "bc-theme-star",
          text: "Resume from here",
          onclick: async () => {
            const targetCwd = await host.pickResumeFolder();
            if (!targetCwd) return;
            await host.resumeSessionBundle({ bundlePath: this._sbImport.bundlePath, sessionId: s.sessionId, targetCwd });
            host.notify && host.notify("Starting a new session with this transcript as context…");
          },
        }));
        row.appendChild(actions);
      } else {
        row.appendChild(el("span", {
          class: "bc-hint",
          text: s.reason || "excluded by the person who exported this bundle",
        }));
      }

      list.appendChild(row);

      if (this._sbImportViewing === s.sessionId) {
        const viewerContainer = el("div", { class: "bc-css-editor bc-sb-viewer" });
        list.appendChild(viewerContainer);
        if (this._sbTermHandle) this._sbTermHandle.destroy();
        host.readBundleSession({ bundlePath: this._sbImport.bundlePath, sessionId: s.sessionId }).then((messages) => {
          this._sbTermHandle = host.mountTranscriptViewer(viewerContainer, messages);
        });
      }
    });
    wrap.appendChild(list);

    if (manifest.diffIncluded) {
      const diffBtn = el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "View diff.patch",
        onclick: async () => {
          const diffText = await host.readBundleDiff(this._sbImport.bundlePath);
          const box = el("pre", { class: "bc-dv-result", text: diffText || "(empty)" });
          wrap.appendChild(box);
        },
      });
      wrap.appendChild(diffBtn);
    }
  },
};

/**
 * Settings -> Team Sync. Team/Shared Plugin Sync: points at a git repo of
 * *.claudeplugin.js / theme *.css files (electron/team-sync.js shells out
 * to the system `git`), pulled manually or on an interval. New/updated
 * files that don't conflict with a local edit are applied automatically
 * when "Auto-apply safe updates" is on; anything where both the repo AND
 * the local copy changed since the last sync shows up here as a conflict
 * with an inline diff and Keep mine / Take theirs.
 */

const { diffLines } = require("diff");
const { el, toggleField, textField, rangeField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

function renderInlineDiff(container, local, repo) {
  container.innerHTML = "";
  diffLines(local, repo).forEach((part) => {
    const span = document.createElement("span");
    span.textContent = part.value;
    if (part.added) span.className = "bc-dv-added";
    else if (part.removed) span.className = "bc-dv-removed";
    container.appendChild(span);
  });
}

module.exports = {
  _renderTeamSync() {
    const { settings } = this;
    const ts = settings.teamSync;
    if (this._teamSyncReviewing === undefined) this._teamSyncReviewing = null;

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Team Sync" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default. Point at a git repo containing shared *.claudeplugin.js and/or theme *.css files — "
        + "pull manually or on an interval to keep a team's plugin/theme set consistent. Safe updates (nothing "
        + "locally edited) apply automatically when enabled below; anything where both sides changed since the "
        + "last sync shows up here as a conflict for you to resolve.",
    }));

    if (this.host.checkSessionBundlePresence) {
      const bundleRow = el("div", { class: "bc-hint", text: "Checking for a shared session bundle…" });
      wrap.appendChild(bundleRow);
      this.host.checkSessionBundlePresence().then(({ files }) => {
        bundleRow.innerHTML = "";
        if (!files || files.length === 0) {
          bundleRow.remove();
          return;
        }
        bundleRow.appendChild(el("span", {
          text: files.length === 1
            ? `📦 Shared bundle available: ${files[0]}`
            : `📦 ${files.length} shared bundles available in this project`,
        }));
        bundleRow.appendChild(document.createTextNode(" — "));
        bundleRow.appendChild(el("button", {
          class: "bc-btn bc-btn-secondary",
          text: "Open in Code window",
          onclick: () => this.host.openSessionBundlesPanel(),
        }));
      }).catch(() => bundleRow.remove());
    }

    wrap.appendChild(toggleField("Enable Team Sync", ts.enabled, (v) => this._set("teamSync.enabled", v)));
    wrap.appendChild(textField("Repo URL", ts.repoUrl, (v) => this._set("teamSync.repoUrl", v.trim()), { placeholder: "https://github.com/your-team/betterclaude-shared.git" }));
    wrap.appendChild(textField("Branch", ts.branch, (v) => this._set("teamSync.branch", v.trim() || "main")));
    wrap.appendChild(rangeField("Auto-sync interval", {
      min: 0, max: 1440, step: 15, value: ts.intervalMinutes,
      format: (v) => (v === 0 ? "Manual only" : v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
      onInput: (v) => this._set("teamSync.intervalMinutes", v),
    }));
    wrap.appendChild(toggleField("Auto-apply safe updates (no local edits in the way)", ts.autoApply, (v) => this._set("teamSync.autoApply", v)));

    const syncRow = el("div", { class: "bc-theme-toolbar" });
    const syncBtn = el("button", {
      class: "bc-btn",
      text: "Sync now",
      onclick: async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = "Syncing…";
        try {
          await this.host.syncTeamNow();
          this.settings = this.host.getSettings();
          this.renderSection();
        } catch (err) {
          this.host.notify && this.host.notify(`Team Sync failed: ${err.message}`);
        } finally {
          syncBtn.disabled = false;
          syncBtn.textContent = "Sync now";
        }
      },
    });
    syncRow.appendChild(syncBtn);
    syncRow.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Open synced files folder",
      onclick: () => this.host.openTeamSyncFolder(),
    }));
    wrap.appendChild(syncRow);
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: ts.lastSyncError ? `Last sync failed: ${ts.lastSyncError}` : `Last synced: ${formatWhen(ts.lastSyncedAt)}`,
    }));

    if (ts.pendingUpdates.length > 0) {
      wrap.appendChild(el("h2", { text: "Updates available", class: "bc-ae-subhead" }));
      const list = el("div", { class: "bc-plugin-list" });
      ts.pendingUpdates.forEach((item) => {
        const row = el("div", { class: "bc-plugin-row" });
        row.appendChild(el("div", { class: "bc-plugin-info" }, [
          el("strong", { text: item.filename }),
          el("span", { class: "bc-plugin-version", text: item.kind }),
        ]));
        row.appendChild(el("button", {
          class: "bc-theme-star",
          text: "Apply",
          onclick: async () => {
            await this.host.applyTeamSyncFile(item.relPath);
            this.settings = this.host.getSettings();
            this.renderSection();
          },
        }));
        list.appendChild(row);
      });
      wrap.appendChild(list);
    }

    if (ts.conflicts.length > 0) {
      wrap.appendChild(el("h2", { text: "Conflicts", class: "bc-ae-subhead" }));
      wrap.appendChild(el("p", {
        class: "bc-hint",
        text: "Both the shared repo and your local copy changed since the last sync — review the diff and pick one.",
      }));
      const list = el("div", { class: "bc-plugin-list" });
      ts.conflicts.forEach((item) => {
        const row = el("div", { class: "bc-plugin-row" });
        row.appendChild(el("div", { class: "bc-plugin-info" }, [
          el("strong", { text: item.filename }),
          el("span", { class: "bc-plugin-version", text: item.kind }),
        ]));
        const actions = el("div", { class: "bc-theme-card-actions" });
        actions.appendChild(el("button", {
          class: "bc-theme-star",
          text: "Review diff",
          onclick: () => {
            this._teamSyncReviewing = this._teamSyncReviewing === item.relPath ? null : item.relPath;
            this.renderSection();
          },
        }));
        actions.appendChild(el("button", {
          class: "bc-theme-star",
          text: "Take theirs",
          onclick: async () => {
            await this.host.applyTeamSyncFile(item.relPath);
            this.settings = this.host.getSettings();
            this.renderSection();
          },
        }));
        actions.appendChild(el("button", {
          class: "bc-theme-star",
          text: "Keep mine",
          onclick: async () => {
            await this.host.keepLocalTeamSyncFile(item.relPath);
            this.settings = this.host.getSettings();
            this.renderSection();
          },
        }));
        row.appendChild(actions);
        list.appendChild(row);

        if (this._teamSyncReviewing === item.relPath) {
          const diffBox = el("div", { class: "bc-dv-result" });
          diffBox.textContent = "Loading diff…";
          list.appendChild(diffBox);
          this.host.getTeamSyncDiff(item.relPath).then(({ localContent, repoContent }) => {
            renderInlineDiff(diffBox, localContent, repoContent);
          }).catch((err) => {
            diffBox.textContent = `Couldn't load diff: ${err.message}`;
          });
        }
      });
      wrap.appendChild(list);
    }

    this.contentEl.appendChild(wrap);
  },
};

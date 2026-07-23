/**
 * Settings -> Skill Marketplace. Configuration only — the actual browsing
 * UI (search, filters, README preview, Install) lives in the full-screen
 * core/skill-marketplace.js overlay, opened from the "Open Marketplace"
 * button here, same split as Settings -> Playful's "Play" button opening
 * the mini-game modal.
 */

const { el, field, rangeField, toggleField, textField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

module.exports = {
  _renderSkillMarketplace() {
    const { settings } = this;
    const sm = settings.skillMarketplace;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Skill Marketplace" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Browse public GitHub repos tagged \"claude-skill\". Installing only downloads SKILL.md + assets into a "
        + "local folder — claude.ai has no public API to register a Skill for you, so upload the result yourself via "
        + "claude.ai Settings → Capabilities.",
    }));

    wrap.appendChild(toggleField("Enable Skill Marketplace", sm.enabled, (v) => this._set("skillMarketplace.enabled", v)));

    wrap.appendChild(textField(
      "GitHub personal access token (optional)",
      sm.githubToken,
      (v) => this._set("skillMarketplace.githubToken", v.trim()),
      { placeholder: "Raises the GitHub API rate limit — never sent anywhere but api.github.com" }
    ));

    wrap.appendChild(rangeField("Cache refresh interval", {
      min: 15, max: 1440, step: 15, value: sm.cacheTTLMinutes,
      format: (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
      onInput: (v) => this._set("skillMarketplace.cacheTTLMinutes", v),
    }));

    const refreshRow = el("div", { class: "bc-theme-toolbar" });
    const refreshBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Refresh catalog now",
      onclick: async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "Refreshing…";
        try {
          await this.host.refreshSkillsCache();
          this.settings = this.host.getSettings();
          this.renderSection();
        } catch (err) {
          this.host.notify ? this.host.notify(`Refresh failed: ${err.message}`) : console.error(err);
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = "Refresh catalog now";
        }
      },
    });
    refreshRow.appendChild(refreshBtn);
    wrap.appendChild(refreshRow);
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: `Last refreshed: ${formatWhen(sm.cache.fetchedAt)} · ${(sm.cache.items || []).length} skills cached.`,
    }));

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "Open Marketplace",
      onclick: () => this.host.openSkillMarketplace(),
    }));

    wrap.appendChild(el("h2", { text: "Installed skills", class: "bc-ae-subhead" }));
    const installedEntries = Object.entries(sm.installed || {});
    const list = el("div", { class: "bc-plugin-list" });
    if (installedEntries.length === 0) {
      list.appendChild(el("p", { class: "bc-hint", text: "Nothing installed yet." }));
    }
    installedEntries.forEach(([id, record]) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: `${record.owner}/${record.repo}` }),
        el("span", { class: "bc-plugin-version", text: `Installed ${formatWhen(record.installedAt)}` }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: "Reveal",
        title: "Reveal in folder",
        onclick: () => this.host.revealSkill(id),
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete",
        text: "✕",
        title: "Uninstall",
        onclick: async () => {
          await this.host.uninstallSkill(id);
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

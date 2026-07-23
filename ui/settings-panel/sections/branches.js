/**
 * Settings -> Branches. Conversation Branching is DOM-automated (see
 * core/branch-fork-buttons.js + electron/main.js's createBranchWindow): a
 * "Fork" button next to any message opens a new claude.ai window with the
 * transcript pre-filled and un-sent — nothing is ever sent without the
 * user's own click, and nothing calls claude.ai's private chat API. This
 * section manages the resulting branch records and the fork-buttons toggle.
 */

const { el, field, toggleField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

module.exports = {
  _renderBranches() {
    const { settings } = this;
    const branching = settings.branching;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Branches" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Fork any message into a new window with the transcript up to that point pre-filled in the composer — "
        + "you review and send it yourself. claude.ai's own chat API is never called directly.",
    }));

    wrap.appendChild(toggleField("Enable Conversation Branching", branching.enabled, (v) => this._set("branching.enabled", v)));
    wrap.appendChild(toggleField("Show floating Fork buttons on messages", branching.showForkButtons, (v) => this._set("branching.showForkButtons", v)));

    wrap.appendChild(el("h2", { text: "Branch history", class: "bc-ae-subhead" }));
    const list = el("div", { class: "bc-plugin-list" });
    const branches = [...(branching.branches || [])].sort((a, b) => b.createdAt - a.createdAt);
    if (branches.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No forks yet — click \"⑂ Fork\" next to any message." }));
    branches.forEach((b) => {
      const row = el("div", { class: "bc-plugin-row" });
      const status = b.conversationUrl ? "Started" : "Pending (not sent yet)";
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: b.label }),
        el("span", { class: "bc-plugin-version", text: `${formatWhen(b.createdAt)} · ${status}` }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: "Open",
        onclick: () => this.host.openBranch(b.id),
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: async () => {
          await this.host.deleteBranch(b.id);
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

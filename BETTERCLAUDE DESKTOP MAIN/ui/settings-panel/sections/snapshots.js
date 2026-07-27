/**
 * Settings -> Snapshots. Auto-Session Snapshots + Restore Points: captures
 * the visible transcript on an interval (or on demand) — dedup'd against
 * the last snapshot of the same conversation, capped at 20 per conversation.
 * "Restore" forks a new window from the snapshot's transcript (see
 * electron/preload.js's restoreSnapshot / the shared branching:open-fork
 * IPC), not an in-place rewind of the live claude.ai conversation.
 */

const { el, toggleField, rangeField } = require("../dom-helpers");

function formatWhen(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

module.exports = {
  _renderSnapshots() {
    const { settings } = this;
    const snapshots = settings.snapshots;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Snapshots" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Periodic checkpoints of the conversation's transcript. \"Restore\" opens a forked window pre-filled "
        + "from that checkpoint — claude.ai owns the real conversation, so this resumes from a point in time rather "
        + "than rewinding it in place.",
    }));

    wrap.appendChild(toggleField("Enable auto-snapshots", snapshots.enabled, (v) => this._set("snapshots.enabled", v)));
    wrap.appendChild(rangeField("Snapshot interval", {
      min: 5, max: 240, step: 5, value: snapshots.intervalMinutes,
      format: (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
      onInput: (v) => this._set("snapshots.intervalMinutes", v),
    }));

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "Snapshot this conversation now",
      onclick: async () => {
        await this.host.snapshotNow();
        this.settings = this.host.getSettings();
        this.renderSection();
      },
    }));

    wrap.appendChild(el("h2", { text: "Restore points", class: "bc-ae-subhead" }));
    const list = el("div", { class: "bc-plugin-list" });
    const records = [...(snapshots.list || [])].sort((a, b) => b.createdAt - a.createdAt);
    if (records.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No snapshots yet." }));
    records.forEach((snap) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: snap.label }),
        el("span", {
          class: "bc-plugin-version",
          text: `${snap.conversationTitle} · ${snap.turnCount} turns · ${formatWhen(snap.createdAt)}`,
        }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: "Restore",
        title: "Fork a new window from this checkpoint",
        onclick: () => this.host.restoreSnapshot(snap.id),
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: "Export",
        onclick: () => this.host.exportSnapshot(snap.id),
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: async () => {
          await this.host.deleteSnapshot(snap.id);
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

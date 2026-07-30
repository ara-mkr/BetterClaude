/**
 * Settings section: Buddies — desktop characters that live in their own
 * always-on-top overlay window and animate while Claude is working.
 *
 * Cards are generated from core/buddies.js rather than written out here, so
 * adding a buddy stays a one-line registry change (see that file's header).
 *
 * Thumbnails arrive as data URIs over IPC: this panel is injected into
 * https://claude.ai, so a file:// <img> for a bundled asset would be blocked.
 */

const { el, toggleField } = require("../dom-helpers");
const { listBuddies } = require("../../../core/buddies");

module.exports = {
  _renderBuddies() {
    const { settings } = this;
    const cfg = settings.buddies || {};
    const perBuddy = cfg.perBuddy || {};

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Buddies" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A little character that floats above every app on your desktop. Drag it anywhere — "
        + "it remembers where you left it. While Claude is working it acts out a short loop; "
        + "the rest of the time it just sits there.",
    }));

    wrap.appendChild(toggleField("Enable buddy", cfg.enabled, (v) => {
      this._set("buddies.enabled", v);
      // Re-render so the per-buddy cards visibly go dim/live with the master
      // switch instead of silently doing nothing while it's off.
      this.renderSection();
    }));

    wrap.appendChild(toggleField("Enable animations", cfg.animations, (v) => {
      this._set("buddies.animations", v);
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "With animations off the buddy always shows its still pose, even while Claude works.",
    }));

    const grid = el("div", { class: `bc-buddy-grid${cfg.enabled ? "" : " bc-buddy-disabled"}` });
    const buddies = listBuddies();

    buddies.forEach((buddy) => {
      const card = el("div", { class: "bc-buddy-card" });
      const thumb = el("div", { class: "bc-buddy-thumb" });
      card.appendChild(thumb);
      const title = el("div", { class: "bc-buddy-title", text: buddy.label, id: `bc-buddy-title-${buddy.id}` });
      card.appendChild(title);
      card.appendChild(el("div", { class: "bc-buddy-desc", text: buddy.description }));

      const toggle = el("input", {
        type: "checkbox",
        id: `bc-buddy-toggle-${buddy.id}`,
        "aria-labelledby": title.id,
      });
      toggle.checked = perBuddy[buddy.id] === true;
      toggle.disabled = !cfg.enabled;
      toggle.addEventListener("change", () => {
        this._set(`buddies.perBuddy.${buddy.id}`, toggle.checked);
      });
      const row = el("div", { class: "bc-buddy-actions" });
      row.appendChild(toggle);
      card.appendChild(row);
      grid.appendChild(card);

      // Paint the card immediately and fill the thumbnail in when the IPC
      // round-trip lands — same pattern as the widget gallery, so a slow or
      // failed asset read degrades to a blank thumb rather than an empty tab.
      this.host.getBuddyThumbnail(buddy.id).then((dataUri) => {
        if (!thumb.isConnected || !dataUri) return;
        thumb.appendChild(el("img", { src: dataUri, alt: `${buddy.label} idle pose` }));
      }).catch((err) => console.error("[BetterClaude] buddy thumbnail failed:", err));
    });

    wrap.appendChild(grid);
    this.contentEl.appendChild(wrap);
  },
};

/**
 * Settings panel sections: Animation & Motion, Notifications. Mixed onto
 * SettingsPanel.prototype by panel.js — see cursor-sound.js header comment
 * for why.
 */

const { el, field, rangeField, selectField, toggleField, textField } = require("../dom-helpers");
const { openColorPopover } = require("../color-popover");

const TRANSITION_OPTIONS = [
  { value: "fade", label: "Fade" },
  { value: "slide", label: "Slide" },
  { value: "zoom", label: "Zoom" },
  { value: "none", label: "None" },
];
const EASING_OPTIONS = [
  { value: "smooth", label: "Smooth" },
  { value: "bouncy", label: "Bouncy" },
];
const NOTIFICATION_STYLE_OPTIONS = [
  { value: "banner", label: "Banner (bottom, center)" },
  { value: "popup", label: "Popup (top-right)" },
  { value: "badge", label: "Subtle badge (icon only)" },
];
const NOTIFICATION_CATEGORIES = [
  { key: "theme", label: "Theme changes", bypassDnd: false },
  { key: "plugin", label: "Plugin toggles", bypassDnd: false },
  { key: "achievement", label: "Achievements", bypassDnd: true },
  { key: "update", label: "App updates", bypassDnd: true },
];

module.exports = {
  _renderMotion() {
    const { settings } = this;
    const motion = settings.motion;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Animation & Motion" }));

    wrap.appendChild(rangeField("Animation speed", {
      min: 0, max: 2, step: 0.1, value: motion.speed,
      format: (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`),
      onInput: (v) => this._set("motion.speed", v),
    }));
    wrap.appendChild(selectField("Transition style (BetterClaude's own overlays)", TRANSITION_OPTIONS, motion.transition, (v) => this._set("motion.transition", v)));
    wrap.appendChild(selectField("Easing curve", EASING_OPTIONS, motion.easing, (v) => this._set("motion.easing", v)));
    wrap.appendChild(toggleField("Ignore system “reduce motion” preference", motion.overrideReducedMotion, (v) => this._set("motion.overrideReducedMotion", v)));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default: BetterClaude's animations respect your OS accessibility setting unless you override it here.",
    }));

    wrap.appendChild(el("h2", { text: "Effects", class: "bc-ae-subhead" }));
    wrap.appendChild(toggleField("Confetti on achievements & streak milestones", motion.confetti, (v) => this._set("motion.confetti", v)));
    wrap.appendChild(toggleField("Parallax drift on BetterClaude's own overlays", motion.parallax, (v) => this._set("motion.parallax", v)));
    wrap.appendChild(toggleField("Seasonal decorations (snow/leaves)", motion.seasonalDecorations, (v) => this._set("motion.seasonalDecorations", v)));

    const previewBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Preview confetti",
      onclick: () => this.host.previewConfetti(),
    });
    wrap.appendChild(previewBtn);

    this.contentEl.appendChild(wrap);
  },

  _renderNotifications() {
    const { settings } = this;
    const notifications = settings.notifications;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Notifications" }));

    wrap.appendChild(selectField("Style", NOTIFICATION_STYLE_OPTIONS, notifications.style, (v) => this._set("notifications.style", v)));

    wrap.appendChild(el("h2", { text: "Do Not Disturb", class: "bc-ae-subhead" }));
    wrap.appendChild(toggleField("Enable quiet hours", notifications.dnd.enabled, (v) => this._set("notifications.dnd.enabled", v)));
    const startInput = el("input", { type: "time", value: notifications.dnd.start });
    startInput.addEventListener("change", () => this._set("notifications.dnd.start", startInput.value));
    wrap.appendChild(field("Starts at", startInput));
    const endInput = el("input", { type: "time", value: notifications.dnd.end });
    endInput.addEventListener("change", () => this._set("notifications.dnd.end", endInput.value));
    wrap.appendChild(field("Ends at", endInput));

    wrap.appendChild(el("h2", { text: "Categories", class: "bc-ae-subhead" }));
    const grid = el("div", { class: "bc-notif-grid" });
    NOTIFICATION_CATEGORIES.forEach(({ key, label, bypassDnd }) => {
      const typeConf = notifications.types[key];
      const row = el("div", { class: "bc-notif-row" });

      const enabled = el("input", { type: "checkbox" });
      enabled.checked = typeConf.enabled !== false;
      enabled.addEventListener("change", () => this._set(`notifications.types.${key}.enabled`, enabled.checked));

      const swatch = el("button", { class: "bc-color-swatch" });
      swatch.style.background = typeConf.color;
      let liveColor = typeConf.color;
      swatch.addEventListener("click", () => {
        openColorPopover(swatch, liveColor, (hex) => {
          liveColor = hex;
          swatch.style.background = hex;
        }, () => this._set(`notifications.types.${key}.color`, liveColor));
      });

      const iconInput = el("input", { type: "text", value: typeConf.icon, maxlength: "2", placeholder: "icon" });
      iconInput.style.width = "40px";
      iconInput.addEventListener("change", () => this._set(`notifications.types.${key}.icon`, iconInput.value));

      row.appendChild(enabled);
      row.appendChild(el("span", { class: "bc-notif-label", text: `${label}${bypassDnd ? " (bypasses DND)" : ""}` }));
      row.appendChild(iconInput);
      row.appendChild(swatch);
      grid.appendChild(row);
    });
    wrap.appendChild(grid);

    const previewBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Preview a notification",
      onclick: () => this.host.notifyPreview("theme"),
    });
    wrap.appendChild(previewBtn);

    wrap.appendChild(el("h2", { text: "Smart Notification Digest", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default. Batches routine background completions (macro replays, Team Sync, clipboard syncs, "
        + "...) into one periodic native OS notification instead of interrupting one at a time. Failures always "
        + "notify immediately regardless of this setting — the digest only ever delays routine \"it worked\" updates.",
    }));
    wrap.appendChild(toggleField("Enable digest", notifications.digest.enabled, (v) => this._set("notifications.digest.enabled", v)));
    wrap.appendChild(rangeField("Digest interval", {
      min: 1, max: 120, step: 1, value: notifications.digest.intervalMinutes,
      format: (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`),
      onInput: (v) => this._set("notifications.digest.intervalMinutes", v),
    }));

    this.contentEl.appendChild(wrap);
  },
};

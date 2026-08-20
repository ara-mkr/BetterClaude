/**
 * Settings panel section: Personality — one tab for everything that gives
 * BetterClaude a character, in the order a user meets them:
 *
 *   1. Desktop buddy      (core/buddies.js — its own always-on-top window)
 *   2. In-window companion(core/companion.js — greeting bubble inside the chat)
 *   3. Streak & achievements
 *   4. Playful            (Snake, loading tips, weather theming)
 *
 * Previously these were three separate tabs (Personality, Buddies, Playful),
 * and the split actively misled: the companion was described as "a small
 * character in the corner" in one tab while a different tab configured a
 * different small character, with nothing anywhere admitting the two existed
 * at the same time. They ARE two implementations of the same idea — one is an
 * SVG mascot inside claude.ai's page, the other an image/video character in a
 * desktop-level overlay — and the only honest fix is to put them side by side
 * and say which is which. Renderers for the buddy and playful blocks are
 * reused from their original section modules rather than copied, so this is a
 * regrouping, not a fork.
 *
 * Avatar customization deliberately lives with the buddy: core/companion.js
 * ships one fixed look on purpose.
 */

const { el, selectField, toggleField, textField } = require("../dom-helpers");

const GREETING_STYLES = [
  { value: "timeOfDay", label: "Time of day only — “Good evening”" },
  { value: "name", label: "Include your name — “Good evening, Sam”" },
  { value: "streak", label: "Name and streak — “Good evening, Sam — 5 day streak!”" },
];

module.exports = {
  /** The companion + streak half. The buddy and playful halves are the
   *  existing renderers, called by _renderPersonality below. */
  _renderCompanion() {
    const { settings } = this;
    const p = settings.personality || {};
    const wrap = el("div", { class: "bc-section" });

    wrap.appendChild(el("h2", { text: "In-window companion", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A second, smaller character — this one lives inside the Claude window rather than on "
        + "your desktop, and its job is the speech bubble: it greets you, flashes your streak, and "
        + "reacts when you unlock an achievement. If you only want one character on screen, this is "
        + "the one to leave off.",
    }));

    wrap.appendChild(toggleField(
      "Show the companion",
      p.companionEnabled === true,
      (v) => { this._set("personality.companionEnabled", v); this.renderSection(); }
    ));

    if (p.companionEnabled === true) {
      wrap.appendChild(textField(
        "Your name",
        p.userName || "",
        (v) => this._set("personality.userName", v.trim()),
        { placeholder: "Used in greetings — leave blank to skip" }
      ));

      wrap.appendChild(selectField(
        "Greeting style",
        GREETING_STYLES,
        GREETING_STYLES.some((g) => g.value === p.greetingStyle) ? p.greetingStyle : "timeOfDay",
        (v) => this._set("personality.greetingStyle", v)
      ));

      wrap.appendChild(textField(
        "Status message",
        p.statusMessage || "",
        (v) => this._set("personality.statusMessage", v.trim()),
        { placeholder: "Overrides the greeting entirely — blank to use it" }
      ));
      wrap.appendChild(el("p", {
        class: "bc-hint",
        text: "Anything here replaces the greeting in the bubble, so it stays put instead of changing with the time of day.",
      }));
    }

    // Read-only: a record of what happened, not a preference.
    const streak = p.streak || { count: 0, lastActiveDate: "" };
    const unlocked = Array.isArray(p.achievements) ? p.achievements.length : 0;
    wrap.appendChild(el("h2", { text: "Streak & achievements", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: streak.count > 0
        ? `${streak.count} day${streak.count === 1 ? "" : "s"} in a row — last counted ${streak.lastActiveDate || "today"}. `
          + `${unlocked} achievement${unlocked === 1 ? "" : "s"} unlocked.`
        : `No streak yet — it starts the next day you use BetterClaude. ${unlocked} achievement${unlocked === 1 ? "" : "s"} unlocked.`,
    }));

    this.contentEl.appendChild(wrap);
  },

  _renderPersonality() {
    // Buddy first: it is the character most people actually see, so the
    // companion block below can describe itself in terms of it.
    this._renderBuddies();
    this._renderCompanion();
    this._renderPlayful();
  },
};

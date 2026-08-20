/**
 * Settings panel section: Personality — the companion bubble, how it greets
 * you, and your streak. Mixed onto SettingsPanel.prototype by panel.js.
 *
 * These four preferences (companionEnabled, userName, greetingStyle,
 * statusMessage) were all read at runtime by electron/preload.js and
 * core/companion.js but had no control anywhere in the panel. Because
 * companionEnabled defaults to false, that meant the companion could never be
 * turned on by any means the app offered — a whole feature reachable only by
 * hand-editing config.json.
 *
 * Avatar customization is deliberately NOT here: core/companion.js ships one
 * fixed look and Settings -> Buddies owns character customization.
 */

const { el, selectField, toggleField, textField } = require("../dom-helpers");

const GREETING_STYLES = [
  { value: "timeOfDay", label: "Time of day only — “Good evening”" },
  { value: "name", label: "Include your name — “Good evening, Sam”" },
  { value: "streak", label: "Name and streak — “Good evening, Sam — 5 day streak!”" },
];

module.exports = {
  _renderPersonality() {
    const { settings } = this;
    const p = settings.personality || {};
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Personality" }));

    wrap.appendChild(toggleField(
      "Show the companion",
      p.companionEnabled === true,
      (v) => { this._set("personality.companionEnabled", v); this.renderSection(); }
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A small character in the corner of the chat with a speech bubble. It only ever appears when you're signed in.",
    }));

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
        text: "Anything here replaces the greeting in the speech bubble, so it stays put instead of changing with the time of day.",
      }));
    }

    // Read-only: the streak is a record of what happened, not a preference, so
    // it is shown rather than made editable.
    const streak = p.streak || { count: 0, lastActiveDate: "" };
    wrap.appendChild(el("h2", { text: "Streak", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: streak.count > 0
        ? `${streak.count} day${streak.count === 1 ? "" : "s"} in a row — last counted ${streak.lastActiveDate || "today"}.`
        : "No streak yet — it starts the next day you use BetterClaude.",
    }));

    const unlocked = Array.isArray(p.achievements) ? p.achievements.length : 0;
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: `${unlocked} achievement${unlocked === 1 ? "" : "s"} unlocked.`,
    }));

    this.contentEl.appendChild(wrap);
  },
};

/**
 * Personality & fun — DOM-only aside from pure date/stat logic that's
 * intentionally side-effect-free so it's unit-testable in isolation
 * (incrementStreak/checkAchievements/buildGreeting never touch the DOM).
 *
 * Companion is a small in-window mascot (built from layered SVG shapes — no
 * image assets) that shows a greeting/status speech bubble and reacts to
 * streak bumps and achievement unlocks. It is distinct from Buddies
 * (core/buddies.js), which are image/video characters in their own
 * desktop-level overlay window.
 */

const { FLAME } = require("./icons");

const ACHIEVEMENTS = [
  { id: "first-launch", label: "Hello, BetterClaude", description: "Opened BetterClaude for the first time.", check: (s) => s.launches >= 1 },
  { id: "streak-3", label: "Getting Warmed Up", description: "Reached a 3-day streak.", check: (s) => s.streakCount >= 3 },
  { id: "streak-7", label: "One Week Strong", description: "Reached a 7-day streak.", check: (s) => s.streakCount >= 7 },
  { id: "theme-explorer", label: "Theme Explorer", description: "Tried 3 different themes.", check: (s) => s.themesTried >= 3 },
  { id: "plugin-tinkerer", label: "Plugin Tinkerer", description: "Enabled 3 plugins at once.", check: (s) => s.pluginsEnabledCount >= 3 },
  { id: "night-owl", label: "Night Owl", description: "Used BetterClaude after midnight.", check: (s) => !!s.usedAfterMidnight },
  { id: "konami", label: "Cheat Code", description: "Found the secret input sequence.", check: (s) => !!s.konamiUnlocked },
];

// stats: { launches, streakCount, themesTried, pluginsEnabledCount,
//          usedAfterMidnight, konamiUnlocked }
function checkAchievements(stats, alreadyUnlocked = []) {
  const unlocked = new Set(alreadyUnlocked);
  const newlyUnlocked = [];
  ACHIEVEMENTS.forEach((a) => {
    if (!unlocked.has(a.id) && a.check(stats)) {
      unlocked.add(a.id);
      newlyUnlocked.push(a.id);
    }
  });
  return { allUnlocked: Array.from(unlocked), newlyUnlocked };
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// Pure: given the persisted streak object and "today" (defaults to real
// today, injectable for tests), returns the next streak state. Calendar-day
// based — opening the app twice in one day doesn't double-count, and
// missing a day resets to 1 rather than 0 (today itself still counts).
function incrementStreak(streak, todayStr = toDateStr(new Date())) {
  const prev = streak || { count: 0, lastActiveDate: "" };
  if (prev.lastActiveDate === todayStr) return { count: prev.count || 0, lastActiveDate: todayStr, bumped: false };

  const today = new Date(`${todayStr}T00:00:00Z`);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const continuedStreak = prev.lastActiveDate === toDateStr(yesterday);
  const count = continuedStreak ? (prev.count || 0) + 1 : 1;
  return { count, lastActiveDate: todayStr, bumped: true };
}

// Combines time-of-day + streak + name into ONE greeting rather than three
// competing greeting styles picked by a mode switch — style still lets a
// user opt out of the parts they don't want (see settings.personality.greetingStyle).
function buildGreeting({ name, streakCount = 0, hour, style = "timeOfDay" } = {}) {
  const h = hour != null ? hour : new Date().getHours();
  const timeGreeting = h < 5 || h >= 22 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const namePart = style !== "timeOfDay" && name && name.trim() ? `, ${name.trim()}` : "";
  const streakPart = style === "streak" && streakCount > 1 ? ` — ${streakCount} day streak!` : "";
  return `${timeGreeting}${namePart}${streakPart}`;
}

// One fixed look, deliberately not user-configurable. The old
// shape/color/accessory picker (settings.personality.avatar) was removed in
// favour of Settings -> Buddies, which owns character customization now.
function buildCompanionSvg() {
  return `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">`
    + `<circle cx="24" cy="24" r="20" fill="#8b5cf6"/>`
    + `<circle cx="17" cy="22" r="2.6" fill="#14101f"/><circle cx="31" cy="22" r="2.6" fill="#14101f"/>`
    + `<path d="M17 30q7 6 14 0" stroke="#14101f" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `</svg>`;
}

class Companion {
  constructor() {
    this.el = null;
    this._bubbleTimeout = null;
    this._reactTimeout = null;
  }

  mount(settings) {
    if (this.el) return this.el;
    const root = document.createElement("div");
    root.id = "bc-companion";
    root.innerHTML = `
      <div class="bc-companion-bubble" data-bc-bubble hidden></div>
      <div class="bc-companion-face" data-bc-face></div>
      <div class="bc-companion-streak" data-bc-streak hidden></div>
    `;
    document.body.appendChild(root);
    this.el = root;
    this.update(settings);
    return root;
  }

  update(settings) {
    if (!this.el) return;
    const personality = settings.personality || {};
    this.el.style.display = personality.companionEnabled === false ? "none" : "flex";
    this.el.querySelector("[data-bc-face]").innerHTML = buildCompanionSvg();
    const streakEl = this.el.querySelector("[data-bc-streak]");
    const count = (personality.streak && personality.streak.count) || 0;
    if (count > 1) {
      streakEl.hidden = false;
      streakEl.innerHTML = `${FLAME}<span>${count}</span>`;
    } else {
      streakEl.hidden = true;
    }
  }

  say(text, { timeoutMs = 4500 } = {}) {
    if (!this.el || !text) return;
    const bubble = this.el.querySelector("[data-bc-bubble]");
    bubble.textContent = text;
    bubble.hidden = false;
    clearTimeout(this._bubbleTimeout);
    this._bubbleTimeout = setTimeout(() => { bubble.hidden = true; }, timeoutMs);
  }

  react(kind = "happy", { durationMs = 1500 } = {}) {
    if (!this.el) return;
    const face = this.el.querySelector("[data-bc-face]");
    face.classList.add(`bc-companion-${kind}`);
    clearTimeout(this._reactTimeout);
    this._reactTimeout = setTimeout(() => face.classList.remove(`bc-companion-${kind}`), durationMs);
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    clearTimeout(this._bubbleTimeout);
    clearTimeout(this._reactTimeout);
  }
}

module.exports = {
  ACHIEVEMENTS,
  checkAchievements,
  incrementStreak,
  buildGreeting,
  buildCompanionSvg,
  Companion,
};

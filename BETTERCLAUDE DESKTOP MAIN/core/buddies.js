/**
 * Buddy registry — the single source of truth for which buddies exist, what
 * files each one ships, and which clips its working-state cycle runs through.
 *
 * Adding a buddy later should be exactly: drop processed assets into
 * resources/buddies/<id>/ (see scripts/process-buddy-assets.py) and append one
 * entry here. Nothing else — the settings section, the overlay window and the
 * animation state machine all read this list rather than hardcoding ids.
 *
 * Deliberately only Astronaut for now. The other characters in the source
 * folder (Spartan, Detective, Scuba Diver) have no processed assets, and a
 * registry entry without assets would render a broken card.
 *
 * Kept free of Electron/DOM imports so the Electron main process, the
 * renderer bundle and the settings panel can all require it.
 */

// Every processed asset is emitted on this shared canvas, so the character
// never changes scale or position when one clip is swapped for another.
// Must match OUT_W/OUT_H in scripts/process-buddy-assets.py.
const BUDDY_CANVAS = { width: 640, height: 360 };

// Fraction of the canvas actually occupied by the character. The overlay uses
// it to hit-test the pointer, so the transparent margin stays click-through
// instead of swallowing clicks meant for whatever is behind it.
const BUDDY_HIT_BOX = { left: 0.30, top: 0.05, right: 0.70, bottom: 0.95 };

const BUDDIES = [
  {
    id: "astronaut",
    label: "Astronaut",
    description: "Taps away at a keyboard, ponders, then blasts off — on repeat while Claude works.",
    // Paths are relative to resources/buddies/<id>/.
    assets: {
      idle: "astronaut-idle.png",
      typing: "astronaut-typing.webm",
      thinking: "astronaut-thinking.webm",
      blastoff: "astronaut-blastoff.webm",
    },
    // Order of the working-state loop. Advanced by each clip's `ended` event,
    // never by a timer, so it stays correct if clip durations drift.
    cycle: ["typing", "thinking", "blastoff"],
  },
];

function listBuddies() {
  return BUDDIES.slice();
}

function getBuddy(id) {
  return BUDDIES.find((b) => b.id === id) || null;
}

/**
 * Which buddy the overlay should show, or null for "show nothing".
 *
 * Returns null when the master toggle is off or no buddy is individually
 * enabled — the caller uses that to decide whether the overlay window should
 * exist at all, so an all-off state costs no window.
 */
function resolveActiveBuddy(settings) {
  const cfg = (settings && settings.buddies) || {};
  if (!cfg.enabled) return null;
  const perBuddy = cfg.perBuddy || {};
  // Registry order is the tie-break, so behaviour stays deterministic once
  // more than one buddy can be enabled at a time.
  return BUDDIES.find((b) => perBuddy[b.id] === true) || null;
}

module.exports = {
  BUDDIES,
  BUDDY_CANVAS,
  BUDDY_HIT_BOX,
  listBuddies,
  getBuddy,
  resolveActiveBuddy,
};

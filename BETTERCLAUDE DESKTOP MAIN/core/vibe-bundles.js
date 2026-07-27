/**
 * Vibe Bundles — the one table that makes "Randomize Everything," the mood
 * picker, and seasonal auto-theming all produce a COHESIVE result instead of
 * independently-random sliders fighting each other. Each bundle names a
 * matched palette + shape language + cursor + sound pack + motion feel;
 * applying one is a single atomic action, never a per-field dice roll.
 *
 * Pure data + pure functions — no DOM, no Node/Electron APIs — so it's
 * unit-testable and portable like the rest of core/.
 */

const VIBE_BUNDLES = [
  {
    id: "cyberpunk-pulse",
    label: "Cyberpunk Pulse",
    themeId: "cyberpunk-neon",
    shape: "sharp",
    cursorStyle: "crosshair",
    cursorTrail: "comet",
    soundPack: "8bit",
    easing: "bouncy",
    transition: "slide",
    mood: "energetic",
    featured: true,
  },
  {
    id: "cottagecore-calm",
    label: "Cottagecore Calm",
    themeId: "forest-light",
    shape: "soft",
    cursorStyle: "dot",
    cursorTrail: "sparkles",
    soundPack: "soft",
    easing: "smooth",
    transition: "fade",
    mood: "calm",
    featured: true,
  },
  {
    id: "y2k-vaporwave",
    label: "Y2K Vaporwave",
    themeId: "vaporwave",
    shape: "pill",
    cursorStyle: "dot",
    cursorTrail: "particles",
    soundPack: "minimal",
    easing: "bouncy",
    transition: "zoom",
    mood: "playful",
    featured: true,
  },
  {
    id: "brutalist-mono",
    label: "Brutalist Mono",
    themeId: "high-contrast",
    shape: "sharp",
    cursorStyle: "default",
    cursorTrail: "off",
    soundPack: "off",
    easing: "smooth",
    transition: "none",
    mood: "focused",
    featured: true,
  },
  {
    id: "hacker-terminal",
    label: "Hacker Terminal",
    themeId: "hacker-green",
    shape: "sharp",
    cursorStyle: "crosshair",
    cursorTrail: "off",
    soundPack: "8bit",
    easing: "smooth",
    transition: "fade",
    mood: "focused",
    featured: false,
  },
  {
    id: "sakura-dream",
    label: "Sakura Dream",
    themeId: "sakura-blossom",
    shape: "rounded",
    cursorStyle: "dot",
    cursorTrail: "sparkles",
    soundPack: "soft",
    easing: "smooth",
    transition: "fade",
    mood: "calm",
    featured: false,
  },
  {
    id: "midnight-tokyo",
    label: "Midnight Tokyo",
    themeId: "tokyo-night",
    shape: "rounded",
    cursorStyle: "dot",
    cursorTrail: "comet",
    soundPack: "minimal",
    easing: "bouncy",
    transition: "slide",
    mood: "energetic",
    featured: false,
  },
];

function getBundle(id) {
  return VIBE_BUNDLES.find((b) => b.id === id) || null;
}

function featuredBundles() {
  return VIBE_BUNDLES.filter((b) => b.featured);
}

function pickRandomBundle(excludeId) {
  const candidates = VIBE_BUNDLES.filter((b) => b.id !== excludeId);
  const pool = candidates.length ? candidates : VIBE_BUNDLES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function bundlesForMood(mood) {
  return VIBE_BUNDLES.filter((b) => b.mood === mood);
}

// Deterministic first match per mood so the mood picker feels intentional,
// not a second random draw wearing a mood label.
function bundleForMood(mood) {
  return bundlesForMood(mood)[0] || null;
}

// monthIndex: 0 = January .. 11 = December. Northern-hemisphere seasons;
// good enough for a cosmetic feature, not a scientific one.
const SEASON_BUNDLE_IDS = {
  winter: "midnight-tokyo",
  spring: "sakura-dream",
  summer: "y2k-vaporwave",
  autumn: "cottagecore-calm",
};

function seasonForMonth(monthIndex) {
  if ([11, 0, 1].includes(monthIndex)) return "winter";
  if ([2, 3, 4].includes(monthIndex)) return "spring";
  if ([5, 6, 7].includes(monthIndex)) return "summer";
  return "autumn";
}

function bundleForSeason(monthIndex) {
  return getBundle(SEASON_BUNDLE_IDS[seasonForMonth(monthIndex)]);
}

// Applies every field of a bundle atomically via the given setSetting
// (keyPath, value) callback, then triggers the caller's live-preview hook
// (falling back to nothing if not provided) so the whole bundle — theme,
// shape, cursor style/trail, motion — is visible immediately instead of
// waiting on the next full settings round-trip. applyBundlePreview (not just
// a theme swap) matters here: shape and cursor live in style layers that a
// plain theme-only preview doesn't rebuild, which used to leave corners
// sharp/cursor stale until the async writes below resolved.
// Writes are sequenced (not Promise.all) so a second bundle applied while the
// first is still persisting can't have its fields clobbered by the first
// call's writes resolving out of order. Returns a promise that resolves once
// every field has actually been written, so callers that re-read settings
// right after (e.g. the Themes tab re-rendering itself post-apply) see the
// new values instead of whatever was there before the writes landed.
async function applyBundle(bundle, { setSetting, selectTheme, applyBundlePreview } = {}) {
  if (!bundle || !setSetting) return;
  if (selectTheme) await selectTheme(bundle.themeId);
  else await setSetting("appearance.activeTheme", bundle.themeId);
  if (applyBundlePreview && !selectTheme) applyBundlePreview(bundle);
  await setSetting("appearanceEditor.shape", bundle.shape);
  await setSetting("cursor.style", bundle.cursorStyle);
  await setSetting("cursor.trail", bundle.cursorTrail);
  await setSetting("sound.pack", bundle.soundPack);
  await setSetting("motion.easing", bundle.easing);
  await setSetting("motion.transition", bundle.transition);
}

module.exports = {
  VIBE_BUNDLES,
  getBundle,
  featuredBundles,
  pickRandomBundle,
  bundlesForMood,
  bundleForMood,
  seasonForMonth,
  bundleForSeason,
  applyBundle,
};

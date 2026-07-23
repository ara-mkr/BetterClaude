/**
 * Display names for bundled theme ids. Extracted from panel.js so both
 * panel.js and the sections/*.js mixins can use it without a circular
 * require (mixins are required BY panel.js to be attached to its
 * prototype, so they can't safely require panel.js back).
 */
const THEME_LABELS = {
  "midnight-violet": "Midnight Violet",
  "ocean-abyss": "Ocean Abyss",
  "rose-glass": "Rose Glass",
  "hacker-green": "Hacker Green",
  "warm-dusk": "Warm Dusk",
  "nord": "Nord",
  "catppuccin-mocha": "Catppuccin Mocha",
  "tokyo-night": "Tokyo Night",
  "dracula": "Dracula",
  "solarized-light": "Solarized Light",
  "high-contrast": "High Contrast",
  "gruvbox-dark": "Gruvbox Dark",
  "one-dark": "One Dark",
  "cyberpunk-neon": "Cyberpunk Neon",
  "forest-light": "Forest Light",
  "sakura-blossom": "Sakura Blossom",
  "vaporwave": "Vaporwave",
  "arctic-light": "Arctic Light",
  "monokai": "Monokai",
  // Konami-unlocked bonus theme — kept out of the visible grid until then
  // (see panel.js _renderThemes), so the label doubles as a small reveal.
  "secret-rainbow": "Secret Rainbow",
};

module.exports = { THEME_LABELS };

/**
 * Shared minimalist line-icon set (24x24, stroke=currentColor) used anywhere
 * BetterClaude's own chrome needs a small icon — replaces emoji glyphs, which
 * render as full-color pictographs (inconsistent across platforms/themes and
 * out of step with the rest of the UI's monochrome stroke-icon language, e.g.
 * the plugin dock's icons in core/plugin-loader.js).
 *
 * Every export is a raw <svg> string meant for direct innerHTML/`html:`
 * insertion (see ui/settings-panel/dom-helpers.js's `el(..., { html })`).
 */

const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

module.exports = {
  WARNING: `<svg ${ATTRS}><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>`,
  FLAME: `<svg ${ATTRS}><path d="M12 2c1 3-2 4.5-2 7.5a4 4 0 0 0 8 0c0-1.5-.6-2.3-1-3 .8 3-1 4.5-2 3 .6-2-1-3.5-1-5-1 1-2 2.5-2 4.5-1-1-1-4 0-7z"/><path d="M8.5 14.5a3.5 3.5 0 1 0 7 0c0-1-.5-1.8-1-2.5-.3 1.5-1.3 2-1.5 1-1 1-1.5 0-1-1.5-1.6.7-2.5 1.8-3.5 3z"/></svg>`,
  SPARKLE: `<svg ${ATTRS}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>`,
  SHUFFLE: `<svg ${ATTRS}><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
  MUTE: `<svg ${ATTRS}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
  ZEN: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>`,
  COMMAND: `<svg ${ATTRS}><path d="M9 3.5A2.5 2.5 0 1 0 6.5 6H9v3H6.5A2.5 2.5 0 1 0 9 11.5V9h6v2.5a2.5 2.5 0 1 0 2.5-2.5H15V6h2.5A2.5 2.5 0 1 0 15 3.5V6H9V3.5z"/></svg>`,
  SETTINGS_GEAR: `<svg ${ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.8 1 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  TIMER: `<svg ${ATTRS}><path d="M9 2h6"/><path d="M12 8v4l2.5 1.5"/><circle cx="12" cy="13" r="8"/></svg>`,
  QUOTE: `<svg ${ATTRS}><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5z"/></svg>`,
  NOTE: `<svg ${ATTRS}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>`,
  CLOCK: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  TARGET: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`,
  BOLT: `<svg ${ATTRS}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
  BOOK: `<svg ${ATTRS}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  UPLOAD: `<svg ${ATTRS}><path d="M12 16V4"/><path d="M6 9l6-6 6 6"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`,
  FLIP_H: `<svg ${ATTRS}><path d="M12 3v18"/><path d="M17 8l3 4-3 4"/><path d="M7 8l-3 4 3 4"/></svg>`,
};

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
  MIC: `<svg ${ATTRS}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`,
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
  TERMINAL: `<svg ${ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>`,
  FOLDER: `<svg ${ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`,
  FILE: `<svg ${ATTRS}><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/></svg>`,
  GIT_BRANCH: `<svg ${ATTRS}><circle cx="6" cy="5" r="2.3"/><circle cx="6" cy="19" r="2.3"/><circle cx="18" cy="8" r="2.3"/><path d="M6 7.3V16.7"/><path d="M6 11c0-3.5 2.5-3 6-4.4 2-.8 3.5-1.6 4.6-2.3"/><path d="M18 10.3V13"/></svg>`,
  EXTENSIONS: `<svg ${ATTRS}><path d="M10 3.5a1.5 1.5 0 0 1 3 0V5h2.5A1.5 1.5 0 0 1 17 6.5V9h1.5a1.5 1.5 0 0 1 0 3H17v2.5a1.5 1.5 0 0 1-1.5 1.5H13v1.5a1.5 1.5 0 0 1-3 0V16H6.5A1.5 1.5 0 0 1 5 14.5V12H3.5a1.5 1.5 0 0 1 0-3H5V6.5A1.5 1.5 0 0 1 6.5 5H10V3.5z"/></svg>`,
  REFRESH: `<svg ${ATTRS}><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/></svg>`,
  PLUS: `<svg ${ATTRS}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  // Code tab chrome (ui/code-window): sidebar / panel toggles, search, the
  // composer's send/stop, and transcript tool rows.
  SEARCH: `<svg ${ATTRS}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>`,
  SIDEBAR: `<svg ${ATTRS}><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/></svg>`,
  PANEL_RIGHT: `<svg ${ATTRS}><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14.5 4v16"/></svg>`,
  MORE: `<svg ${ATTRS}><circle cx="5.5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18.5" cy="12" r="1.1"/></svg>`,
  STOP: `<svg ${ATTRS}><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
  ARROW_UP: `<svg ${ATTRS}><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>`,
  NEW_CHAT: `<svg ${ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  COPY: `<svg ${ATTRS}><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  EYE: `<svg ${ATTRS}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>`,
  EDIT: `<svg ${ATTRS}><path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg>`,
  LIST: `<svg ${ATTRS}><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>`,
  CHEVRON: `<svg ${ATTRS}><path d="M6 9l6 6 6-6"/></svg>`,
  CLOSE: `<svg ${ATTRS}><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>`,
  ATTACH: `<svg ${ATTRS}><path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.4-6.4L14.6 5a3 3 0 0 1 4.3 4.3l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8"/></svg>`,
  SEND: `<svg ${ATTRS}><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
  CHECK: `<svg ${ATTRS}><path d="M5 13l4 4L19 7"/></svg>`,
  HOME: `<svg ${ATTRS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/></svg>`,
  CODE: `<svg ${ATTRS}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  CHAT_BOX: `<svg ${ATTRS}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  // Nav-rail chat glyph: two overlapping speech bubbles, matching claude.ai's
  // own "Chat / Cowork" mode icon (a double bubble, not the single one).
  CHAT: `<svg ${ATTRS}><path d="M14 9a2 2 0 0 1-2 2H6l-4 3.5V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M17.5 9H18a2 2 0 0 1 2 2v10.5L16.5 18H11a2 2 0 0 1-2-2v-.5"/></svg>`,
  // Nav-rail code glyph: angle brackets around a slash — the conventional
  // "code" mark, matching the </> claude.ai uses.
  CODE_SLASH: `<svg ${ATTRS}><path d="M8.5 7 3 12l5.5 5"/><path d="M15.5 7 21 12l-5.5 5"/><path d="M13.5 4.5 10.5 19.5"/></svg>`,
  // Full-IDE layout toggle: activity bar | editor | chat.
  LAYOUT_IDE: `<svg ${ATTRS}><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16"/><path d="M15.5 4v16"/></svg>`,
};

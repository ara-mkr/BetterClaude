/**
 * Focus Mode (§4.2) — a real layout mode, not a CSS opacity filter.
 *
 * What it does that the old version didn't:
 *   - HIDES the sidebar / chat list by actually DETACHING those nodes from the
 *     DOM (with a placeholder comment marking where to put them back), so they
 *     stop rendering, stop costing layout, and their listeners go dormant —
 *     verifiable by querying for them and finding nothing (the §4.2/§5.5 DOM
 *     assertion), instead of a display:none/opacity:0 node left mounted.
 *   - HIDES the top-bar chrome (header) with display:none, keeping only the
 *     always-present dock toggle as the minimal "exit focus mode" affordance.
 *   - RE-FLOWS the transcript + composer to full width (the space is genuinely
 *     reclaimed because the sidebar box is gone, not just visually hidden).
 *   - Is reachable via the persistent dock toggle AND a keyboard shortcut
 *     (Cmd/Ctrl+Shift+F), and reverses with one action.
 *   - Survives claude.ai's React re-renders: a MutationObserver re-detaches a
 *     sidebar that React re-inserts while focus mode is on, and everything is
 *     fully restored — nodes reinserted at their original position — on exit.
 */
const FOCUS_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

// Nodes to remove entirely in focus mode (sidebar + any chat-list rail).
const HIDE_SELECTORS = [
  'nav[class*="sidebar"]',
  '[data-testid="sidebar"]',
  '[data-testid="chat-list"]',
];

module.exports = {
  name: "Focus Mode",
  version: "2.0.0",

  onLoad(api) {
    this.api = api;
    this.active = !!api.getSetting("active");
    this._detached = []; // [{ node, placeholder }]
    this._observer = null;

    api.injectCSS(`
      /* Top-bar chrome is removed (not dimmed) — the dock toggle is the
         exit affordance. */
      body.bc-focus-mode header { display: none !important; }

      /* Reclaimed space: transcript + composer re-flow to a centered full
         column now that the sidebar box is physically gone. */
      body.bc-focus-mode main,
      body.bc-focus-mode [data-testid="composer"] {
        max-width: 860px !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      /* Keep our own exit affordance fully visible and obvious. */
      body.bc-focus-mode #betterclaude-plugin-dock { opacity: 1 !important; }
    `);

    this._dockBtn = api.mountToolbarButton({
      icon: FOCUS_ICON,
      label: "Toggle Focus Mode (⌘/Ctrl+Shift+F)",
      active: this.active,
      onClick: () => this.setActive(!this.active),
    });

    // Keyboard shortcut — documented in the button label, removable on unload.
    this._onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        this.setActive(!this.active);
      }
    };
    document.addEventListener("keydown", this._onKey, true);

    this._applyState();
  },

  setActive(active) {
    this.active = active;
    this.api.setSetting("active", active);
    this._applyState();
  },

  _detach() {
    HIDE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((node) => {
        if (node.__bcFocusDetached || !node.parentNode) return;
        const placeholder = document.createComment("bc-focus-mode-placeholder");
        node.__bcFocusDetached = true;
        node.parentNode.insertBefore(placeholder, node);
        node.remove();
        this._detached.push({ node, placeholder });
      });
    });
  },

  _restore() {
    this._detached.forEach(({ node, placeholder }) => {
      if (placeholder.parentNode) placeholder.parentNode.insertBefore(node, placeholder);
      if (placeholder.parentNode) placeholder.remove();
      delete node.__bcFocusDetached;
    });
    this._detached = [];
  },

  _applyState() {
    document.body.classList.toggle("bc-focus-mode", this.active);
    if (this._dockBtn) this._dockBtn.setActive(this.active);

    if (this.active) {
      this._detach();
      // Re-detach anything React re-mounts while focus mode stays on.
      if (!this._observer) {
        this._observer = new MutationObserver(() => {
          if (this.active) this._detach();
        });
        this._observer.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      this._restore();
    }
  },

  /** Exposed for the audit/DOM assertion: are the hidden nodes truly gone? */
  areHiddenElementsUnmounted() {
    return HIDE_SELECTORS.every((sel) => document.querySelector(sel) === null);
  },

  onUnload() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._restore();
    document.body.classList.remove("bc-focus-mode");
    if (this._onKey) document.removeEventListener("keydown", this._onKey, true);
    if (this._dockBtn) this._dockBtn.remove();
  },
};

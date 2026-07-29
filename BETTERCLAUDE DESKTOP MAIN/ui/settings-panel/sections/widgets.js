/**
 * Settings panel section: Widgets — a curated gallery over the existing
 * plugin system. Mixed onto SettingsPanel.prototype by panel.js.
 */

const { el, selectField } = require("../dom-helpers");
const ICONS = require("../../../core/icons");

const WIDGET_CATALOG = [
  { id: "pomodoro-timer", label: "Pomodoro Timer", icon: ICONS.TIMER, description: "Focus/break countdown in the dock." },
  { id: "quote-of-the-day", label: "Quote of the Day", icon: ICONS.QUOTE, description: "A fresh quote (real or joke) each day, editable." },
  { id: "sticky-notes", label: "Sticky Notes", icon: ICONS.NOTE, description: "A small corkboard of freeform notes." },
  { id: "world-clock", label: "World Clock", icon: ICONS.CLOCK, description: "Local time plus other time zones." },
  { id: "goal-tracker", label: "Goal Tracker", icon: ICONS.TARGET, description: "A checklist with a progress bar." },
  { id: "quick-prompts", label: "Quick Prompts", icon: ICONS.BOLT, description: "Canned prompts inserted into the composer." },
  { id: "snippet-library", label: "Snippet Library", icon: ICONS.BOOK, description: "Full CRUD prompt/snippet manager with search." },
];

module.exports = {
  _renderWidgets() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Widgets" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A curated gallery over the plugin system (see the Plugins tab for the full raw list) — toggle a widget on to add its dock icon.",
    }));

    wrap.appendChild(selectField("Gallery view", [
      { value: "grid", label: "Grid" },
      { value: "list", label: "List" },
      { value: "card", label: "Card" },
    ], settings.layout.widgetGalleryView, (v) => {
      this._set("layout.widgetGalleryView", v);
      this.renderSection();
    }));

    const gallery = el("div", { class: `bc-widget-gallery bc-view-${settings.layout.widgetGalleryView}` });
    wrap.appendChild(gallery);
    this.contentEl.appendChild(wrap);

    const pinned = new Set(settings.layout.pinnedWidgets || []);

    // WIDGET_CATALOG is static/local, so the gallery can paint immediately —
    // only each card's enabled checkbox needs the async plugin-state
    // round-trip (renderCards is called again once that resolves). Painting
    // synchronously first means the gallery is never left empty even if
    // that IPC call is slow, races a newer render, or fails outright — all
    // real ways the old single-async-render version silently showed nothing
    // (see the isConnected guard below for the race specifically).
    const renderCards = (byId) => {
      const sorted = [...WIDGET_CATALOG].sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
      gallery.innerHTML = "";
      sorted.forEach((widget) => {
        const state = byId.get(widget.id);
        const card = el("div", { class: "bc-widget-card" });
        card.appendChild(el("div", { class: "bc-widget-icon", html: widget.icon }));
        card.appendChild(el("div", { class: "bc-widget-title", text: widget.label }));
        card.appendChild(el("div", { class: "bc-widget-desc", text: widget.description }));

        const row = el("div", { class: "bc-widget-actions" });
        const toggle = el("input", { type: "checkbox" });
        toggle.checked = !!(state && state.enabled);
        toggle.addEventListener("change", () => this.host.togglePlugin(widget.id, toggle.checked));
        row.appendChild(toggle);

        const pinBtn = el("button", {
          class: `bc-theme-star${pinned.has(widget.id) ? " bc-active" : ""}`,
          text: pinned.has(widget.id) ? "★" : "☆",
          title: "Pin to top of this gallery",
          onclick: () => {
            const next = pinned.has(widget.id) ? [...pinned].filter((id) => id !== widget.id) : [...pinned, widget.id];
            this._set("layout.pinnedWidgets", next);
            this.renderSection();
          },
        });
        row.appendChild(pinBtn);
        card.appendChild(row);
        gallery.appendChild(card);
      });
    };

    renderCards(new Map());
    this.host.listPlugins().then((plugins) => {
      // A newer renderSection() may have already wiped contentEl (and thus
      // detached `gallery`) before this IPC round-trip returned — updating
      // an orphaned node would silently do nothing visible, so skip it.
      if (!gallery.isConnected) return;
      renderCards(new Map(plugins.map((p) => [p.id, p])));
    }).catch((err) => console.error("[BetterClaude] Failed to load widget gallery:", err));
  },
};

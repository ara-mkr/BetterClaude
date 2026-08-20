/**
 * Settings -> Usage Analytics. Configuration only — the actual dashboard
 * (charts, date range picker, CSV/PNG export, clear) lives in the
 * full-screen core/analytics-dashboard.js overlay, opened from the "Open
 * Dashboard" button here, same split as Settings -> Skill Marketplace.
 */

const { el, toggleField } = require("../dom-helpers");

module.exports = {
  _renderAnalytics() {
    const { settings } = this;
    const an = settings.analytics;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Usage Analytics" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default. Charts which of your plugins are actually active, built from usage events logged "
        + "locally as you go, stored in a local database and never sent anywhere. No conversation content is "
        + "read or recorded.",
    }));

    wrap.appendChild(toggleField("Enable Usage Analytics", an.enabled, (v) => this._set("analytics.enabled", v)));

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "Open Dashboard",
      onclick: () => this.host.openAnalyticsDashboard(),
    }));

    this.contentEl.appendChild(wrap);
  },
};

/**
 * Settings -> Usage Analytics. Configuration only — the actual dashboard
 * (charts, date range picker, CSV/PNG export, clear) lives in the
 * full-screen core/analytics-dashboard.js overlay, opened from the "Open
 * Dashboard" button here, same split as Settings -> Skill Marketplace.
 */

const { el, toggleField, rangeField } = require("../dom-helpers");

module.exports = {
  _renderAnalytics() {
    const { settings } = this;
    const an = settings.analytics;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Usage Analytics" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Off by default. Historical charts — tokens/day, messages/day, estimated cost/day, most-used "
        + "skills/plugins, busiest projects — built entirely from usage events logged locally as you go, stored in "
        + "a local database and never sent anywhere. Distinct from the live Usage HUD, which doesn't persist "
        + "anything.",
    }));

    wrap.appendChild(toggleField("Enable Usage Analytics", an.enabled, (v) => this._set("analytics.enabled", v)));

    wrap.appendChild(el("h2", { text: "Estimated cost", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "There's no public Claude pricing API, so cost is estimated from these rates you set — adjust them to "
        + "match your actual plan/model.",
    }));
    wrap.appendChild(rangeField("Input — $ per million tokens", {
      min: 0, max: 30, step: 0.5, value: an.costPerMillionTokens.input,
      format: (v) => `$${v}`,
      onInput: (v) => this._set("analytics.costPerMillionTokens.input", v),
    }));
    wrap.appendChild(rangeField("Output — $ per million tokens", {
      min: 0, max: 100, step: 0.5, value: an.costPerMillionTokens.output,
      format: (v) => `$${v}`,
      onInput: (v) => this._set("analytics.costPerMillionTokens.output", v),
    }));

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "Open Dashboard",
      onclick: () => this.host.openAnalyticsDashboard(),
    }));

    this.contentEl.appendChild(wrap);
  },
};

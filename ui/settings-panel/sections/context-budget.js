/**
 * Settings -> Context Budget. A pre-send planning step (see
 * core/context-budget.js) distinct from the live Usage HUD: it only
 * interrupts a send once the projected total crosses this threshold.
 */

const { el, toggleField, rangeField } = require("../dom-helpers");

module.exports = {
  _renderContextBudget() {
    const { settings } = this;
    const cb = settings.contextBudget;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Context Budget" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Before a large paste or attachment goes out, show a breakdown of what it'll cost against the context "
        + "window and let you back out — instead of finding out after the fact. Below the threshold, nothing here "
        + "ever gets in the way of a normal send.",
    }));

    wrap.appendChild(toggleField("Enable Context Budget Planner", cb.enabled, (v) => this._set("contextBudget.enabled", v)));

    wrap.appendChild(rangeField("Warn threshold", {
      min: 40, max: 95, step: 5, value: cb.warnThresholdPercent,
      format: (v) => `${v}%`,
      onInput: (v) => this._set("contextBudget.warnThresholdPercent", v),
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Shows the pre-send breakdown once the conversation-so-far + your draft + any pasted/attached files would cross this percentage of the model's context window.",
    }));

    this.contentEl.appendChild(wrap);
  },
};

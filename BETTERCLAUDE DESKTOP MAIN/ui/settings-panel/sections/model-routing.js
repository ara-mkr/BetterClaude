/**
 * Settings -> Model Routing. User-defined rules matched against the
 * outgoing message → route to a specific model by clicking through
 * claude.ai's own model picker before the send goes through (see
 * core/model-router.js). Off by default; every match fires a notification
 * so routing is never a silent black box.
 */

const { el, field, toggleField, textField } = require("../dom-helpers");

function uid() {
  return `mr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = {
  _renderModelRouting() {
    const { settings } = this;
    const mr = settings.modelRouting;
    if (this._mrEditingId === undefined) this._mrEditingId = null;

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Model Routing" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Match the outgoing message against rules (in priority order, top wins) and switch claude.ai's model "
        + "picker before sending. Best-effort DOM automation — if the picker can't be found or the option can't be "
        + "matched, the send goes through unmodified rather than getting stuck.",
    }));

    wrap.appendChild(toggleField("Enable Model Routing", mr.enabled, (v) => this._set("modelRouting.enabled", v)));
    wrap.appendChild(textField(
      "Fallback model (used when no rule matches)",
      mr.defaultModel,
      (v) => this._set("modelRouting.defaultModel", v.trim()),
      { placeholder: "e.g. Sonnet — leave blank to never override" }
    ));

    const save = (next) => {
      this.settings.modelRouting.rules = next;
      this._set("modelRouting.rules", next);
    };

    wrap.appendChild(el("button", {
      class: "bc-btn",
      text: "+ New Rule",
      onclick: () => { this._mrEditingId = "__new__"; this.renderSection(); },
    }));

    if (this._mrEditingId) {
      const existing = this._mrEditingId === "__new__" ? null : mr.rules.find((r) => r.id === this._mrEditingId);
      wrap.appendChild(this._buildRuleForm(existing, (saved) => {
        const next = existing ? mr.rules.map((r) => (r.id === existing.id ? saved : r)) : [...mr.rules, saved];
        save(next);
        this._mrEditingId = null;
        this.renderSection();
      }, () => { this._mrEditingId = null; this.renderSection(); }));
    }

    wrap.appendChild(el("h2", { text: "Rules (priority order)", class: "bc-ae-subhead" }));
    const list = el("div", { class: "bc-plugin-list" });
    if (mr.rules.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No rules yet — everything sends on whatever model you pick manually." }));
    mr.rules.forEach((rule, i) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: rule.label }),
        el("span", {
          class: "bc-plugin-version",
          text: `${rule.isRegex ? "regex" : "contains"}: "${rule.pattern}" → ${rule.modelMatch}${rule.enabled ? "" : " (disabled)"}`,
        }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      if (i > 0) {
        actions.appendChild(el("button", {
          class: "bc-theme-star", text: "▲", title: "Higher priority",
          onclick: () => { const next = [...mr.rules]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; save(next); this.renderSection(); },
        }));
      }
      if (i < mr.rules.length - 1) {
        actions.appendChild(el("button", {
          class: "bc-theme-star", text: "▼", title: "Lower priority",
          onclick: () => { const next = [...mr.rules]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; save(next); this.renderSection(); },
        }));
      }
      actions.appendChild(el("button", {
        class: "bc-theme-star", text: "Edit",
        onclick: () => { this._mrEditingId = rule.id; this.renderSection(); },
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete", text: "✕",
        onclick: () => { save(mr.rules.filter((r) => r.id !== rule.id)); this.renderSection(); },
      }));
      row.appendChild(actions);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    this.contentEl.appendChild(wrap);
  },

  _buildRuleForm(existing, onSave, onCancel) {
    const form = el("div", { class: "bc-schedule-section" });
    form.appendChild(el("h2", { text: existing ? "Edit rule" : "New rule", class: "bc-ae-subhead" }));

    const labelInput = el("input", { type: "text", value: existing ? existing.label : "", placeholder: "Label" });
    form.appendChild(field("Label", labelInput));

    const patternInput = el("input", { type: "text", value: existing ? existing.pattern : "", placeholder: "e.g. review this code" });
    form.appendChild(field("Match text contains…", patternInput));

    const regexToggle = el("input", { type: "checkbox" });
    regexToggle.checked = existing ? !!existing.isRegex : false;
    form.appendChild(field("Treat pattern as a regular expression", regexToggle));

    const modelInput = el("input", { type: "text", value: existing ? existing.modelMatch : "", placeholder: "e.g. Opus" });
    form.appendChild(field("Route to model matching…", modelInput));
    form.appendChild(el("p", {
      class: "bc-hint",
      text: "A substring to look for in the model picker's option text — not an exact model id, since claude.ai doesn't expose one.",
    }));

    const enabledToggle = el("input", { type: "checkbox" });
    enabledToggle.checked = existing ? existing.enabled !== false : true;
    form.appendChild(field("Enabled", enabledToggle));

    const actions = el("div", { class: "bc-theme-toolbar" });
    actions.appendChild(el("button", { class: "bc-btn bc-btn-secondary", text: "Cancel", onclick: onCancel }));
    actions.appendChild(el("button", {
      class: "bc-btn",
      text: "Save",
      onclick: () => {
        const label = labelInput.value.trim();
        const pattern = patternInput.value.trim();
        const modelMatch = modelInput.value.trim();
        if (!label || !pattern || !modelMatch) return;
        onSave({
          id: existing ? existing.id : uid(),
          label,
          pattern,
          isRegex: regexToggle.checked,
          modelMatch,
          enabled: enabledToggle.checked,
        });
      },
    }));
    form.appendChild(actions);

    return form;
  },
};

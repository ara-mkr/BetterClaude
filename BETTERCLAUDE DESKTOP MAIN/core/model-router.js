/**
 * Multi-Model Routing — DOM-only, no Node/Electron APIs.
 *
 * pickRule() is pure/testable in isolation (no DOM), same spirit as
 * core/prompt-vars.js. ModelRouter is the DOM half: modeled directly on
 * core/context-budget.js's interception shape (same capture-phase
 * keydown/click listeners, same bypassNextSend + _resend pattern), except
 * instead of showing a modal it clicks through claude.ai's own model-picker
 * dropdown before letting the send through.
 *
 * This is a new category of automation versus everything else in this app:
 * previous DOM automation only ever wrote to the composer or clicked one
 * well-defined button. Opening and navigating a live dropdown menu is more
 * fragile, so every step here is wrapped and fails open — a selector miss
 * just sends on whatever model is already selected, never blocks.
 */

const { findComposer, findSendButton } = require("./compose-insert");
const { detectModel, MESSAGE_SELECTORS } = require("./token-counter");

// First enabled rule (in array order = priority) whose pattern matches
// `text` wins. Returns null if nothing matches.
function pickRule(rules, text) {
  const t = text || "";
  for (const rule of rules || []) {
    if (!rule.enabled) continue;
    if (!rule.pattern) continue;
    try {
      if (rule.isRegex) {
        if (new RegExp(rule.pattern, "i").test(t)) return rule;
      } else if (t.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule;
      }
    } catch (_e) {
      // Invalid regex — skip this rule rather than throw mid-send.
    }
  }
  return null;
}

class ModelRouter {
  constructor(host) {
    // { getRules(), getDefaultModel(), isEnabled(), notify, isBypassed(), setBypass() }
    // isBypassed/setBypass are the shared, time-windowed bypass also used by
    // core/context-budget.js — see that file's header for why a per-instance
    // flag doesn't work once two composer-send interceptors coexist.
    this.host = host;
    this.composer = null;
    this.sendButton = null;
  }

  attach(root = document) {
    const composer = findComposer(root);
    if (!composer) return false;
    this.composer = composer;
    this.sendButton = findSendButton(root);

    composer.addEventListener("keydown", (e) => this._safely(() => this._onComposerKeydown(e)), true);
    if (this.sendButton) {
      this.sendButton.addEventListener("click", (e) => this._safely(() => this._onSendClick(e)), true);
    }
    return true;
  }

  _safely(fn) {
    try {
      fn();
    } catch (err) {
      console.error("[BetterClaude] Model Router error (failing open, send not blocked)", err);
    }
  }

  _onComposerKeydown(e) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    this._interceptSend(e);
  }

  _onSendClick(e) {
    this._interceptSend(e);
  }

  _interceptSend(e) {
    if (!this.host.isEnabled()) return;
    if (this.host.isBypassed && this.host.isBypassed()) return;
    const text = this.composer ? this.composer.value : "";
    const rule = pickRule(this.host.getRules(), text) || (this.host.getDefaultModel() ? { modelMatch: this.host.getDefaultModel(), label: "default model" } : null);
    if (!rule || !rule.modelMatch) return; // nothing to route — let the send through untouched

    const current = detectModel(document) || "";
    if (current.toLowerCase().includes(rule.modelMatch.toLowerCase())) return; // already on the right model

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    this._switchModelThenResend(rule);
  }

  async _switchModelThenResend(rule) {
    const switched = await this._trySwitchModel(rule.modelMatch);
    if (switched && this.host.notify) {
      this.host.notify(`Routed to a model matching "${rule.modelMatch}" via rule "${rule.label}".`);
    }
    if (this.host.setBypass) this.host.setBypass();
    this._resend();
  }

  // Best-effort: open the model picker, wait a beat for its menu to render,
  // click the first item whose text includes `modelMatch`. Returns false
  // (not throws) on any miss so the caller always falls through to sending.
  async _trySwitchModel(modelMatch) {
    try {
      const picker = document.querySelector(MESSAGE_SELECTORS.modelPicker);
      if (!picker) return false;
      picker.click();
      await new Promise((r) => setTimeout(r, 200));
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-testid*="model-option" i]'));
      const target = items.find((el) => (el.innerText || el.textContent || "").toLowerCase().includes(modelMatch.toLowerCase()));
      if (!target) {
        picker.click(); // best-effort close the menu we opened
        return false;
      }
      target.click();
      return true;
    } catch (_e) {
      return false;
    }
  }

  _resend() {
    if (this.sendButton) this.sendButton.click();
    else if (this.composer) {
      this.composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }
  }
}

module.exports = { pickRule, ModelRouter };

/**
 * Context Budget Planner — DOM-only, no Node/Electron APIs. A pre-send
 * planning step, distinct from core/hud.js's passive live readout: it only
 * ever interrupts a send once the *projected* usage (conversation so far +
 * draft + pending attachments) crosses a configurable threshold. Below
 * threshold, nothing here is ever in the way of a normal send.
 *
 * Every listener is wrapped so a thrown error (composer/button not found,
 * unexpected DOM) skips the check instead of ever silently blocking a send
 * — "fails open," never "fails closed."
 *
 * `host`:
 *   host.getUsage() -> { usedTokens, contextWindow }   (sync, reads local state)
 *   host.getThreshold() -> number (0-100)                (sync)
 *   host.isBypassed() / host.setBypass()  — shared, time-windowed bypass used
 *     by every composer-send interceptor (this + core/model-router.js), see
 *     electron/preload.js. Not per-instance: a resend from *any* interceptor
 *     re-fires every sibling's listener on the same element, so bypass state
 *     has to be shared or siblings re-block an attempt that already passed.
 */

const { findComposer, findSendButton } = require("./compose-insert");
const { estimateTokens } = require("./token-counter");

// Anthropic's own docs describe vision token cost as roughly
// (width * height) / 750 for Claude models — used here as a documented
// estimate, not an exact figure (the real cost depends on model-specific
// tiling we have no visibility into). Capped so a huge image can't dominate
// the breakdown with a wildly implausible number.
const IMAGE_TOKENS_PER_PIXEL_DIVISOR = 750;
const IMAGE_TOKEN_CAP = 1600;
const FALLBACK_BYTES_PER_TOKEN = 4;

async function estimateFileTokens(file) {
  try {
    if (file.type && file.type.startsWith("image/") && typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const tokens = Math.round((bitmap.width * bitmap.height) / IMAGE_TOKENS_PER_PIXEL_DIVISOR);
      if (bitmap.close) bitmap.close();
      return Math.min(IMAGE_TOKEN_CAP, Math.max(1, tokens));
    }
    if (file.type.startsWith("text/") || /\.(md|txt|json|csv|ya?ml|js|ts|jsx|tsx|py|log|xml|html?)$/i.test(file.name || "")) {
      return estimateTokens(await file.text());
    }
  } catch (_e) {
    // Falls through to the size-based heuristic below.
  }
  return Math.ceil((file.size || 0) / FALLBACK_BYTES_PER_TOKEN);
}

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class ContextBudgetPlanner {
  constructor(host) {
    this.host = host;
    this.el = null;
    this.composer = null;
    this.sendButton = null;
    this.pendingAttachments = []; // [{ name, tokens }]
  }

  // Returns true if a composer was found and listeners attached. Safe to
  // call again later (e.g. after claude.ai re-renders the composer) — it
  // just re-attaches to whatever's currently in the DOM.
  attach(root = document) {
    const composer = findComposer(root);
    if (!composer) return false;
    this.composer = composer;
    this.sendButton = findSendButton(root);

    composer.addEventListener("paste", (e) => this._safely(() => this._onPaste(e)));
    composer.addEventListener("drop", (e) => this._safely(() => this._onDrop(e)), true);
    root.addEventListener("change", (e) => this._safely(() => this._onFileInputChange(e)), true);
    // Capture phase: must see the send action before claude.ai's own
    // React-delegated handler does, so preventDefault/stopPropagation here
    // actually stops it from going through.
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
      console.error("[BetterClaude] Context Budget Planner error (failing open, send not blocked)", err);
    }
  }

  _onPaste(e) {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    files.forEach((f) => this._trackAttachment(f));
  }

  _onDrop(e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    files.forEach((f) => this._trackAttachment(f));
  }

  _onFileInputChange(e) {
    const input = e.target;
    if (!input || input.type !== "file" || !input.files) return;
    Array.from(input.files).forEach((f) => this._trackAttachment(f));
  }

  async _trackAttachment(file) {
    const tokens = await estimateFileTokens(file);
    this.pendingAttachments.push({ name: file.name || "attachment", tokens });
  }

  _onComposerKeydown(e) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    this._interceptSend(e);
  }

  _onSendClick(e) {
    this._interceptSend(e);
  }

  _interceptSend(e) {
    if (this.host.isEnabled && !this.host.isEnabled()) return; // live-togglable without re-attaching listeners
    // Shared, time-windowed bypass (not a private one-shot flag): a resend
    // triggered by *any* composer-send interceptor (Model Router included)
    // re-fires every interceptor's listener on the same element, so a
    // per-instance flag consumed by whichever one happens to run first
    // would leave the others re-evaluating a stale attempt and re-blocking
    // it. See core/model-router.js for the sibling interceptor.
    if (this.host.isBypassed && this.host.isBypassed()) {
      this.pendingAttachments = [];
      return;
    }
    const breakdown = this._computeBreakdown();
    const threshold = this.host.getThreshold();
    if (breakdown.percent < threshold) {
      // Send is proceeding un-intercepted — those attachments are now
      // "used" either way, so don't let them bleed into the next message.
      this.pendingAttachments = [];
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    this._openModal(breakdown);
  }

  _computeBreakdown() {
    const usage = this.host.getUsage() || { usedTokens: 0, contextWindow: 200000 };
    const draftTokens = estimateTokens(this.composer ? this.composer.value : "");
    const attachmentTotal = this.pendingAttachments.reduce((s, a) => s + a.tokens, 0);
    const total = usage.usedTokens + draftTokens + attachmentTotal;
    const percent = usage.contextWindow > 0 ? Math.round((total / usage.contextWindow) * 1000) / 10 : 0;
    return { usage, draftTokens, attachments: [...this.pendingAttachments], total, percent };
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-context-budget-overlay";
    overlay.innerHTML = `<div class="bc-cb-box" data-bc-cb-box></div>`;
    document.body.appendChild(overlay);
    this.el = overlay;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    return overlay;
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  _openModal(breakdown) {
    if (!this.el) this.mount();
    const box = this.el.querySelector("[data-bc-cb-box]");
    const rows = [
      { label: "Conversation so far", tokens: breakdown.usage.usedTokens },
      { label: "Your draft", tokens: breakdown.draftTokens },
      ...breakdown.attachments.map((a) => ({ label: a.name, tokens: a.tokens })),
    ];
    box.innerHTML = `
      <div class="bc-cb-header">Context budget: ${breakdown.percent}% of ${breakdown.usage.contextWindow.toLocaleString()} tokens</div>
      <div class="bc-cb-rows">
        ${rows.map((r) => `<div class="bc-cb-row"><span>${escapeHtml(r.label)}</span><span>${r.tokens.toLocaleString()} tok</span></div>`).join("")}
      </div>
      <p class="bc-cb-hint">Sending this will use about ${breakdown.percent}% of this conversation's context window.</p>
      <div class="bc-cb-actions">
        <button type="button" class="bc-btn bc-btn-secondary" data-bc-cb-cancel>Cancel</button>
        <button type="button" class="bc-btn" data-bc-cb-continue>Continue anyway</button>
      </div>
    `;
    this.el.classList.add("bc-open");

    box.querySelector("[data-bc-cb-cancel]").addEventListener("click", () => this.close());
    box.querySelector("[data-bc-cb-continue]").addEventListener("click", () => {
      this.close();
      if (this.host.setBypass) this.host.setBypass();
      this._resend();
    });
  }

  // Prefers clicking the real send button (a trusted-feeling `.click()`
  // reliably triggers React's onClick delegation) over re-simulating an
  // Enter keydown, which is more likely to be second-guessed by app code.
  _resend() {
    if (this.sendButton) this.sendButton.click();
    else if (this.composer) {
      this.composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }
  }
}

module.exports = { ContextBudgetPlanner, estimateFileTokens };

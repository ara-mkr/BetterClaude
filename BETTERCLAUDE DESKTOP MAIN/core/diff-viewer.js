/**
 * Diff Viewer overlay — DOM-only aside from requiring the `diff` package
 * (pure JS, browser-safe, bundled by esbuild the same way gpt-tokenizer
 * already is). Two textareas holding two assistant responses to compare,
 * word-level diff highlighting rendered below. Modeled on
 * core/command-palette.js's mount/open/close/toggle pattern.
 */

const { diffWords } = require("diff");

class DiffViewer {
  constructor() {
    this.el = null;
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-diff-viewer-overlay";
    overlay.innerHTML = `
      <div class="bc-dv-box">
        <div class="bc-dv-header">
          <strong>Compare Responses</strong>
          <button type="button" class="bc-dv-close" data-bc-dv-close title="Close">✕</button>
        </div>
        <div class="bc-dv-inputs">
          <textarea class="bc-dv-textarea" placeholder="Response A" data-bc-dv-a></textarea>
          <textarea class="bc-dv-textarea" placeholder="Response B" data-bc-dv-b></textarea>
        </div>
        <button type="button" class="bc-btn" data-bc-dv-run>Diff</button>
        <div class="bc-dv-result" data-bc-dv-result></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector("[data-bc-dv-close]").addEventListener("click", () => this.close());
    overlay.querySelector("[data-bc-dv-run]").addEventListener("click", () => this._runDiff());
    return overlay;
  }

  // { a, b } optionally prefills a side — e.g. from the fork-buttons layer's
  // "Copy for compare" affordance, so the user doesn't have to paste by hand.
  open({ a, b } = {}) {
    if (!this.el) this.mount();
    this.el.classList.add("bc-open");
    if (a != null) this.el.querySelector("[data-bc-dv-a]").value = a;
    if (b != null) this.el.querySelector("[data-bc-dv-b]").value = b;
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  _runDiff() {
    const a = this.el.querySelector("[data-bc-dv-a]").value;
    const b = this.el.querySelector("[data-bc-dv-b]").value;
    const result = this.el.querySelector("[data-bc-dv-result]");
    result.innerHTML = "";
    diffWords(a, b).forEach((part) => {
      const span = document.createElement("span");
      span.textContent = part.value;
      if (part.added) span.className = "bc-dv-added";
      else if (part.removed) span.className = "bc-dv-removed";
      result.appendChild(span);
    });
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { DiffViewer };

/**
 * Inline Diff Applier for Code Blocks — DOM-only, no Node/Electron APIs.
 *
 * Gated entirely on Native File Watcher Sync (#8, core/file-sync-
 * indicator.js) already having an open/attached matching file: with nothing
 * watched, matchCandidates() always returns [] and no button ever appears.
 * Matching a code block to a watched file is inherently fuzzy (there's no
 * reliable signal claude.ai's own DOM gives us for "this code is that
 * file"), so this is honest about confidence rather than silently guessing:
 *   "exact"     — the watched file's name is mentioned in the same message
 *   "fuzzy"     — exactly one watched file shares the code block's language
 *   "ambiguous" — more than one watched file shares that language
 *   "unknown"   — no filename mention and no language tag to go on
 * Anything short of "exact" is surfaced as a visible warning in
 * DiffApplierOverlay, with every watched file offered in a picker so the
 * user confirms (or corrects) the guess before Apply is enabled — this is
 * the "handle partial/fuzzy matches gracefully" requirement, not a unified-
 * diff/patch-context fuzzy-apply algorithm: the code block is always taken
 * as the intended full file contents, diffed line-by-line against the real
 * current file (freshly read from disk, not a cached copy) before Apply
 * overwrites it.
 */

const { diffLines } = require("diff");
const { guessCodeFenceLang } = require("./file-sync-indicator");

function extractCodeBlocks(turnNode) {
  if (!turnNode || !turnNode.querySelectorAll) return [];
  return Array.from(turnNode.querySelectorAll("pre"))
    .map((pre) => {
      const codeEl = pre.querySelector("code") || pre;
      const langMatch = /language-([\w+-]+)/.exec(codeEl.className || "");
      const text = (codeEl.innerText || codeEl.textContent || "").replace(/\n$/, "");
      return { node: pre, text, lang: langMatch ? langMatch[1] : "" };
    })
    .filter((block) => block.text.trim().length > 0);
}

function matchCandidates(codeBlock, turnText, watchedFiles) {
  const files = watchedFiles || [];
  if (files.length === 0) return [];

  const lowerText = (turnText || "").toLowerCase();
  const exact = files.filter((f) => f.label && lowerText.includes(f.label.toLowerCase()));
  if (exact.length > 0) return exact.map((f) => ({ file: f, confidence: "exact" }));

  const lang = (codeBlock.lang || "").toLowerCase();
  if (lang) {
    const byLang = files.filter((f) => guessCodeFenceLang(f.label || f.path).toLowerCase() === lang);
    if (byLang.length === 1) return [{ file: byLang[0], confidence: "fuzzy" }];
    if (byLang.length > 1) return byLang.map((f) => ({ file: f, confidence: "ambiguous" }));
  }
  return files.map((f) => ({ file: f, confidence: "unknown" }));
}

// Floating "Diff & Apply" buttons pinned over each matched code block's real
// on-screen position — same viewport-tracking technique as
// core/branch-fork-buttons.js, never inserted into claude.ai's own DOM.
function mountCodeDiffButtons({ getTurns, getWatchedFiles, onOpen }) {
  let layer = document.getElementById("bc-diff-apply-buttons-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "bc-diff-apply-buttons-layer";
    document.body.appendChild(layer);
  }

  const buttonsByNode = new Map(); // <pre> node -> { wrap, btn }
  let rafPending = false;

  function sync() {
    const watchedFiles = getWatchedFiles() || [];
    const liveNodes = new Set();

    if (watchedFiles.length > 0) {
      const turns = (getTurns() || []).filter((t) => t.role === "assistant");
      turns.forEach((turn) => {
        if (!turn.node || !turn.node.isConnected) return;
        extractCodeBlocks(turn.node).forEach((block) => {
          const candidates = matchCandidates(block, turn.text, watchedFiles);
          if (candidates.length === 0) return;
          liveNodes.add(block.node);

          let entry = buttonsByNode.get(block.node);
          if (!entry) {
            const wrap = document.createElement("div");
            wrap.className = "bc-diff-apply-btn-wrap";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bc-diff-apply-btn";
            btn.textContent = "⇄ Diff & Apply";
            wrap.appendChild(btn);
            layer.appendChild(wrap);
            entry = { wrap, btn };
            buttonsByNode.set(block.node, entry);
          }
          entry.btn.onclick = () => onOpen({ codeText: block.text, candidates });

          const rect = block.node.getBoundingClientRect();
          const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.width === 0;
          entry.wrap.style.display = offscreen ? "none" : "flex";
          if (!offscreen) {
            entry.wrap.style.top = `${Math.max(0, rect.top + 6)}px`;
            entry.wrap.style.right = `${Math.max(0, window.innerWidth - rect.right + 10)}px`;
          }
        });
      });
    }

    buttonsByNode.forEach((entry, node) => {
      if (!liveNodes.has(node)) {
        entry.wrap.remove();
        buttonsByNode.delete(node);
      }
    });
  }

  function scheduleSync() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      sync();
    });
  }

  window.addEventListener("scroll", scheduleSync, true);
  window.addEventListener("resize", scheduleSync);

  function setVisible(visible) {
    layer.style.display = visible ? "block" : "none";
  }

  function destroy() {
    window.removeEventListener("scroll", scheduleSync, true);
    window.removeEventListener("resize", scheduleSync);
    layer.remove();
  }

  return { sync, setVisible, destroy };
}

const CONFIDENCE_LABELS = {
  exact: "Matched by filename mention in this message.",
  fuzzy: "Matched by file extension only — please confirm before applying.",
  ambiguous: "Multiple watched files share this extension — pick the right one before applying.",
  unknown: "No filename or language match — pick the right file before applying.",
};

// Modal: pick/confirm the target watched file, review a line diff against
// its real current contents (read fresh each time, never the cached
// settings copy), then Apply overwrites the file on disk.
class DiffApplierOverlay {
  constructor(host) {
    // host: { readFile(path) -> Promise<string>, writeFile(path, content) -> Promise, notify(message) }
    this.host = host;
    this.el = null;
    this.codeText = "";
    this.candidates = [];
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-diff-applier-overlay";
    overlay.innerHTML = `
      <div class="bc-da-box">
        <div class="bc-da-header">
          <strong>Diff &amp; Apply</strong>
          <button type="button" class="bc-dv-close" data-bc-da-close title="Close">✕</button>
        </div>
        <label class="bc-da-select-label">
          Target file
          <select class="bc-da-select" data-bc-da-select></select>
        </label>
        <p class="bc-da-confidence" data-bc-da-confidence></p>
        <div class="bc-dv-result bc-da-result" data-bc-da-result></div>
        <div class="bc-da-actions">
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-da-cancel>Cancel</button>
          <button type="button" class="bc-btn" data-bc-da-apply>Apply to file</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector("[data-bc-da-close]").addEventListener("click", () => this.close());
    overlay.querySelector("[data-bc-da-cancel]").addEventListener("click", () => this.close());
    overlay.querySelector("[data-bc-da-select]").addEventListener("change", () => this._refreshDiff());
    overlay.querySelector("[data-bc-da-apply]").addEventListener("click", () => this._apply());
    return overlay;
  }

  async open({ codeText, candidates }) {
    if (!this.el) this.mount();
    this.codeText = codeText;
    this.candidates = candidates;
    const select = this.el.querySelector("[data-bc-da-select]");
    select.innerHTML = "";
    candidates.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = c.file.label;
      select.appendChild(opt);
    });
    select.value = "0";
    this.el.classList.add("bc-open");
    await this._refreshDiff();
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
  }

  _currentCandidate() {
    const select = this.el.querySelector("[data-bc-da-select]");
    return this.candidates[Number(select.value)] || this.candidates[0];
  }

  async _refreshDiff() {
    const candidate = this._currentCandidate();
    if (!candidate) return;
    const confEl = this.el.querySelector("[data-bc-da-confidence]");
    confEl.textContent = CONFIDENCE_LABELS[candidate.confidence] || "";
    confEl.className = `bc-da-confidence bc-da-conf-${candidate.confidence}`;

    const result = this.el.querySelector("[data-bc-da-result]");
    result.textContent = "Loading current file contents…";
    let current;
    try {
      current = await this.host.readFile(candidate.file.path);
    } catch (err) {
      result.textContent = `Couldn't read "${candidate.file.path}": ${err.message}`;
      return;
    }
    result.innerHTML = "";
    if (current === this.codeText) {
      result.textContent = "No differences — the file already matches this code block.";
      return;
    }
    diffLines(current, this.codeText).forEach((part) => {
      const span = document.createElement("span");
      span.textContent = part.value;
      if (part.added) span.className = "bc-dv-added";
      else if (part.removed) span.className = "bc-dv-removed";
      result.appendChild(span);
    });
  }

  async _apply() {
    const candidate = this._currentCandidate();
    if (!candidate) return;
    const applyBtn = this.el.querySelector("[data-bc-da-apply]");
    applyBtn.disabled = true;
    try {
      await this.host.writeFile(candidate.file.path, this.codeText);
      if (this.host.notify) this.host.notify(`Applied to ${candidate.file.label}.`);
      this.close();
    } catch (err) {
      if (this.host.notify) this.host.notify(`Apply failed: ${err.message}`);
    } finally {
      applyBtn.disabled = false;
    }
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { extractCodeBlocks, matchCandidates, mountCodeDiffButtons, DiffApplierOverlay };

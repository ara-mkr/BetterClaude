/**
 * Macro Recorder — DOM-only, no Node/Electron APIs.
 *
 * MacroRecorder is a small state machine (idle / recording / replaying)
 * plus one shared floating indicator (never inserted into claude.ai's own
 * DOM, same convention as core/branch-fork-buttons.js) showing whichever
 * state is active with a Stop control.
 *
 * waitForResponseSettled() is the awaitable counterpart to the two-tick-
 * stable finalization technique electron/preload.js's dispatch loop already
 * uses to know when a streaming assistant message has actually finished —
 * same principle (wait for the last turn's text to stop changing across
 * consecutive polls), reimplemented as a one-shot `await` since replay needs
 * to block step-to-step rather than react to a recurring mutation callback.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResponseSettled({ getTurns, timeoutMs = 120000, pollMs = 500, stableTicks = 2, shouldStop } = {}) {
  const start = Date.now();
  const baselineCount = (getTurns() || []).length;

  // Phase 1: wait for a new turn (the assistant's reply) to actually appear.
  while (Date.now() - start < timeoutMs) {
    if (shouldStop && shouldStop()) return false;
    if ((getTurns() || []).length > baselineCount) break;
    await sleep(pollMs);
  }
  if (shouldStop && shouldStop()) return false;

  // Phase 2: wait for the last turn's text to stop changing (streaming done).
  let lastText = null;
  let stableCount = 0;
  while (Date.now() - start < timeoutMs) {
    if (shouldStop && shouldStop()) return false;
    const turns = getTurns() || [];
    const last = turns[turns.length - 1];
    const text = last ? last.text : null;
    if (text != null && text === lastText) {
      stableCount += 1;
      if (stableCount >= stableTicks) return true;
    } else {
      stableCount = 0;
    }
    lastText = text;
    await sleep(pollMs);
  }
  return false; // timed out
}

// Steps through a macro: insert -> send -> wait for the response to settle
// -> next step. Stoppable mid-wait via `shouldStop()`, capped per-step by
// `timeoutMs` so a hung/unanswered step can't wedge replay forever.
async function replayMacro(macro, { insertText, clickSend, getTurns, resolvePromptStep, onStep, shouldStop, timeoutMs = 120000 } = {}) {
  const steps = (macro && macro.steps) || [];
  for (let i = 0; i < steps.length; i += 1) {
    if (shouldStop && shouldStop()) return { stopped: true, completedSteps: i };
    const step = steps[i];
    const text = step.type === "prompt" ? await resolvePromptStep(step) : step.text;
    if (onStep) onStep(i);
    insertText(text);
    clickSend();
    const settled = await waitForResponseSettled({ getTurns, timeoutMs, shouldStop });
    if (!settled) return { stopped: true, timedOut: !(shouldStop && shouldStop()), completedSteps: i + 1 };
  }
  return { stopped: false, completedSteps: steps.length };
}

class MacroRecorder {
  constructor(host) {
    this.host = host; // { onStopRecording(), onStopReplay() }
    this.mode = null; // null | "recording" | "replaying"
    this.name = "";
    this.steps = [];
    this.replayProgress = { index: 0, total: 0 };
    this.el = null;
  }

  isRecording() { return this.mode === "recording"; }
  isReplaying() { return this.mode === "replaying"; }

  startRecording(name) {
    this.mode = "recording";
    this.name = name || `Macro @ ${new Date().toLocaleString()}`;
    this.steps = [];
    this._render();
  }

  // Returns { name, steps } — the caller (electron/preload.js) is
  // responsible for actually persisting it as a saved macro.
  stopRecording() {
    const result = { name: this.name, steps: this.steps };
    this.mode = null;
    this.steps = [];
    this._render();
    return result;
  }

  recordStep(step) {
    if (this.mode !== "recording") return;
    this.steps.push(step);
    this._render();
  }

  startReplay(total) {
    this.mode = "replaying";
    this.replayProgress = { index: 0, total };
    this._render();
  }

  setReplayIndex(index) {
    this.replayProgress.index = index;
    this._render();
  }

  stopReplay() {
    this.mode = null;
    this._render();
  }

  _render() {
    if (!this.mode) {
      if (this.el) {
        this.el.remove();
        this.el = null;
      }
      return;
    }
    if (!this.el) {
      const bar = document.createElement("div");
      bar.id = "bc-macro-recording-indicator";
      document.body.appendChild(bar);
      bar.addEventListener("click", (e) => {
        if (!e.target.closest("[data-bc-macro-stop]")) return;
        if (this.mode === "recording" && this.host.onStopRecording) this.host.onStopRecording();
        else if (this.mode === "replaying" && this.host.onStopReplay) this.host.onStopReplay();
      });
      this.el = bar;
    }
    const label = this.mode === "recording"
      ? `⏺ Recording "${this.name}" — ${this.steps.length} step${this.steps.length === 1 ? "" : "s"}`
      : `▶ Replaying — step ${this.replayProgress.index}/${this.replayProgress.total}`;
    this.el.innerHTML = `<span>${label}</span><button type="button" data-bc-macro-stop>Stop</button>`;
  }
}

module.exports = { MacroRecorder, replayMacro, waitForResponseSettled };

/**
 * Coarse Claude Code activity detection from a TUI pty stream.
 *
 * Feeds on the same terminal output BetterClaude already forwards to the CLI /
 * IDE panes and reduces it to one of a few states, so the nav rail in the
 * shared title bar (ui/title-bar.js) can show a status dot on the Code / CLI
 * button - visible even while you are looking at the chat:
 *
 *   working  - Claude is generating (spinner / "esc to interrupt" on screen)
 *   waiting  - a permission or choice prompt is up; Claude needs an answer  -> amber
 *   stopped  - the last turn was interrupted or errored                     -> red
 *   done     - a turn that had been working went quiet at the prompt        -> green
 *   idle     - quiet, nothing pending (fresh session, or dot already seen)  -> no dot
 *
 * HEURISTIC AND BEST-EFFORT. Claude Code's terminal UI is not a stable API,
 * so every pattern here is a tuned guess kept deliberately loose, and the only
 * cost of a miss is a wrong-coloured 7px dot. Content is never persisted,
 * logged, or inspected for anything beyond these matches; only the last few KB
 * of (ANSI-stripped) output is held, and only long enough to test against.
 */

// CSI / control sequences - stripped before matching so a spinner frame or a
// colour escape can't split a keyword. Built at runtime so no literal ESC
// (0x1b) sits in the source.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]", "g");

// Rolling tail: enough for the permission box plus a few lines of lead-in.
const TAIL_MAX = 6000;
// Silence this long with nothing pending => the turn is over.
const QUIET_MS = 1200;

// The permission / choice prompt. "> 1. Yes" is the distinctive line; the
// looser alternatives cover plan-mode and reworded builds.
const WAITING_RE = /(❯\s*1\.\s*Yes|Do you want to (proceed|create|make this edit|run this|continue)|Would you like to proceed|\bpress\b[^\n]{0,20}\bto (confirm|continue)|1\.\s*Yes\b[\s\S]{0,140}\b(No|esc)\b)/i;

// An interrupted or failed turn.
const STOPPED_RE = /(Interrupted by user|Request (was )?(cancelled|interrupted|aborted)|Execution error|API Error|The operation was aborted)/i;

// Generation in progress: the interrupt hint, the elapsed/token line, or a
// braille spinner frame (U+2800..U+28FF).
const WORKING_RE = /(esc to interrupt|\besc\b[^\n]{0,16}\binterrupt\b|·\s*\d+s\s*·|[⠀-⣿])/i;

function createActivityTracker({ onState } = {}) {
  let tail = "";
  let state = "idle";
  let sawWorking = false;
  let quietTimer = null;

  function emit(next) {
    if (next === state) return;
    state = next;
    if (typeof onState === "function") onState(state);
  }

  function evaluate() {
    if (STOPPED_RE.test(tail)) {
      sawWorking = false;
      return emit("stopped");
    }
    if (WAITING_RE.test(tail)) return emit("waiting");
    if (WORKING_RE.test(tail)) {
      sawWorking = true;
      return emit("working");
    }
    // Nothing conclusive - leave the current state for the quiet timer.
  }

  function armQuiet() {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      // Went quiet with nothing pending. If we'd been generating, that's a
      // finished turn (green); otherwise just resting.
      if (state === "working") emit(sawWorking ? "done" : "idle");
    }, QUIET_MS);
  }

  return {
    feed(chunk) {
      const clean = String(chunk == null ? "" : chunk).replace(ANSI, "");
      if (!clean) return;
      tail = (tail + clean).slice(-TAIL_MAX);
      evaluate();
      armQuiet();
    },
    /** Session (re)start or exit - forget the stream and settle on `to`. */
    reset(to = "idle") {
      tail = "";
      sawWorking = false;
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      emit(to);
    },
    getState: () => state,
    dispose() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
    },
  };
}

module.exports = { createActivityTracker };

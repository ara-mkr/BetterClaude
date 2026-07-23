/**
 * Pomodoro Timer — dock button + small popover with start/pause/reset and
 * configurable focus/break lengths. State persists via api.registerSetting
 * so a running timer survives closing the popover (not app restarts, since
 * there's no background timer outside the renderer — the countdown just
 * resumes visually from whatever time has "passed" isn't tracked while
 * unloaded, which is an acceptable, honest limitation for a page-injected
 * widget with no separate process).
 */
const TIMER_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>`;

const DEFAULT_STATE = { workMinutes: 25, breakMinutes: 5, onBreak: false, running: false, remainingSeconds: 25 * 60 };

function fmt(totalSeconds) {
  const seconds = Math.max(0, totalSeconds);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

module.exports = {
  name: "Pomodoro Timer",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.state = Object.assign({}, DEFAULT_STATE, api.registerSetting("state", DEFAULT_STATE));
    this.interval = null;

    api.injectCSS(`
      #bc-pomodoro-panel {
        position: fixed; top: 88px; right: 16px; width: 220px;
        z-index: 2147482950; background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
        display: none; flex-direction: column; gap: 10px; padding: 14px;
        font: 12px -apple-system, sans-serif; color: #ece7fb;
      }
      #bc-pomodoro-panel.bc-open { display: flex; }
      .bc-pom-time { font-size: 28px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
      .bc-pom-phase { text-align: center; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; }
      .bc-pom-row { display: flex; gap: 6px; }
      .bc-pom-row button {
        flex: 1; padding: 7px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
        background: transparent; color: #ece7fb; cursor: pointer; font: inherit;
      }
      .bc-pom-row button:hover { background: rgba(139,92,246,0.25); }
      .bc-pom-row button.bc-pom-primary { background: #8b5cf6; border-color: #8b5cf6; }
      .bc-pom-lengths { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
      .bc-pom-lengths input {
        width: 44px; background: #14101f; border: 1px solid #3a2e5c; color: #ece7fb;
        border-radius: 6px; padding: 4px 6px; font: inherit;
      }
    `);

    this._dockBtn = api.mountToolbarButton({ icon: TIMER_ICON, label: "Pomodoro Timer", onClick: () => this.toggle() });

    const panel = document.createElement("div");
    panel.id = "bc-pomodoro-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this.render();
    if (this.state.running) this._startInterval();
    this._updateDockLabel();
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
  },

  persist() {
    this.api.setSetting("state", this.state);
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";

    const time = document.createElement("div");
    time.className = "bc-pom-time";
    time.textContent = fmt(this.state.remainingSeconds);
    panel.appendChild(time);
    this._timeEl = time;

    const phase = document.createElement("div");
    phase.className = "bc-pom-phase";
    phase.textContent = this.state.onBreak ? "Break" : "Focus";
    panel.appendChild(phase);
    this._phaseEl = phase;

    const row = document.createElement("div");
    row.className = "bc-pom-row";
    const startBtn = document.createElement("button");
    startBtn.className = "bc-pom-primary";
    startBtn.textContent = this.state.running ? "Pause" : "Start";
    startBtn.addEventListener("click", () => (this.state.running ? this.pause() : this.start()));
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => this.reset());
    row.appendChild(startBtn);
    row.appendChild(resetBtn);
    panel.appendChild(row);

    const lengths = document.createElement("div");
    lengths.className = "bc-pom-lengths";
    const workInput = document.createElement("input");
    workInput.type = "number";
    workInput.min = "1";
    workInput.max = "90";
    workInput.value = this.state.workMinutes;
    workInput.title = "Focus minutes";
    workInput.addEventListener("change", () => {
      this.state.workMinutes = Math.max(1, Math.min(90, Number(workInput.value) || 25));
      if (!this.state.running && !this.state.onBreak) this.state.remainingSeconds = this.state.workMinutes * 60;
      this.persist();
      this.render();
    });
    const breakInput = document.createElement("input");
    breakInput.type = "number";
    breakInput.min = "1";
    breakInput.max = "60";
    breakInput.value = this.state.breakMinutes;
    breakInput.title = "Break minutes";
    breakInput.addEventListener("change", () => {
      this.state.breakMinutes = Math.max(1, Math.min(60, Number(breakInput.value) || 5));
      if (!this.state.running && this.state.onBreak) this.state.remainingSeconds = this.state.breakMinutes * 60;
      this.persist();
      this.render();
    });
    lengths.appendChild(document.createTextNode("Focus"));
    lengths.appendChild(workInput);
    lengths.appendChild(document.createTextNode("Break"));
    lengths.appendChild(breakInput);
    panel.appendChild(lengths);
  },

  start() {
    this.state.running = true;
    this.persist();
    this._startInterval();
    this.render();
  },

  pause() {
    this.state.running = false;
    this.persist();
    this._stopInterval();
    this.render();
  },

  reset() {
    this.state.running = false;
    this.state.onBreak = false;
    this.state.remainingSeconds = this.state.workMinutes * 60;
    this.persist();
    this._stopInterval();
    this.render();
    this._updateDockLabel();
  },

  _startInterval() {
    this._stopInterval();
    this.interval = setInterval(() => this._tick(), 1000);
  },

  _stopInterval() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  },

  _tick() {
    this.state.remainingSeconds -= 1;
    if (this.state.remainingSeconds <= 0) {
      this.state.onBreak = !this.state.onBreak;
      this.state.remainingSeconds = (this.state.onBreak ? this.state.breakMinutes : this.state.workMinutes) * 60;
      this.api.notify(this.state.onBreak ? "Break time!" : "Back to focus!");
    }
    this.persist();
    if (this._timeEl) this._timeEl.textContent = fmt(this.state.remainingSeconds);
    if (this._phaseEl) this._phaseEl.textContent = this.state.onBreak ? "Break" : "Focus";
    this._updateDockLabel();
  },

  _updateDockLabel() {
    if (!this._dockBtn) return;
    this._dockBtn.el.title = this.state.running
      ? `${this.state.onBreak ? "Break" : "Focus"}: ${fmt(this.state.remainingSeconds)}`
      : "Pomodoro Timer";
  },

  onUnload() {
    this._stopInterval();
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

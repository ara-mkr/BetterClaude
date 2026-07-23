/**
 * Usage Analytics Dashboard overlay — DOM-only, no Node/Electron APIs.
 * Historical charts (tokens/day, messages/day, estimated cost/day,
 * most-used skills/plugins, busiest projects) built entirely from usage
 * events logged locally as they happen — see electron/analytics-db.js (a
 * WASM SQLite store via sql.js, under userData/analytics.sqlite). No
 * external analytics service is ever involved. Mirrors
 * core/skill-marketplace.js's full-screen overlay mount/open/close/toggle
 * pattern.
 *
 * host:
 *   host.queryAnalytics({from, to}) -> Promise<{tokensByDay, messagesByDay, costByDay, topPlugins, topProjects, totals}>
 *   host.exportCsv({from, to}) -> Promise<path|null>
 *   host.savePng(dataUrl, suggestedName) -> Promise<path|null>
 *   host.clearAnalytics() -> Promise
 *   host.notify(message)
 */

const { renderLineChart, renderBarChart } = require("./analytics-charts");

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function presetRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: isoDay(from), to: isoDay(to) };
}

class AnalyticsDashboard {
  constructor(host) {
    this.host = host;
    this.el = null;
    this.range = presetRange(30);
    this.data = null;
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-analytics-overlay";
    overlay.innerHTML = `
      <div class="bc-an-box">
        <div class="bc-an-header">
          <strong>Usage Analytics</strong>
          <button type="button" class="bc-dv-close" data-bc-an-close title="Close">✕</button>
        </div>
        <div class="bc-an-controls">
          <div class="bc-an-presets" data-bc-an-presets>
            <button type="button" data-range="7">7d</button>
            <button type="button" data-range="30">30d</button>
            <button type="button" data-range="90">90d</button>
            <button type="button" data-range="3650">All</button>
          </div>
          <label class="bc-an-date-label">From <input type="date" data-bc-an-from></label>
          <label class="bc-an-date-label">To <input type="date" data-bc-an-to></label>
          <span class="bc-an-spacer"></span>
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-an-export-csv>Export CSV</button>
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-an-clear>Clear all data</button>
        </div>
        <div class="bc-an-body" data-bc-an-body>
          <div class="bc-an-totals" data-bc-an-totals></div>
          <div class="bc-an-chart-block">
            <div class="bc-an-chart-title"><span>Tokens / day</span><button type="button" class="bc-an-png" data-bc-an-png="tokens">PNG</button></div>
            <canvas data-bc-an-canvas="tokens"></canvas>
          </div>
          <div class="bc-an-chart-block">
            <div class="bc-an-chart-title"><span>Messages / day</span><button type="button" class="bc-an-png" data-bc-an-png="messages">PNG</button></div>
            <canvas data-bc-an-canvas="messages"></canvas>
          </div>
          <div class="bc-an-chart-block">
            <div class="bc-an-chart-title"><span>Estimated cost / day (USD)</span><button type="button" class="bc-an-png" data-bc-an-png="cost">PNG</button></div>
            <canvas data-bc-an-canvas="cost"></canvas>
          </div>
          <div class="bc-an-chart-block">
            <div class="bc-an-chart-title"><span>Most-used skills/plugins</span><button type="button" class="bc-an-png" data-bc-an-png="plugins">PNG</button></div>
            <canvas data-bc-an-canvas="plugins"></canvas>
          </div>
          <div class="bc-an-chart-block bc-an-chart-wide">
            <div class="bc-an-chart-title"><span>Busiest projects (by messages)</span><button type="button" class="bc-an-png" data-bc-an-png="projects">PNG</button></div>
            <canvas data-bc-an-canvas="projects"></canvas>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector("[data-bc-an-close]").addEventListener("click", () => this.close());
    overlay.querySelectorAll("[data-bc-an-presets] button").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.range = presetRange(Number(btn.dataset.range));
        this._syncInputs();
        this._refresh();
      });
    });
    overlay.querySelector("[data-bc-an-export-csv]").addEventListener("click", async () => {
      const path = await this.host.exportCsv(this.range);
      if (path && this.host.notify) this.host.notify(`Exported to ${path}`);
    });
    overlay.querySelector("[data-bc-an-clear]").addEventListener("click", async () => {
      await this.host.clearAnalytics();
      this._refresh();
    });
    overlay.querySelectorAll("[data-bc-an-png]").forEach((btn) => {
      btn.addEventListener("click", () => this._exportPng(btn.dataset.bcAnPng));
    });

    return overlay;
  }

  _syncInputs() {
    this.el.querySelector("[data-bc-an-from]").value = this.range.from;
    this.el.querySelector("[data-bc-an-to]").value = this.range.to;
  }

  open() {
    if (!this.el) this.mount();
    this._syncInputs();
    this.el.classList.add("bc-open");

    const fromInput = this.el.querySelector("[data-bc-an-from]");
    const toInput = this.el.querySelector("[data-bc-an-to]");
    fromInput.onchange = () => { this.range = { ...this.range, from: fromInput.value }; this._refresh(); };
    toInput.onchange = () => { this.range = { ...this.range, to: toInput.value }; this._refresh(); };

    this._refresh();
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  async _refresh() {
    const body = this.el.querySelector("[data-bc-an-body]");
    body.classList.add("bc-an-loading");
    try {
      this.data = await this.host.queryAnalytics(this.range);
    } catch (err) {
      if (this.host.notify) this.host.notify(`Couldn't load analytics: ${err.message}`);
      this.data = null;
    }
    body.classList.remove("bc-an-loading");
    this._render();
  }

  _render() {
    const totalsEl = this.el.querySelector("[data-bc-an-totals]");
    totalsEl.innerHTML = "";
    if (!this.data) {
      totalsEl.textContent = "No data yet — usage is logged as you use claude.ai with BetterClaude running (Settings → Usage Analytics).";
      return;
    }
    const { totals } = this.data;
    [
      ["Messages", totals.messages.toLocaleString()],
      ["Tokens", totals.tokens.toLocaleString()],
      ["Estimated cost", `$${(totals.costUsd || 0).toFixed(2)}`],
    ].forEach(([label, value]) => {
      const tile = document.createElement("div");
      tile.className = "bc-an-tile";
      const valueEl = document.createElement("div");
      valueEl.className = "bc-an-tile-value";
      valueEl.textContent = value;
      const labelEl = document.createElement("div");
      labelEl.className = "bc-an-tile-label";
      labelEl.textContent = label;
      tile.appendChild(valueEl);
      tile.appendChild(labelEl);
      totalsEl.appendChild(tile);
    });

    renderLineChart(this.el.querySelector('[data-bc-an-canvas="tokens"]'), {
      labels: this.data.tokensByDay.map((r) => r.day.slice(5)),
      series: this.data.tokensByDay.map((r) => r.tokens || 0),
    }, { color: "#8b5cf6" });

    renderLineChart(this.el.querySelector('[data-bc-an-canvas="messages"]'), {
      labels: this.data.messagesByDay.map((r) => r.day.slice(5)),
      series: this.data.messagesByDay.map((r) => r.messages || 0),
    }, { color: "#22c55e" });

    renderLineChart(this.el.querySelector('[data-bc-an-canvas="cost"]'), {
      labels: this.data.costByDay.map((r) => r.day.slice(5)),
      series: this.data.costByDay.map((r) => Number((r.costUsd || 0).toFixed(4))),
    }, { color: "#f59e0b" });

    renderBarChart(this.el.querySelector('[data-bc-an-canvas="plugins"]'), {
      labels: this.data.topPlugins.map((r) => r.pluginId),
      values: this.data.topPlugins.map((r) => r.count || 0),
    });

    renderBarChart(this.el.querySelector('[data-bc-an-canvas="projects"]'), {
      labels: this.data.topProjects.map((r) => r.project || "Untitled"),
      values: this.data.topProjects.map((r) => r.messages || 0),
    }, { width: 900 });
  }

  _exportPng(key) {
    const canvas = this.el.querySelector(`[data-bc-an-canvas="${key}"]`);
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    Promise.resolve(this.host.savePng(dataUrl, `betterclaude-${key}-${this.range.from}_${this.range.to}.png`)).then((path) => {
      if (path && this.host.notify) this.host.notify(`Saved to ${path}`);
    });
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { AnalyticsDashboard, presetRange };

/**
 * World Clock — a small popover with the local time plus a couple of other
 * time zones, using Intl.DateTimeFormat (no external time-zone data needed).
 */
const CLOCK_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;

const DEFAULT_ZONES = [
  { label: "Local", tz: null },
  { label: "UTC", tz: "UTC" },
];

module.exports = {
  name: "World Clock",
  version: "1.0.0",

  onLoad(api) {
    this.api = api;
    this.format24h = api.registerSetting("format24h", true);
    this.zones = api.registerSetting("zones", DEFAULT_ZONES);

    api.injectCSS(`
      #bc-clock-panel {
        position: fixed; top: 88px; right: 16px; width: 220px;
        z-index: 2147482950; background: rgba(20,16,31,0.98);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 10px;
        display: none; flex-direction: column; gap: 8px; padding: 14px;
        font: 12px -apple-system, sans-serif; color: #ece7fb;
      }
      #bc-clock-panel.bc-open { display: flex; }
      .bc-clock-row { display: flex; justify-content: space-between; align-items: baseline; }
      .bc-clock-zone { opacity: 0.65; }
      .bc-clock-time { font-variant-numeric: tabular-nums; font-size: 15px; font-weight: 600; }
      .bc-clock-toggle {
        margin-top: 4px; padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
        background: transparent; color: #ece7fb; cursor: pointer; font: inherit;
      }
      .bc-clock-toggle:hover { background: rgba(139,92,246,0.25); }
    `);

    this._dockBtn = api.mountToolbarButton({ icon: CLOCK_ICON, label: "World Clock", onClick: () => this.toggle() });

    const panel = document.createElement("div");
    panel.id = "bc-clock-panel";
    document.body.appendChild(panel);
    this._panel = panel;

    this.render();
    this._interval = setInterval(() => this._tick(), 1000);
  },

  toggle() {
    const open = this._panel.classList.toggle("bc-open");
    if (this._dockBtn) this._dockBtn.setActive(open);
  },

  _formatTime(tz) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: !this.format24h,
        timeZone: tz || undefined,
      }).format(new Date());
    } catch (_e) {
      return "--:--:--";
    }
  },

  render() {
    const panel = this._panel;
    panel.innerHTML = "";
    this.zones.forEach((zone) => {
      const row = document.createElement("div");
      row.className = "bc-clock-row";
      const label = document.createElement("span");
      label.className = "bc-clock-zone";
      label.textContent = zone.label;
      const time = document.createElement("span");
      time.className = "bc-clock-time";
      time.textContent = this._formatTime(zone.tz);
      row.appendChild(label);
      row.appendChild(time);
      panel.appendChild(row);
    });

    const toggle = document.createElement("button");
    toggle.className = "bc-clock-toggle";
    toggle.textContent = this.format24h ? "Switch to 12-hour" : "Switch to 24-hour";
    toggle.addEventListener("click", () => {
      this.format24h = !this.format24h;
      this.api.setSetting("format24h", this.format24h);
      this.render();
    });
    panel.appendChild(toggle);
  },

  _tick() {
    if (this._panel.classList.contains("bc-open")) this.render();
  },

  onUnload() {
    if (this._interval) clearInterval(this._interval);
    if (this._dockBtn) this._dockBtn.remove();
    if (this._panel) this._panel.remove();
  },
};

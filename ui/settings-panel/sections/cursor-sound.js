/**
 * Settings panel sections: Cursor & Interaction, Sound & Haptics.
 * Exported as a plain object of methods, mixed onto SettingsPanel.prototype
 * by ui/settings-panel/panel.js (Object.assign), so `this` below is the
 * SettingsPanel instance — same as every _render* method already in
 * panel.js.
 */

const { el, field, rangeField, selectField, toggleField } = require("../dom-helpers");

const CURSOR_STYLE_OPTIONS = [
  { value: "default", label: "System default" },
  { value: "dot", label: "Dot" },
  { value: "crosshair", label: "Crosshair" },
];
const TRAIL_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "sparkles", label: "Sparkles" },
  { value: "particles", label: "Particles" },
  { value: "comet", label: "Comet" },
];
const SOUND_PACK_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "8bit", label: "Retro 8-bit" },
  { value: "minimal", label: "Minimal clicks" },
  { value: "soft", label: "ASMR-soft" },
];
const AMBIENT_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "rain", label: "Rain" },
  { value: "cafe", label: "Cafe" },
  { value: "lofi", label: "Lo-fi" },
];

module.exports = {
  _renderCursor() {
    const { settings } = this;
    const cursor = settings.cursor;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Cursor & Interaction" }));

    wrap.appendChild(selectField("Cursor style", CURSOR_STYLE_OPTIONS, cursor.style, (v) => this._set("cursor.style", v)));
    wrap.appendChild(selectField("Trail effect", TRAIL_OPTIONS, cursor.trail, (v) => this._set("cursor.trail", v)));
    if (cursor.trail !== "off") {
      wrap.appendChild(rangeField("Trail density", {
        min: 0.2, max: 1, step: 0.05, value: cursor.trailDensity,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => this._set("cursor.trailDensity", v),
      }));
    }
    wrap.appendChild(toggleField("Click ripple", cursor.ripple, (v) => this._set("cursor.ripple", v)));
    wrap.appendChild(toggleField("Magnetic buttons (BetterClaude's own controls only)", cursor.magnetic, (v) => {
      this._set("cursor.magnetic", v);
      this.renderSection();
    }));
    if (cursor.magnetic) {
      wrap.appendChild(rangeField("Magnetic strength", {
        min: 0, max: 0.8, step: 0.05, value: cursor.magneticStrength,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (v) => this._set("cursor.magneticStrength", v),
      }));
    }
    wrap.appendChild(toggleField("Right-click radial quick-action menu", cursor.radialMenu, (v) => this._set("cursor.radialMenu", v)));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Drag icons in the plugin dock (top-right) to reorder them — the order is remembered.",
    }));

    this.contentEl.appendChild(wrap);
  },

  _renderSound() {
    const { settings } = this;
    const sound = settings.sound;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Sound & Haptics" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Every sound here is synthesized on the fly (Web Audio) — there are no shipped audio files.",
    }));

    wrap.appendChild(toggleField("Mute all sound", sound.muted, (v) => this._set("sound.muted", v)));

    const packRow = el("div", { class: "bc-theme-toolbar" });
    const packSelectField = selectField("Sound pack", SOUND_PACK_OPTIONS, sound.pack, (v) => {
      this._set("sound.pack", v);
      this.renderSection();
    });
    wrap.appendChild(packSelectField);
    if (sound.pack !== "off") {
      const testBtn = el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Test",
        onclick: () => this.host.playSoundPreview("notification"),
      });
      packRow.appendChild(testBtn);
      wrap.appendChild(packRow);
    }

    wrap.appendChild(rangeField("Volume", {
      min: 0, max: 1, step: 0.05, value: sound.volume,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this._set("sound.volume", v),
    }));

    wrap.appendChild(el("h2", { text: "Per-sound toggles", class: "bc-ae-subhead" }));
    ["click", "hover", "notification", "achievement"].forEach((type) => {
      wrap.appendChild(toggleField(type[0].toUpperCase() + type.slice(1), sound.perType[type], (v) => this._set(`sound.perType.${type}`, v)));
    });

    wrap.appendChild(el("h2", { text: "Ambient soundscape", class: "bc-ae-subhead" }));
    wrap.appendChild(selectField("Track", AMBIENT_OPTIONS, sound.ambient.track, (v) => this._set("sound.ambient.track", v)));
    wrap.appendChild(rangeField("Ambient volume", {
      min: 0, max: 1, step: 0.05, value: sound.ambient.volume,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this._set("sound.ambient.volume", v),
    }));

    wrap.appendChild(el("h2", { text: "Haptics", class: "bc-ae-subhead" }));
    wrap.appendChild(rangeField("Haptic intensity", {
      min: 0, max: 1, step: 0.05, value: sound.hapticsIntensity,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => this._set("sound.hapticsIntensity", v),
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Desktop hardware has no rumble motor, so this drives a small visual pulse instead of real haptics.",
    }));

    this.contentEl.appendChild(wrap);
  },
};

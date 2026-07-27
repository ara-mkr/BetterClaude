/**
 * Settings panel sections: Focus & Reading, Command Palette (part of Input
 * & Shortcuts). Mixed onto SettingsPanel.prototype by panel.js.
 */

const { el, field, rangeField, selectField, toggleField, textField } = require("../dom-helpers");
const { THEME_LABELS } = require("../theme-labels");

// Custom commands are bounded to "set setting X to value Y" — never
// arbitrary code — so the builder only offers a curated, known-safe list of
// targets rather than a free-text keyPath.
const COMMAND_TARGETS = [
  { path: "focusReading.zenMode", label: "Zen Mode", type: "boolean" },
  { path: "focusReading.readingMode", label: "Reading Mode", type: "boolean" },
  { path: "sound.muted", label: "Mute Sound", type: "boolean" },
  { path: "appearance.activeTheme", label: "Theme", type: "theme" },
  { path: "personality.mood", label: "Mood", type: "mood" },
  { path: "appearanceEditor.shape", label: "Corner shape", type: "shape" },
];
const MOOD_VALUES = ["energetic", "calm", "focused", "playful"];
const SHAPE_VALUES = ["sharp", "soft", "rounded", "pill"];

module.exports = {
  _renderFocusReading() {
    const { settings } = this;
    const fr = settings.focusReading;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Focus & Reading" }));

    wrap.appendChild(toggleField("Zen Mode", fr.zenMode, (v) => this._set("focusReading.zenMode", v)));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Zen Mode builds on the existing Focus Mode plugin (hides the sidebar/chrome) and additionally hides the companion and plugin dock — so only the conversation is visible.",
    }));

    wrap.appendChild(toggleField("Reading Mode", fr.readingMode, (v) => {
      this._set("focusReading.readingMode", v);
      this.renderSection();
    }));
    if (fr.readingMode) {
      wrap.appendChild(rangeField("Reading width", {
        min: 480, max: 1000, step: 10, value: fr.readingWidthPx,
        format: (v) => `${v}px`,
        onInput: (v) => this._set("focusReading.readingWidthPx", v),
      }));
      wrap.appendChild(textField("Reading font override", fr.readingFont, (v) => this._set("focusReading.readingFont", v), {
        placeholder: "empty = use your UI font",
      }));
    }

    wrap.appendChild(el("h2", { text: "Accessibility", class: "bc-ae-subhead" }));
    wrap.appendChild(toggleField("General contrast boost", settings.appearance.contrastBoost, (v) => this._set("appearance.contrastBoost", v)));
    wrap.appendChild(toggleField("Color-blind-safe palette (Okabe-Ito substitution)", settings.appearance.colorBlindSafe, (v) => this._set("appearance.colorBlindSafe", v)));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "One universal substitution rather than three separate deuteranopia/protanopia/tritanopia simulations — the Okabe-Ito palette was designed to already read safely for all three.",
    }));

    this.contentEl.appendChild(wrap);
  },

  _renderCommandPalette() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Command Palette" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Cmd/Ctrl+K opens the palette anywhere, fuzzy-searching everything at once: app actions, every settings "
        + "page, plugins, prompt library entries, and installed + cached marketplace skills. Custom commands below "
        + "are bounded to “set setting X to value Y” — never arbitrary code.",
    }));

    const list = el("div", { class: "bc-plugin-list" });
    (settings.commandPalette.customCommands || []).forEach((cmd) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: cmd.label }),
        el("span", { class: "bc-plugin-version", text: `${cmd.settingPath} → ${JSON.stringify(cmd.value)}` }),
      ]));
      const del = el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: () => {
          const next = settings.commandPalette.customCommands.filter((c) => c.id !== cmd.id);
          this._set("commandPalette.customCommands", next);
          this.renderSection();
        },
      });
      row.appendChild(del);
      list.appendChild(row);
    });
    if ((settings.commandPalette.customCommands || []).length === 0) {
      list.appendChild(el("p", { class: "bc-hint", text: "No custom commands yet." }));
    }
    wrap.appendChild(list);

    wrap.appendChild(el("h2", { text: "Add a command", class: "bc-ae-subhead" }));
    const targetSelect = el("select", {}, COMMAND_TARGETS.map((t) => el("option", { value: t.path, text: t.label })));
    wrap.appendChild(field("Setting", targetSelect));

    const valueContainer = el("div");
    wrap.appendChild(valueContainer);

    const labelInput = el("input", { type: "text", placeholder: 'Command name (e.g. "Chill Mode")' });
    wrap.appendChild(field("Label", labelInput));

    const renderValueControl = () => {
      valueContainer.innerHTML = "";
      const target = COMMAND_TARGETS.find((t) => t.path === targetSelect.value);
      let valueSelect;
      if (target.type === "boolean") {
        valueSelect = el("select", {}, [el("option", { value: "true", text: "On" }), el("option", { value: "false", text: "Off" })]);
      } else if (target.type === "theme") {
        // Konami-unlocked bonus theme stays hidden here too, same gating
        // as the Themes tab grid (panel.js _renderThemes).
        const konamiUnlocked = !!(this.settings.personality && this.settings.personality.easterEggs && this.settings.personality.easterEggs.konamiUnlocked);
        const themeIds = this.host.listThemeIds().filter((id) => id !== "secret-rainbow" || konamiUnlocked);
        valueSelect = el("select", {}, themeIds.map((id) => el("option", { value: id, text: THEME_LABELS[id] || id })));
      } else if (target.type === "mood") {
        valueSelect = el("select", {}, MOOD_VALUES.map((m) => el("option", { value: m, text: m })));
      } else {
        valueSelect = el("select", {}, SHAPE_VALUES.map((s) => el("option", { value: s, text: s })));
      }
      valueContainer.appendChild(field("Value", valueSelect));
      valueContainer._select = valueSelect;
    };
    targetSelect.addEventListener("change", renderValueControl);
    renderValueControl();

    const addBtn = el("button", {
      class: "bc-btn",
      text: "Add command",
      onclick: () => {
        const target = COMMAND_TARGETS.find((t) => t.path === targetSelect.value);
        const rawValue = valueContainer._select.value;
        const value = target.type === "boolean" ? rawValue === "true" : rawValue;
        const label = labelInput.value.trim() || `${target.label}: ${rawValue}`;
        const next = [
          ...(settings.commandPalette.customCommands || []),
          { id: `cmd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, settingPath: target.path, value },
        ];
        this._set("commandPalette.customCommands", next);
        labelInput.value = "";
        this.renderSection();
      },
    });
    wrap.appendChild(addBtn);

    this.contentEl.appendChild(wrap);
  },
};

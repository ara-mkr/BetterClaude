/**
 * Settings panel sections: Profiles (also backs "Time Capsule") and
 * Automations. Mixed onto SettingsPanel.prototype by panel.js.
 */

const { el, field, toggleField } = require("../dom-helpers");
const { THEME_LABELS } = require("../theme-labels");

module.exports = {
  _renderProfiles() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Profiles" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Save your whole current setup under a name and swap to it in one click. Also doubles as a “time capsule” — snapshot before a big change, restore it later.",
    }));

    const saveRow = el("div", { class: "bc-theme-import-row" });
    const nameInput = el("input", { type: "text", placeholder: "Profile name (e.g. Work, Gaming, Chill)" });
    const saveBtn = el("button", {
      class: "bc-btn",
      text: "Save current setup",
      onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        await this.host.saveProfile(name);
        nameInput.value = "";
        this.settings = this.host.getSettings();
        this.renderSection();
      },
    });
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);

    const list = el("div", { class: "bc-plugin-list" });
    const profiles = settings.profiles.list || [];
    profiles.forEach((p) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: p.name }),
        el("span", { class: "bc-plugin-version", text: new Date(p.createdAt).toLocaleString() }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      const applyBtn = el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Apply",
        onclick: async () => {
          await this.host.applyProfile(p.id);
          this.settings = this.host.getSettings();
          this.renderSection();
        },
      });
      const delBtn = el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: () => {
          const next = profiles.filter((x) => x.id !== p.id);
          this._set("profiles.list", next);
          this.renderSection();
        },
      });
      actions.appendChild(applyBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      list.appendChild(row);
    });
    if (profiles.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No saved profiles yet." }));
    wrap.appendChild(list);

    wrap.appendChild(el("h2", { text: "A/B compare", class: "bc-ae-subhead" }));
    if (profiles.length < 2) {
      wrap.appendChild(el("p", { class: "bc-hint", text: "Save at least two profiles to compare them side by side." }));
    } else {
      const selectA = el("select", {}, profiles.map((p) => el("option", { value: p.id, text: p.name })));
      const selectB = el("select", {}, profiles.map((p) => el("option", { value: p.id, text: p.name })));
      selectB.selectedIndex = Math.min(1, profiles.length - 1);
      const compareOut = el("div", { class: "bc-compare-grid" });

      const rows = [
        ["Theme", (s) => (s.appearance && THEME_LABELS[s.appearance.activeTheme]) || (s.appearance && s.appearance.activeTheme)],
        ["Corner shape", (s) => s.appearanceEditor && s.appearanceEditor.shape],
        ["Cursor style", (s) => s.cursor && s.cursor.style],
        ["Sound pack", (s) => s.sound && s.sound.pack],
        ["Motion transition", (s) => s.motion && s.motion.transition],
        ["Mood", (s) => (s.personality && s.personality.mood) || "—"],
      ];
      const compare = () => {
        const a = profiles.find((p) => p.id === selectA.value);
        const b = profiles.find((p) => p.id === selectB.value);
        compareOut.innerHTML = "";
        if (!a || !b) return;
        const table = el("table", { class: "bc-compare-table" });
        table.appendChild(el("tr", {}, [el("th", { text: "" }), el("th", { text: a.name }), el("th", { text: b.name })]));
        rows.forEach(([label, getter]) => {
          const va = getter(a.snapshot) || "—";
          const vb = getter(b.snapshot) || "—";
          const diffClass = va !== vb ? "bc-compare-diff" : "";
          table.appendChild(el("tr", {}, [
            el("td", { text: label }),
            el("td", { text: String(va), class: diffClass }),
            el("td", { text: String(vb), class: diffClass }),
          ]));
        });
        compareOut.appendChild(table);
      };
      wrap.appendChild(field("Profile A", selectA));
      wrap.appendChild(field("Profile B", selectB));
      wrap.appendChild(el("button", { class: "bc-btn bc-btn-secondary", text: "Compare", onclick: compare }));
      wrap.appendChild(compareOut);
    }

    this.contentEl.appendChild(wrap);
  },

  _renderAutomations() {
    const { settings } = this;
    const automations = settings.automations;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Automations" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A curated, reliable set of “if X then Y” behaviors rather than a free-form rule builder — safer at this scope, and a natural place to grow later.",
    }));

    wrap.appendChild(toggleField("Zen Mode also mutes sound", automations.zenMutesSound, (v) => this._set("automations.zenMutesSound", v)));
    wrap.appendChild(toggleField("Achievements burst confetti", automations.achievementBurstsConfetti, (v) => this._set("automations.achievementBurstsConfetti", v)));
    wrap.appendChild(toggleField("Focus Mode pauses the ambient soundscape", automations.focusPausesAmbient, (v) => this._set("automations.focusPausesAmbient", v)));

    this.contentEl.appendChild(wrap);
  },
};

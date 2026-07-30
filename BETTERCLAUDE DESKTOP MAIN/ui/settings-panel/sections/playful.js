/**
 * Settings panel section: Playful. Mini-game launcher, editable
 * loading-screen tips, and weather-based theming. Mixed onto
 * SettingsPanel.prototype by panel.js.
 */

const { el, field, toggleField } = require("../dom-helpers");

module.exports = {
  _renderPlayful() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Playful" }));

    // Snake is deliberately NOT playable from inside this panel any more.
    // Settings is where you configure things; the game belongs where the
    // waiting actually is — floating over the conversation while Claude is
    // generating. This section only owns the on/off switch for that.
    const playful = settings.playful || {};
    wrap.appendChild(toggleField(
      "Play Snake while Claude is working",
      playful.snakeWhileWaiting === true,
      (v) => this._set("playful.snakeWhileWaiting", v),
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A small Snake board pops up in the corner whenever Claude is generating a response, and disappears on its own once the answer lands. Its ✕ dismisses that one wait — it comes back the next time Claude is thinking.",
    }));

    wrap.appendChild(el("h2", { text: "Loading-screen tips", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Shown while claude.ai's page loads, mixed with the built-in tips — some real, some joke, all editable.",
    }));

    const tips = settings.personality.customLoadingTips || { real: [], joke: [] };
    const renderTipList = (kind) => {
      const listWrap = el("div", { class: "bc-plugin-list" });
      (tips[kind] || []).forEach((text, i) => {
        const row = el("div", { class: "bc-plugin-row" });
        row.appendChild(el("div", { class: "bc-plugin-info" }, [el("span", { text })]));
        const del = el("button", {
          class: "bc-theme-delete",
          text: "✕",
          onclick: () => {
            const next = { ...tips, [kind]: tips[kind].filter((_, idx) => idx !== i) };
            this._set("personality.customLoadingTips", next);
            this.renderSection();
          },
        });
        row.appendChild(del);
        listWrap.appendChild(row);
      });
      return listWrap;
    };

    wrap.appendChild(el("h3", { text: "Real tips" }));
    wrap.appendChild(renderTipList("real"));
    const realInput = el("input", { type: "text", placeholder: "Add a real tip…" });
    const realAdd = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "+",
      onclick: () => {
        const value = realInput.value.trim();
        if (!value) return;
        this._set("personality.customLoadingTips", { ...tips, real: [...(tips.real || []), value] });
        realInput.value = "";
        this.renderSection();
      },
    });
    wrap.appendChild(el("div", { class: "bc-theme-import-row" }, [realInput, realAdd]));

    wrap.appendChild(el("h3", { text: "Joke tips" }));
    wrap.appendChild(renderTipList("joke"));
    const jokeInput = el("input", { type: "text", placeholder: "Add a joke tip…" });
    const jokeAdd = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "+",
      onclick: () => {
        const value = jokeInput.value.trim();
        if (!value) return;
        this._set("personality.customLoadingTips", { ...tips, joke: [...(tips.joke || []), value] });
        jokeInput.value = "";
        this.renderSection();
      },
    });
    wrap.appendChild(el("div", { class: "bc-theme-import-row" }, [jokeInput, jokeAdd]));

    wrap.appendChild(el("h2", { text: "Weather-based theme", class: "bc-ae-subhead" }));
    const wt = settings.appearance.weatherTheme;
    wrap.appendChild(toggleField("Enable", wt.enabled, (v) => this._set("appearance.weatherTheme.enabled", v)));

    const latInput = el("input", { type: "number", step: "0.0001", value: wt.lat != null ? wt.lat : "", placeholder: "latitude" });
    latInput.addEventListener("change", () => this._set("appearance.weatherTheme.lat", latInput.value ? Number(latInput.value) : null));
    wrap.appendChild(field("Latitude", latInput));

    const lonInput = el("input", { type: "number", step: "0.0001", value: wt.lon != null ? wt.lon : "", placeholder: "longitude" });
    lonInput.addEventListener("change", () => this._set("appearance.weatherTheme.lon", lonInput.value ? Number(lonInput.value) : null));
    wrap.appendChild(field("Longitude", lonInput));

    const actionRow = el("div", { class: "bc-theme-toolbar" });
    actionRow.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Use current location",
      onclick: () => {
        if (!navigator.geolocation) {
          this.host.notify("Geolocation isn't available.");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            latInput.value = pos.coords.latitude.toFixed(4);
            lonInput.value = pos.coords.longitude.toFixed(4);
            this._set("appearance.weatherTheme.lat", pos.coords.latitude);
            this._set("appearance.weatherTheme.lon", pos.coords.longitude);
          },
          () => this.host.notify("Couldn't get your location."),
        );
      },
    }));
    actionRow.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Apply now",
      onclick: async () => {
        const ok = await this.host.applyWeatherTheme();
        this.host.notify(ok ? "Applied a weather-matched theme." : "Couldn't fetch weather — check coordinates.");
      },
    }));
    wrap.appendChild(actionRow);

    this.contentEl.appendChild(wrap);
  },
};

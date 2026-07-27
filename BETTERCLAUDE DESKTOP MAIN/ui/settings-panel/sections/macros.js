/**
 * Settings -> Macros. Recording captures a sequence of sends (Prompt
 * Library entries re-resolvable at replay time, or arbitrary typed text —
 * see core/macro-recorder.js's capture hook in electron/preload.js).
 * Replay drives real multi-turn conversation: insert, send, wait for the
 * assistant's response to actually finish, then the next step.
 */

const { el, toggleField, textField } = require("../dom-helpers");

function stepLabel(step) {
  if (step.type === "prompt") return `[Prompt] ${step.promptId}`;
  return step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text;
}

module.exports = {
  _renderMacros() {
    const { settings } = this;
    const macros = settings.macros;
    if (this._macroEditingId === undefined) this._macroEditingId = null;

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Macros" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Record a sequence of sends and replay them one click at a time — replay waits for each real assistant "
        + "response before sending the next step, so it drives an actual multi-turn conversation.",
    }));

    wrap.appendChild(toggleField("Enable Macros", macros.enabled, (v) => this._set("macros.enabled", v)));

    const recording = this.host.isRecordingMacro();
    const recRow = el("div", { class: "bc-theme-toolbar" });
    if (recording) {
      recRow.appendChild(el("button", {
        class: "bc-btn",
        text: "■ Stop Recording",
        onclick: () => { this.host.stopRecordingMacro(); this.renderSection(); },
      }));
    } else {
      const nameInput = el("input", { type: "text", placeholder: "Macro name (optional)" });
      recRow.appendChild(nameInput);
      recRow.appendChild(el("button", {
        class: "bc-btn",
        text: "⏺ Start Recording",
        onclick: () => { this.host.startRecordingMacro(nameInput.value.trim() || undefined); this.renderSection(); },
      }));
    }
    wrap.appendChild(recRow);
    if (recording) {
      wrap.appendChild(el("p", { class: "bc-hint", text: "Recording — every message you send in claude.ai right now is being captured as a step." }));
    }

    wrap.appendChild(el("h2", { text: "Saved macros", class: "bc-ae-subhead" }));
    const list = el("div", { class: "bc-plugin-list" });
    if (macros.list.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No macros yet — start recording to create one." }));
    macros.list.forEach((macro) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: macro.name }),
        el("span", { class: "bc-plugin-version", text: `${macro.steps.length} step${macro.steps.length === 1 ? "" : "s"}${macro.shortcut ? ` · ${macro.shortcut}` : ""}` }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(el("button", {
        class: "bc-theme-star", text: "Replay",
        onclick: () => this.host.replayMacro(macro.id),
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-star", text: "Edit",
        onclick: () => { this._macroEditingId = this._macroEditingId === macro.id ? null : macro.id; this.renderSection(); },
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete", text: "✕",
        onclick: () => { this.host.deleteMacro(macro.id); this.renderSection(); },
      }));
      row.appendChild(actions);
      list.appendChild(row);

      if (this._macroEditingId === macro.id) {
        list.appendChild(this._buildMacroEditor(macro));
      }
    });
    wrap.appendChild(list);

    if (this.host.isReplayingMacro && this.host.isReplayingMacro()) {
      wrap.appendChild(el("p", { class: "bc-hint", text: "A macro is currently replaying — use the floating \"Stop\" control, or:" }));
      wrap.appendChild(el("button", { class: "bc-btn bc-btn-secondary", text: "Stop replay", onclick: () => this.host.stopMacroReplay() }));
    }

    this.contentEl.appendChild(wrap);
  },

  _buildMacroEditor(macro) {
    const box = el("div", { class: "bc-schedule-section" });
    box.appendChild(el("h2", { text: "Edit macro", class: "bc-ae-subhead" }));

    box.appendChild(textField("Name", macro.name, (v) => this.host.renameMacro(macro.id, v.trim() || macro.name)));
    box.appendChild(textField(
      "Global shortcut",
      macro.shortcut || "",
      (v) => this.host.setMacroShortcut(macro.id, v.trim()),
      { placeholder: "e.g. CommandOrControl+Alt+1 (optional)" }
    ));
    box.appendChild(el("p", { class: "bc-hint", text: "Restart BetterClaude for a new/changed shortcut to take effect." }));

    const stepsList = el("div", { class: "bc-plugin-list" });
    macro.steps.forEach((step, i) => {
      const row = el("div", { class: "bc-plugin-row" });
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: `${i + 1}. ${step.type === "prompt" ? "Prompt" : "Text"}` }),
        el("span", { class: "bc-plugin-version", text: stepLabel(step) }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      const setSteps = (next) => this.host.updateMacroSteps(macro.id, next);
      if (i > 0) {
        actions.appendChild(el("button", {
          class: "bc-theme-star", text: "▲",
          onclick: () => { const next = [...macro.steps]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setSteps(next); this.renderSection(); },
        }));
      }
      if (i < macro.steps.length - 1) {
        actions.appendChild(el("button", {
          class: "bc-theme-star", text: "▼",
          onclick: () => { const next = [...macro.steps]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; setSteps(next); this.renderSection(); },
        }));
      }
      actions.appendChild(el("button", {
        class: "bc-theme-delete", text: "✕",
        onclick: () => { setSteps(macro.steps.filter((_, idx) => idx !== i)); this.renderSection(); },
      }));
      row.appendChild(actions);
      stepsList.appendChild(row);
    });
    box.appendChild(stepsList);

    return box;
  },
};

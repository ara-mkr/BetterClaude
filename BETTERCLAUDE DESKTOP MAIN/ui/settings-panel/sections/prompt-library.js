/**
 * Settings -> Prompt Library. Full CRUD for saved prompts (folders/tags,
 * {{variable}} placeholders, per-prompt global keyboard shortcut, JSON
 * import/export). The actual "insert into claude.ai" flow lives in the
 * core/prompt-picker.js overlay (Cmd/Ctrl+Shift+P, or Cmd+K -> "Insert
 * Prompt…") — this section only manages the library itself.
 */

const { el, field, toggleField, textField } = require("../dom-helpers");
const { extractVariables } = require("../../../core/prompt-vars");

function uid() {
  return `pr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = {
  _renderPromptLibrary() {
    const { settings } = this;
    const lib = settings.promptLibrary;
    if (this._plQuery === undefined) this._plQuery = "";
    if (this._plFolderFilter === undefined) this._plFolderFilter = "All";
    if (this._plEditingId === undefined) this._plEditingId = null;

    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Prompt Library" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Saved prompts with {{variable}} placeholders. Open the picker with "
        + `${settings.keyboardShortcuts.openPromptPicker || "Cmd/Ctrl+Shift+P"} or via Cmd+K → "Insert Prompt…". `
        + "{{clipboard}} and {{selection}} auto-fill from your clipboard / current text selection.",
    }));
    wrap.appendChild(toggleField("Enable Prompt Library", lib.enabled, (v) => this._set("promptLibrary.enabled", v)));

    const savePrompts = (next) => {
      this.settings.promptLibrary.prompts = next;
      this._set("promptLibrary.prompts", next);
    };

    // --- Toolbar: search + folder filter + new/import/export ---
    const toolbar = el("div", { class: "bc-theme-toolbar" });
    const search = el("input", { type: "text", placeholder: "Search prompts…", value: this._plQuery });
    search.addEventListener("input", () => { this._plQuery = search.value; this.renderSection(); });
    toolbar.appendChild(search);

    const folders = ["All", ...new Set(lib.prompts.map((p) => p.folder || "General"))];
    const folderSelect = el("select", {}, folders.map((f) => el("option", { value: f, text: f })));
    folderSelect.value = this._plFolderFilter;
    folderSelect.addEventListener("change", () => { this._plFolderFilter = folderSelect.value; this.renderSection(); });
    toolbar.appendChild(folderSelect);

    toolbar.appendChild(el("button", {
      class: "bc-btn",
      text: "+ New Prompt",
      onclick: () => { this._plEditingId = "__new__"; this.renderSection(); },
    }));
    toolbar.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Export JSON…",
      onclick: async () => {
        const ok = await this.host.exportPromptLibrary();
        if (ok && this.host.notify) this.host.notify("Prompt library exported.");
      },
    }));
    toolbar.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Import JSON…",
      onclick: async () => {
        const updated = await this.host.importPromptLibrary();
        if (updated) {
          this.settings = updated;
          this.renderSection();
          if (this.host.notify) this.host.notify("Prompt library imported.");
        }
      },
    }));
    wrap.appendChild(toolbar);

    // --- Inline add/edit form ---
    if (this._plEditingId) {
      const existing = this._plEditingId === "__new__" ? null : lib.prompts.find((p) => p.id === this._plEditingId);
      wrap.appendChild(this._buildPromptForm(existing, (saved) => {
        const next = existing
          ? lib.prompts.map((p) => (p.id === existing.id ? saved : p))
          : [...lib.prompts, saved];
        savePrompts(next);
        this._plEditingId = null;
        this.renderSection();
      }, () => { this._plEditingId = null; this.renderSection(); }));
    }

    // --- List ---
    const q = this._plQuery.trim().toLowerCase();
    const filtered = lib.prompts.filter((p) => {
      const matchesFolder = this._plFolderFilter === "All" || (p.folder || "General") === this._plFolderFilter;
      const matchesQuery = !q || p.title.toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q));
      return matchesFolder && matchesQuery;
    });

    const list = el("div", { class: "bc-plugin-list" });
    if (filtered.length === 0) list.appendChild(el("p", { class: "bc-hint", text: "No prompts yet." }));
    filtered.forEach((p) => {
      const row = el("div", { class: "bc-plugin-row" });
      const meta = [p.folder || "General", ...(p.tags || [])].join(" · ");
      row.appendChild(el("div", { class: "bc-plugin-info" }, [
        el("strong", { text: p.title }),
        el("span", { class: "bc-plugin-version", text: `${meta}${p.shortcut ? ` · ${p.shortcut}` : ""}` }),
      ]));
      const actions = el("div", { class: "bc-theme-card-actions" });
      actions.appendChild(el("button", {
        class: "bc-theme-star",
        text: "Edit",
        onclick: () => { this._plEditingId = p.id; this.renderSection(); },
      }));
      actions.appendChild(el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: () => {
          savePrompts(lib.prompts.filter((x) => x.id !== p.id));
          this.renderSection();
        },
      }));
      row.appendChild(actions);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    this.contentEl.appendChild(wrap);
  },

  _buildPromptForm(existing, onSave, onCancel) {
    const { settings } = this;
    const form = el("div", { class: "bc-schedule-section" });
    form.appendChild(el("h2", { text: existing ? "Edit prompt" : "New prompt", class: "bc-ae-subhead" }));

    const titleInput = el("input", { type: "text", value: existing ? existing.title : "", placeholder: "Title" });
    form.appendChild(field("Title", titleInput));

    const bodyInput = el("textarea", { rows: "5", placeholder: "Prompt text — use {{variable}}, {{clipboard}}, {{selection}}" });
    bodyInput.value = existing ? existing.body : "";
    const varsHint = el("p", { class: "bc-hint" });
    const refreshVarsHint = () => {
      const vars = extractVariables(bodyInput.value);
      varsHint.textContent = vars.length ? `Variables detected: ${vars.map((v) => `{{${v}}}`).join(", ")}` : "No {{variables}} detected.";
    };
    bodyInput.addEventListener("input", refreshVarsHint);
    refreshVarsHint();
    form.appendChild(field("Body", bodyInput));
    form.appendChild(varsHint);

    const tagsInput = el("input", { type: "text", value: existing ? (existing.tags || []).join(", ") : "", placeholder: "comma, separated, tags" });
    form.appendChild(field("Tags", tagsInput));

    const folderInput = el("input", { type: "text", value: existing ? (existing.folder || "General") : "General" });
    form.appendChild(field("Folder", folderInput));

    const otherShortcuts = new Set([
      ...Object.values(settings.keyboardShortcuts || {}),
      ...settings.promptLibrary.prompts.filter((p) => p.id !== (existing && existing.id)).map((p) => p.shortcut).filter(Boolean),
    ]);
    const shortcutInput = el("input", { type: "text", value: existing ? (existing.shortcut || "") : "", placeholder: "e.g. CommandOrControl+Shift+9 (optional)" });
    const shortcutWarn = el("p", { class: "bc-hint bc-conflict-hint", style: "display:none" });
    shortcutInput.addEventListener("input", () => {
      const dupe = shortcutInput.value.trim() && otherShortcuts.has(shortcutInput.value.trim());
      shortcutWarn.style.display = dupe ? "" : "none";
      shortcutWarn.textContent = dupe ? `"${shortcutInput.value.trim()}" is already assigned elsewhere — only one binding will fire.` : "";
    });
    form.appendChild(field("Global shortcut (optional)", shortcutInput));
    form.appendChild(shortcutWarn);
    form.appendChild(el("p", { class: "bc-hint", text: "Restart BetterClaude for a new/changed shortcut to take effect." }));

    const actions = el("div", { class: "bc-theme-toolbar" });
    actions.appendChild(el("button", { class: "bc-btn bc-btn-secondary", text: "Cancel", onclick: onCancel }));
    actions.appendChild(el("button", {
      class: "bc-btn",
      text: "Save",
      onclick: () => {
        const title = titleInput.value.trim();
        const body = bodyInput.value.trim();
        if (!title || !body) return;
        onSave({
          id: existing ? existing.id : uid(),
          title,
          body,
          tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
          folder: folderInput.value.trim() || "General",
          shortcut: shortcutInput.value.trim() || null,
          createdAt: existing ? existing.createdAt : Date.now(),
          updatedAt: Date.now(),
        });
      },
    }));
    form.appendChild(actions);

    return form;
  },
};

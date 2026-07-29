/**
 * Settings panel overlay — DOM-only aside from the `host` object it is
 * given. `host` is the Electron-specific (or future extension-specific)
 * bridge for persistence and cross-cutting actions:
 *
 *   host.getSettings() -> settings object (kept in sync locally)
 *   host.setSetting(keyPath, value) -> Promise<settings>
 *   host.onSettingsChanged(cb)
 *   host.listThemeIds() -> string[]
 *   host.getThemesData() -> { [themeId]: cssText }
 *   host.listPlugins() -> Promise<{id, name, version, enabled}[]>
 *   host.togglePlugin(id, enabled) -> Promise
 *   host.openPluginsFolder()
 *   host.mountCSSEditor(container, { initialValue, onChange }) -> { setValue, destroy }
 *   host.applyThemePreview(themeId) / host.applyCustomCSSPreview(css)
 *   host.applyAccentPreview(hex)
 *   host.refreshSkillsCache() / host.openSkillMarketplace() / host.revealSkill(id) / host.uninstallSkill(id)
 *   host.exportPromptLibrary() / host.importPromptLibrary()
 *   host.pickWatchedFile() / host.stopWatchingFile(id) / host.insertWatchedFile(id) / host.setAutoReattach(id, bool)
 *   host.getClipboardBridgeStatus() / host.onClipboardBridgeStatus(cb) / host.pushClipboardNow() / host.testClipboardBridgeConnection()
 *   host.openAnalyticsDashboard()
 *   host.syncTeamNow() / host.getTeamSyncDiff(relPath) / host.applyTeamSyncFile(relPath) / host.keepLocalTeamSyncFile(relPath) / host.openTeamSyncFolder()
 *   host.getAppInfo() -> Promise<{version, isPackaged, githubUrl, releasesUrl}>
 *   host.getUpdateStatus() / host.onUpdateStatus(cb)
 *   host.checkForUpdates() / host.downloadUpdate() / host.installUpdate() / host.openReleasesPage()
 */

const { openColorPopover } = require("./color-popover");
const { THEME_LABELS } = require("./theme-labels");
const { el, field, toggleField } = require("./dom-helpers");
const { COMPONENT_FAMILIES, contrastRatio, WCAG_AA_BODY } = require("../../core/tokens");
const { featuredBundles } = require("../../core/vibe-bundles");
const ICONS = require("../../core/icons");

const cursorSoundSection = require("./sections/cursor-sound");
const motionNotificationsSection = require("./sections/motion-notifications");
const focusInputSection = require("./sections/focus-input");
const widgetsSection = require("./sections/widgets");
const buddiesSection = require("./sections/buddies");
const powerUserSection = require("./sections/power-user");
const playfulSection = require("./sections/playful");
const skillMarketplaceSection = require("./sections/skill-marketplace");
const promptLibrarySection = require("./sections/prompt-library");
const fileWatcherSection = require("./sections/file-watcher");
const clipboardBridgeSection = require("./sections/clipboard-bridge");
const analyticsSection = require("./sections/analytics");
const teamSyncSection = require("./sections/team-sync");

const PANEL_ID = "betterclaude-settings-panel";

// The subset of --bc-* variables every theme preset defines, used both to
// render the live theme-preview mockups and to seed the Appearance
// Editor's per-element pickers with the active theme's current values.
const THEME_VARS = [
  "--bc-bg",
  "--bc-bg-elevated",
  "--bc-bg-sidebar",
  "--bc-text",
  "--bc-text-muted",
  "--bc-accent",
  "--bc-border",
  "--bc-bubble-user",
];

function parseThemeVars(cssText) {
  const out = {};
  THEME_VARS.forEach((name) => {
    const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
    const m = re.exec(cssText || "");
    if (m) out[name] = m[1].trim();
  });
  return out;
}

const APPEARANCE_EDITOR_MARK_START = "/* BC-APPEARANCE-EDITOR:START (generated, safe to leave alone or delete) */";
const APPEARANCE_EDITOR_MARK_END = "/* BC-APPEARANCE-EDITOR:END */";

const SECTIONS = [
  "Appearance",
  "Themes",
  "Appearance Editor",
  "Background",
  "Custom CSS",
  "Fonts",
  "Cursor & Interaction",
  "Sound & Haptics",
  "Layout",
  "Animation & Motion",
  "Widgets",
  "Buddies",
  "Notifications",
  "Focus & Reading",
  "Command Palette",
  "Profiles",
  "Automations",
  "Playful",
  "Usage Analytics",
  "Plugins",
  "Team Sync",
  "Skill Marketplace",
  "Prompt Library",
  "File Watcher",
  "Clipboard Bridge",
  "Keyboard Shortcuts",
];

const SHAPE_OPTIONS = [
  { value: "sharp", label: "Sharp" },
  { value: "soft", label: "Soft" },
  { value: "rounded", label: "Rounded" },
  { value: "pill", label: "Pill" },
];

class SettingsPanel {
  constructor(host) {
    this.host = host;
    this.activeSection = "Appearance";
    this.root = null;
    this.cssEditorHandle = null;
    host.onSettingsChanged((settings) => {
      this.settings = settings;
      if (this.root && this.root.classList.contains("bc-open")) this.renderSection();
    });
  }

  toggle() {
    if (!this.root) this._build();
    this.root.classList.toggle("bc-open");
    if (this.root.classList.contains("bc-open")) {
      this.settings = this.host.getSettings();
      this.renderSection();
    }
  }

  open() {
    if (!this.root) this._build();
    this.settings = this.host.getSettings();
    this.root.classList.add("bc-open");
    this.renderSection();
  }

  // Jumps straight to a named section (must be one of SECTIONS) — used by
  // the Command Palette's "Settings: <page>" entries so picking one is a
  // single action rather than open-then-click-the-tab.
  openSection(name) {
    if (!SECTIONS.includes(name)) return;
    this.activeSection = name;
    this.open();
  }

  close() {
    if (this.root) this.root.classList.remove("bc-open");
  }

  _build() {
    const root = el("div", { id: PANEL_ID });
    const sidebar = el("div", { class: "bc-sp-sidebar" });
    const title = el("div", { class: "bc-sp-title", text: "BetterClaude Settings" });
    sidebar.appendChild(title);

    const nav = el("nav", { class: "bc-sp-nav" });
    SECTIONS.forEach((section) => {
      const item = el("button", {
        class: "bc-sp-nav-item",
        text: section,
        onclick: () => {
          this.activeSection = section;
          this.renderSection();
        },
      });
      item.dataset.section = section;
      nav.appendChild(item);
    });
    sidebar.appendChild(nav);

    const closeBtn = el("button", { class: "bc-sp-close", text: "Close", onclick: () => this.close() });
    sidebar.appendChild(closeBtn);

    const content = el("div", { class: "bc-sp-content" });

    const modal = el("div", { class: "bc-sp-modal" });
    modal.appendChild(sidebar);
    modal.appendChild(content);
    root.appendChild(modal);
    root.addEventListener("click", (e) => {
      if (e.target === root) this.close();
    });

    document.body.appendChild(root);
    this.root = root;
    this.contentEl = content;
    this.navEl = nav;
  }

  renderSection() {
    Array.from(this.navEl.children).forEach((btn) => {
      btn.classList.toggle("bc-active", btn.dataset.section === this.activeSection);
    });
    this.contentEl.innerHTML = "";
    const renderers = {
      "Appearance": () => this._renderAppearance(),
      "Themes": () => this._renderThemes(),
      "Appearance Editor": () => this._renderAppearanceEditor(),
      "Background": () => this._renderBackground(),
      "Custom CSS": () => this._renderCustomCSS(),
      "Fonts": () => this._renderFonts(),
      "Cursor & Interaction": () => this._renderCursor(),
      "Sound & Haptics": () => this._renderSound(),
      "Layout": () => this._renderLayout(),
      "Animation & Motion": () => this._renderMotion(),
      "Widgets": () => this._renderWidgets(),
      "Buddies": () => this._renderBuddies(),
      "Notifications": () => this._renderNotifications(),
      "Focus & Reading": () => this._renderFocusReading(),
      "Command Palette": () => this._renderCommandPalette(),
      "Profiles": () => this._renderProfiles(),
      "Automations": () => this._renderAutomations(),
      "Playful": () => this._renderPlayful(),
      "Usage Analytics": () => this._renderAnalytics(),
      "Plugins": () => this._renderPlugins(),
      "Team Sync": () => this._renderTeamSync(),
      "Skill Marketplace": () => this._renderSkillMarketplace(),
      "Prompt Library": () => this._renderPromptLibrary(),
      "File Watcher": () => this._renderFileWatcher(),
      "Clipboard Bridge": () => this._renderClipboardBridge(),
      "Keyboard Shortcuts": () => this._renderShortcuts(),
    };
    (renderers[this.activeSection] || (() => {}))();
  }

  _set(keyPath, value) {
    this.host.setSetting(keyPath, value);
  }

  _renderAppearance() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Appearance" }));

    const masterToggle = el("div", { class: "bc-master-toggle" }, [
      el("div", {}, [
        el("strong", { text: "Enable BetterClaude" }),
        el("span", { text: "Turn off to instantly revert to stock claude.ai — no uninstall needed." }),
      ]),
    ]);
    const masterCheckbox = el("input", { type: "checkbox" });
    masterCheckbox.checked = settings.general.enabled !== false;
    masterCheckbox.addEventListener("change", () => this._set("general.enabled", masterCheckbox.checked));
    masterToggle.appendChild(masterCheckbox);
    wrap.appendChild(masterToggle);

    const accentBtn = el("button", { class: "bc-color-swatch" });
    accentBtn.style.background = settings.appearance.accentColor;
    let liveAccent = settings.appearance.accentColor;
    accentBtn.addEventListener("click", () => {
      openColorPopover(accentBtn, liveAccent, (hex) => {
        liveAccent = hex;
        accentBtn.style.background = hex;
        this.host.applyAccentPreview(hex);
      }, () => {
        this._set("appearance.accentColor", liveAccent);
      });
    });
    wrap.appendChild(field("Accent color", accentBtn));

    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Pick a preset theme in the Themes tab, then fine-tune with the Appearance Editor or Custom CSS.",
    }));

    wrap.appendChild(el("h2", { text: "Backup", class: "bc-ae-subhead" }));
    const backupRow = el("div", { class: "bc-theme-toolbar" });
    backupRow.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Export settings…",
      onclick: async () => {
        const ok = await this.host.exportSettings();
        if (ok) this.host.notify && this.host.notify("Settings exported.");
      },
    }));
    backupRow.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Import settings…",
      onclick: async () => {
        const updated = await this.host.importSettings();
        if (updated) {
          this.settings = updated;
          this.renderSection();
          this.host.notify && this.host.notify("Settings imported.");
        }
      },
    }));
    wrap.appendChild(backupRow);
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Export your whole BetterClaude setup (theme, layout, plugin data, shortcuts) as one JSON file, or import one to replace your current setup.",
    }));

    wrap.appendChild(el("h2", { text: "Updates", class: "bc-ae-subhead" }));
    const updateBox = el("div", { class: "bc-master-toggle" });
    wrap.appendChild(updateBox);
    this._renderUpdateBox(updateBox);
    if (this.host.onUpdateStatus) {
      this.host.onUpdateStatus(() => {
        if (this.activeSection === "Appearance") this._renderUpdateBox(updateBox);
      });
    }

    wrap.appendChild(toggleField(
      "Automatically check for updates",
      (settings.updates || {}).autoCheck !== false,
      (v) => this._set("updates.autoCheck", v),
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Checks the GitHub Releases feed shortly after launch. Nothing is ever downloaded or installed without you clicking through first.",
    }));

    // Version line — the only place the app prints its own version; the
    // value comes from package.json via app.getVersion() over IPC rather
    // than being duplicated as a literal anywhere in the renderer.
    const versionLine = el("p", { class: "bc-hint", text: "BetterClaude" });
    wrap.appendChild(versionLine);
    if (this.host.getAppInfo) {
      this.host.getAppInfo().then((info) => {
        versionLine.textContent = `BetterClaude v${info.version}${info.isPackaged ? "" : " (dev build)"}`;
      }).catch(() => {});
    }

    this.contentEl.appendChild(wrap);
  }

  _renderUpdateBox(box) {
    if (!this.host.getUpdateStatus) return;
    const status = this.host.getUpdateStatus();
    box.innerHTML = "";

    const info = el("div", {});
    const labels = {
      idle: "Not checked yet.",
      checking: "Checking for updates…",
      "not-available": "You're on the latest version.",
      available: `Update available${status.version ? ` (v${status.version})` : ""}.`,
      downloading: `Downloading update… ${status.percent || 0}%`,
      downloaded: "Update downloaded — restart to install.",
      error: `Couldn't check for updates: ${status.error || "unknown error"}`,
    };
    info.appendChild(el("strong", { text: "Auto-update" }));
    info.appendChild(el("span", { text: labels[status.state] || "Not checked yet." }));
    // Release blurb, when GitHub gave us one. textContent (via el's `text`),
    // never `html` — this is a release body we don't author.
    if (status.state === "available" && status.notes) {
      info.appendChild(el("span", { class: "bc-hint", text: status.notes }));
    }
    box.appendChild(info);

    const actionBtn = el("button", { class: "bc-btn bc-btn-secondary" });
    if (status.state === "available") {
      actionBtn.textContent = "Download";
      actionBtn.onclick = () => this.host.downloadUpdate();
    } else if (status.state === "downloaded") {
      actionBtn.textContent = "Restart & Install";
      actionBtn.onclick = () => this.host.installUpdate();
    } else {
      actionBtn.textContent = "Check now";
      actionBtn.disabled = status.state === "checking" || status.state === "downloading";
      actionBtn.onclick = () => this.host.checkForUpdates();
    }
    box.appendChild(actionBtn);

    // Auto-update can fail for reasons the user can't act on (unsigned
    // build, no release published yet, offline, API rate limit). Leave a
    // manual path to the new version rather than dead-ending — but keep
    // "Check now" above so the failure is also retryable.
    if (status.state === "error" && this.host.openReleasesPage) {
      const releasesBtn = el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Open Releases",
      });
      releasesBtn.onclick = () => this.host.openReleasesPage();
      box.appendChild(releasesBtn);
    }
  }

  _renderThemes() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Themes" }));

    // Konami-unlocked bonus theme stays out of the visible grid until found
    // (see core/command-palette.js's mountKonamiListener, wired in preload).
    const konamiUnlocked = !!(settings.personality && settings.personality.easterEggs && settings.personality.easterEggs.konamiUnlocked);
    const allIds = this.host.listThemeIds().filter((id) => id !== "secret-rainbow" || konamiUnlocked);
    const favorites = new Set(settings.appearance.favoriteThemes || []);
    if (settings.appearance.activeTheme === "custom") {
      wrap.appendChild(el("p", {
        class: "bc-hint",
        text: `Custom appearance${settings.appearance.customThemeBase ? ` (based on ${THEME_LABELS[settings.appearance.customThemeBase] || settings.appearance.customThemeBase})` : ""}. Select any preset below to restore its original look.`,
      }));
    }

    // --- Featured Vibe Bundles: theme + shape + cursor + sound + motion,
    // applied atomically so the result always reads as cohesive (see
    // core/vibe-bundles.js) rather than independently-random pieces. ---
    wrap.appendChild(el("h2", { text: "Featured Vibes", class: "bc-ae-subhead" }));
    const vibesRow = el("div", { class: "bc-vibes-row" });
    const vibeThemesData = this.host.getThemesData ? this.host.getThemesData() : {};
    featuredBundles().forEach((bundle) => {
      const card = el("button", {
        class: "bc-vibe-card",
        onclick: async () => {
          await this.host.applyVibeBundle(bundle.id);
          this.settings = this.host.getSettings();
          this.renderSection();
        },
      });
      card.appendChild(this._buildThemePreview(parseThemeVars(vibeThemesData[bundle.themeId])));
      card.appendChild(el("strong", { text: bundle.label }));
      card.appendChild(el("span", { text: THEME_LABELS[bundle.themeId] || bundle.themeId }));
      vibesRow.appendChild(card);
    });
    wrap.appendChild(vibesRow);

    // --- Toolbar: shuffle (theme only) + surprise me (whole bundle) + import ---
    const toolbar = el("div", { class: "bc-theme-toolbar" });
    const shuffleBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Shuffle",
      onclick: async () => {
        const candidates = allIds.filter((id) => id !== settings.appearance.activeTheme);
        if (candidates.length === 0) return;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        await this.host.selectTheme(pick);
        this.renderSection();
      },
    });
    toolbar.appendChild(shuffleBtn);
    const surpriseBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Surprise Me",
      title: "Randomize theme + shape + cursor + sound + motion together, cohesively",
      onclick: async () => {
        await this.host.surpriseMe();
        this.settings = this.host.getSettings();
        this.renderSection();
      },
    });
    toolbar.appendChild(surpriseBtn);
    wrap.appendChild(toolbar);

    const importRow = el("div", { class: "bc-theme-import-row" });
    const urlInput = el("input", { type: "text", placeholder: "https://.../theme.css or theme.json" });
    const importUrlBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Import from URL",
      onclick: async () => {
        if (!urlInput.value.trim()) return;
        importUrlBtn.disabled = true;
        importUrlBtn.textContent = "Importing…";
        try {
          const result = await this.host.importThemeFromUrl(urlInput.value.trim());
          urlInput.value = "";
          await this.host.selectTheme(result.id);
          this.renderSection();
        } catch (err) {
          this.host.notify ? this.host.notify(`Theme import failed: ${err.message}`) : console.error(err);
        } finally {
          importUrlBtn.disabled = false;
          importUrlBtn.textContent = "Import from URL";
        }
      },
    });
    const importFileBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Import from file…",
      onclick: async () => {
        try {
          const result = await this.host.importThemeFromFile();
          if (!result) return;
          await this.host.selectTheme(result.id);
          this.renderSection();
        } catch (err) {
          this.host.notify ? this.host.notify(`Theme import failed: ${err.message}`) : console.error(err);
        }
      },
    });
    importRow.appendChild(urlInput);
    importRow.appendChild(importUrlBtn);
    importRow.appendChild(importFileBtn);
    wrap.appendChild(importRow);

    // --- Scheduled / automatic switching ---
    wrap.appendChild(this._buildScheduleSection());

    const grid = el("div", { class: "bc-theme-grid" });
    wrap.appendChild(grid);
    this.contentEl.appendChild(wrap);

    this.host.listUserThemeIds().then((userIds) => {
      const userIdSet = new Set(userIds);
      const themesData = this.host.getThemesData ? this.host.getThemesData() : {};
      const sortedIds = [...allIds].sort((a, b) => {
        const fa = favorites.has(a) ? 0 : 1;
        const fb = favorites.has(b) ? 0 : 1;
        return fa - fb;
      });

      grid.innerHTML = "";
      sortedIds.forEach((id) => {
        const label = THEME_LABELS[id] || id;
        const card = el("div", {
          class: `bc-theme-card${settings.appearance.activeTheme === id ? " bc-active" : ""}`,
        });
        card.addEventListener("click", async (e) => {
          if (e.target.closest("[data-bc-theme-action]")) return;
          await this.host.selectTheme(id);
          this.renderSection();
        });
        card.appendChild(this._buildThemePreview(parseThemeVars(themesData[id])));

        const footer = el("div", { class: "bc-theme-card-footer" });
        footer.appendChild(el("span", { text: label, title: label }));

        const actions = el("div", { class: "bc-theme-card-actions" });
        const starBtn = el("button", {
          "data-bc-theme-action": "1",
          class: `bc-theme-star${favorites.has(id) ? " bc-active" : ""}`,
          text: favorites.has(id) ? "★" : "☆",
          title: favorites.has(id) ? "Remove from favorites" : "Add to favorites",
          onclick: () => {
            const next = favorites.has(id)
              ? [...favorites].filter((f) => f !== id)
              : [...favorites, id];
            this._set("appearance.favoriteThemes", next);
            this.renderSection();
          },
        });
        actions.appendChild(starBtn);

        const copyBtn = el("button", {
          "data-bc-theme-action": "1",
          class: "bc-theme-star",
          text: "⧉",
          title: "Copy theme as shareable JSON",
          onclick: async () => {
            const payload = JSON.stringify({ name: label, vars: parseThemeVars(themesData[id]) }, null, 2);
            try {
              await navigator.clipboard.writeText(payload);
              if (this.host.notify) this.host.notify("Theme copied as JSON.");
            } catch (_e) {
              if (this.host.notify) this.host.notify("Couldn't copy to clipboard.");
            }
          },
        });
        actions.appendChild(copyBtn);

        if (userIdSet.has(id)) {
          actions.appendChild(el("button", {
            "data-bc-theme-action": "1",
            class: "bc-theme-delete",
            text: "✕",
            title: "Delete this theme",
            onclick: async () => {
              await this.host.deleteUserTheme(id);
              if (settings.appearance.activeTheme === id) {
                await this.host.selectTheme("midnight-violet");
              }
              this.renderSection();
            },
          }));
        }
        footer.appendChild(actions);
        card.appendChild(footer);
        grid.appendChild(card);
      });
    });
  }

  _buildScheduleSection() {
    const { settings } = this;
    const schedule = settings.appearance.schedule || {};
    const wrap = el("div", { class: "bc-schedule-section" });
    wrap.appendChild(el("h2", { text: "Automatic switching", class: "bc-ae-subhead" }));

    const mode = el("select", {}, [
      el("option", { value: "off", text: "Off (manual)" }),
      el("option", { value: "time", text: "By time of day" }),
      el("option", { value: "os", text: "Follow OS light/dark mode" }),
    ]);
    mode.value = schedule.mode || "off";
    mode.addEventListener("change", () => {
      this._set("appearance.schedule.mode", mode.value);
    });
    wrap.appendChild(field("Mode", mode));

    const themeOptions = () => this.host.listThemeIds().map((id) =>
      el("option", { value: id, text: THEME_LABELS[id] || id }));

    const lightSelect = el("select", {}, themeOptions());
    lightSelect.value = schedule.lightThemeId || "arctic-light";
    lightSelect.addEventListener("change", () => this._set("appearance.schedule.lightThemeId", lightSelect.value));
    wrap.appendChild(field("Light theme", lightSelect));

    const darkSelect = el("select", {}, themeOptions());
    darkSelect.value = schedule.darkThemeId || "midnight-violet";
    darkSelect.addEventListener("change", () => this._set("appearance.schedule.darkThemeId", darkSelect.value));
    wrap.appendChild(field("Dark theme", darkSelect));

    const lightStart = el("input", { type: "time", value: schedule.lightStart || "07:00" });
    lightStart.addEventListener("change", () => this._set("appearance.schedule.lightStart", lightStart.value));
    wrap.appendChild(field("Light starts at", lightStart));

    const darkStart = el("input", { type: "time", value: schedule.darkStart || "19:00" });
    darkStart.addEventListener("change", () => this._set("appearance.schedule.darkStart", darkStart.value));
    wrap.appendChild(field("Dark starts at", darkStart));

    return wrap;
  }

  _buildThemePreview(vars) {
    const bg = vars["--bc-bg"] || "#14101f";
    const bgSidebar = vars["--bc-bg-sidebar"] || bg;
    const bgElevated = vars["--bc-bg-elevated"] || bg;
    const text = vars["--bc-text"] || "#ece7fb";
    const accent = vars["--bc-accent"] || "#8b5cf6";
    const bubbleUser = vars["--bc-bubble-user"] || accent;
    const border = vars["--bc-border"] || "rgba(255,255,255,0.1)";

    const preview = el("div", { class: "bc-theme-preview" });
    const sidebar = el("div", { class: "bc-theme-preview-sidebar" });
    sidebar.style.background = bgSidebar;
    [0.9, 0.65, 0.65, 0.65].forEach((w) => {
      const line = el("span");
      line.style.background = text;
      line.style.width = `${w * 100}%`;
      sidebar.appendChild(line);
    });
    preview.appendChild(sidebar);

    const main = el("div", { class: "bc-theme-preview-main" });
    main.style.background = bg;
    const assistantBubble = el("div", { class: "bc-theme-preview-bubble bc-theme-preview-bubble-assistant" });
    assistantBubble.style.background = border;
    const userBubble = el("div", { class: "bc-theme-preview-bubble bc-theme-preview-bubble-user" });
    userBubble.style.background = bubbleUser;
    const input = el("div", { class: "bc-theme-preview-input" });
    input.style.background = bgElevated;
    input.style.border = `1px solid ${border}`;
    main.appendChild(assistantBubble);
    main.appendChild(userBubble);
    main.appendChild(input);
    preview.appendChild(main);

    return preview;
  }

  _renderAppearanceEditor() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Appearance Editor" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Visual, no-code overrides. These write straight into Custom CSS as generated "
        + "variable overrides, so they stay in sync with (and are visible/editable from) the Custom CSS tab.",
    }));

    const overrides = settings.appearanceEditor.colors || {};
    const colorFields = [
      { key: "--bc-bg", label: "Background" },
      { key: "--bc-bg-sidebar", label: "Sidebar background" },
      { key: "--bc-bg-elevated", label: "Composer / panel background" },
      { key: "--bc-text", label: "Text" },
      { key: "--bc-text-muted", label: "Muted text" },
      { key: "--bc-accent", label: "Accent / buttons" },
      { key: "--bc-border", label: "Borders" },
      { key: "--bc-bubble-user", label: "Your message bubble" },
      { key: "--bc-bubble-assistant", label: "Assistant message bubble" },
      { key: "--bc-danger", label: "Destructive / delete" },
    ];

    const grid = el("div", { class: "bc-ae-grid" });

    // Live WCAG guardrail for --bc-text: nothing here stopped a user from
    // picking a text color that's nearly invisible against its own
    // background (the Background tab has this check — see _renderBackground
    // above — but these swatches, which is where the actual base --bc-text /
    // --bc-bg* variables live, never did). liveValues tracks in-progress
    // picks so the warning updates as the color popover is dragged, not just
    // after committing.
    const liveValues = { ...overrides };
    const BG_CONTRAST_TARGETS = [
      { key: "--bc-bg", label: "Background" },
      { key: "--bc-bg-sidebar", label: "Sidebar background" },
      { key: "--bc-bg-elevated", label: "Composer / panel background" },
    ];
    const resolveColor = (key, fallback) =>
      liveValues[key] || getComputedStyle(document.documentElement).getPropertyValue(key).trim() || fallback;
    const textWarn = el("div", { class: "bc-contrast-warn", style: "display:none" });
    const refreshTextWarn = () => {
      const text = resolveColor("--bc-text", "#ece7fb");
      const failing = BG_CONTRAST_TARGETS
        .map(({ key, label }) => ({ label, ratio: contrastRatio(text, resolveColor(key, "#14101f")) }))
        .filter(({ ratio }) => ratio < WCAG_AA_BODY)
        .sort((a, b) => a.ratio - b.ratio);
      if (!failing.length) {
        textWarn.style.display = "none";
        textWarn.innerHTML = "";
        return;
      }
      textWarn.style.display = "";
      textWarn.innerHTML = "";
      textWarn.appendChild(el("span", { class: "bc-warn-icon", html: ICONS.WARNING }));
      textWarn.appendChild(el("span", {
        text: `Text contrast against ${failing[0].label.toLowerCase()} is ${failing[0].ratio.toFixed(2)}:1 — below the ${WCAG_AA_BODY}:1 readability minimum.`,
      }));
      textWarn.appendChild(el("button", {
        class: "bc-btn bc-btn-secondary",
        text: "Reset text color",
        onclick: () => {
          delete liveValues["--bc-text"];
          const next = { ...overrides };
          delete next["--bc-text"];
          // Clears the setting AND rewrites the generated Custom CSS block
          // (which still has the old --bc-text line baked in and would keep
          // applying it otherwise — see _applyAppearanceEditorCSS).
          this._applyAppearanceEditorCSS(next);
          this._set("appearanceEditor.colors", next);
          this.renderSection();
        },
      }));
    };

    colorFields.forEach(({ key, label }) => {
      const current = key === "--bc-accent"
        ? settings.appearance.accentColor
        : (overrides[key] || getComputedStyle(document.documentElement).getPropertyValue(key).trim() || "#8b5cf6");
      const swatch = el("button", { class: "bc-color-swatch" });
      swatch.style.background = current;
      let live = current;
      swatch.addEventListener("click", () => {
        openColorPopover(swatch, live, (hex) => {
          live = hex;
          swatch.style.background = hex;
          if (key === "--bc-accent") {
            // The accent color has its own dedicated pipeline (Appearance
            // tab -> ThemeEngine.setAccentColor -> inline style on :root),
            // which — being an inline style — always wins over a plain
            // `:root { --bc-accent: ... }` rule from a stylesheet. Routing
            // through that same pipeline here instead of the generated
            // Custom CSS block is what makes this swatch actually take
            // effect instead of being silently overridden by it.
            this.host.applyAccentPreview(hex);
          } else {
            this._applyAppearanceEditorCSS({ ...overrides, [key]: hex });
          }
          if (key === "--bc-text" || BG_CONTRAST_TARGETS.some((t) => t.key === key)) {
            liveValues[key] = hex;
            refreshTextWarn();
          }
        }, () => {
          if (key === "--bc-accent") {
            this._set("appearance.accentColor", live);
          } else {
            const next = { ...overrides, [key]: live };
            this._set("appearanceEditor.colors", next);
          }
        });
      });
      grid.appendChild(field(label, swatch));
    });
    wrap.appendChild(grid);
    wrap.appendChild(textWarn);
    refreshTextWarn();

    wrap.appendChild(el("h2", { text: "Size", class: "bc-ae-subhead" }));
    // Real size: applied through height/padding/font (reflow), bounded so text
    // can't clip and neighbors can't overflow. Persisting sizeScale triggers a
    // settings-changed roundtrip that re-applies the base layer live.
    const curSize = settings.appearanceEditor.sizeScale != null
      ? settings.appearanceEditor.sizeScale
      : (settings.appearanceEditor.buttonScale != null ? settings.appearanceEditor.buttonScale : 1);
    const sizeScale = el("input", {
      type: "range", min: "0.85", max: "1.4", step: "0.05", value: curSize,
    });
    const sizeLabel = el("span", { class: "bc-range-value", text: `${Math.round(curSize * 100)}%` });
    sizeScale.addEventListener("input", () => {
      sizeLabel.textContent = `${Math.round(sizeScale.value * 100)}%`;
      this._set("appearanceEditor.sizeScale", Number(sizeScale.value));
    });
    wrap.appendChild(field("Control size", el("div", { class: "bc-range-row" }, [sizeScale, sizeLabel])));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Scales buttons and inputs by resizing them (not a visual zoom), so text stays crisp and tap targets stay ≥ 40px.",
    }));

    wrap.appendChild(el("h2", { text: "Corner shape", class: "bc-ae-subhead" }));
    // Shape maps to a radius:height ratio (≤ 0.5), so corners always scale
    // with size and can never square off on a rounded control or lobe on a
    // small one. Replaces the old free-pixel radius slider entirely.
    const shapeRow = el("div", { class: "bc-shape-row" });
    const curShape = settings.appearanceEditor.shape || "rounded";
    SHAPE_OPTIONS.forEach(({ value, label }) => {
      const btn = el("button", {
        class: `bc-shape-btn${curShape === value ? " bc-active" : ""}`,
        text: label,
        "data-shape": value,
        onclick: () => {
          this._set("appearanceEditor.shape", value);
          Array.from(shapeRow.children).forEach((c) =>
            c.classList.toggle("bc-active", c.dataset.shape === value));
        },
      });
      shapeRow.appendChild(btn);
    });
    wrap.appendChild(field("Corner roundness", shapeRow));

    wrap.appendChild(el("h2", { text: "Position", class: "bc-ae-subhead" }));
    const position = el("select", {}, [
      el("option", { value: "left", text: "Sidebar on left" }),
      el("option", { value: "right", text: "Sidebar on right" }),
    ]);
    position.value = settings.layout.sidebarPosition;
    position.addEventListener("change", () => this._set("layout.sidebarPosition", position.value));
    wrap.appendChild(field("Reposition sidebar", position));

    wrap.appendChild(el("h2", { text: "Save", class: "bc-ae-subhead" }));
    const saveRow = el("div", { class: "bc-theme-import-row" });
    const nameInput = el("input", { type: "text", placeholder: "My theme name" });
    const saveBtn = el("button", {
      class: "bc-btn",
      text: "Save as new theme",
      onclick: async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        saveBtn.disabled = true;
        try {
          const result = await this.host.saveCurrentAsNewTheme(name);
          nameInput.value = "";
          await this.host.selectTheme(result.id);
          this.host.notify ? this.host.notify(`Saved theme "${name}"`) : null;
        } finally {
          saveBtn.disabled = false;
        }
      },
    });
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Bakes the active theme plus everything above (and Custom CSS) into a new, independent theme in the Themes tab.",
    }));

    wrap.appendChild(el("h2", { text: "Advanced: all tokens", class: "bc-ae-subhead" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Read-only live values of every derived state token (hover/active/disabled/selected), computed from the palette above — useful for writing precise Custom CSS overrides.",
    }));
    const inspector = el("div", { class: "bc-token-inspector" });
    const computed = getComputedStyle(document.documentElement);
    const suffixes = ["bg-default", "bg-hover", "bg-active", "bg-disabled", "bg-selected", "fg", "fg-default", "fg-selected"];
    COMPONENT_FAMILIES.forEach((familyName) => {
      suffixes.forEach((suffix) => {
        const varName = `--${familyName}-${suffix}`;
        const value = computed.getPropertyValue(varName).trim();
        if (!value) return;
        const row = el("div", { class: "bc-token-row" });
        row.appendChild(el("span", { class: "bc-token-name", text: varName }));
        row.appendChild(el("span", { class: "bc-token-value", text: value }));
        inspector.appendChild(row);
      });
    });
    wrap.appendChild(inspector);

    this.contentEl.appendChild(wrap);
  }

  // Renders the current color overrides into a marked block inside
  // customCSS.code, preserving anything the user hand-wrote outside the
  // markers, so the visual editor and the raw CSS editor stay a single source
  // of truth. Size and corner shape are NOT written here — they're real,
  // bounded settings (appearanceEditor.sizeScale / .shape) consumed by the
  // base layer, so they can't be pushed out of range via generated CSS.
  _applyAppearanceEditorCSS(colors) {
    const varLines = Object.entries(colors)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    const generated = `${APPEARANCE_EDITOR_MARK_START}\n:root {\n${varLines}\n}\n${APPEARANCE_EDITOR_MARK_END}`;

    const existing = this.settings.customCSS.code || "";
    const startIdx = existing.indexOf(APPEARANCE_EDITOR_MARK_START);
    const endIdx = existing.indexOf(APPEARANCE_EDITOR_MARK_END);
    let merged;
    if (startIdx !== -1 && endIdx !== -1) {
      merged = existing.slice(0, startIdx) + generated + existing.slice(endIdx + APPEARANCE_EDITOR_MARK_END.length);
    } else {
      merged = existing ? `${existing}\n\n${generated}` : generated;
    }

    this.host.applyCustomCSSPreview(merged);
    this._set("customCSS.code", merged);
    if (this.cssEditorHandle) this.cssEditorHandle.setValue(merged);
  }

  _renderBackground() {
    const { settings } = this;
    const bg = Object.assign({}, settings.background);
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Background" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Applies to the main chat pane only — never the sidebar or top bar (unless you opt in below). "
        + "Contrast against your text color is checked live so text never becomes unreadable.",
    }));

    // Live WCAG warning banner, refreshed on every change.
    const warn = el("div", { class: "bc-contrast-warn", style: "display:none" });
    const refreshWarn = () => {
      const res = this.host.applyBackgroundPreview(bg);
      if (!res || res.applicable === false || res.passes) {
        warn.style.display = "none";
        warn.innerHTML = "";
        return;
      }
      warn.style.display = "";
      warn.innerHTML = "";
      warn.appendChild(el("span", {
        class: "bc-warn-icon",
        html: ICONS.WARNING,
      }));
      warn.appendChild(el("span", {
        text: `Text contrast is ${res.ratio}:1 — below the 4.5:1 readability minimum.`,
      }));
      if (res.suggestedScrimOpacity != null) {
        warn.appendChild(el("button", {
          class: "bc-btn bc-btn-secondary",
          text: `Fix: set scrim to ${Math.round(res.suggestedScrimOpacity * 100)}%`,
          onclick: () => {
            bg.scrimColor = res.suggestedScrimColor || bg.scrimColor;
            bg.scrimOpacity = res.suggestedScrimOpacity;
            this._set("background.scrimColor", bg.scrimColor);
            this._set("background.scrimOpacity", bg.scrimOpacity);
            this.renderSection();
          },
        }));
      }
    };
    const save = (key, value) => {
      bg[key] = value;
      this._set(`background.${key}`, value);
      refreshWarn();
    };

    const mode = el("select", {}, [
      el("option", { value: "off", text: "Off" }),
      el("option", { value: "solid", text: "Solid color" }),
      el("option", { value: "gradient", text: "Gradient (CSS)" }),
      el("option", { value: "image", text: "Image" }),
    ]);
    mode.value = bg.mode || "off";
    mode.addEventListener("change", () => { save("mode", mode.value); this.renderSection(); });
    wrap.appendChild(field("Background type", mode));

    if (bg.mode === "solid") {
      const sw = el("button", { class: "bc-color-swatch" });
      sw.style.background = bg.color;
      let live = bg.color;
      sw.addEventListener("click", () => openColorPopover(sw, live, (hex) => {
        live = hex; sw.style.background = hex; save("color", hex);
      }, () => save("color", live)));
      wrap.appendChild(field("Color", sw));
    }

    if (bg.mode === "gradient") {
      const gi = el("input", { type: "text", value: bg.gradient });
      gi.addEventListener("change", () => save("gradient", gi.value));
      wrap.appendChild(field("CSS gradient", gi));
      const anim = el("input", { type: "checkbox" });
      anim.checked = !!bg.animated;
      anim.addEventListener("change", () => save("animated", anim.checked));
      wrap.appendChild(field("Animate (respects reduced-motion)", anim));
    }

    if (bg.mode === "image") {
      // Nested background.filter.* fields need their own setter — save()
      // does a shallow bg[key] = value, which would create a bogus flat
      // "filter.brightness" key instead of updating bg.filter.brightness.
      const saveFilter = (key, value) => {
        bg.filter[key] = value;
        this._set(`background.filter.${key}`, value);
        refreshWarn();
      };

      const loadImageFile = (f) => {
        if (!f || !/^image\//.test(f.type)) return;
        const reader = new FileReader();
        reader.onload = () => {
          bg.imageDataUrl = reader.result;
          save("imageDataUrl", reader.result);
          this.renderSection();
        };
        reader.readAsDataURL(f);
      };

      const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
      fileInput.addEventListener("change", () => loadImageFile(fileInput.files && fileInput.files[0]));

      const dropzone = el("div", { class: "bc-bg-dropzone" });
      dropzone.appendChild(fileInput);

      if (bg.imageDataUrl) {
        dropzone.classList.add("bc-bg-dropzone-filled");

        const preview = el("div", { class: "bc-bg-preview-image" });
        const applyPreviewStyle = () => {
          preview.style.backgroundImage = `url("${bg.imageDataUrl}")`;
          preview.style.backgroundPosition = `${bg.offsetX}% ${bg.offsetY}%`;
          preview.style.backgroundSize = bg.fit === "contain" ? "contain" : (bg.fit === "tile" || bg.fit === "center") ? "auto" : "cover";
          preview.style.backgroundRepeat = bg.fit === "tile" ? "repeat" : "no-repeat";
          const sx = (bg.zoom / 100) * (bg.flipH ? -1 : 1);
          const sy = (bg.zoom / 100) * (bg.flipV ? -1 : 1);
          preview.style.transform = `scale(${sx}, ${sy})`;
          preview.style.transformOrigin = `${bg.offsetX}% ${bg.offsetY}%`;
          const f = bg.filter;
          preview.style.filter = `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) `
            + `grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hueRotate}deg)`;
        };
        applyPreviewStyle();

        // Drag-to-pan directly on the preview — same named-handler
        // add/remove-on-release pattern used elsewhere for dragging, so a
        // re-render of this section (every save() call re-renders) can
        // never leave a stale mousemove/mouseup listener attached.
        let dragState = null;
        const onDragMove = (e) => {
          if (!dragState) return;
          bg.offsetX = Math.max(0, Math.min(100, bg.offsetX - (e.movementX / dragState.width) * 100));
          bg.offsetY = Math.max(0, Math.min(100, bg.offsetY - (e.movementY / dragState.height) * 100));
          applyPreviewStyle();
        };
        const onDragEnd = () => {
          dragState = null;
          document.removeEventListener("mousemove", onDragMove);
          document.removeEventListener("mouseup", onDragEnd);
          save("offsetX", bg.offsetX);
          save("offsetY", bg.offsetY);
        };
        preview.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const rect = preview.getBoundingClientRect();
          dragState = { width: rect.width, height: rect.height };
          document.addEventListener("mousemove", onDragMove);
          document.addEventListener("mouseup", onDragEnd);
        });
        dropzone.appendChild(preview);

        dropzone.appendChild(el("div", { class: "bc-bg-preview-overlay" }, [
          el("button", { class: "bc-btn bc-btn-secondary", text: "Replace image", onclick: (e) => { e.stopPropagation(); fileInput.click(); } }),
          el("button", { class: "bc-btn bc-btn-secondary", text: "Remove", onclick: (e) => {
            e.stopPropagation();
            bg.imageDataUrl = "";
            save("imageDataUrl", "");
            this.renderSection();
          } }),
        ]));
      } else {
        dropzone.appendChild(el("span", { class: "bc-bg-dropzone-icon", html: ICONS.UPLOAD }));
        dropzone.appendChild(el("span", { class: "bc-bg-dropzone-text", text: "Click to upload, or drag & drop an image" }));
        dropzone.addEventListener("click", () => fileInput.click());
      }

      dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("bc-bg-dropzone-drag"); });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("bc-bg-dropzone-drag"));
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("bc-bg-dropzone-drag");
        loadImageFile(e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      wrap.appendChild(field("Image", dropzone));

      const fit = el("select", {}, [
        el("option", { value: "cover", text: "Cover" }),
        el("option", { value: "contain", text: "Contain" }),
        el("option", { value: "tile", text: "Tile" }),
        el("option", { value: "center", text: "Center" }),
      ]);
      fit.value = bg.fit || "cover";
      fit.addEventListener("change", () => { save("fit", fit.value); this.renderSection(); });
      wrap.appendChild(field("Fit", fit));

      if (bg.imageDataUrl) {
        const zoom = el("input", { type: "range", min: "100", max: "300", step: "5", value: bg.zoom });
        const zoomLabel = el("span", { class: "bc-range-value", text: `${bg.zoom}%` });
        zoom.addEventListener("input", () => {
          bg.zoom = Number(zoom.value);
          zoomLabel.textContent = `${bg.zoom}%`;
          save("zoom", bg.zoom);
        });
        wrap.appendChild(field("Zoom", el("div", { class: "bc-range-row" }, [zoom, zoomLabel])));

        const flipRow = el("div", { class: "bc-shape-row" }, [
          el("button", { class: `bc-shape-btn${bg.flipH ? " bc-active" : ""}`, text: "Flip horizontal", onclick: () => { bg.flipH = !bg.flipH; save("flipH", bg.flipH); this.renderSection(); } }),
          el("button", { class: `bc-shape-btn${bg.flipV ? " bc-active" : ""}`, text: "Flip vertical", onclick: () => { bg.flipV = !bg.flipV; save("flipV", bg.flipV); this.renderSection(); } }),
        ]);
        wrap.appendChild(field("Flip", flipRow));

        wrap.appendChild(el("h2", { text: "Color filters" }));
        const filterDefs = [
          { key: "brightness", label: "Brightness", min: 0, max: 200 },
          { key: "contrast", label: "Contrast", min: 0, max: 200 },
          { key: "saturate", label: "Saturation", min: 0, max: 200 },
          { key: "grayscale", label: "Grayscale", min: 0, max: 100 },
          { key: "sepia", label: "Sepia", min: 0, max: 100 },
          { key: "hueRotate", label: "Hue rotate", min: 0, max: 360 },
        ];
        filterDefs.forEach((fdef) => {
          const suffix = fdef.key === "hueRotate" ? "°" : "%";
          const input = el("input", { type: "range", min: String(fdef.min), max: String(fdef.max), step: "1", value: bg.filter[fdef.key] });
          const label = el("span", { class: "bc-range-value", text: `${bg.filter[fdef.key]}${suffix}` });
          input.addEventListener("input", () => {
            const v = Number(input.value);
            label.textContent = `${v}${suffix}`;
            saveFilter(fdef.key, v);
          });
          wrap.appendChild(field(fdef.label, el("div", { class: "bc-range-row" }, [input, label])));
        });
        wrap.appendChild(el("button", {
          class: "bc-btn bc-btn-secondary",
          text: "Reset filters",
          onclick: () => {
            bg.filter = { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0, hueRotate: 0 };
            Object.entries(bg.filter).forEach(([k, v]) => this._set(`background.filter.${k}`, v));
            refreshWarn();
            this.renderSection();
          },
        }));
      }
    }

    if (bg.mode !== "off") {
      // Scrim + blur + unify controls, shared across visual modes.
      const scrimSw = el("button", { class: "bc-color-swatch" });
      scrimSw.style.background = bg.scrimColor;
      let liveScrim = bg.scrimColor;
      scrimSw.addEventListener("click", () => openColorPopover(scrimSw, liveScrim, (hex) => {
        liveScrim = hex; scrimSw.style.background = hex; save("scrimColor", hex);
      }, () => save("scrimColor", liveScrim)));
      wrap.appendChild(field("Overlay (scrim) color", scrimSw));

      const scrim = el("input", { type: "range", min: "0", max: "0.95", step: "0.05", value: bg.scrimOpacity });
      const scrimLabel = el("span", { class: "bc-range-value", text: `${Math.round(bg.scrimOpacity * 100)}%` });
      scrim.addEventListener("input", () => {
        scrimLabel.textContent = `${Math.round(scrim.value * 100)}%`;
        save("scrimOpacity", Number(scrim.value));
      });
      wrap.appendChild(field("Overlay opacity", el("div", { class: "bc-range-row" }, [scrim, scrimLabel])));

      const blur = el("input", { type: "range", min: "0", max: "40", step: "1", value: bg.blurPx });
      const blurLabel = el("span", { class: "bc-range-value", text: `${bg.blurPx}px` });
      blur.addEventListener("input", () => {
        blurLabel.textContent = `${blur.value}px`;
        save("blurPx", Number(blur.value));
      });
      wrap.appendChild(field("Overlay blur", el("div", { class: "bc-range-row" }, [blur, blurLabel])));

      const unify = el("input", { type: "checkbox" });
      unify.checked = !!bg.unifyAllSurfaces;
      unify.addEventListener("change", () => save("unifyAllSurfaces", unify.checked));
      wrap.appendChild(field("Apply to every surface (sidebar + bars too)", unify));
    }

    wrap.appendChild(warn);

    wrap.appendChild(el("h2", { text: "Scheduled rotation", class: "bc-ae-subhead" }));
    const rotation = settings.background.rotation || { enabled: false, intervalMinutes: 60, pool: [] };
    const rotationEnabled = el("input", { type: "checkbox" });
    rotationEnabled.checked = !!rotation.enabled;
    rotationEnabled.addEventListener("change", () => this._set("background.rotation.enabled", rotationEnabled.checked));
    wrap.appendChild(field("Rotate through a saved pool of backgrounds", rotationEnabled));

    const interval = el("input", { type: "range", min: "15", max: "1440", step: "15", value: rotation.intervalMinutes });
    const intervalLabel = el("span", { class: "bc-range-value", text: rotation.intervalMinutes >= 60 ? `${Math.round(rotation.intervalMinutes / 60)}h` : `${rotation.intervalMinutes}m` });
    interval.addEventListener("input", () => {
      const v = Number(interval.value);
      intervalLabel.textContent = v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`;
      this._set("background.rotation.intervalMinutes", v);
    });
    wrap.appendChild(field("Rotate every", el("div", { class: "bc-range-row" }, [interval, intervalLabel])));

    const poolList = el("div", { class: "bc-plugin-list" });
    (rotation.pool || []).forEach((snap, i) => {
      const row = el("div", { class: "bc-plugin-row" });
      const desc = snap.mode === "solid" ? `Solid · ${snap.color}` : snap.mode === "gradient" ? "Gradient" : snap.mode === "image" ? "Image" : "Off";
      row.appendChild(el("div", { class: "bc-plugin-info" }, [el("strong", { text: desc })]));
      const del = el("button", {
        class: "bc-theme-delete",
        text: "✕",
        onclick: () => {
          const next = rotation.pool.filter((_, idx) => idx !== i);
          this._set("background.rotation.pool", next);
          this.renderSection();
        },
      });
      row.appendChild(del);
      poolList.appendChild(row);
    });
    if ((rotation.pool || []).length === 0) poolList.appendChild(el("p", { class: "bc-hint", text: "No saved backgrounds in the rotation yet." }));
    wrap.appendChild(poolList);

    wrap.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "+ Add current background to rotation",
      onclick: () => {
        const snap = { mode: bg.mode, color: bg.color, gradient: bg.gradient, imageDataUrl: bg.imageDataUrl, fit: bg.fit };
        const next = [...(rotation.pool || []), snap];
        this._set("background.rotation.pool", next);
        this.renderSection();
      },
    }));

    wrap.appendChild(el("h2", { text: "Overlay style", class: "bc-ae-subhead" }));
    const glass = el("input", { type: "checkbox" });
    glass.checked = !!settings.appearance.glassPanels;
    glass.addEventListener("change", () => this._set("appearance.glassPanels", glass.checked));
    wrap.appendChild(field("Frosted-glass panels (Settings, overlays, popovers)", glass));

    this.contentEl.appendChild(wrap);
    refreshWarn();
  }

  _renderCustomCSS() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section bc-section-css" });
    wrap.appendChild(el("h2", { text: "Custom CSS" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Applied live as you type (after your theme). Overrides anything above it.",
    }));

    const editorContainer = el("div", { class: "bc-css-editor" });
    const resetBtn = el("button", { class: "bc-btn bc-btn-secondary", text: "Reset" });

    wrap.appendChild(editorContainer);
    wrap.appendChild(resetBtn);
    this.contentEl.appendChild(wrap);

    let debounceTimer = null;
    this.cssEditorHandle = this.host.mountCSSEditor(editorContainer, {
      initialValue: settings.customCSS.code || "",
      onChange: (value) => {
        this.host.applyCustomCSSPreview(value);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this._set("customCSS.code", value), 150);
      },
    });

    resetBtn.addEventListener("click", () => {
      this.cssEditorHandle.setValue("");
      this.host.applyCustomCSSPreview("");
      this._set("customCSS.code", "");
    });
  }

  _renderFonts() {
    const { settings } = this;
    const fonts = settings.fonts;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Fonts" }));

    const FONT_PRESETS = [
      { label: "System UI", value: "system-ui" },
      { label: "Rounded sans", value: "Verdana, Geneva, sans-serif" },
      { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
      { label: "Monospace-y", value: "SFMono-Regular, Menlo, monospace" },
      { label: "Comic-ish (dyslexia-friendlier)", value: "'Comic Sans MS', 'Comic Neue', sans-serif" },
    ];

    const uiFont = el("input", { type: "text", value: fonts.uiFont });
    uiFont.addEventListener("change", () => this._set("fonts.uiFont", uiFont.value));

    const quickPick = el("select", {}, [
      el("option", { value: "", text: "Quick pick…" }),
      ...FONT_PRESETS.map((p) => el("option", { value: p.value, text: p.label })),
    ]);
    quickPick.addEventListener("change", () => {
      if (!quickPick.value) return;
      uiFont.value = quickPick.value;
      this._set("fonts.uiFont", quickPick.value);
      quickPick.value = "";
    });

    wrap.appendChild(field("UI font family", el("div", { class: "bc-range-row" }, [uiFont, quickPick])));

    const codeFont = el("input", { type: "text", value: fonts.codeFont });
    codeFont.addEventListener("change", () => this._set("fonts.codeFont", codeFont.value));
    wrap.appendChild(field("Code font family", codeFont));

    const size = el("input", { type: "range", min: "12", max: "20", value: fonts.baseSizePx });
    const sizeLabel = el("span", { class: "bc-range-value", text: `${fonts.baseSizePx}px` });
    size.addEventListener("input", () => {
      sizeLabel.textContent = `${size.value}px`;
      this._set("fonts.baseSizePx", Number(size.value));
    });
    wrap.appendChild(field("Base font size", el("div", { class: "bc-range-row" }, [size, sizeLabel])));

    const lineHeight = el("input", { type: "range", min: "1.1", max: "2.0", step: "0.05", value: fonts.lineHeight });
    const lineHeightLabel = el("span", { class: "bc-range-value", text: fonts.lineHeight.toFixed(2) });
    lineHeight.addEventListener("input", () => {
      lineHeightLabel.textContent = Number(lineHeight.value).toFixed(2);
      this._set("fonts.lineHeight", Number(lineHeight.value));
    });
    wrap.appendChild(field("Line height", el("div", { class: "bc-range-row" }, [lineHeight, lineHeightLabel])));

    const letterSpacing = el("input", { type: "range", min: "-0.5", max: "3", step: "0.1", value: fonts.letterSpacingPx });
    const letterSpacingLabel = el("span", { class: "bc-range-value", text: `${fonts.letterSpacingPx}px` });
    letterSpacing.addEventListener("input", () => {
      letterSpacingLabel.textContent = `${letterSpacing.value}px`;
      this._set("fonts.letterSpacingPx", Number(letterSpacing.value));
    });
    wrap.appendChild(field("Letter spacing", el("div", { class: "bc-range-row" }, [letterSpacing, letterSpacingLabel])));

    const weight = el("input", { type: "range", min: "400", max: "900", step: "50", value: fonts.fontWeight });
    const weightLabel = el("span", { class: "bc-range-value", text: String(fonts.fontWeight) });
    weight.addEventListener("input", () => {
      weightLabel.textContent = weight.value;
      this._set("fonts.fontWeight", Number(weight.value));
    });
    wrap.appendChild(field("Body font weight", el("div", { class: "bc-range-row" }, [weight, weightLabel])));

    const dyslexia = el("input", { type: "checkbox" });
    dyslexia.checked = !!fonts.dyslexiaMode;
    dyslexia.addEventListener("change", () => this._set("fonts.dyslexiaMode", dyslexia.checked));
    wrap.appendChild(field("Dyslexia-friendly mode", dyslexia));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "A typographic approximation (wider spacing + a rounded sans fallback) rather than the actual OpenDyslexic font file.",
    }));

    wrap.appendChild(el("h2", { text: "Headings", class: "bc-ae-subhead" }));
    const headingFont = el("input", { type: "text", value: fonts.headingFont, placeholder: "empty = same as UI font" });
    headingFont.addEventListener("change", () => this._set("fonts.headingFont", headingFont.value));
    wrap.appendChild(field("Heading font family", headingFont));

    const headingWeight = el("input", { type: "range", min: "400", max: "900", step: "50", value: fonts.headingWeight });
    const headingWeightLabel = el("span", { class: "bc-range-value", text: String(fonts.headingWeight) });
    headingWeight.addEventListener("input", () => {
      headingWeightLabel.textContent = headingWeight.value;
      this._set("fonts.headingWeight", Number(headingWeight.value));
    });
    wrap.appendChild(field("Heading font weight", el("div", { class: "bc-range-row" }, [headingWeight, headingWeightLabel])));

    this.contentEl.appendChild(wrap);
  }

  _renderLayout() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Layout" }));

    // The slider is always live now. It used to render `disabled` behind a
    // separate "use claude.ai's normal sidebar (recommended)" checkbox that
    // defaulted to on, so out of the box the width control looked broken —
    // you could drag it and nothing happened. Dragging writes the width
    // immediately; the reset button below is the way back to claude.ai's own
    // width (null = don't touch it at all).
    const isCustomWidth = settings.layout.sidebarWidthPx != null;
    const width = el("input", {
      type: "range", min: "180", max: "420",
      value: settings.layout.sidebarWidthPx != null ? settings.layout.sidebarWidthPx : 280,
    });
    const widthLabel = el("span", {
      class: "bc-range-value",
      text: isCustomWidth ? `${width.value}px` : `${width.value}px (auto)`,
    });
    width.addEventListener("input", () => {
      widthLabel.textContent = `${width.value}px`;
      this._set("layout.sidebarWidthPx", Number(width.value));
    });
    wrap.appendChild(field("Sidebar width", el("div", { class: "bc-range-row" }, [width, widthLabel])));
    wrap.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Use claude.ai's default width",
      onclick: () => {
        this._set("layout.sidebarWidthPx", null);
        this.renderSection();
      },
    }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "\"(auto)\" means claude.ai's own width is untouched — drag the slider to force a fixed one. Wider keeps full chat titles and section names readable instead of truncating them.",
    }));

    wrap.appendChild(toggleField(
      "Hide claude.ai's sidebar pin button",
      settings.layout.hideSidebarPin !== false,
      (v) => this._set("layout.hideSidebarPin", v),
    ));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Removes the pin glyph near the top of the sidebar. With it hidden the sidebar keeps whatever expanded state it's in now — turn this back off if you ever want to collapse it again.",
    }));

    const position = el("select", {}, [
      el("option", { value: "left", text: "Left" }),
      el("option", { value: "right", text: "Right" }),
    ]);
    position.value = settings.layout.sidebarPosition;
    position.addEventListener("change", () => this._set("layout.sidebarPosition", position.value));
    wrap.appendChild(field("Sidebar position", position));

    const densityRow = el("div", { class: "bc-shape-row" });
    ["compact", "comfortable", "spacious"].forEach((d) => {
      const btn = el("button", {
        class: `bc-shape-btn${(settings.layout.density || "comfortable") === d ? " bc-active" : ""}`,
        text: d[0].toUpperCase() + d.slice(1),
        onclick: () => {
          this._set("layout.density", d);
          this._set("layout.compactMode", d === "compact");
          this.renderSection();
        },
      });
      densityRow.appendChild(btn);
    });
    wrap.appendChild(field("Density", densityRow));

    this._appendLayoutDiagnostics(wrap);

    this.contentEl.appendChild(wrap);
  }

  // Read-only status for core/layout-probe.js. Lives at the bottom of Layout
  // because that is the page whose settings stop working first when Anthropic
  // changes their DOM — the sidebar width/position/pin controls above all
  // target claude.ai's own elements.
  //
  // The reason this is in the UI at all, rather than only a console warning:
  // the failure it reports is invisible by construction. A selector that stops
  // matching doesn't throw, so "BetterClaude's chrome is in the wrong place
  // after an update" arrives as a bug report with no diagnostic attached. This
  // turns that into one line a user can read back over a support thread.
  _appendLayoutDiagnostics(wrap) {
    // Guard, don't assume: the browser-extension build shares this file and
    // supplies its own host object, which has no layout-probe bridge. An
    // unguarded call would throw mid-render and blank the whole Layout page.
    if (typeof this.host.getLayoutStatus !== "function") return;

    const LABELS = {
      recognized: "Recognized",
      partial: "Partially recognized",
      unrecognized: "Unrecognized",
      unknown: "Not yet probed",
    };
    const HINTS = {
      recognized: "Every part of claude.ai's layout that BetterClaude styles was found where expected.",
      partial: "BetterClaude found everything it needs, but at least one element only matched a fallback selector. Things should still look right — this is an early warning that a future claude.ai update may break this page's settings.",
      unrecognized: "BetterClaude could not find claude.ai's app layout, so it has stopped applying page geometry and made the title bar click-through rather than risk covering the page. Reload; if this persists, claude.ai's structure has changed and BetterClaude needs an update.",
      unknown: "The layout probe has not reported yet.",
    };

    wrap.appendChild(el("h3", { text: "Claude UI structure" }));

    const valueEl = el("strong", {});
    const hintEl = el("p", { class: "bc-hint" });
    const regionsEl = el("p", { class: "bc-hint" });

    const paint = ({ status, regions }) => {
      const key = LABELS[status] ? status : "unknown";
      valueEl.textContent = LABELS[key];
      hintEl.textContent = HINTS[key];
      // Per-region detail so a "partial" is actionable rather than just
      // ominous — it names which selector degraded.
      //
      // "not present" vs "NOT FOUND" is a real distinction, not wording fuss.
      // The current claude.ai build ships no top-level tab bar at all, so that
      // region is legitimately absent on a completely healthy app; labelling it
      // "not found" made a working install look broken.
      regionsEl.textContent = (regions || [])
        .map((r) => {
          if (r.found) return `${r.label}: ${r.tier === "primary" ? "found" : `fallback (${r.via})`}`;
          return `${r.label}: ${r.absentOk ? "not present (fine)" : "NOT FOUND"}`;
        })
        .join(" · ");
    };

    paint(this.host.getLayoutStatus());
    wrap.appendChild(field("Detection status", valueEl));
    wrap.appendChild(hintEl);
    wrap.appendChild(regionsEl);
    wrap.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Re-check now",
      onclick: () => paint(this.host.recheckLayout()),
    }));

    // Live updates while the page is open: a soft update to claude.ai's shell
    // is exactly the moment this field becomes interesting, and re-rendering
    // the whole section (the usual pattern in this file) would fight the user
    // if they were mid-drag on the sidebar width slider above.
    //
    // Subscribed ONCE for the lifetime of the panel, not once per render.
    // renderSection() runs on every settings change and on every nav click, so
    // subscribing here would push a new callback onto the host's handler array
    // each time and never remove one — the array has no unsubscribe, so those
    // would accumulate for the whole session. Instead the single subscription
    // repaints through whatever the current render assigned, and stale
    // closures die with the nodes they captured.
    this._paintLayoutDiagnostics = paint;
    if (!this._layoutDiagnosticsSubscribed && typeof this.host.onLayoutStatusChanged === "function") {
      this._layoutDiagnosticsSubscribed = true;
      this.host.onLayoutStatusChanged((status, regions) => {
        // isConnected, not a truthiness check: the node exists but is detached
        // once the user navigates to another section, and painting into a
        // detached node is wasted work rather than an error.
        if (this._layoutDiagnosticsAnchor && this._layoutDiagnosticsAnchor.isConnected) {
          this._paintLayoutDiagnostics({ status, regions });
        }
      });
    }
    this._layoutDiagnosticsAnchor = valueEl;
  }

  _renderPlugins() {
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Plugins" }));

    const openFolderBtn = el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Open Plugins Folder",
      onclick: () => this.host.openPluginsFolder(),
    });
    wrap.appendChild(openFolderBtn);

    const list = el("div", { class: "bc-plugin-list" });
    wrap.appendChild(list);
    this.contentEl.appendChild(wrap);

    this.host.listPlugins().then((plugins) => {
      list.innerHTML = "";
      plugins.forEach((p) => {
        const row = el("div", { class: "bc-plugin-row" });
        row.appendChild(el("div", { class: "bc-plugin-info" }, [
          el("strong", { text: p.name || p.id }),
          el("span", { class: "bc-plugin-version", text: `v${p.version || "0.0.0"}` }),
        ]));
        const toggle = el("input", { type: "checkbox" });
        toggle.checked = p.enabled;
        toggle.addEventListener("change", () => this.host.togglePlugin(p.id, toggle.checked));
        row.appendChild(toggle);
        list.appendChild(row);
      });
    });
  }

  _renderShortcuts() {
    const { settings } = this;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Keyboard Shortcuts" }));

    const entries = Object.entries(settings.keyboardShortcuts);
    const counts = {};
    entries.forEach(([, value]) => { counts[value] = (counts[value] || 0) + 1; });

    entries.forEach(([key, value]) => {
      const isDupe = counts[value] > 1;
      // Accelerator strings ("CommandOrControl+Shift+H") routinely exceed the
      // shared .bc-field input min-width, silently clipping the trailing key
      // — the one character that actually distinguishes the shortcut.
      const classes = ["bc-input-shortcut", isDupe ? "bc-input-conflict" : ""].filter(Boolean).join(" ");
      const input = el("input", { type: "text", value, class: classes });
      input.addEventListener("change", () => {
        this._set(`keyboardShortcuts.${key}`, input.value);
        this.renderSection();
      });
      wrap.appendChild(field(key, input));
      if (isDupe) {
        wrap.appendChild(el("p", { class: "bc-hint bc-conflict-hint" }, [
          el("span", { class: "bc-warn-icon", html: ICONS.WARNING }),
          el("span", { text: `"${value}" is assigned to more than one shortcut — only one will fire.` }),
        ]));
      }
    });
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Restart BetterClaude for accelerator changes to take effect.",
    }));

    this.contentEl.appendChild(wrap);
  }
}

// Mixed in rather than inlined so panel.js doesn't grow into one enormous
// file as new settings categories are added — each mixin is a plain object
// of _render* methods that assume `this` is a SettingsPanel instance
// (same contract as every _render* method defined above).
Object.assign(
  SettingsPanel.prototype,
  cursorSoundSection,
  motionNotificationsSection,
  focusInputSection,
  widgetsSection,
  buddiesSection,
  powerUserSection,
  playfulSection,
  skillMarketplaceSection,
  promptLibrarySection,
  fileWatcherSection,
  clipboardBridgeSection,
  analyticsSection,
  teamSyncSection,
);

module.exports = { SettingsPanel, PANEL_ID, THEME_LABELS, SECTIONS };

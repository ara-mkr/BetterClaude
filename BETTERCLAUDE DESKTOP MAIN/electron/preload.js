/**
 * Preload — the only place besides main.js allowed to touch Node/Electron
 * APIs. It plays the role a background/content-script pair would play in a
 * browser extension: `ipcRenderer.invoke`/`.on` here is the direct analog
 * of `chrome.runtime.sendMessage` / `onMessage`. Everything it hands to the
 * /core and /ui modules is plain data or plain callback functions — those
 * modules never see `ipcRenderer` directly, which is what keeps them
 * portable to a real content script later.
 *
 * Note on contextIsolation: preload runs in its own JS realm but shares the
 * live DOM with the page, so calling document.* here really does mutate
 * what's on screen — no contextBridge round-trip is needed for that part.
 */
const { ipcRenderer } = require("electron");

const { ThemeEngine, resolveScheduledTheme, ensureStyleTag, restoreClaudeColorMode } = require("../core/theme-engine");
const { TokenCounter, collectConversationText, estimateTokens } = require("../core/token-counter");
const { fetchAccountUsage } = require("../core/account-usage");
const { HUD } = require("../core/hud");
const { PluginLoader } = require("../core/plugin-loader");
const { buildExtrasCSS, applyColorBlindSafeVars } = require("../core/extras-css");
const { InteractionFX } = require("../core/interaction-fx");
const { SoundEngine } = require("../core/sound-engine");
const { celebrate, mountParallax, mountSeasonalDecoration, pickLoadingTip } = require("../core/motion-fx");
const { Companion, checkAchievements, incrementStreak, buildGreeting, ACHIEVEMENTS } = require("../core/companion");
const { CommandPalette, mountKonamiListener } = require("../core/command-palette");
const { SkillMarketplaceOverlay } = require("../core/skill-marketplace");
const { PromptPicker } = require("../core/prompt-picker");
const { mountBranchForkButtons } = require("../core/branch-fork-buttons");
const { DiffViewer } = require("../core/diff-viewer");
const { ContextBudgetPlanner } = require("../core/context-budget");
const { SemanticSearchOverlay } = require("../core/semantic-search");
const { ModelRouter } = require("../core/model-router");
const { findAndReplaceInComposer, insertFileBlock } = require("../core/file-sync-indicator");
const { MacroRecorder, replayMacro } = require("../core/macro-recorder");
const { mountCodeDiffButtons, DiffApplierOverlay } = require("../core/diff-applier");
const { AnalyticsDashboard } = require("../core/analytics-dashboard");
const { extractVariables, fillTemplate } = require("../core/prompt-vars");
const { VIBE_BUNDLES, pickRandomBundle, bundleForMood, bundleForSeason, applyBundle } = require("../core/vibe-bundles");
const { mapWeatherCodeToBundle } = require("../core/weather");
const { shouldSuppress, notificationStyleClass } = require("../core/notifications");
const { insertIntoComposer, waitForComposer, buildTranscriptText, findComposer, findSendButton, getComposerText } = require("../core/compose-insert");

const { mountTitleBar } = require("../ui/title-bar");
const { SettingsPanel, SECTIONS } = require("../ui/settings-panel/panel");
const { mountSnakeGame } = require("../ui/mini-game/snake");

const fs = require("fs");
const path = require("path");

function injectStaticCSS(id, filePath) {
  const tag = document.createElement("style");
  tag.id = id;
  tag.textContent = fs.readFileSync(filePath, "utf8");
  document.head.appendChild(tag);
}

// Plugins are loaded via Node's require() on their on-disk path rather than
// eval/new Function: claude.ai's Content-Security-Policy disallows
// string-to-code generation ("unsafe-eval") for the whole renderer
// (including preload's isolated context), so eval-based loading throws.
// require() goes through Node's own module compiler, which CSP doesn't gate.
function loadPluginModule(absolutePath) {
  delete require.cache[require.resolve(absolutePath)];
  return require(absolutePath);
}

async function bootstrap() {
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve);
  });

  // Required lazily (not at module top-level): @codemirror/view does
  // feature-detection against `document.body` at import time, which is
  // still null before DOMContentLoaded and would crash preload's
  // synchronous top-level requires.
  const cssEditor = require("../build/css-editor.bundle.js");

  // Static chrome stylesheets (not part of the theme system's swappable tags).
  injectStaticCSS("betterclaude-squircle-css", path.join(__dirname, "../ui/squircle.css"));
  injectStaticCSS("betterclaude-titlebar-css", path.join(__dirname, "../ui/title-bar.css"));
  injectStaticCSS("betterclaude-hud-css", path.join(__dirname, "../ui/hud/hud.css"));
  injectStaticCSS("betterclaude-panel-css", path.join(__dirname, "../ui/settings-panel/panel.css"));
  injectStaticCSS("betterclaude-overlays-css", path.join(__dirname, "../ui/overlays.css"));
  injectStaticCSS("betterclaude-skill-marketplace-css", path.join(__dirname, "../ui/skill-marketplace.css"));

  let settings = await ipcRenderer.invoke("settings:get");
  const themes = await ipcRenderer.invoke("themes:get-all");
  let osThemeIsDark = (await ipcRenderer.invoke("system:get-os-theme")).isDark;

  // A forked branch window lands here on https://claude.ai/new#bc-fork=<id>
  // (see electron/main.js's createBranchWindow). Consumed exactly once and
  // the hash is stripped immediately so it doesn't linger in the URL bar.
  // Never auto-submits — insertIntoComposer only fills the textarea.
  async function handlePendingForkHash() {
    const m = /bc-fork=([^&]+)/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    const text = await ipcRenderer.invoke("branching:consume-pending-fork", m[1]);
    if (!text) return;
    const composer = await waitForComposer();
    if (!composer) return;
    insertIntoComposer(text, { append: false });
  }
  handlePendingForkHash().catch((err) => console.error("[BetterClaude] fork hash handling failed", err));

  // Best-effort "jump to result" for Semantic Search: setting location.href
  // (below, in jumpToResult) is a full page reload even for a same-origin
  // SPA route, so a plain JS variable can't survive it — sessionStorage
  // does, and is cleared immediately so it only ever fires once.
  function scrollToSnippet(snippet) {
    const needle = (snippet || "").replace(/…$/, "").slice(0, 60).trim();
    if (!needle) return;
    const turns = collectConversationText(document);
    const match = turns.find((t) => t.text.includes(needle));
    if (match && match.node && match.node.scrollIntoView) {
      match.node.scrollIntoView({ behavior: "smooth", block: "center" });
      match.node.classList && match.node.classList.add("bc-search-highlight");
      setTimeout(() => match.node.classList && match.node.classList.remove("bc-search-highlight"), 2000);
    }
  }
  try {
    const pendingSnippet = sessionStorage.getItem("bc-scroll-to-snippet");
    if (pendingSnippet) {
      sessionStorage.removeItem("bc-scroll-to-snippet");
      // Give claude.ai's own render a moment to paint the conversation
      // before searching the DOM for the match.
      setTimeout(() => scrollToSnippet(pendingSnippet), 1200);
    }
  } catch (_e) {
    // sessionStorage can throw under some privacy settings — non-fatal.
  }

  // --- Theme engine ---
  const themeEngine = new ThemeEngine({ presets: themes });

  // --- Customize Everything: cursor/sound/motion/companion/palette engines ---
  const soundEngine = new SoundEngine();
  const companion = new Companion();
  let interactionFX = null; // mounted/unmounted with the general kill-switch
  let stopParallax = null;
  let stopSeasonal = null;
  const commandPalette = new CommandPalette({ onExecute: (cmd) => runCommand(cmd) });
  let stopKonami = null;

  // --- Skill Marketplace ---
  // getCachedItems/getInstalledMap read the local `settings` closure var
  // directly (kept fresh by the betterclaude:settings-changed handler below)
  // instead of round-tripping through IPC for data we already have.
  const skillMarketplace = new SkillMarketplaceOverlay({
    getCachedItems: () => (settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || [],
    getInstalledMap: () => settings.skillMarketplace.installed || {},
    searchSkills: (params) => ipcRenderer.invoke("skills:search", params),
    getReadme: (params) => ipcRenderer.invoke("skills:get-readme", params),
    installSkill: (item) => ipcRenderer.invoke("skills:install", item),
    revealSkill: (id) => ipcRenderer.invoke("skills:reveal", id),
    notify: (message) => notify(message, { category: "plugin" }),
  });

  // --- Prompt Library ---
  const promptPicker = new PromptPicker({
    getPrompts: () => settings.promptLibrary.prompts || [],
    insertIntoComposer: (text) => insertIntoComposer(text),
    notify: (message) => notify(message, { category: "plugin" }),
    // Macro Recorder's capture hook — see the "Macro Recorder" section below.
    onInsert: (meta) => { pendingMacroStepSource = meta; },
  });

  // --- Conversation Branching ---
  const diffViewer = new DiffViewer();

  // --- Context Budget Planner ---
  // Shared, time-windowed bypass for every composer-send interceptor
  // (Context Budget Planner, Model Router — see both files' headers for
  // why a private per-instance flag breaks once more than one interceptor
  // sits on the same composer/send-button: a resend from one re-fires every
  // sibling's own listener too, so bypass state needs to be shared and
  // survive that whole chain, not be consumed by whichever runs first).
  let sendBypassUntil = 0;
  const isSendBypassed = () => Date.now() < sendBypassUntil;
  const setSendBypass = (ms = 800) => { sendBypassUntil = Date.now() + ms; };

  const contextBudgetPlanner = new ContextBudgetPlanner({
    getUsage: () => (lastUsage ? { usedTokens: lastUsage.usedTokens, contextWindow: lastUsage.contextWindow } : { usedTokens: 0, contextWindow: tokenCounter.contextWindow }),
    getThreshold: () => (settings.contextBudget ? settings.contextBudget.warnThresholdPercent : 75),
    isEnabled: () => !!(settings.contextBudget && settings.contextBudget.enabled),
    isBypassed: isSendBypassed,
    setBypass: setSendBypass,
  });

  // --- Multi-Model Routing ---
  const modelRouter = new ModelRouter({
    getRules: () => (settings.modelRouting ? settings.modelRouting.rules : []),
    getDefaultModel: () => (settings.modelRouting ? settings.modelRouting.defaultModel : ""),
    isEnabled: () => !!(settings.modelRouting && settings.modelRouting.enabled),
    notify: (message) => notify(message, { category: "plugin" }),
    isBypassed: isSendBypassed,
    setBypass: setSendBypass,
  });

  // --- Macro Recorder ---
  // Set by core/prompt-picker.js's onInsert hook right before a send, so the
  // capture step below can tell "this send's text came from a Prompt
  // Library entry" (record a re-resolvable {type:"prompt"} step) apart from
  // arbitrary typed text ({type:"text"}).
  let pendingMacroStepSource = null;
  let replayStopRequested = false;

  function finishRecording() {
    const macro = macroRecorder.stopRecording();
    if (macro.steps.length === 0) {
      notify("Recording stopped — no steps captured.", { category: "plugin" });
      return;
    }
    const record = {
      id: `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: macro.name,
      shortcut: null,
      steps: macro.steps,
      createdAt: Date.now(),
    };
    const next = [...(settings.macros.list || []), record];
    settings.macros.list = next;
    setSetting("macros.list", next);
    notify(`Saved macro "${record.name}" (${record.steps.length} step${record.steps.length === 1 ? "" : "s"}).`, { category: "plugin" });
  }

  const macroRecorder = new MacroRecorder({
    onStopRecording: () => finishRecording(),
    onStopReplay: () => { replayStopRequested = true; },
  });

  // Re-resolves a {type:"prompt"} step at replay time (not at record time)
  // so {{clipboard}} picks up whatever's on the clipboard *during replay* —
  // {{selection}} can't be meaningfully re-captured unattended (no user
  // gesture is selecting text mid-replay), so it falls back to whatever was
  // captured when the step was originally recorded, if anything.
  async function resolvePromptStep(step) {
    const prompt = (settings.promptLibrary.prompts || []).find((p) => p.id === step.promptId);
    if (!prompt) return ""; // deleted since recording — replay as empty rather than crash
    const vars = extractVariables(prompt.body);
    const values = { ...step.values };
    if (vars.includes("clipboard") && navigator.clipboard && navigator.clipboard.readText) {
      try { values.clipboard = await navigator.clipboard.readText(); } catch (_e) { /* keep recorded value */ }
    }
    return fillTemplate(prompt.body, values);
  }

  async function doReplayMacro(macro) {
    if (!macro || !macro.steps || macro.steps.length === 0) {
      notify("This macro has no steps.");
      return;
    }
    if (macroRecorder.isReplaying()) {
      notify("A macro is already replaying — stop it first.");
      return;
    }
    replayStopRequested = false;
    macroRecorder.startReplay(macro.steps.length);
    const result = await replayMacro(macro, {
      insertText: (text) => insertIntoComposer(text, { append: false }),
      clickSend: () => { const btn = findSendButton(document); if (btn) btn.click(); },
      getTurns: () => collectConversationText(document),
      resolvePromptStep,
      onStep: (i) => macroRecorder.setReplayIndex(i + 1),
      shouldStop: () => replayStopRequested,
    });
    macroRecorder.stopReplay();
    if (result.stopped) {
      notify(
        result.timedOut
          ? `Macro stopped — timed out waiting for a response (step ${result.completedSteps}).`
          : `Macro stopped after ${result.completedSteps} step(s).`,
        { category: "plugin", urgent: result.timedOut }
      );
    } else {
      notify(`Macro "${macro.name}" finished (${result.completedSteps} steps).`, { category: "plugin" });
    }
  }

  // Observes (never blocks) the same send action Context Budget/Model
  // Router intercept — records a step when recording is active, then always
  // lets the send through untouched. Self-healing re-attach happens in
  // refreshUsage() below, same pattern as the other composer-attached
  // features.
  let macroCaptureComposer = null;
  function attachMacroCaptureIfNeeded() {
    const composer = findComposer(document);
    if (!composer || composer === macroCaptureComposer) return;
    macroCaptureComposer = composer;
    const capture = () => {
      if (!macroRecorder.isRecording()) return;
      const text = getComposerText(composer);
      if (!text.trim()) return;
      if (pendingMacroStepSource && pendingMacroStepSource.filledText === text) {
        macroRecorder.recordStep({ type: "prompt", promptId: pendingMacroStepSource.promptId, values: pendingMacroStepSource.values });
      } else {
        macroRecorder.recordStep({ type: "text", text });
      }
      pendingMacroStepSource = null;
    };
    const safeCapture = () => { try { capture(); } catch (err) { console.error("[BetterClaude] Macro capture error", err); } };
    composer.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) safeCapture(); }, true);
    const sendBtn = findSendButton(document);
    if (sendBtn) sendBtn.addEventListener("click", () => safeCapture(), true);
  }

  // --- Local Semantic Search ---
  function jumpToResult(item) {
    if (location.href === item.conversationUrl) {
      scrollToSnippet(item.snippet);
      return;
    }
    try { sessionStorage.setItem("bc-scroll-to-snippet", item.snippet); } catch (_e) { /* non-fatal */ }
    location.href = item.conversationUrl;
  }

  const semanticSearch = new SemanticSearchOverlay({
    query: (params) => ipcRenderer.invoke("search:query", params),
    jumpToResult,
  });

  // Buffered, not per-turn: flushed on a timer / page unload rather than
  // firing an IPC call for every finalized message.
  let searchIndexBuffer = [];
  function bufferForIndexing(turn, idx) {
    if (!settings.semanticSearch || !settings.semanticSearch.enabled) return;
    searchIndexBuffer.push({ idx, role: turn.role, text: turn.text });
  }
  function flushSearchIndex() {
    if (searchIndexBuffer.length === 0) return;
    if (!settings.semanticSearch || !settings.semanticSearch.enabled) {
      searchIndexBuffer = [];
      return;
    }
    const turns = searchIndexBuffer;
    searchIndexBuffer = [];
    ipcRenderer.invoke("search:index-turns", { conversationUrl: location.href, title: document.title, turns })
      .catch((err) => console.error("[BetterClaude] search indexing failed", err));
  }
  setInterval(flushSearchIndex, 15000);
  window.addEventListener("beforeunload", flushSearchIndex);
  // Declared (not initialized) here, assigned further down once notify/hud
  // are ready — effectiveSoundSettings below can run before that assignment
  // (it's invoked from applyThemeState's very first call), so it needs a
  // `let` it can safely check rather than a `const` it would TDZ-fault on.
  let pluginLoader;

  // Effective (not persisted) sound settings: automations layer temporary
  // behavior (Zen Mode muting, Focus Mode pausing ambient) on top of the
  // user's real saved sound settings, without ever overwriting them.
  function effectiveSoundSettings() {
    const sound = settings.sound;
    const zenActive = !!(settings.focusReading && settings.focusReading.zenMode);
    const focusModeEntry = pluginLoader && pluginLoader.loaded.get("focus-mode");
    const focusActive = !!(focusModeEntry && focusModeEntry.module.active);
    const forcedMute = zenActive && settings.automations.zenMutesSound;
    const forcedAmbientOff = focusActive && settings.automations.focusPausesAmbient;
    return {
      ...sound,
      muted: sound.muted || forcedMute,
      ambient: forcedAmbientOff ? { ...sound.ambient, track: "off" } : sound.ambient,
    };
  }

  function applyExtras() {
    ensureStyleTag("betterclaude-extras").textContent = buildExtrasCSS(settings);
    applyColorBlindSafeVars(!!(settings.appearance && settings.appearance.colorBlindSafe));
    document.documentElement.dataset.bcMood = (settings.personality && settings.personality.mood) || "";
    // Zen Mode = Focus Mode plugin (see syncZenModeWithFocusPlugin) + these
    // two additionally hidden, so only the conversation itself is visible.
    document.body.classList.toggle("bc-zen-mode", !!(settings.focusReading && settings.focusReading.zenMode));

    soundEngine.applySettings({ sound: effectiveSoundSettings() });
    companion.update(settings);

    if (interactionFX) interactionFX.applySettings(settings);

    if (settings.motion && settings.motion.parallax && !stopParallax) {
      stopParallax = mountParallax(() => [
        document.getElementById("bc-companion"),
        document.getElementById("betterclaude-hud"),
      ]);
    } else if ((!settings.motion || !settings.motion.parallax) && stopParallax) {
      stopParallax();
      stopParallax = null;
    }

    const wantsSeasonal = !!(settings.motion && settings.motion.seasonalDecorations);
    if (wantsSeasonal && !stopSeasonal) {
      stopSeasonal = mountSeasonalDecoration(new Date().getMonth());
    } else if (!wantsSeasonal && stopSeasonal) {
      stopSeasonal();
      stopSeasonal = null;
    }
  }

  // Optimistic, synchronous full re-render for a Vibe Bundle preview (theme +
  // shape + cursor + motion together). A bundle also changes
  // appearanceEditor.shape and cursor.style/trail, which live in the BASE and
  // EXTRAS style layers (border-radius, cursor CSS/trail) rather than the
  // theme layer that themeEngine.setTheme() alone rebuilds. Those two layers
  // only used to catch up once the async settings:set round trip resolved
  // and the "betterclaude:settings-changed" broadcast re-ran applyThemeState
  // — leaving corners sharp and the cursor on its old style/trail in the
  // meantime, worse if a rapid second click's response resolved first. Patch
  // the local settings snapshot and re-run the real pipeline here instead, so
  // the whole bundle lands in one synchronous paint that already matches what
  // the eventual persisted round trip will produce.
  function applyBundlePreview(bundle) {
    Object.assign(settings.appearance, { activeTheme: bundle.themeId });
    Object.assign(settings.appearanceEditor, { shape: bundle.shape });
    Object.assign(settings.cursor, { style: bundle.cursorStyle, trail: bundle.cursorTrail });
    Object.assign(settings.motion, { easing: bundle.easing, transition: bundle.transition });
    themeEngine.applySettings(settings);
    applyExtras();
  }

  // themeEngine.setAccentColor() writes --bc-accent/--bc-accent-hover/
  // --bc-focus-ring/--bc-border-focus (and possibly other --bc-*-derived
  // vars added later) directly onto document.documentElement.style, i.e.
  // outside the injected <style id="betterclaude-*"> tags that the rest of
  // applyThemeState's disabled-branch already clears. Those inline
  // properties otherwise survive the master toggle (e.g. ui/title-bar.css
  // reading var(--bc-accent, ...) for the traffic-light dots even with
  // BetterClaude fully off). Rather than hardcoding that variable list here
  // (which would silently drift from theme-engine.js's list), just sweep
  // every inline BetterClaude custom property document.documentElement
  // carries (both --bc-* palette tokens and --btn-* state tokens) — robust
  // to that set changing upstream.
  function clearInlineAccentVariables() {
    const style = document.documentElement.style;
    // Snapshot names first: mutating a live CSSStyleDeclaration while
    // iterating it by index can skip entries as indices shift.
    const bcProps = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (prop.startsWith("--bc-") || prop.startsWith("--btn-")) bcProps.push(prop);
    }
    bcProps.forEach((prop) => style.removeProperty(prop));
  }

  // Master kill-switch: everything downstream (theme CSS, HUD, plugins)
  // only actually gets applied when general.enabled isn't false. This lets
  // Settings -> Appearance fully revert to stock claude.ai without an
  // uninstall, and flip back on just by re-checking the box. The title bar
  // itself stays mounted regardless (it's the only way back into Settings
  // once frame:false has removed the OS chrome).
  function applyThemeState() {
    if (settings.general && settings.general.enabled === false) {
      ["betterclaude-theme", "betterclaude-base", "betterclaude-custom-css", "betterclaude-background", "betterclaude-extras"].forEach((id) => {
        const tag = document.getElementById(id);
        if (tag) tag.textContent = "";
      });
      hud.setVisible(false);
      companion.update({ personality: { companionEnabled: false } });
      if (interactionFX) {
        interactionFX.unmount();
        interactionFX = null;
      }
      if (stopParallax) { stopParallax(); stopParallax = null; }
      if (stopSeasonal) { stopSeasonal(); stopSeasonal = null; }
      soundEngine.applySettings({ sound: { ...settings.sound, muted: true, ambient: { track: "off" } } });
      // Revert claude.ai's own color-mode (dark class / color-scheme) to
      // exactly what it was before BetterClaude ever touched it (§4.1).
      restoreClaudeColorMode();
      // Remove the inline --bc-accent/--bc-accent-hover/--bc-focus-ring/
      // --bc-border-focus (etc.) custom properties setAccentColor() wrote
      // directly onto :root, so no theming remnant (e.g. the title bar's
      // accent-colored traffic-light dots) survives the master toggle.
      clearInlineAccentVariables();
    } else {
      themeEngine.applySettings(settings);
      hud.applyVisualSettings(settings.hud);
      hud.applyPosition(settings.hud);
      if (!interactionFX) {
        interactionFX = new InteractionFX({ onRadialAction: (id) => runRadialAction(id) });
        interactionFX.mount(settings);
      }
      applyExtras();
    }
  }

  // Scheduled/automatic theme switching lives on top of applyThemeState
  // rather than inside it: it never touches settings.appearance.activeTheme
  // in storage, so flipping the schedule back to "off" cleanly falls back
  // to whatever the user last picked manually in the Themes tab.
  function applyScheduledTheme() {
    if (settings.general && settings.general.enabled === false) return;
    // A manual cosmetic edit has intentionally created a frozen Custom
    // appearance. Schedules must not paint a different preset over that
    // state while leaving the UI labelled Custom.
    if (settings.appearance && settings.appearance.activeTheme === "custom") return;
    const schedule = settings.appearance && settings.appearance.schedule;
    if (schedule && schedule.mode === "season") {
      const bundle = bundleForSeason(new Date().getMonth());
      if (bundle && themes[bundle.themeId]) themeEngine.setTheme(bundle.themeId);
      return;
    }
    const themeId = resolveScheduledTheme(schedule, { isDarkOS: osThemeIsDark });
    if (themeId && themes[themeId]) themeEngine.setTheme(themeId);
  }

  // Opt-in: fetches current weather (main-process IPC, see electron/main.js)
  // and applies the matched Vibe Bundle. Mutually exclusive in effect with
  // the time/OS/season schedule above — whichever runs most recently wins,
  // same "last write wins" behavior the existing schedule already has.
  async function applyScheduledWeatherTheme() {
    const wt = settings.appearance && settings.appearance.weatherTheme;
    if (settings.appearance && settings.appearance.activeTheme === "custom") return false;
    if (!wt || !wt.enabled || wt.lat == null || wt.lon == null) return false;
    try {
      const { code, isDay } = await ipcRenderer.invoke("weather:get", { lat: wt.lat, lon: wt.lon });
      const bundle = mapWeatherCodeToBundle(code, isDay);
      if (!bundle) return false;
      applyBundle(bundle, { setSetting, selectTheme });
      return true;
    } catch (err) {
      console.error("[BetterClaude] weather theme fetch failed", err);
      return false;
    }
  }

  // Rotates settings.background.mode/color/gradient/imageDataUrl/fit through
  // the saved pool on an interval — same schedule-on-top-of-storage pattern
  // as applyScheduledTheme (never mutates the pool itself).
  let lastRotationAt = Date.now();
  function applyBackgroundRotation() {
    const rotation = settings.background && settings.background.rotation;
    if (!rotation || !rotation.enabled || !rotation.pool || rotation.pool.length === 0) return;
    const intervalMs = Math.max(15, rotation.intervalMinutes || 60) * 60 * 1000;
    const now = Date.now();
    if (now - lastRotationAt < intervalMs) return;
    lastRotationAt = now;
    const currentIndex = rotation.pool.findIndex((snap) => snap.mode === settings.background.mode
      && snap.color === settings.background.color && snap.gradient === settings.background.gradient);
    const next = rotation.pool[(currentIndex + 1 + rotation.pool.length) % rotation.pool.length];
    Object.entries(next).forEach(([key, value]) => setSetting(`background.${key}`, value));
  }

  async function applyPluginState() {
    const sources = await ipcRenderer.invoke("plugins:list-sources");
    if (settings.general && settings.general.enabled === false) {
      pluginLoader.list().forEach((p) => pluginLoader.unload(p.id));
      return;
    }
    sources.forEach(({ id, path: pluginPath }) => {
      // Focus Mode has no shipped product surface yet. Do not resurrect its
      // launcher from an older persisted `true` value.
      if (id === "focus-mode") {
        if (pluginLoader.list().some((p) => p.id === id)) pluginLoader.unload(id);
        return;
      }
      const shouldBeEnabled = settings.plugins.enabled[id] !== false;
      const isLoaded = pluginLoader.list().some((p) => p.id === id);
      if (shouldBeEnabled && !isLoaded) {
        try {
          pluginLoader.load(id, loadPluginModule(pluginPath));
        } catch (err) {
          console.error(`[BetterClaude] failed to evaluate plugin "${id}"`, err);
        }
      } else if (!shouldBeEnabled && isLoaded) {
        pluginLoader.unload(id);
      }
    });
  }

  // --- Settings persistence bridge ---
  // Returns the update promise (a promise is truthy, so existing
  // fire-and-forget call sites like `setSetting(a) && setSetting(b)` still
  // work unchanged) so new callers that need the fresh settings back —
  // saveProfile, applyProfile — can `await` it instead of racing a stale
  // read of the outer `settings` variable.
  function setSetting(keyPath, value) {
    const cosmetic = /^(appearance\.(accentColor|colorBlindSafe|contrastBoost|glassPanels)|appearanceEditor\.|background\.|customCSS\.|fonts\.|layout\.|cursor\.|motion\.)/.test(keyPath);
    const write = cosmetic
      ? ipcRenderer.invoke("appearance:set-cosmetic", keyPath, value)
      : ipcRenderer.invoke("settings:set", keyPath, value);
    return write.then((updated) => {
      settings = updated;
      return updated;
    });
  }

  function selectTheme(themeId) {
    return ipcRenderer.invoke("appearance:select-theme", themeId).then((updated) => {
      settings = updated;
      return updated;
    });
  }

  const settingsChangedHandlers = [];

  // --- Token counter + HUD ---
  const tokenCounter = new TokenCounter({ modelName: "claude" });
  const hud = new HUD({
    onPositionChange: (pos) => setSetting("hud.x", pos.x) && setSetting("hud.y", pos.y),
    onDismiss: () => setSetting("hud.enabled", false),
  });
  hud.mount(settings);
  // applyPosition() re-clamps against the current viewport, but nothing
  // calls it when the window itself is resized after a drag — without this,
  // shrinking the window can leave a previously-valid saved position
  // pushing the HUD (and its account-usage rows) off the bottom/right edge.
  window.addEventListener("resize", () => hud.applyPosition(settings.hud));
  companion.mount(settings);

  let lastUsage = null;
  // Never show auxiliary chrome on Claude's public sign-in/marketing route,
  // and do not surface an empty "0 tokens" meter before a real turn exists.
  function syncContextualChrome() {
    const hasComposer = !!document.querySelector('[data-testid="chat-input"]');
    const hasUsage = !!(lastUsage && lastUsage.turnCount > 0);
    document.body.classList.toggle("bc-signed-out", !hasComposer);
    hud.setVisible(!!(settings.hud && settings.hud.enabled && hasComposer && hasUsage));
    companion.update({
      ...settings,
      personality: { ...settings.personality, companionEnabled: !!(settings.personality && settings.personality.companionEnabled && hasComposer) },
    });
    // Cursor trails/ripples/radial controls are app chrome, not part of a
    // sign-in screen. Do not let a saved Vibe Bundle spill visual effects
    // over Claude's authentication flow.
    if (!hasComposer && interactionFX) {
      interactionFX.unmount();
      interactionFX = null;
    } else if (hasComposer && !interactionFX && (!settings.general || settings.general.enabled !== false)) {
      interactionFX = new InteractionFX({ onRadialAction: (id) => runRadialAction(id) });
      interactionFX.mount(settings);
    }
  }
  applyThemeState();
  syncContextualChrome();
  applyScheduledTheme();
  applyScheduledWeatherTheme();
  setInterval(applyScheduledTheme, 60 * 1000);
  setInterval(applyScheduledWeatherTheme, 30 * 60 * 1000);
  setInterval(applyBackgroundRotation, 60 * 1000);
  ipcRenderer.on("betterclaude:os-theme-changed", (_e, { isDark }) => {
    osThemeIsDark = isDark;
    applyScheduledTheme();
  });

  // Minimal, dependency-free toast, shared by the plugin API's api.notify()
  // and the settings panel host bridge. `category` gates it through
  // core/notifications.js's DND/priority check and per-type enable flag,
  // and picks a visual variant per settings.notifications.style.
  function showToast(message, { category = null, timeout = 3000 } = {}) {
    const style = (settings.notifications && settings.notifications.style) || "banner";
    const typeConf = category && settings.notifications && settings.notifications.types[category];

    const toast = document.createElement("div");
    toast.className = `bc-toast ${notificationStyleClass(style)}`;
    if (style === "badge" && typeConf) {
      toast.textContent = typeConf.icon || "•";
      toast.title = message;
    } else {
      toast.textContent = (typeConf && typeConf.icon ? `${typeConf.icon} ` : "") + message;
    }
    if (typeConf && typeConf.color) toast.style.borderColor = typeConf.color;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), timeout);
  }

  // --- Smart Notification Digest ---
  // Off by default (settings.notifications.digest.enabled) — every call
  // still shows immediately, unchanged, until the user opts in. Once on,
  // routine categorized completions (macro replay finished, Team Sync
  // applied files, clipboard synced, ...) queue instead of interrupting one
  // at a time; a periodic flush shows ONE native OS notification
  // summarizing what changed. `urgent: true` (failures) always bypasses the
  // queue and fires immediately as both an in-page toast and a native
  // notification, so this only changes *routine* visibility, never errors.
  let digestQueue = [];

  function flushDigest() {
    if (digestQueue.length === 0) return;
    const items = digestQueue;
    digestQueue = [];
    const shown = items.slice(0, 5).map((i) => i.message);
    const summary = shown.join(" · ") + (items.length > shown.length ? ` · +${items.length - shown.length} more` : "");
    showToast(`${items.length} update${items.length === 1 ? "" : "s"}: ${summary}`, { timeout: 6000 });
    ipcRenderer.invoke("notifications:show-native", {
      title: `BetterClaude — ${items.length} update${items.length === 1 ? "" : "s"}`,
      body: summary,
    }).catch(() => {});
  }

  let digestTimer = null;
  function syncDigestTimer() {
    if (digestTimer) {
      clearInterval(digestTimer);
      digestTimer = null;
    }
    const digest = settings.notifications && settings.notifications.digest;
    if (!digest || !digest.enabled) {
      flushDigest(); // drain anything already queued rather than lose it silently
      return;
    }
    const intervalMs = Math.max(1, digest.intervalMinutes || 15) * 60 * 1000;
    digestTimer = setInterval(flushDigest, intervalMs);
  }

  function notify(message, { category = null, timeout = 3000, urgent = false } = {}) {
    if (category && settings.notifications && shouldSuppress(settings.notifications, category)) return;
    const digest = settings.notifications && settings.notifications.digest;
    if (category && digest && digest.enabled && !urgent) {
      digestQueue.push({ message, category, ts: Date.now() });
      return;
    }
    showToast(message, { category, timeout });
    if (urgent) {
      ipcRenderer.invoke("notifications:show-native", { title: "BetterClaude", body: message }).catch(() => {});
    }
  }

  // --- Plugin loader ---
  pluginLoader = new PluginLoader({
    themeEngine,
    hud,
    getSettings: () => settings,
    setSetting,
    host: {
      getLastUsage: () => lastUsage,
      notify,
    },
  });

  // --- New-message detection ---
  // Turns are dispatched to plugins once their text stops changing between
  // two consecutive ticks, so assistant messages are reported only after
  // streaming finishes (not once per token). If several turns appear between
  // ticks (e.g. a user message immediately followed by a settled assistant
  // one), everything except the newest turn is already final and dispatched
  // right away.
  let dispatchedTurnCount = 0;
  let pendingTurnText = null;

  // --- Usage Analytics Dashboard: local event logging ---
  // Off by default (settings.analytics.enabled) — nothing is logged, let
  // alone sent anywhere, until the user opts in. "message" events feed
  // tokens/day, messages/day, busiest-projects, and estimated cost; "plugin"
  // events are one tick per currently-enabled plugin per dispatched
  // message, the honest proxy this app has for "most-used skills/plugins"
  // without instrumenting each plugin's internals individually.
  function costForTokens(role, tokens) {
    const rates = (settings.analytics && settings.analytics.costPerMillionTokens) || { input: 0, output: 0 };
    const rate = role === "user" ? rates.input : rates.output;
    return (tokens / 1000000) * (rate || 0);
  }

  function logMessageAnalytics(turn) {
    if (!settings.analytics || !settings.analytics.enabled) return;
    const tokens = estimateTokens(turn.text);
    ipcRenderer.invoke("analytics:log-event", {
      ts: Date.now(),
      day: new Date().toISOString().slice(0, 10),
      type: "message",
      role: turn.role,
      tokens,
      model: tokenCounter.modelName,
      project: document.title || location.href,
      costUsd: costForTokens(turn.role, tokens),
    }).catch(() => {});
  }

  function logPluginAnalyticsTick() {
    if (!settings.analytics || !settings.analytics.enabled) return;
    const pluginIds = pluginLoader.list().map((p) => p.id);
    if (pluginIds.length === 0) return;
    ipcRenderer.invoke("analytics:log-plugin-tick", { ts: Date.now(), day: new Date().toISOString().slice(0, 10), pluginIds }).catch(() => {});
  }

  function detectAndDispatchNewMessages(turns) {
    if (turns.length === 0) {
      dispatchedTurnCount = 0;
      pendingTurnText = null;
      return;
    }

    const lastIndex = turns.length - 1;

    // Any turn strictly before the current last one is necessarily final —
    // a newer turn already exists after it — so flush those immediately.
    while (dispatchedTurnCount < lastIndex) {
      const turn = turns[dispatchedTurnCount];
      pluginLoader.dispatchMessage({ role: turn.role, text: turn.text, node: turn.node });
      logMessageAnalytics(turn);
      logPluginAnalyticsTick();
      bufferForIndexing(turn, dispatchedTurnCount);
      dispatchedTurnCount += 1;
    }

    if (dispatchedTurnCount > lastIndex) return; // already dispatched the last turn too

    const lastTurn = turns[lastIndex];
    if (pendingTurnText === lastTurn.text) {
      pluginLoader.dispatchMessage({ role: lastTurn.role, text: lastTurn.text, node: lastTurn.node });
      logMessageAnalytics(lastTurn);
      logPluginAnalyticsTick();
      bufferForIndexing(lastTurn, lastIndex);
      dispatchedTurnCount = turns.length;
      pendingTurnText = null;
      // The real session/weekly rate-limit only changes server-side once a
      // message round-trip finishes (see refreshAccountUsage below) — a turn
      // becoming "dispatched" here means its text just stopped changing
      // between polls, i.e. streaming finished. Refetching right now instead
      // of waiting up to 60s for the next interval tick is what actually
      // closes the staleness gap users notice ("says 63, account page says
      // 62"), since neither number is wrong, just briefly out of date.
      refreshAccountUsage();
    } else {
      pendingTurnText = lastTurn.text;
    }
  }

  // --- Conversation Branching: fork buttons ---
  // Shared by an in-conversation "Fork here" and by Auto-Session Snapshots'
  // "Restore" (which forks from a saved transcript instead of a live turn
  // range) — same framing either way so the new window's model has context.
  function wrapForkPreamble(transcriptText) {
    return [
      "[Continuing from a forked conversation — the messages below are context from the original chat. "
        + "Reply to the last one as if this conversation had continued from there.]",
      "",
      transcriptText,
      "",
      "[End of forked context]",
    ].join("\n");
  }

  async function forkFromTurn(turns, idx) {
    const upto = turns.slice(0, idx + 1);
    const preamble = wrapForkPreamble(buildTranscriptText(upto));
    await ipcRenderer.invoke("branching:open-fork", {
      preambleText: preamble,
      label: `Fork @ turn ${idx + 1} — ${document.title || "Untitled"}`,
      forkedFromUrl: location.href,
      forkedAtTurnIndex: idx,
    });
    notify("Opened a forked window — review and send when ready.", { category: "plugin" });
  }

  async function copyForCompare(text) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied — paste it into the Diff Viewer (Cmd+K → Compare Responses).", { category: "plugin" });
    } catch (_e) {
      notify("Couldn't copy to clipboard.");
    }
  }

  const branchForkButtons = mountBranchForkButtons({
    getTurns: () => collectConversationText(document),
    onFork: (turns, idx) => forkFromTurn(turns, idx),
    onCopyForCompare: (text) => copyForCompare(text),
  });

  // --- Inline Diff Applier for Code Blocks ---
  // Entirely gated on File Watcher already having watched files — see
  // core/diff-applier.js's matchCandidates() for the confidence levels.
  const diffApplier = new DiffApplierOverlay({
    readFile: (filePath) => ipcRenderer.invoke("fileWatcher:read", filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke("fileWatcher:write", filePath, content),
    notify: (message) => notify(message, { category: "plugin" }),
  });
  const codeDiffButtons = mountCodeDiffButtons({
    getTurns: () => collectConversationText(document),
    getWatchedFiles: () => settings.fileWatcher.watched || [],
    onOpen: (payload) => diffApplier.open(payload),
  });

  // --- Usage Analytics Dashboard ---
  const analyticsDashboard = new AnalyticsDashboard({
    queryAnalytics: (range) => ipcRenderer.invoke("analytics:query", range),
    exportCsv: (range) => ipcRenderer.invoke("analytics:export-csv", range),
    savePng: (dataUrl, suggestedName) => ipcRenderer.invoke("analytics:save-png", { dataUrl, suggestedName }),
    clearAnalytics: () => ipcRenderer.invoke("analytics:clear"),
    notify: (message) => notify(message, { category: "plugin" }),
  });

  // --- Auto-Session Snapshots + Restore Points ---
  // "Restore" forks a new window from the snapshot's transcript (reuses the
  // same branching:open-fork IPC above) rather than rewinding the live
  // claude.ai conversation, which isn't possible without its private API.
  function snapshotId() {
    return `sn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // Dedup, not diffing: skips silently if nothing changed since this
  // conversation's most recent snapshot. Caps at 20 snapshots per
  // conversation (oldest pruned) so one long-lived chat can't grow
  // unbounded — the practical "avoid bloating storage" mechanism in place
  // of true binary diffing.
  function takeSnapshot(label) {
    const turns = collectConversationText(document);
    if (turns.length === 0) return null;
    const transcript = buildTranscriptText(turns);
    const list = settings.snapshots.list || [];
    const sameConversation = list.filter((s) => s.conversationUrl === location.href);
    const mostRecent = sameConversation[sameConversation.length - 1];
    if (mostRecent && mostRecent.transcript === transcript) return null;

    const record = {
      id: snapshotId(),
      label: label || `Snapshot @ ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      conversationUrl: location.href,
      conversationTitle: document.title || "Untitled",
      turnCount: turns.length,
      transcript,
    };
    const others = list.filter((s) => s.conversationUrl !== location.href);
    const keptForThisConvo = [...sameConversation, record].slice(-20);
    const next = [...others, ...keptForThisConvo];
    settings.snapshots.list = next;
    setSetting("snapshots.list", next);
    return record;
  }

  let lastAutoSnapshotAt = Date.now();
  function maybeAutoSnapshot() {
    if (!settings.snapshots || !settings.snapshots.enabled) return;
    const intervalMs = Math.max(5, settings.snapshots.intervalMinutes || 30) * 60 * 1000;
    if (Date.now() - lastAutoSnapshotAt < intervalMs) return;
    lastAutoSnapshotAt = Date.now();
    takeSnapshot();
  }
  setInterval(maybeAutoSnapshot, 60 * 1000);

  function syncForkButtonsVisibility() {
    const show = !!(settings.branching && settings.branching.enabled && settings.branching.showForkButtons);
    branchForkButtons.setVisible(show);
  }

  function syncCodeDiffButtonsVisibility() {
    const show = !!(settings.diffApplier && settings.diffApplier.enabled && settings.fileWatcher && settings.fileWatcher.enabled);
    codeDiffButtons.setVisible(show);
  }

  function refreshUsage() {
    lastUsage = tokenCounter.computeUsage(document);
    hud.update(lastUsage);
    syncContextualChrome();
    detectAndDispatchNewMessages(collectConversationText(document));
    if (settings.branching && settings.branching.enabled && settings.branching.showForkButtons) {
      branchForkButtons.sync();
    }
    if (settings.diffApplier && settings.diffApplier.enabled && settings.fileWatcher && settings.fileWatcher.enabled) {
      codeDiffButtons.sync();
    }
    // Self-healing: claude.ai can swap out the composer element (route
    // change, React remount) out from under our listeners — cheap re-attach
    // check on the same tick that already polls the DOM for usage.
    if (!contextBudgetPlanner.composer || !document.contains(contextBudgetPlanner.composer)) {
      contextBudgetPlanner.attach(document);
    }
    if (!modelRouter.composer || !document.contains(modelRouter.composer)) {
      modelRouter.attach(document);
    }
    if (!macroCaptureComposer || !document.contains(macroCaptureComposer)) {
      attachMacroCaptureIfNeeded();
    }
  }

  // FRAGILE: see core/token-counter.js — Claude.ai has no public usage API,
  // so we watch the conversation container for mutations (covers both new
  // messages and in-place streaming edits to the last assistant message)
  // plus a short polling fallback in case mutations are batched/coalesced.
  //
  // Scoped to claude.ai's own app root (#root / #__next), NOT document.body:
  // every BetterClaude surface (HUD, companion, settings panel, dock, title
  // bar) mounts as a sibling of that root, and refreshUsage() itself mutates
  // the HUD's text on every call (see hud.update()) — observing body would
  // pick up that mutation too, re-triggering refreshUsage() in an unbounded
  // self-feeding loop that pins the renderer's CPU for as long as the page
  // stays open, HUD visible or not.
  const chatObserver = new MutationObserver(() => refreshUsage());
  const claudeRoot = document.getElementById("root") || document.getElementById("__next") || document.body;
  chatObserver.observe(claudeRoot, { childList: true, subtree: true, characterData: true });
  setInterval(refreshUsage, 1000);
  refreshUsage();

  // Real plan-level usage (session/weekly rate-limit %), straight from
  // Anthropic's own backend — see core/account-usage.js for why this is
  // accurate rather than estimated. Polled, not mutation-driven: it only
  // changes server-side after a message round-trip, not on every keystroke,
  // so there's nothing to gain from watching the DOM for it.
  function refreshAccountUsage() {
    fetchAccountUsage()
      .then((usage) => hud.updateAccountUsage(usage))
      .catch(() => {
        // Transient failure or a plan/account that doesn't expose this —
        // leave the last known good values on screen rather than blanking them.
      });
  }
  setInterval(refreshAccountUsage, 60 * 1000);
  refreshAccountUsage();

  // Zen Mode directly drives the existing Focus Mode plugin's own
  // setActive() (reusing its real DOM-detachment logic instead of
  // reimplementing it) — see plugins/focus-mode.claudeplugin.js.
  function syncZenModeWithFocusPlugin() {
    if (!pluginLoader) return;
    const entry = pluginLoader.loaded.get("focus-mode");
    if (entry && entry.module && typeof entry.module.setActive === "function") {
      const desired = !!(settings.focusReading && settings.focusReading.zenMode);
      // This runs on every "settings changed" broadcast, and setActive()
      // itself writes a setting — calling it unconditionally re-triggers
      // the very broadcast that invoked us, spinning the whole app (every
      // settings-panel section, every open dropdown/popover) in an
      // infinite re-render loop. Only call through when the value actually
      // needs to change.
      if (entry.module.active !== desired) entry.module.setActive(desired);
    }
  }

  // Cheap, pure stat computation re-run on every settings change; only acts
  // when checkAchievements finds something newly true. themesTried is an
  // honest approximation (distinct themes ever activated or favorited),
  // not a dedicated historical log.
  function refreshAchievements() {
    const stats = {
      launches: 1,
      streakCount: (settings.personality.streak && settings.personality.streak.count) || 0,
      themesTried: new Set([settings.appearance.activeTheme, ...(settings.appearance.favoriteThemes || [])]).size,
      pluginsEnabledCount: Object.values(settings.plugins.enabled).filter(Boolean).length,
      usedAfterMidnight: new Date().getHours() < 5,
      konamiUnlocked: !!(settings.personality.easterEggs && settings.personality.easterEggs.konamiUnlocked),
    };
    const { allUnlocked, newlyUnlocked } = checkAchievements(stats, settings.personality.achievements || []);
    if (newlyUnlocked.length === 0) return;
    setSetting("personality.achievements", allUnlocked);
    newlyUnlocked.forEach((id) => {
      const achievement = ACHIEVEMENTS.find((a) => a.id === id);
      notify(`Achievement unlocked: ${achievement ? achievement.label : id}`, { category: "achievement" });
    });
    companion.react("happy");
    if (settings.motion.confetti && settings.automations.achievementBurstsConfetti) celebrate();
  }

  // --- Team/Shared Plugin Sync ---
  // Applying a synced file (electron/main.js) broadcasts which plugin/theme
  // ids changed rather than expecting every window to blindly re-fetch
  // everything; this reloads exactly those (unload+reload for a plugin
  // whose file changed underneath an already-loaded instance, since
  // applyPluginState() alone only loads/unloads based on the enabled flag,
  // not on file content changing).
  async function reloadTeamSyncedItems({ pluginIds, themeIds }) {
    if (pluginIds && pluginIds.length > 0) {
      const sources = await ipcRenderer.invoke("plugins:list-sources");
      pluginIds.forEach((id) => {
        const found = sources.find((s) => s.id === id);
        if (!found) return;
        if (pluginLoader.list().some((p) => p.id === id)) pluginLoader.unload(id);
        if (settings.plugins.enabled[id] !== false) {
          try {
            pluginLoader.load(id, loadPluginModule(found.path));
          } catch (err) {
            console.error(`[BetterClaude] failed to reload synced plugin "${id}"`, err);
          }
        }
      });
    }
    if (themeIds && themeIds.length > 0) {
      const updatedThemes = await ipcRenderer.invoke("themes:get-all");
      Object.assign(themes, updatedThemes);
    }
  }

  ipcRenderer.on("betterclaude:team-sync-error", (_e, message) => {
    notify(`Team Sync failed: ${message}`, { category: "plugin", urgent: true });
  });

  ipcRenderer.on("betterclaude:team-sync-applied", (_e, payload) => {
    reloadTeamSyncedItems(payload).catch((err) => console.error("[BetterClaude] team sync reload failed", err));
    const parts = [];
    if (payload.pluginIds.length > 0) parts.push(`${payload.pluginIds.length} plugin${payload.pluginIds.length === 1 ? "" : "s"}`);
    if (payload.themeIds.length > 0) parts.push(`${payload.themeIds.length} theme${payload.themeIds.length === 1 ? "" : "s"}`);
    if (parts.length > 0) notify(`Team Sync applied ${parts.join(" and ")}.`, { category: "plugin" });
  });

  // Seeded from the settings already loaded at bootstrap so a restart with
  // pre-existing conflicts (from a previous session) doesn't re-notify.
  let lastTeamSyncConflictCount = (settings.teamSync && settings.teamSync.conflicts.length) || 0;

  ipcRenderer.on("betterclaude:settings-changed", (_e, updated) => {
    settings = updated;
    applyThemeState();
    applyScheduledTheme();
    applyPluginState();
    syncZenModeWithFocusPlugin();
    syncForkButtonsVisibility();
    syncCodeDiffButtonsVisibility();
    syncDigestTimer();
    refreshAchievements();
    const conflictCount = (updated.teamSync && updated.teamSync.conflicts.length) || 0;
    if (conflictCount > lastTeamSyncConflictCount) {
      notify(`Team Sync: ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} need review — Settings → Team Sync.`, { category: "plugin" });
    }
    lastTeamSyncConflictCount = conflictCount;
    settingsChangedHandlers.forEach((cb) => cb(settings));
  });

  await applyPluginState();
  syncZenModeWithFocusPlugin();
  syncForkButtonsVisibility();
  syncCodeDiffButtonsVisibility();
  syncDigestTimer();

  // --- Streak + greeting (once per bootstrap) ---
  {
    const todayStr = new Date().toISOString().slice(0, 10);
    const nextStreak = incrementStreak(settings.personality.streak, todayStr);
    if (nextStreak.bumped) {
      setSetting("personality.streak", { count: nextStreak.count, lastActiveDate: nextStreak.lastActiveDate });
      if (nextStreak.count > 1) companion.react("streak-bump");
    }
    refreshAchievements();
    const greeting = buildGreeting({
      name: settings.personality.userName,
      streakCount: nextStreak.count,
      style: settings.personality.greetingStyle,
    });
    companion.say(settings.personality.statusMessage || greeting);
  }

  // --- Command palette (Cmd/Ctrl+K) + Konami easter egg ---
  function runCommand(cmd) {
    if (!cmd) return;
    if (typeof cmd.run === "function") {
      cmd.run();
      return;
    }
    if (cmd.settingPath) setSetting(cmd.settingPath, cmd.value);
  }

  // "For Everything": one flat, freshly-built list covering every indexable
  // surface — app actions, settings pages, plugins, prompt library entries,
  // macros, and skills (installed + marketplace cache). Rebuilt fresh every
  // time the palette opens (below) rather than kept reactively in sync, so
  // a prompt/macro/plugin added a second ago is always there without extra
  // wiring. Past chats are handled separately (see commandPalette's
  // setAsyncSource call below) since that's an async lookup, not a
  // synchronous list to filter.
  async function indexedCommands() {
    const actions = [
      { id: "open-settings", label: "Open Settings", group: "Action", run: () => settingsPanel.open() },
      { id: "toggle-zen", label: "Toggle Zen Mode", group: "Action", run: () => setSetting("focusReading.zenMode", !settings.focusReading.zenMode) },
      { id: "toggle-mute", label: "Toggle Mute", group: "Action", run: () => setSetting("sound.muted", !settings.sound.muted) },
      { id: "surprise-me", label: "Surprise Me (randomize everything)", group: "Action", run: () => surpriseMe() },
      { id: "play-snake", label: "Play Snake", group: "Action", run: () => openMiniGame() },
      { id: "open-skill-marketplace", label: "Open Skill Marketplace", group: "Skills", run: () => skillMarketplace.open() },
      { id: "insert-prompt", label: "Insert Prompt…", group: "Prompts", run: () => promptPicker.open() },
      { id: "compare-responses", label: "Compare Responses (Diff)", group: "Action", run: () => diffViewer.open() },
      { id: "snapshot-now", label: "Snapshot This Conversation", group: "Action", run: () => panelHost.snapshotNow() },
      { id: "search-all-chats", label: "Search All Chats", group: "Chats", run: () => semanticSearch.open() },
      { id: "open-usage-analytics", label: "Open Usage Analytics", group: "Analytics", run: () => analyticsDashboard.open() },
      {
        id: "sync-team-now",
        label: "Sync Team Plugins Now",
        group: "Action",
        run: () => ipcRenderer.invoke("teamSync:sync").catch((err) => notify(`Team Sync failed: ${err.message}`)),
      },
      {
        id: "toggle-macro-recording",
        label: macroRecorder.isRecording() ? "Stop Macro Recording" : "Start Macro Recording",
        group: "Macros",
        run: () => (macroRecorder.isRecording() ? finishRecording() : macroRecorder.startRecording()),
      },
      ...(settings.commandPalette.customCommands || []).map((c) => ({ id: c.id, label: c.label, group: "Action", settingPath: c.settingPath, value: c.value })),
    ];

    const settingsPages = SECTIONS.map((section) => ({
      id: `settings-${section}`,
      label: `Settings: ${section}`,
      group: "Settings",
      keywords: "settings preferences",
      run: () => settingsPanel.openSection(section),
    }));

    const prompts = (settings.promptLibrary.prompts || []).map((p) => ({
      id: `prompt-${p.id}`,
      label: `Insert Prompt: ${p.title}`,
      group: "Prompts",
      run: () => promptPicker.open(p.id),
    }));

    const macros = (settings.macros.list || []).map((m) => ({
      id: `macro-${m.id}`,
      label: `Replay Macro: ${m.name}`,
      group: "Macros",
      run: () => doReplayMacro(m),
    }));

    const installedSkills = Object.entries(settings.skillMarketplace.installed || {}).map(([id, record]) => ({
      id: `skill-installed-${id}`,
      label: `Reveal Skill: ${record.owner}/${record.repo}`,
      group: "Skills",
      run: () => ipcRenderer.invoke("skills:reveal", id),
    }));

    const cachedSkills = ((settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || []).map((item) => ({
      id: `skill-cache-${item.id}`,
      label: `Marketplace: ${item.fullName}`,
      group: "Skills",
      run: () => {
        skillMarketplace.open();
        skillMarketplace.select(item);
      },
    }));

    let plugins = [];
    try {
      const sources = await panelHost.listPlugins();
      plugins = sources.map((p) => ({
        id: `plugin-${p.id}`,
        label: `Toggle Plugin: ${p.name}`,
        group: "Plugins",
        run: () => panelHost.togglePlugin(p.id, !p.enabled),
      }));
    } catch (_e) {
      // Non-fatal — the palette just shows everything else without plugins this time.
    }

    return [...actions, ...settingsPages, ...prompts, ...macros, ...installedSkills, ...cachedSkills, ...plugins];
  }

  // Past chats, via Local Semantic Search's own index (#4) — only wired
  // once that feature is actually enabled, and only once the user has
  // typed something (an empty-query "browse all chats" isn't what this is
  // for; "Search All Chats" above opens the full overlay for that).
  commandPalette.setAsyncSource(async (query) => {
    if (!settings.semanticSearch || !settings.semanticSearch.enabled) return [];
    const results = await ipcRenderer.invoke("search:query", { query, limit: 5 });
    return (results || []).map((r) => ({
      id: `chat-${r.conversationUrl}-${r.snippet.slice(0, 24)}`,
      label: `${r.title || "Untitled"} — ${r.snippet}`,
      group: "Chats",
      run: () => jumpToResult(r),
    }));
  });

  document.addEventListener("keydown", async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      commandPalette.setCommands(await indexedCommands());
      commandPalette.toggle();
    }
  });

  // In-page fallback for opening the Prompt Picker (works while the window
  // has focus). The same prompt can also carry its own OS-wide accelerator,
  // registered in electron/main.js's registerPromptShortcuts() and delivered
  // here via the betterclaude:trigger-prompt IPC channel below.
  document.addEventListener("keydown", (e) => {
    const accel = settings.keyboardShortcuts.openPromptPicker || "";
    if (!accel) return;
    const wantsMeta = /commandorcontrol|cmdorctrl/i.test(accel);
    const wantsShift = /shift/i.test(accel);
    const keyMatch = /\+([a-z0-9])$/i.exec(accel);
    if (!keyMatch) return;
    if ((wantsMeta ? (e.metaKey || e.ctrlKey) : true) && (wantsShift ? e.shiftKey : true) && e.key.toLowerCase() === keyMatch[1].toLowerCase()) {
      e.preventDefault();
      promptPicker.toggle();
    }
  });

  ipcRenderer.on("betterclaude:trigger-prompt", (_e, promptId) => promptPicker.open(promptId));
  ipcRenderer.on("betterclaude:trigger-macro", (_e, macroId) => {
    const macro = (settings.macros.list || []).find((m) => m.id === macroId);
    if (macro) doReplayMacro(macro);
  });

  // --- Native File Watcher Sync ---
  // "Auto-reattach" only ever find-and-replaces the labeled block this app
  // itself inserted into an *unsent* composer — it can't and doesn't try to
  // edit an already-sent message. A miss (marker not found) just marks the
  // record stale so Settings -> File Watcher can offer a manual re-insert.
  ipcRenderer.on("betterclaude:file-changed", (_e, { path: filePath, content }) => {
    const watched = settings.fileWatcher.watched || [];
    const idx = watched.findIndex((w) => w.path === filePath);
    if (idx === -1) return;
    const record = watched[idx];
    const synced = !!record.autoReattach && findAndReplaceInComposer(record.label, content);
    const next = [...watched];
    next[idx] = {
      ...record,
      lastDiskContent: content,
      stale: !synced,
      lastSyncedAt: synced ? Date.now() : record.lastSyncedAt,
    };
    settings.fileWatcher.watched = next;
    setSetting("fileWatcher.watched", next);
    notify(
      synced ? `${record.label} auto-synced from disk.` : `${record.label} changed on disk — re-insert it from Settings → File Watcher.`,
      { category: "plugin" }
    );
  });

  document.addEventListener("keydown", (e) => {
    const accel = settings.keyboardShortcuts.openChatSearch || "";
    if (!accel) return;
    const wantsMeta = /commandorcontrol|cmdorctrl/i.test(accel);
    const wantsShift = /shift/i.test(accel);
    const keyMatch = /\+([a-z0-9])$/i.exec(accel);
    if (!keyMatch) return;
    if ((wantsMeta ? (e.metaKey || e.ctrlKey) : true) && (wantsShift ? e.shiftKey : true) && e.key.toLowerCase() === keyMatch[1].toLowerCase()) {
      e.preventDefault();
      semanticSearch.toggle();
    }
  });

  stopKonami = mountKonamiListener(async () => {
    setSetting("personality.easterEggs.konamiUnlocked", true);
    await selectTheme("secret-rainbow");
    notify("Secret theme unlocked!", { category: "achievement" });
    refreshAchievements();
    if (settings.motion.confetti) celebrate();
  });

  // --- Right-click radial quick-action menu ---
  function runRadialAction(id) {
    if (id === "settings") settingsPanel.open();
    else if (id === "shuffle-theme") {
      const ids = Object.keys(themes).filter((t) => t !== settings.appearance.activeTheme && t !== "secret-rainbow");
      if (ids.length) {
        const pick = ids[Math.floor(Math.random() * ids.length)];
        selectTheme(pick);
      }
    } else if (id === "zen-mode") setSetting("focusReading.zenMode", !settings.focusReading.zenMode);
    else if (id === "mute-sound") setSetting("sound.muted", !settings.sound.muted);
    else if (id === "command-palette") {
      indexedCommands().then((cmds) => {
        commandPalette.setCommands(cmds);
        commandPalette.toggle();
      });
    } else if (id === "surprise-me") surpriseMe();
  }

  // --- Click / hover sounds (Settings -> Sound & Haptics) ---
  // soundEngine.play() already no-ops instantly when pack is "off" (the
  // default) or the specific type is toggled off, so wiring these
  // unconditionally is cheap and safe. Uses Web Audio only — no DOM
  // mutation — so unlike the click ripple (see core/interaction-fx.js) this
  // is safe to fire even when the click opens a native <select> popup.
  document.addEventListener("click", () => {
    // The public auth screen is deliberately silent; the click tone is for
    // the BetterClaude workspace and is distracting during sign-in/OAuth.
    if (!document.body.classList.contains("bc-signed-out")) soundEngine.play("click");
  });
  let lastHoverSoundTarget = null;
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest && e.target.closest('button, a, [role="button"], select, .bc-dock-btn');
    if (target && target !== lastHoverSoundTarget) {
      lastHoverSoundTarget = target;
      soundEngine.play("hover");
    } else if (!target) {
      lastHoverSoundTarget = null;
    }
  });

  // Web Audio's autoplay policy can leave the context "suspended" until a
  // real user gesture — this catches the very first one so a persisted
  // ambient soundscape (which starts automatically from saved settings on
  // bootstrap, with no gesture yet) reliably resumes instead of staying
  // silently muted for the rest of the session.
  document.addEventListener("pointerdown", () => {
    if (soundEngine.ctx && soundEngine.ctx.state === "suspended") soundEngine.ctx.resume();
  });

  // --- Vibe Bundles: mood picker, "Surprise Me", weather theme ---
  async function surpriseMe() {
    const bundle = pickRandomBundle(settings.appearance.activeTheme && VIBE_BUNDLES.find((b) => b.themeId === settings.appearance.activeTheme)?.id);
    await applyBundle(bundle, { setSetting, selectTheme });
    if (settings.motion.confetti) celebrate();
  }

  function openMiniGame() {
    let modal = document.getElementById("bc-minigame-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "bc-minigame-modal";
      modal.innerHTML = `<div class="bc-minigame-box"><button class="bc-minigame-close" data-bc-close>Close</button><div data-bc-game-container></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeMiniGame(); });
      modal.querySelector("[data-bc-close]").addEventListener("click", closeMiniGame);
    }
    modal.classList.add("bc-open");
    if (modal._gameHandle) modal._gameHandle.destroy();
    modal._gameHandle = mountSnakeGame(modal.querySelector("[data-bc-game-container]"));
  }

  function closeMiniGame() {
    const modal = document.getElementById("bc-minigame-modal");
    if (!modal) return;
    modal.classList.remove("bc-open");
    if (modal._gameHandle) {
      modal._gameHandle.destroy();
      modal._gameHandle = null;
    }
  }

  // --- Auto-updater bridge ---
  let updateStatus = { state: "idle" };
  const updateStatusHandlers = [];
  ipcRenderer.on("betterclaude:update-status", (_e, status) => {
    updateStatus = status;
    updateStatusHandlers.forEach((cb) => cb(status));
  });

  // --- Cross-Device Clipboard Bridge bridge ---
  // The actual relay push/pull + OS clipboard read/write happens in
  // electron/main.js (Node/Electron-specific, mirrors the file watcher
  // split) — this side just mirrors live connection status for Settings ->
  // Clipboard Bridge and surfaces a notification whenever a synced item
  // actually lands, so syncing is never silent.
  let clipboardBridgeStatus = { state: "idle", lastError: null, lastSyncedAt: null };
  const clipboardBridgeStatusHandlers = [];
  ipcRenderer.on("betterclaude:clipboard-bridge-status", (_e, status) => {
    clipboardBridgeStatus = status;
    clipboardBridgeStatusHandlers.forEach((cb) => cb(status));
  });
  ipcRenderer.on("betterclaude:clipboard-synced", (_e, { deviceName }) => {
    notify(`Clipboard synced from ${deviceName || "another device"}.`, { category: "plugin" });
  });

  // --- Settings panel ---
  const panelHost = {
    getSettings: () => settings,
    setSetting,
    onSettingsChanged: (cb) => settingsChangedHandlers.push(cb),
    listThemeIds: () => Object.keys(themes),
    getThemesData: () => themes,
    listUserThemeIds: () => ipcRenderer.invoke("themes:list-user-ids"),
    notify,
    exportSettings: () => ipcRenderer.invoke("settings:export"),
    // Resulting settings arrive back through the normal
    // "betterclaude:settings-changed" broadcast main.js sends after
    // writing them, so there's nothing further to wire up here.
    importSettings: () => ipcRenderer.invoke("settings:import"),
    getUpdateStatus: () => updateStatus,
    onUpdateStatus: (cb) => updateStatusHandlers.push(cb),
    checkForUpdates: () => ipcRenderer.invoke("updater:check"),
    downloadUpdate: () => ipcRenderer.invoke("updater:download"),
    installUpdate: () => ipcRenderer.invoke("updater:install"),
    selectTheme,
    applyThemePreview: (id) => themeEngine.setTheme(id),
    applyCustomCSSPreview: (code) => themeEngine.setCustomCSS(code),
    applyAccentPreview: (hex) => themeEngine.setAccentColor(hex),
    // Live-applies a background patch and returns its WCAG contrast eval so the
    // panel can warn + suggest a scrim opacity before the setting is saved.
    applyBackgroundPreview: (patch) => themeEngine.setBackground(patch),
    importThemeFromUrl: async (url) => {
      const result = await ipcRenderer.invoke("themes:import-url", url);
      Object.assign(themes, result.themes);
      return result;
    },
    importThemeFromFile: async () => {
      const result = await ipcRenderer.invoke("themes:import-file");
      if (!result) return null;
      Object.assign(themes, result.themes);
      return result;
    },
    // Compiles the theme currently rendered on screen (bundled/imported
    // preset CSS + whatever the Appearance Editor/Custom CSS tabs have
    // layered on top) into one standalone theme file, so it round-trips
    // through Themes -> pick it again -> get the exact same look.
    saveCurrentAsNewTheme: async (name) => {
      const baseCSS = themes[settings.appearance.activeTheme] || "";
      const customCSS = settings.customCSS.code || "";
      const cssText = `/* BetterClaude theme: ${name} */\n${baseCSS}\n\n${customCSS}`;
      const result = await ipcRenderer.invoke("themes:save-user", name, cssText);
      Object.assign(themes, result.themes);
      return result;
    },
    deleteUserTheme: async (id) => {
      const updated = await ipcRenderer.invoke("themes:delete-user", id);
      Object.keys(themes).forEach((k) => delete themes[k]);
      Object.assign(themes, updated);
    },
    listPlugins: async () => {
      const sources = await ipcRenderer.invoke("plugins:list-sources");
      return sources.map(({ id }) => {
        const loaded = pluginLoader.list().find((p) => p.id === id);
        return {
          id,
          name: loaded ? loaded.name : id,
          version: loaded ? loaded.version : "",
          enabled: settings.plugins.enabled[id] !== false,
        };
      });
    },
    togglePlugin: async (id, enabled) => {
      setSetting(`plugins.enabled.${id}`, enabled);
      if (enabled) {
        const sources = await ipcRenderer.invoke("plugins:list-sources");
        const found = sources.find((p) => p.id === id);
        if (found) {
          const moduleObj = loadPluginModule(found.path);
          pluginLoader.load(id, moduleObj);
        }
      } else {
        pluginLoader.unload(id);
      }
    },
    openPluginsFolder: () => ipcRenderer.invoke("plugins:open-folder"),
    mountCSSEditor: (container, opts) => cssEditor.mount(container, opts),

    // --- Skill Marketplace bridge ---
    refreshSkillsCache: () => ipcRenderer.invoke("skills:refresh-cache"),
    openSkillMarketplace: () => skillMarketplace.open(),
    revealSkill: (id) => ipcRenderer.invoke("skills:reveal", id),
    uninstallSkill: (id) => ipcRenderer.invoke("skills:uninstall", id),

    // --- Prompt Library bridge ---
    exportPromptLibrary: () => ipcRenderer.invoke("promptLibrary:export"),
    importPromptLibrary: () => ipcRenderer.invoke("promptLibrary:import"),

    // --- Branching bridge ---
    openBranch: (id) => ipcRenderer.invoke("branching:open-branch", id),
    deleteBranch: (id) => ipcRenderer.invoke("branching:delete-branch", id),

    // --- Snapshots bridge ---
    snapshotNow: (label) => {
      const record = takeSnapshot(label);
      notify(record ? "Snapshot saved." : "Nothing's changed since the last snapshot of this conversation.", { category: "plugin" });
      return record;
    },
    restoreSnapshot: (id) => {
      const snap = (settings.snapshots.list || []).find((s) => s.id === id);
      if (!snap) return null;
      return ipcRenderer.invoke("branching:open-fork", {
        preambleText: wrapForkPreamble(snap.transcript),
        label: `Restored: ${snap.label}`,
        forkedFromUrl: snap.conversationUrl,
        forkedAtTurnIndex: snap.turnCount - 1,
      });
    },
    exportSnapshot: (id) => ipcRenderer.invoke("snapshots:export-one", id),
    renameSnapshot: (id, label) => {
      const next = (settings.snapshots.list || []).map((s) => (s.id === id ? { ...s, label } : s));
      settings.snapshots.list = next;
      return setSetting("snapshots.list", next);
    },
    deleteSnapshot: (id) => {
      const next = (settings.snapshots.list || []).filter((s) => s.id !== id);
      settings.snapshots.list = next;
      return setSetting("snapshots.list", next);
    },

    // --- Semantic Search bridge ---
    openChatSearch: () => semanticSearch.open(),
    clearSearchIndex: async () => {
      const indexed = await ipcRenderer.invoke("search:clear-index");
      settings.semanticSearch.indexed = indexed;
    },

    // --- File Watcher bridge ---
    pickWatchedFile: async () => {
      const picked = await ipcRenderer.invoke("fileWatcher:pick-file");
      if (!picked) return null;
      const record = {
        id: `fw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        path: picked.path,
        label: picked.name,
        autoReattach: true,
        lastDiskContent: picked.content,
        stale: false,
        lastSyncedAt: null,
      };
      const next = [...(settings.fileWatcher.watched || []), record];
      settings.fileWatcher.watched = next;
      await setSetting("fileWatcher.watched", next);
      await ipcRenderer.invoke("fileWatcher:start", picked.path);
      return record;
    },
    stopWatchingFile: async (id) => {
      const record = (settings.fileWatcher.watched || []).find((w) => w.id === id);
      if (record) await ipcRenderer.invoke("fileWatcher:stop", record.path);
      const next = (settings.fileWatcher.watched || []).filter((w) => w.id !== id);
      settings.fileWatcher.watched = next;
      return setSetting("fileWatcher.watched", next);
    },
    insertWatchedFile: (id) => {
      const record = (settings.fileWatcher.watched || []).find((w) => w.id === id);
      if (!record) return false;
      const ok = insertFileBlock(record.label, record.lastDiskContent);
      if (ok) {
        const next = settings.fileWatcher.watched.map((w) => (w.id === id ? { ...w, stale: false, lastSyncedAt: Date.now() } : w));
        settings.fileWatcher.watched = next;
        setSetting("fileWatcher.watched", next);
      } else {
        notify("Couldn't find claude.ai's composer.");
      }
      return ok;
    },
    setAutoReattach: (id, autoReattach) => {
      const next = settings.fileWatcher.watched.map((w) => (w.id === id ? { ...w, autoReattach } : w));
      settings.fileWatcher.watched = next;
      return setSetting("fileWatcher.watched", next);
    },

    // --- Macro Recorder bridge ---
    isRecordingMacro: () => macroRecorder.isRecording(),
    isReplayingMacro: () => macroRecorder.isReplaying(),
    startRecordingMacro: (name) => macroRecorder.startRecording(name),
    stopRecordingMacro: () => finishRecording(),
    replayMacro: (id) => {
      const macro = (settings.macros.list || []).find((m) => m.id === id);
      if (macro) doReplayMacro(macro);
    },
    stopMacroReplay: () => { replayStopRequested = true; },
    renameMacro: (id, name) => {
      const next = settings.macros.list.map((m) => (m.id === id ? { ...m, name } : m));
      settings.macros.list = next;
      return setSetting("macros.list", next);
    },
    setMacroShortcut: (id, shortcut) => {
      const next = settings.macros.list.map((m) => (m.id === id ? { ...m, shortcut: shortcut || null } : m));
      settings.macros.list = next;
      return setSetting("macros.list", next);
    },
    updateMacroSteps: (id, steps) => {
      const next = settings.macros.list.map((m) => (m.id === id ? { ...m, steps } : m));
      settings.macros.list = next;
      return setSetting("macros.list", next);
    },
    deleteMacro: (id) => {
      const next = settings.macros.list.filter((m) => m.id !== id);
      settings.macros.list = next;
      return setSetting("macros.list", next);
    },

    // --- Clipboard Bridge bridge ---
    getClipboardBridgeStatus: () => clipboardBridgeStatus,
    onClipboardBridgeStatus: (cb) => clipboardBridgeStatusHandlers.push(cb),
    pushClipboardNow: () => ipcRenderer.invoke("clipboardBridge:push-now"),
    testClipboardBridgeConnection: () => ipcRenderer.invoke("clipboardBridge:test-connection"),

    // --- Usage Analytics Dashboard bridge ---
    openAnalyticsDashboard: () => analyticsDashboard.open(),

    // --- Team/Shared Plugin Sync bridge ---
    syncTeamNow: () => ipcRenderer.invoke("teamSync:sync"),
    getTeamSyncDiff: (relPath) => ipcRenderer.invoke("teamSync:get-diff", relPath),
    applyTeamSyncFile: (relPath) => ipcRenderer.invoke("teamSync:apply-file", relPath),
    keepLocalTeamSyncFile: (relPath) => ipcRenderer.invoke("teamSync:keep-local", relPath),
    openTeamSyncFolder: () => ipcRenderer.invoke("teamSync:open-folder"),

    // --- Customize Everything bridge methods ---
    playSoundPreview: (type) => soundEngine.play(type),
    previewConfetti: () => celebrate(),
    notifyPreview: (category) => notify("This is what a notification looks like.", { category }),
    applyMood: async (mood) => {
      await setSetting("personality.mood", mood);
      const bundle = bundleForMood(mood);
      if (bundle) await applyBundle(bundle, { setSetting, selectTheme });
    },
    applyVibeBundle: async (bundleId) => {
      const bundle = VIBE_BUNDLES.find((b) => b.id === bundleId);
      if (bundle) await applyBundle(bundle, { setSetting, selectTheme });
    },
    surpriseMe: () => surpriseMe(),
    saveProfile: async (name) => {
      const { profiles, window, ...rest } = settings;
      const snapshot = JSON.parse(JSON.stringify(rest));
      const entry = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name,
        createdAt: Date.now(),
        snapshot,
      };
      await setSetting("profiles.list", [...(settings.profiles.list || []), entry]);
    },
    applyProfile: async (id) => {
      settings = await ipcRenderer.invoke("profiles:apply", id);
    },
    openMiniGame: () => openMiniGame(),
    applyWeatherTheme: () => applyScheduledWeatherTheme(),
  };

  const settingsPanel = new SettingsPanel(panelHost);

  // --- Title bar ---
  // Inlined as a data URI (not a file:// src) since claude.ai's CSP img-src
  // policy doesn't allow file:// resources into the page.
  const logoSrc = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "../assets/logo-mark.png")).toString("base64");

  mountTitleBar({
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximizeToggle: () => ipcRenderer.invoke("window:maximize-toggle"),
    close: () => ipcRenderer.invoke("window:close"),
    toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
    isAlwaysOnTop: () => ipcRenderer.invoke("window:is-always-on-top"),
    openSettings: () => settingsPanel.toggle(),
    logoSrc,
  });

  // --- Menu / accelerator bridges from main.js ---
  ipcRenderer.on("betterclaude:toggle-settings", () => settingsPanel.toggle());
  ipcRenderer.on("betterclaude:toggle-hud", () => {
    const next = !settings.hud.enabled;
    setSetting("hud.enabled", next);
    hud.setVisible(next);
  });
}

bootstrap().catch((err) => console.error("[BetterClaude] preload bootstrap failed", err));

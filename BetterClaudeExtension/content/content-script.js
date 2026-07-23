/**
 * Content script — the direct analog of electron/preload.js's bootstrap().
 * Runs in claude.ai's page (isolated JS world, shared DOM) instead of an
 * Electron preload, and talks to background/service-worker.js instead of
 * ipcMain — see content/bridge.js for the `bg()`/`onBroadcast()` mapping of
 * `ipcRenderer.invoke`/`.on`.
 *
 * Everything from core/ and ui/ is the exact same source the Electron app
 * uses, reached here as globals (window.BetterClaudeCore, etc.) because
 * build.js bundles those same files as content-script-loadable IIFEs rather
 * than duplicating any logic.
 *
 * Not ported (see BetterClaudeExtension/README.md for the full list and why):
 * frameless window chrome / tray / always-on-top, the splash screen, and the
 * auto-updater — none of those concepts exist for a browser tab. Custom
 * user-authored plugins are also not loadable here (no safe dynamic-code
 * path under CSP without a filesystem `require()`); only the same built-in
 * plugin set ships, toggled on/off exactly as before.
 */
(function () {
  const Core = window.BetterClaudeCore;
  const { bg, onBroadcast } = window.BetterClaudeBridge;
  const FileWatcher = window.BetterClaudeFileWatcher;
  const { SettingsPanel, SECTIONS } = window.BetterClaudeSettingsPanel;
  const { mountSnakeGame } = window.BetterClaudeSnake;

  const {
    ThemeEngine, resolveScheduledTheme, ensureStyleTag, TokenCounter, collectConversationText,
    estimateTokens, HUD, PluginLoader, buildExtrasCSS, applyColorBlindSafeVars, InteractionFX,
    SoundEngine, motionFx, companion: companionModule, CommandPalette, mountKonamiListener,
    SkillMarketplaceOverlay, PromptPicker, mountBranchForkButtons, DiffViewer, ContextBudgetPlanner,
    SemanticSearchOverlay, ModelRouter, findAndReplaceInComposer, insertFileBlock, MacroRecorder,
    replayMacro, mountCodeDiffButtons, DiffApplierOverlay, AnalyticsDashboard, extractVariables,
    fillTemplate, vibeBundles, weather: weatherModule, notifications: notificationsModule,
    insertIntoComposer, waitForComposer, buildTranscriptText, findComposer, findSendButton,
  } = Core;
  const { celebrate, mountParallax, mountSeasonalDecoration } = motionFx;
  const { Companion, checkAchievements, incrementStreak, buildGreeting, ACHIEVEMENTS } = companionModule;
  const { mapWeatherCodeToBundle } = weatherModule;
  const { shouldSuppress, notificationStyleClass } = notificationsModule;
  const { bundleForSeason, applyBundle } = vibeBundles;

  async function bootstrap() {
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve));
    }

    // Lazily injected (CodeMirror does feature-detection against
    // document.body at import time) — a <script src> pointing at the
    // extension's own bundled file, same web_accessible_resources path a
    // dynamic import() would use, and not subject to claude.ai's CSP since
    // it's the extension's own packaged code, not remote/eval'd code.
    let cssEditorPromise = null;
    function loadCssEditor() {
      if (!cssEditorPromise) {
        cssEditorPromise = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = chrome.runtime.getURL("dist/css-editor.bundle.js");
          s.onload = () => resolve(window.BetterClaudeCssEditor);
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      return cssEditorPromise;
    }

    let settings = await bg("settings:get");
    const themes = await bg("themes:get-all");
    let osThemeIsDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      osThemeIsDark = e.matches;
      applyScheduledTheme();
    });

    // A forked tab lands here on https://claude.ai/new#bc-fork=<id> (see
    // background/service-worker.js's openFork). Consumed exactly once.
    async function handlePendingForkHash() {
      const m = /bc-fork=([^&]+)/.exec(location.hash);
      if (!m) return;
      history.replaceState(null, "", location.pathname + location.search);
      const text = await bg("branching:consume-pending-fork", { forkId: m[1] });
      if (!text) return;
      const composer = await waitForComposer();
      if (!composer) return;
      insertIntoComposer(text, { append: false });
    }
    handlePendingForkHash().catch((err) => console.error("[BetterClaude] fork hash handling failed", err));

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
        setTimeout(() => scrollToSnippet(pendingSnippet), 1200);
      }
    } catch (_e) { /* sessionStorage can throw under some privacy settings — non-fatal */ }

    const themeEngine = new ThemeEngine({ presets: themes });
    const soundEngine = new SoundEngine();
    const companion = new Companion();
    let interactionFX = null;
    let stopParallax = null;
    let stopSeasonal = null;
    const commandPalette = new CommandPalette({ onExecute: (cmd) => runCommand(cmd) });

    const skillMarketplace = new SkillMarketplaceOverlay({
      getCachedItems: () => (settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || [],
      getInstalledMap: () => settings.skillMarketplace.installed || {},
      searchSkills: (params) => bg("skills:search", params),
      getReadme: (params) => bg("skills:get-readme", params),
      installSkill: (item) => bg("skills:install", item),
      revealSkill: (id) => bg("skills:reveal", { id }),
      notify: (message) => notify(message, { category: "plugin" }),
    });

    const promptPicker = new PromptPicker({
      getPrompts: () => settings.promptLibrary.prompts || [],
      insertIntoComposer: (text) => insertIntoComposer(text),
      notify: (message) => notify(message, { category: "plugin" }),
      onInsert: (meta) => { pendingMacroStepSource = meta; },
    });

    const diffViewer = new DiffViewer();

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

    const modelRouter = new ModelRouter({
      getRules: () => (settings.modelRouting ? settings.modelRouting.rules : []),
      getDefaultModel: () => (settings.modelRouting ? settings.modelRouting.defaultModel : ""),
      isEnabled: () => !!(settings.modelRouting && settings.modelRouting.enabled),
      notify: (message) => notify(message, { category: "plugin" }),
      isBypassed: isSendBypassed,
      setBypass: setSendBypass,
    });

    let pendingMacroStepSource = null;
    let replayStopRequested = false;

    function finishRecording() {
      const macro = macroRecorder.stopRecording();
      if (macro.steps.length === 0) { notify("Recording stopped — no steps captured.", { category: "plugin" }); return; }
      const record = { id: `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: macro.name, shortcut: null, steps: macro.steps, createdAt: Date.now() };
      const next = [...(settings.macros.list || []), record];
      settings.macros.list = next;
      setSetting("macros.list", next);
      notify(`Saved macro "${record.name}" (${record.steps.length} step${record.steps.length === 1 ? "" : "s"}).`, { category: "plugin" });
    }

    const macroRecorder = new MacroRecorder({ onStopRecording: () => finishRecording(), onStopReplay: () => { replayStopRequested = true; } });

    async function resolvePromptStep(step) {
      const prompt = (settings.promptLibrary.prompts || []).find((p) => p.id === step.promptId);
      if (!prompt) return "";
      const vars = extractVariables(prompt.body);
      const values = { ...step.values };
      if (vars.includes("clipboard") && navigator.clipboard && navigator.clipboard.readText) {
        try { values.clipboard = await navigator.clipboard.readText(); } catch (_e) { /* keep recorded value */ }
      }
      return fillTemplate(prompt.body, values);
    }

    async function doReplayMacro(macro) {
      if (!macro || !macro.steps || macro.steps.length === 0) { notify("This macro has no steps."); return; }
      if (macroRecorder.isReplaying()) { notify("A macro is already replaying — stop it first."); return; }
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
        notify(result.timedOut ? `Macro stopped — timed out waiting for a response (step ${result.completedSteps}).` : `Macro stopped after ${result.completedSteps} step(s).`, { category: "plugin", urgent: result.timedOut });
      } else {
        notify(`Macro "${macro.name}" finished (${result.completedSteps} steps).`, { category: "plugin" });
      }
    }

    let macroCaptureComposer = null;
    function attachMacroCaptureIfNeeded() {
      const composer = findComposer(document);
      if (!composer || composer === macroCaptureComposer) return;
      macroCaptureComposer = composer;
      const capture = () => {
        if (!macroRecorder.isRecording()) return;
        const text = composer.value || "";
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

    function jumpToResult(item) {
      if (location.href === item.conversationUrl) { scrollToSnippet(item.snippet); return; }
      try { sessionStorage.setItem("bc-scroll-to-snippet", item.snippet); } catch (_e) { /* non-fatal */ }
      location.href = item.conversationUrl;
    }

    // Local Semantic Search's index lives in this page's own IndexedDB
    // (same reasoning as File Watcher above — this needs no service-worker
    // round trip, and search-index/*.json files don't exist without a
    // filesystem) rather than the Electron version's per-conversation JSON
    // files under userData.
    const searchDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("betterclaude-search-index", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "conversationUrl" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    async function searchStore(mode) {
      const db = await searchDbPromise;
      return db.transaction("conversations", mode).objectStore("conversations");
    }
    function tokenize(text) { return (text || "").toLowerCase().match(/[a-z0-9]+/g) || []; }
    async function searchAllDocs() {
      const store = await searchStore("readonly");
      return new Promise((resolve, reject) => {
        const docs = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(docs); return; }
          const conv = cursor.value;
          conv.turns.forEach((t) => docs.push({ conversationUrl: conv.conversationUrl, title: conv.title, ...t }));
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }
    async function searchIndexCounts() {
      const docs = await searchAllDocs();
      return { conversations: new Set(docs.map((d) => d.conversationUrl)).size, turns: docs.length };
    }
    async function indexTurns(conversationUrl, title, turns) {
      const store = await searchStore("readwrite");
      const existing = await new Promise((resolve) => {
        const req = store.get(conversationUrl);
        req.onsuccess = () => resolve(req.result || { conversationUrl, title, turns: [] });
        req.onerror = () => resolve({ conversationUrl, title, turns: [] });
      });
      const byIdx = new Map(existing.turns.map((t) => [t.idx, t]));
      turns.forEach((t) => byIdx.set(t.idx, { idx: t.idx, role: t.role, text: t.text }));
      store.put({ conversationUrl, title, updatedAt: Date.now(), turns: Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx) });
    }
    async function queryLocalIndex(query, limit = 20) {
      const q = (query || "").trim();
      if (!q) return [];
      const docs = await searchAllDocs();
      if (docs.length === 0) return [];
      const df = new Map();
      const docTf = docs.map((d) => {
        const tf = new Map();
        tokenize(d.text).forEach((tok) => tf.set(tok, (tf.get(tok) || 0) + 1));
        Array.from(tf.keys()).forEach((tok) => df.set(tok, (df.get(tok) || 0) + 1));
        return tf;
      });
      const N = docs.length;
      const idf = (term) => Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
      const qTf = new Map();
      tokenize(q).forEach((tok) => qTf.set(tok, (qTf.get(tok) || 0) + 1));
      const qVec = new Map();
      qTf.forEach((tf, term) => qVec.set(term, tf * idf(term)));
      const scored = docs.map((d, i) => {
        const dVec = new Map();
        docTf[i].forEach((tf, term) => dVec.set(term, tf * idf(term)));
        let dot = 0, na = 0, nb = 0;
        qVec.forEach((wa, term) => { na += wa * wa; const wb = dVec.get(term); if (wb) dot += wa * wb; });
        dVec.forEach((wb) => { nb += wb * wb; });
        const score = na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
        return { d, score };
      });
      return scored.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
        .map(({ d, score }) => ({ conversationUrl: d.conversationUrl, title: d.title, role: d.role, snippet: d.text.length > 240 ? `${d.text.slice(0, 240)}…` : d.text, score: Math.round(score * 1000) / 1000 }));
    }

    const semanticSearch = new SemanticSearchOverlay({ query: (params) => queryLocalIndex(params.query, params.limit), jumpToResult });

    let searchIndexBuffer = [];
    function bufferForIndexing(turn, idx) {
      if (!settings.semanticSearch || !settings.semanticSearch.enabled) return;
      searchIndexBuffer.push({ idx, role: turn.role, text: turn.text });
    }
    async function flushSearchIndex() {
      if (searchIndexBuffer.length === 0) return;
      if (!settings.semanticSearch || !settings.semanticSearch.enabled) { searchIndexBuffer = []; return; }
      const turns = searchIndexBuffer;
      searchIndexBuffer = [];
      try {
        await indexTurns(location.href, document.title, turns);
        settings.semanticSearch.indexed = await searchIndexCounts();
      } catch (err) { console.error("[BetterClaude] search indexing failed", err); }
    }
    setInterval(flushSearchIndex, 15000);
    window.addEventListener("beforeunload", flushSearchIndex);

    let pluginLoader;
    function effectiveSoundSettings() {
      const sound = settings.sound;
      const zenActive = !!(settings.focusReading && settings.focusReading.zenMode);
      const focusModeEntry = pluginLoader && pluginLoader.loaded.get("focus-mode");
      const focusActive = !!(focusModeEntry && focusModeEntry.module.active);
      const forcedMute = zenActive && settings.automations.zenMutesSound;
      const forcedAmbientOff = focusActive && settings.automations.focusPausesAmbient;
      return { ...sound, muted: sound.muted || forcedMute, ambient: forcedAmbientOff ? { ...sound.ambient, track: "off" } : sound.ambient };
    }

    function applyExtras() {
      ensureStyleTag("betterclaude-extras").textContent = buildExtrasCSS(settings);
      applyColorBlindSafeVars(!!(settings.appearance && settings.appearance.colorBlindSafe));
      document.documentElement.dataset.bcMood = (settings.personality && settings.personality.mood) || "";
      document.body.classList.toggle("bc-zen-mode", !!(settings.focusReading && settings.focusReading.zenMode));
      soundEngine.applySettings({ sound: effectiveSoundSettings() });
      companion.update(settings);
      if (interactionFX) interactionFX.applySettings(settings);
      if (settings.motion && settings.motion.parallax && !stopParallax) {
        stopParallax = mountParallax(() => [document.getElementById("bc-companion"), document.getElementById("betterclaude-hud")]);
      } else if ((!settings.motion || !settings.motion.parallax) && stopParallax) { stopParallax(); stopParallax = null; }
      const wantsSeasonal = !!(settings.motion && settings.motion.seasonalDecorations);
      if (wantsSeasonal && !stopSeasonal) stopSeasonal = mountSeasonalDecoration(new Date().getMonth());
      else if (!wantsSeasonal && stopSeasonal) { stopSeasonal(); stopSeasonal = null; }
    }

    function applyBundlePreview(bundle) {
      Object.assign(settings.appearance, { activeTheme: bundle.themeId });
      Object.assign(settings.appearanceEditor, { shape: bundle.shape });
      Object.assign(settings.cursor, { style: bundle.cursorStyle, trail: bundle.cursorTrail });
      Object.assign(settings.motion, { easing: bundle.easing, transition: bundle.transition });
      themeEngine.applySettings(settings);
      applyExtras();
    }

    function applyThemeState() {
      if (settings.general && settings.general.enabled === false) {
        ["betterclaude-theme", "betterclaude-base", "betterclaude-custom-css", "betterclaude-background", "betterclaude-extras"].forEach((id) => {
          const tag = document.getElementById(id);
          if (tag) tag.textContent = "";
        });
        hud.setVisible(false);
        companion.update({ personality: { companionEnabled: false } });
        if (interactionFX) { interactionFX.unmount(); interactionFX = null; }
        if (stopParallax) { stopParallax(); stopParallax = null; }
        if (stopSeasonal) { stopSeasonal(); stopSeasonal = null; }
        soundEngine.applySettings({ sound: { ...settings.sound, muted: true, ambient: { track: "off" } } });
      } else {
        themeEngine.applySettings(settings);
        hud.applyVisualSettings(settings.hud);
        hud.applyPosition(settings.hud);
        if (!interactionFX) { interactionFX = new InteractionFX({ onRadialAction: (id) => runRadialAction(id) }); interactionFX.mount(settings); }
        applyExtras();
      }
    }

    function applyScheduledTheme() {
      if (settings.general && settings.general.enabled === false) return;
      const schedule = settings.appearance && settings.appearance.schedule;
      if (schedule && schedule.mode === "season") {
        const bundle = bundleForSeason(new Date().getMonth());
        if (bundle && themes[bundle.themeId]) themeEngine.setTheme(bundle.themeId);
        return;
      }
      const themeId = resolveScheduledTheme(schedule, { isDarkOS: osThemeIsDark });
      if (themeId && themes[themeId]) themeEngine.setTheme(themeId);
    }

    async function applyScheduledWeatherTheme() {
      const wt = settings.appearance && settings.appearance.weatherTheme;
      if (!wt || !wt.enabled || wt.lat == null || wt.lon == null) return false;
      try {
        const { code, isDay } = await bg("weather:get", { lat: wt.lat, lon: wt.lon });
        const bundle = mapWeatherCodeToBundle(code, isDay);
        if (!bundle) return false;
        applyBundle(bundle, { setSetting, applyBundlePreview });
        return true;
      } catch (err) { console.error("[BetterClaude] weather theme fetch failed", err); return false; }
    }

    let lastRotationAt = Date.now();
    function applyBackgroundRotation() {
      const rotation = settings.background && settings.background.rotation;
      if (!rotation || !rotation.enabled || !rotation.pool || rotation.pool.length === 0) return;
      const intervalMs = Math.max(15, rotation.intervalMinutes || 60) * 60 * 1000;
      const now = Date.now();
      if (now - lastRotationAt < intervalMs) return;
      lastRotationAt = now;
      const currentIndex = rotation.pool.findIndex((snap) => snap.mode === settings.background.mode && snap.color === settings.background.color && snap.gradient === settings.background.gradient);
      const next = rotation.pool[(currentIndex + 1 + rotation.pool.length) % rotation.pool.length];
      Object.entries(next).forEach(([key, value]) => setSetting(`background.${key}`, value));
    }

    // Plugins are the same built-in set as the Electron app, statically
    // bundled at build time into window.BetterClaudePlugins[id] — see
    // build.js's bundlePlugins() and this file's header comment for why
    // there's no arbitrary-user-plugin loading here.
    function readAllPluginSources() {
      return Object.keys(window.BetterClaudePlugins || {}).map((id) => ({ id, module: window.BetterClaudePlugins[id] }));
    }

    function applyPluginState() {
      const sources = readAllPluginSources();
      if (settings.general && settings.general.enabled === false) {
        pluginLoader.list().forEach((p) => pluginLoader.unload(p.id));
        return;
      }
      sources.forEach(({ id, module }) => {
        const shouldBeEnabled = settings.plugins.enabled[id] !== false;
        const isLoaded = pluginLoader.list().some((p) => p.id === id);
        if (shouldBeEnabled && !isLoaded) {
          try { pluginLoader.load(id, module); } catch (err) { console.error(`[BetterClaude] failed to load plugin "${id}"`, err); }
        } else if (!shouldBeEnabled && isLoaded) {
          pluginLoader.unload(id);
        }
      });
    }

    function setSetting(keyPath, value) {
      return bg("settings:set", { keyPath, value }).then((updated) => { settings = updated; return updated; });
    }

    const settingsChangedHandlers = [];

    const tokenCounter = new TokenCounter({ modelName: "claude" });
    const hud = new HUD({ onPositionChange: (pos) => setSetting("hud.x", pos.x) && setSetting("hud.y", pos.y), onDismiss: () => setSetting("hud.enabled", false) });
    hud.mount(settings);
    companion.mount(settings);

    let lastUsage = null;
    applyThemeState();
    applyScheduledTheme();
    applyScheduledWeatherTheme();
    setInterval(applyScheduledTheme, 60 * 1000);
    setInterval(applyScheduledWeatherTheme, 30 * 60 * 1000);
    setInterval(applyBackgroundRotation, 60 * 1000);

    function showToast(message, { category = null, timeout = 3000 } = {}) {
      const style = (settings.notifications && settings.notifications.style) || "banner";
      const typeConf = category && settings.notifications && settings.notifications.types[category];
      const toast = document.createElement("div");
      toast.className = `bc-toast ${notificationStyleClass(style)}`;
      if (style === "badge" && typeConf) { toast.textContent = typeConf.icon || "•"; toast.title = message; }
      else toast.textContent = (typeConf && typeConf.icon ? `${typeConf.icon} ` : "") + message;
      if (typeConf && typeConf.color) toast.style.borderColor = typeConf.color;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), timeout);
    }

    let digestQueue = [];
    function flushDigest() {
      if (digestQueue.length === 0) return;
      const items = digestQueue;
      digestQueue = [];
      const shown = items.slice(0, 5).map((i) => i.message);
      const summary = shown.join(" · ") + (items.length > shown.length ? ` · +${items.length - shown.length} more` : "");
      showToast(`${items.length} update${items.length === 1 ? "" : "s"}: ${summary}`, { timeout: 6000 });
      bg("notifications:show-native", { title: `BetterClaude — ${items.length} update${items.length === 1 ? "" : "s"}`, body: summary }).catch(() => {});
    }
    let digestTimer = null;
    function syncDigestTimer() {
      if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
      const digest = settings.notifications && settings.notifications.digest;
      if (!digest || !digest.enabled) { flushDigest(); return; }
      digestTimer = setInterval(flushDigest, Math.max(1, digest.intervalMinutes || 15) * 60 * 1000);
    }
    function notify(message, { category = null, timeout = 3000, urgent = false } = {}) {
      if (category && settings.notifications && shouldSuppress(settings.notifications, category)) return;
      const digest = settings.notifications && settings.notifications.digest;
      if (category && digest && digest.enabled && !urgent) { digestQueue.push({ message, category, ts: Date.now() }); return; }
      showToast(message, { category, timeout });
      if (urgent) bg("notifications:show-native", { title: "BetterClaude", body: message }).catch(() => {});
    }

    pluginLoader = new PluginLoader({ themeEngine, hud, getSettings: () => settings, setSetting, host: { getLastUsage: () => lastUsage, notify } });

    let dispatchedTurnCount = 0;
    let pendingTurnText = null;

    function costForTokens(role, tok) {
      const rates = (settings.analytics && settings.analytics.costPerMillionTokens) || { input: 0, output: 0 };
      const rate = role === "user" ? rates.input : rates.output;
      return (tok / 1000000) * (rate || 0);
    }
    function logMessageAnalytics(turn) {
      if (!settings.analytics || !settings.analytics.enabled) return;
      const tok = estimateTokens(turn.text);
      bg("analytics:log-event", { ts: Date.now(), day: new Date().toISOString().slice(0, 10), type: "message", role: turn.role, tokens: tok, model: tokenCounter.modelName, project: document.title || location.href, costUsd: costForTokens(turn.role, tok) }).catch(() => {});
    }
    function logPluginAnalyticsTick() {
      if (!settings.analytics || !settings.analytics.enabled) return;
      const pluginIds = pluginLoader.list().map((p) => p.id);
      if (pluginIds.length === 0) return;
      bg("analytics:log-plugin-tick", { ts: Date.now(), day: new Date().toISOString().slice(0, 10), pluginIds }).catch(() => {});
    }

    function detectAndDispatchNewMessages(turns) {
      if (turns.length === 0) { dispatchedTurnCount = 0; pendingTurnText = null; return; }
      const lastIndex = turns.length - 1;
      while (dispatchedTurnCount < lastIndex) {
        const turn = turns[dispatchedTurnCount];
        pluginLoader.dispatchMessage({ role: turn.role, text: turn.text, node: turn.node });
        logMessageAnalytics(turn);
        logPluginAnalyticsTick();
        bufferForIndexing(turn, dispatchedTurnCount);
        dispatchedTurnCount += 1;
      }
      if (dispatchedTurnCount > lastIndex) return;
      const lastTurn = turns[lastIndex];
      if (pendingTurnText === lastTurn.text) {
        pluginLoader.dispatchMessage({ role: lastTurn.role, text: lastTurn.text, node: lastTurn.node });
        logMessageAnalytics(lastTurn);
        logPluginAnalyticsTick();
        bufferForIndexing(lastTurn, lastIndex);
        dispatchedTurnCount = turns.length;
        pendingTurnText = null;
      } else {
        pendingTurnText = lastTurn.text;
      }
    }

    function wrapForkPreamble(transcriptText) {
      return ["[Continuing from a forked conversation — the messages below are context from the original chat. Reply to the last one as if this conversation had continued from there.]", "", transcriptText, "", "[End of forked context]"].join("\n");
    }
    async function forkFromTurn(turns, idx) {
      const upto = turns.slice(0, idx + 1);
      const preamble = wrapForkPreamble(buildTranscriptText(upto));
      await bg("branching:open-fork", { preambleText: preamble, label: `Fork @ turn ${idx + 1} — ${document.title || "Untitled"}`, forkedFromUrl: location.href, forkedAtTurnIndex: idx });
      notify("Opened a forked tab — review and send when ready.", { category: "plugin" });
    }
    async function copyForCompare(text) {
      try { await navigator.clipboard.writeText(text); notify("Copied — paste it into the Diff Viewer (Cmd+K → Compare Responses).", { category: "plugin" }); }
      catch (_e) { notify("Couldn't copy to clipboard."); }
    }
    const branchForkButtons = mountBranchForkButtons({ getTurns: () => collectConversationText(document), onFork: (turns, idx) => forkFromTurn(turns, idx), onCopyForCompare: (text) => copyForCompare(text) });

    const diffApplier = new DiffApplierOverlay({
      readFile: (id) => FileWatcher.readFile(id),
      writeFile: (id, content) => FileWatcher.writeFile(id, content),
      notify: (message) => notify(message, { category: "plugin" }),
    });
    const codeDiffButtons = mountCodeDiffButtons({ getTurns: () => collectConversationText(document), getWatchedFiles: () => settings.fileWatcher.watched || [], onOpen: (payload) => diffApplier.open(payload) });

    const analyticsDashboard = new AnalyticsDashboard({
      queryAnalytics: (range) => bg("analytics:query", range),
      exportCsv: (range) => bg("analytics:export-csv", range),
      savePng: (dataUrl, suggestedName) => {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = suggestedName || "betterclaude-chart.png";
        a.click();
        return Promise.resolve(true);
      },
      clearAnalytics: () => bg("analytics:clear"),
      notify: (message) => notify(message, { category: "plugin" }),
    });

    function snapshotId() { return `sn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
    function takeSnapshot(label) {
      const turns = collectConversationText(document);
      if (turns.length === 0) return null;
      const transcript = buildTranscriptText(turns);
      const list = settings.snapshots.list || [];
      const sameConversation = list.filter((s) => s.conversationUrl === location.href);
      const mostRecent = sameConversation[sameConversation.length - 1];
      if (mostRecent && mostRecent.transcript === transcript) return null;
      const record = { id: snapshotId(), label: label || `Snapshot @ ${new Date().toLocaleString()}`, createdAt: Date.now(), conversationUrl: location.href, conversationTitle: document.title || "Untitled", turnCount: turns.length, transcript };
      const others = list.filter((s) => s.conversationUrl !== location.href);
      const keptForThisConvo = [...sameConversation, record].slice(-20);
      settings.snapshots.list = [...others, ...keptForThisConvo];
      setSetting("snapshots.list", settings.snapshots.list);
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

    function syncForkButtonsVisibility() { branchForkButtons.setVisible(!!(settings.branching && settings.branching.enabled && settings.branching.showForkButtons)); }
    function syncCodeDiffButtonsVisibility() { codeDiffButtons.setVisible(!!(settings.diffApplier && settings.diffApplier.enabled && settings.fileWatcher && settings.fileWatcher.enabled)); }

    function refreshUsage() {
      lastUsage = tokenCounter.computeUsage(document);
      hud.update(lastUsage);
      detectAndDispatchNewMessages(collectConversationText(document));
      if (settings.branching && settings.branching.enabled && settings.branching.showForkButtons) branchForkButtons.sync();
      if (settings.diffApplier && settings.diffApplier.enabled && settings.fileWatcher && settings.fileWatcher.enabled) codeDiffButtons.sync();
      if (!contextBudgetPlanner.composer || !document.contains(contextBudgetPlanner.composer)) contextBudgetPlanner.attach(document);
      if (!modelRouter.composer || !document.contains(modelRouter.composer)) modelRouter.attach(document);
      if (!macroCaptureComposer || !document.contains(macroCaptureComposer)) attachMacroCaptureIfNeeded();
    }

    const chatObserver = new MutationObserver(() => refreshUsage());
    const claudeRoot = document.getElementById("root") || document.getElementById("__next") || document.body;
    chatObserver.observe(claudeRoot, { childList: true, subtree: true, characterData: true });
    setInterval(refreshUsage, 1000);
    refreshUsage();

    function syncZenModeWithFocusPlugin() {
      if (!pluginLoader) return;
      const entry = pluginLoader.loaded.get("focus-mode");
      if (entry && entry.module && typeof entry.module.setActive === "function") {
        const desired = !!(settings.focusReading && settings.focusReading.zenMode);
        if (entry.module.active !== desired) entry.module.setActive(desired);
      }
    }

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

    onBroadcast("betterclaude:team-sync-error", (message) => notify(`Team Sync failed: ${message}`, { category: "plugin", urgent: true }));
    onBroadcast("betterclaude:team-sync-applied", (payload) => {
      const parts = [];
      if (payload.pluginIds.length > 0) parts.push(`${payload.pluginIds.length} plugin${payload.pluginIds.length === 1 ? "" : "s"}`);
      if (payload.themeIds.length > 0) parts.push(`${payload.themeIds.length} theme${payload.themeIds.length === 1 ? "" : "s"}`);
      if (parts.length > 0) notify(`Team Sync applied ${parts.join(" and ")} (reload to see updated plugins).`, { category: "plugin" });
    });

    // Cross-Device Clipboard Bridge: background/service-worker.js's
    // "clipboard-bridge" alarm asks whichever claude.ai tab is focused to do
    // the actual clipboard read/write (a service worker has no
    // navigator.clipboard access) — see this file's header comment on why
    // the poll interval is clamped to chrome.alarms' 1-minute floor.
    let clipboardBridgeLastLocal = null;
    onBroadcast("betterclaude:clipboard-tick", async ({ cfg }) => {
      try {
        const current = await navigator.clipboard.readText();
        if (current && current !== clipboardBridgeLastLocal) {
          clipboardBridgeLastLocal = current;
          await bg("clipboardBridge:push-text", { text: current, cfg });
        }
        const pulled = await bg("clipboardBridge:pull-text", { cfg, afterTs: settings.clipboardBridge.lastPulledTs || 0 });
        for (const item of pulled) {
          clipboardBridgeLastLocal = item.text;
          await navigator.clipboard.writeText(item.text);
          notify(`Clipboard synced from ${item.deviceName}.`, { category: "plugin" });
          settings.clipboardBridge.lastPulledTs = Math.max(settings.clipboardBridge.lastPulledTs || 0, item.ts);
        }
      } catch (err) {
        console.error("[BetterClaude] clipboard bridge tick failed", err);
      }
    });

    let lastTeamSyncConflictCount = (settings.teamSync && settings.teamSync.conflicts.length) || 0;
    onBroadcast("betterclaude:settings-changed", (updated) => {
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
      if (conflictCount > lastTeamSyncConflictCount) notify(`Team Sync: ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} need review — Settings → Team Sync.`, { category: "plugin" });
      lastTeamSyncConflictCount = conflictCount;
      settingsChangedHandlers.forEach((cb) => cb(settings));
    });

    applyPluginState();
    syncZenModeWithFocusPlugin();
    syncForkButtonsVisibility();
    syncCodeDiffButtonsVisibility();
    syncDigestTimer();

    {
      const todayStr = new Date().toISOString().slice(0, 10);
      const nextStreak = incrementStreak(settings.personality.streak, todayStr);
      if (nextStreak.bumped) {
        setSetting("personality.streak", { count: nextStreak.count, lastActiveDate: nextStreak.lastActiveDate });
        if (nextStreak.count > 1) companion.react("streak-bump");
      }
      refreshAchievements();
      const greeting = buildGreeting({ name: settings.personality.userName, streakCount: nextStreak.count, style: settings.personality.greetingStyle });
      companion.say(settings.personality.statusMessage || greeting);
    }

    function runCommand(cmd) {
      if (!cmd) return;
      if (typeof cmd.run === "function") { cmd.run(); return; }
      if (cmd.settingPath) setSetting(cmd.settingPath, cmd.value);
    }

    function indexedCommands() {
      const actions = [
        { id: "open-settings", label: "Open Settings", group: "Action", run: () => settingsPanel.open() },
        { id: "toggle-zen", label: "Toggle Zen Mode", group: "Action", run: () => setSetting("focusReading.zenMode", !settings.focusReading.zenMode) },
        { id: "toggle-mute", label: "Toggle Mute", group: "Action", run: () => setSetting("sound.muted", !settings.sound.muted) },
        { id: "play-snake", label: "Play Snake", group: "Action", run: () => openMiniGame() },
        { id: "open-skill-marketplace", label: "Open Skill Marketplace", group: "Skills", run: () => skillMarketplace.open() },
        { id: "insert-prompt", label: "Insert Prompt…", group: "Prompts", run: () => promptPicker.open() },
        { id: "compare-responses", label: "Compare Responses (Diff)", group: "Action", run: () => diffViewer.open() },
        { id: "snapshot-now", label: "Snapshot This Conversation", group: "Action", run: () => panelHost.snapshotNow() },
        { id: "search-all-chats", label: "Search All Chats", group: "Chats", run: () => semanticSearch.open() },
        { id: "open-usage-analytics", label: "Open Usage Analytics", group: "Analytics", run: () => analyticsDashboard.open() },
        { id: "sync-team-now", label: "Sync Team Plugins Now", group: "Action", run: () => bg("teamSync:sync").catch((err) => notify(`Team Sync failed: ${err.message}`)) },
        { id: "toggle-macro-recording", label: macroRecorder.isRecording() ? "Stop Macro Recording" : "Start Macro Recording", group: "Macros", run: () => (macroRecorder.isRecording() ? finishRecording() : macroRecorder.startRecording()) },
        ...(settings.commandPalette.customCommands || []).map((c) => ({ id: c.id, label: c.label, group: "Action", settingPath: c.settingPath, value: c.value })),
      ];
      const settingsPages = SECTIONS.map((section) => ({ id: `settings-${section}`, label: `Settings: ${section}`, group: "Settings", keywords: "settings preferences", run: () => settingsPanel.openSection(section) }));
      const prompts = (settings.promptLibrary.prompts || []).map((p) => ({ id: `prompt-${p.id}`, label: `Insert Prompt: ${p.title}`, group: "Prompts", run: () => promptPicker.open(p.id) }));
      const macros = (settings.macros.list || []).map((m) => ({ id: `macro-${m.id}`, label: `Replay Macro: ${m.name}`, group: "Macros", run: () => doReplayMacro(m) }));
      const installedSkills = Object.entries(settings.skillMarketplace.installed || {}).map(([id, record]) => ({ id: `skill-installed-${id}`, label: `Reveal Skill: ${record.owner}/${record.repo}`, group: "Skills", run: () => bg("skills:reveal", { id }) }));
      const cachedSkills = ((settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || []).map((item) => ({ id: `skill-cache-${item.id}`, label: `Marketplace: ${item.fullName}`, group: "Skills", run: () => { skillMarketplace.open(); skillMarketplace.select(item); } }));
      const plugins = readAllPluginSources().map(({ id }) => ({ id: `plugin-${id}`, label: `Toggle Plugin: ${id}`, group: "Plugins", run: () => panelHost.togglePlugin(id, settings.plugins.enabled[id] === false) }));
      return [...actions, ...settingsPages, ...prompts, ...macros, ...installedSkills, ...cachedSkills, ...plugins];
    }
    commandPalette.setAsyncSource(async (query) => {
      if (!settings.semanticSearch || !settings.semanticSearch.enabled || !query) return [];
      const results = await queryLocalIndex(query, 5);
      return results.map((r) => ({ id: `chat-${r.conversationUrl}-${r.snippet.slice(0, 20)}`, label: `${r.title}: ${r.snippet}`, group: "Chats", run: () => jumpToResult(r) }));
    });
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        commandPalette.setCommands(indexedCommands());
        commandPalette.toggle();
      }
    });
    mountKonamiListener(() => {
      setSetting("personality.easterEggs.konamiUnlocked", true);
      refreshAchievements();
      celebrate();
    });

    let miniGameEl = null;
    function openMiniGame() {
      if (miniGameEl) return;
      const container = document.createElement("div");
      container.id = "bc-mini-game-overlay";
      document.body.appendChild(container);
      miniGameEl = mountSnakeGame(container, { onClose: () => { container.remove(); miniGameEl = null; } });
    }

    function runRadialAction(id) {
      if (id === "settings") settingsPanel.open();
      else if (id === "palette") commandPalette.toggle();
      else if (id === "prompts") promptPicker.open();
      else if (id === "zen") setSetting("focusReading.zenMode", !settings.focusReading.zenMode);
    }

    // --- Settings panel host bridge — see ui/settings-panel/panel.js's
    // top-of-file JSDoc for the full `host` interface contract. ---
    const panelHost = {
      getSettings: () => settings,
      setSetting,
      onSettingsChanged: (cb) => settingsChangedHandlers.push(cb),
      listThemeIds: () => Object.keys(themes),
      getThemesData: () => themes,
      listPlugins: async () => readAllPluginSources().map(({ id, module }) => ({ id, name: (module && module.name) || id, version: (module && module.version) || "1.0.0", enabled: settings.plugins.enabled[id] !== false })),
      togglePlugin: (id, enabled) => setSetting(`plugins.enabled.${id}`, enabled),
      openPluginsFolder: () => notify("Plugins are bundled with the extension — there's no local plugins folder to open."),
      mountCSSEditor: (container, opts) => {
        let editorHandle = null;
        loadCssEditor().then((mod) => { editorHandle = mod.mountCssEditor(container, opts); });
        return { setValue: (v) => editorHandle && editorHandle.setValue(v), destroy: () => editorHandle && editorHandle.destroy() };
      },
      applyThemePreview: (themeId) => themeEngine.setTheme(themeId),
      applyCustomCSSPreview: (css) => { ensureStyleTag("betterclaude-custom-css").textContent = css; },
      applyAccentPreview: (hex) => themeEngine.setAccentColor(hex),
      refreshSkillsCache: () => bg("skills:refresh-cache"),
      openSkillMarketplace: () => skillMarketplace.open(),
      revealSkill: (id) => bg("skills:reveal", { id }),
      uninstallSkill: (id) => bg("skills:uninstall", { id }),
      exportPromptLibrary: () => {
        const payload = { version: 1, prompts: settings.promptLibrary.prompts, folders: settings.promptLibrary.folders };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "betterclaude-prompts.json";
        a.click();
        return Promise.resolve(true);
      },
      importPromptLibrary: () => new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.onchange = () => {
          const file = input.files[0];
          if (!file) { resolve(null); return; }
          file.text().then(async (text) => {
            const parsed = JSON.parse(text);
            const existing = settings.promptLibrary.prompts || [];
            const incoming = Array.isArray(parsed.prompts) ? parsed.prompts : [];
            const byId = new Map(existing.map((p) => [p.id, p]));
            incoming.forEach((p) => { if (p && p.id) byId.set(p.id, p); });
            await setSetting("promptLibrary.prompts", Array.from(byId.values()));
            if (Array.isArray(parsed.folders)) await setSetting("promptLibrary.folders", Array.from(new Set([...(settings.promptLibrary.folders || []), ...parsed.folders])));
            resolve(settings);
          });
        };
        input.click();
      }),
      openBranch: (id) => bg("branching:open-branch", { branchId: id }),
      deleteBranch: (id) => bg("branching:delete-branch", { branchId: id }),
      snapshotNow: (label) => Promise.resolve(takeSnapshot(label)),
      restoreSnapshot: async (id) => {
        const snap = (settings.snapshots.list || []).find((s) => s.id === id);
        if (!snap) return;
        await bg("branching:open-fork", { preambleText: wrapForkPreamble(snap.transcript), label: `Restored: ${snap.label}` });
      },
      exportSnapshot: (id) => {
        const snap = (settings.snapshots.list || []).find((s) => s.id === id);
        if (!snap) return Promise.resolve(false);
        const blob = new Blob([snap.transcript || ""], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${(snap.label || "snapshot").replace(/[^a-z0-9-_ ]/gi, "_")}.txt`;
        a.click();
        return Promise.resolve(true);
      },
      renameSnapshot: (id, label) => {
        const list = (settings.snapshots.list || []).map((s) => (s.id === id ? { ...s, label } : s));
        return setSetting("snapshots.list", list);
      },
      deleteSnapshot: (id) => setSetting("snapshots.list", (settings.snapshots.list || []).filter((s) => s.id !== id)),
      openChatSearch: () => semanticSearch.open(),
      clearSearchIndex: async () => {
        const store = await searchStore("readwrite");
        store.clear();
        settings.semanticSearch.indexed = { conversations: 0, turns: 0 };
        return settings.semanticSearch.indexed;
      },
      pickWatchedFile: async () => {
        const { id, name, content } = await FileWatcher.pickFile();
        const watched = [...(settings.fileWatcher.watched || []), { id, name, path: id }];
        await setSetting("fileWatcher.watched", watched);
        FileWatcher.start(id, (newContent) => {
          const composer = findComposer(document);
          const stale = settings.fileWatcher.autoReattach && settings.fileWatcher.autoReattach[id];
          if (composer && stale) findAndReplaceInComposer(composer, name, newContent);
          notify(`"${name}" changed on disk.`, { category: "plugin" });
        });
        return { id, name, content };
      },
      stopWatchingFile: (id) => {
        FileWatcher.forget(id);
        return setSetting("fileWatcher.watched", (settings.fileWatcher.watched || []).filter((w) => w.id !== id));
      },
      insertWatchedFile: async (id) => {
        const watched = (settings.fileWatcher.watched || []).find((w) => w.id === id);
        if (!watched) return;
        const content = await FileWatcher.readFile(id);
        insertFileBlock(watched.name, content);
      },
      setAutoReattach: (id, enabled) => setSetting(`fileWatcher.autoReattach.${id}`, enabled),
      isRecordingMacro: () => macroRecorder.isRecording(),
      startRecordingMacro: (name) => macroRecorder.startRecording(name),
      stopRecordingMacro: () => finishRecording(),
      isReplayingMacro: () => macroRecorder.isReplaying(),
      replayMacro: (id) => doReplayMacro((settings.macros.list || []).find((m) => m.id === id)),
      stopMacroReplay: () => { replayStopRequested = true; },
      renameMacro: (id, name) => setSetting("macros.list", (settings.macros.list || []).map((m) => (m.id === id ? { ...m, name } : m))),
      setMacroShortcut: () => notify("Per-macro OS-wide shortcuts aren't supported in the browser-extension build — see README."),
      updateMacroSteps: (id, steps) => setSetting("macros.list", (settings.macros.list || []).map((m) => (m.id === id ? { ...m, steps } : m))),
      deleteMacro: (id) => setSetting("macros.list", (settings.macros.list || []).filter((m) => m.id !== id)),
      getClipboardBridgeStatus: () => bg("clipboardBridge:get-status"),
      onClipboardBridgeStatus: () => {},
      pushClipboardNow: async () => {
        const cfg = settings.clipboardBridge;
        const text = await navigator.clipboard.readText();
        if (!text) throw new Error("Clipboard is empty.");
        await bg("clipboardBridge:push-text", { text, cfg });
      },
      testClipboardBridgeConnection: () => bg("clipboardBridge:test-connection", { relayUrl: settings.clipboardBridge.relayUrl }),
      openAnalyticsDashboard: () => analyticsDashboard.open(),
      syncTeamNow: () => bg("teamSync:sync"),
      getTeamSyncDiff: () => notify("Inline repo/local diffing isn't available in the browser-extension build yet — see Settings → Team Sync → conflicts list."),
      applyTeamSyncFile: () => bg("teamSync:sync"),
      keepLocalTeamSyncFile: (relPath) => setSetting("teamSync.conflicts", (settings.teamSync.conflicts || []).filter((c) => c.relPath !== relPath)),
      openTeamSyncFolder: () => notify("Team Sync stores synced files in extension storage, not a local folder, in this build."),
    };

    const settingsPanel = new SettingsPanel(panelHost);
    // No frameless window chrome to mount a title bar into (see
    // ui/title-bar.js's own header comment) — Settings opens via the
    // toolbar popup (popup/popup.js), the command-palette action, or the
    // "toggle-settings" chrome.commands shortcut below.
    onBroadcast("betterclaude:open-settings", () => settingsPanel.open());
    onBroadcast("betterclaude:open-palette", () => { commandPalette.setCommands(indexedCommands()); commandPalette.toggle(); });

    chrome.commands.onCommand.addListener((command) => {
      if (command === "toggle-settings") settingsPanel.open();
      else if (command === "open-command-palette") { commandPalette.setCommands(indexedCommands()); commandPalette.toggle(); }
      else if (command === "open-prompt-picker") promptPicker.open();
      else if (command === "toggle-zen-mode") setSetting("focusReading.zenMode", !settings.focusReading.zenMode);
    });
  }

  bootstrap().catch((err) => console.error("[BetterClaude] bootstrap failed", err));
})();

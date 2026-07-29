/**
 * Core entry point — bundled by esbuild.config.js into a single IIFE that
 * exposes `window.BetterClaudeCore`. This is the exact module a browser
 * extension's content script would import later; nothing here is
 * Electron-specific.
 */

const {
  ThemeEngine,
  SELECTORS,
  THEME_VAR_DEFS,
  buildThemeCSSFromVars,
  resolveScheduledTheme,
  ensureStyleTag,
} = require("./theme-engine");
const { PluginLoader } = require("./plugin-loader");
const { DEFAULT_SETTINGS, mergeDefaults } = require("./settings-schema");
const tokens = require("./tokens");
const { applyBackground, buildBackgroundCSS } = require("./background");
const extrasCss = require("./extras-css");
const { InteractionFX } = require("./interaction-fx");
const { SoundEngine } = require("./sound-engine");
const motionFx = require("./motion-fx");
const companion = require("./companion");
const buddies = require("./buddies");
const { CommandPalette, mountKonamiListener, KONAMI_SEQUENCE, fuzzyScore } = require("./command-palette");
const vibeBundles = require("./vibe-bundles");
const weather = require("./weather");
const notifications = require("./notifications");
const { findComposer, insertIntoComposer, waitForComposer } = require("./compose-insert");
const { SkillMarketplaceOverlay } = require("./skill-marketplace");
const { extractVariables, fillTemplate } = require("./prompt-vars");
const { PromptPicker } = require("./prompt-picker");
const { DiffViewer } = require("./diff-viewer");
const { buildFileBlock, findAndReplaceInComposer, insertFileBlock } = require("./file-sync-indicator");
const { deriveChannelId, deriveKey, encryptText, decryptText } = require("./clipboard-bridge");
const { renderLineChart, renderBarChart } = require("./analytics-charts");
const { AnalyticsDashboard, presetRange } = require("./analytics-dashboard");
const { UpdateBanner, BANNER_ID } = require("./update-banner");
const { mountTopStripGuard, probeReservedStrip } = require("./top-strip-guard");
const {
  mountLayoutProbe,
  probeLayout,
  applyLayoutMarkers,
  findClaudeRoot,
  findTopTabBar,
} = require("./layout-probe");

module.exports = {
  ThemeEngine,
  SELECTORS,
  THEME_VAR_DEFS,
  buildThemeCSSFromVars,
  resolveScheduledTheme,
  ensureStyleTag,
  tokens,
  applyBackground,
  buildBackgroundCSS,
  PluginLoader,
  DEFAULT_SETTINGS,
  mergeDefaults,
  // Customize Everything additions:
  extrasCss,
  InteractionFX,
  SoundEngine,
  motionFx,
  companion,
  buddies,
  CommandPalette,
  mountKonamiListener,
  KONAMI_SEQUENCE,
  fuzzyScore,
  vibeBundles,
  weather,
  notifications,
  // Productivity modules: Skill Marketplace, Prompt Library.
  findComposer,
  insertIntoComposer,
  waitForComposer,
  SkillMarketplaceOverlay,
  extractVariables,
  fillTemplate,
  PromptPicker,
  DiffViewer,
  buildFileBlock,
  findAndReplaceInComposer,
  insertFileBlock,
  deriveChannelId,
  deriveKey,
  encryptText,
  decryptText,
  renderLineChart,
  renderBarChart,
  AnalyticsDashboard,
  presetRange,
  // In-app updates (GitHub Releases feed; transport supplied by the host).
  UpdateBanner,
  BANNER_ID,
  // Diagnostic: warns when claude.ai's own chrome ends up underneath the
  // custom title bar. Inert in the extension build, which reserves no strip.
  mountTopStripGuard,
  probeReservedStrip,
  // Version-aware injection gate: decides whether claude.ai's current DOM is
  // recognizable enough to apply page geometry to, and tags the app root the
  // geometry rules target. Unlike the guard above, this is load-bearing in
  // packaged builds — it is what makes an unknown layout degrade instead of
  // getting injected over blind.
  mountLayoutProbe,
  probeLayout,
  applyLayoutMarkers,
  findClaudeRoot,
  findTopTabBar,
};

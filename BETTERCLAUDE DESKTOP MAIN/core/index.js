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
const { TokenCounter, estimateTokens, getContextWindow, detectModel, collectConversationText } = require("./token-counter");
const { HUD } = require("./hud");
const { PluginLoader } = require("./plugin-loader");
const { DEFAULT_SETTINGS, mergeDefaults } = require("./settings-schema");
const tokens = require("./tokens");
const { applyBackground, buildBackgroundCSS } = require("./background");
const extrasCss = require("./extras-css");
const { InteractionFX } = require("./interaction-fx");
const { SoundEngine } = require("./sound-engine");
const motionFx = require("./motion-fx");
const companion = require("./companion");
const { CommandPalette, mountKonamiListener, KONAMI_SEQUENCE, fuzzyScore } = require("./command-palette");
const vibeBundles = require("./vibe-bundles");
const weather = require("./weather");
const notifications = require("./notifications");
const { findComposer, insertIntoComposer, waitForComposer } = require("./compose-insert");
const { SkillMarketplaceOverlay } = require("./skill-marketplace");
const { extractVariables, fillTemplate } = require("./prompt-vars");
const { PromptPicker } = require("./prompt-picker");
const { mountBranchForkButtons } = require("./branch-fork-buttons");
const { DiffViewer } = require("./diff-viewer");
const { ContextBudgetPlanner } = require("./context-budget");
const { SemanticSearchOverlay } = require("./semantic-search");
const { pickRule, ModelRouter } = require("./model-router");
const { buildFileBlock, findAndReplaceInComposer, insertFileBlock } = require("./file-sync-indicator");
const { MacroRecorder, replayMacro, waitForResponseSettled } = require("./macro-recorder");
const { deriveChannelId, deriveKey, encryptText, decryptText } = require("./clipboard-bridge");
const { extractCodeBlocks, matchCandidates, mountCodeDiffButtons, DiffApplierOverlay } = require("./diff-applier");
const { renderLineChart, renderBarChart } = require("./analytics-charts");
const { AnalyticsDashboard, presetRange } = require("./analytics-dashboard");

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
  TokenCounter,
  estimateTokens,
  getContextWindow,
  detectModel,
  collectConversationText,
  HUD,
  PluginLoader,
  DEFAULT_SETTINGS,
  mergeDefaults,
  // Customize Everything additions:
  extrasCss,
  InteractionFX,
  SoundEngine,
  motionFx,
  companion,
  CommandPalette,
  mountKonamiListener,
  KONAMI_SEQUENCE,
  fuzzyScore,
  vibeBundles,
  weather,
  notifications,
  // Productivity modules: Skill Marketplace, Prompt Library, Branching.
  findComposer,
  insertIntoComposer,
  waitForComposer,
  SkillMarketplaceOverlay,
  extractVariables,
  fillTemplate,
  PromptPicker,
  mountBranchForkButtons,
  DiffViewer,
  ContextBudgetPlanner,
  SemanticSearchOverlay,
  pickRule,
  ModelRouter,
  buildFileBlock,
  findAndReplaceInComposer,
  insertFileBlock,
  MacroRecorder,
  replayMacro,
  waitForResponseSettled,
  deriveChannelId,
  deriveKey,
  encryptText,
  decryptText,
  extractCodeBlocks,
  matchCandidates,
  mountCodeDiffButtons,
  DiffApplierOverlay,
  renderLineChart,
  renderBarChart,
  AnalyticsDashboard,
  presetRange,
};

/**
 * Token counter — DOM-only, no Node/Electron APIs.
 *
 * IMPORTANT / FRAGILE: Claude.ai has no public API for context-window usage,
 * so this module estimates token counts by scraping visible message text
 * from the DOM. Token counting itself uses gpt-tokenizer's o200k_base BPE
 * encoder — there's no published Claude tokenizer, so this is the closest
 * publicly available approximation (Claude's real BPE differs, but this is
 * far closer than the old chars/4 heuristic). Falls back to chars/4 if the
 * encoder throws on some input.
 *
 * This is the single most likely thing to break when Claude.ai changes its
 * markup. If the HUD stops updating, check MESSAGE_SELECTORS below first.
 */

const { encode } = require("gpt-tokenizer");

const MESSAGE_SELECTORS = {
  // Broad selectors intentionally: claude.ai's DOM structure/class names are
  // not stable across releases, so we match on stable-ish data-testid hooks
  // first and fall back to a wider net of role/class-based heuristics. The
  // original list here was too narrow — if none of these hooks exist in the
  // current claude.ai build, `turn` matches nothing and the HUD silently
  // reports 0 forever, which reads as "broken" rather than "no match".
  turn: '[data-testid="user-message"], [data-testid="chat-message"], [data-testid*="message"], '
    + '[data-test-render-count], .font-user-message, .font-claude-message, '
    + 'main [class*="message"][class*="row"], main article',
  userTurn: '[data-testid="user-message"], .font-user-message',
  assistantTurn: '[data-testid="chat-message"], .font-claude-message',
  // Best-effort hook for the current model name, shown in the model picker
  // button/menu. Kept broad for the same reason as `turn` above.
  modelPicker: '[data-testid="model-selector-dropdown"], [data-testid*="model-selector"], button[aria-label*="model" i]',
};

// Known context windows for model-name substring matching, most specific
// first (checked in order). Extend as new models ship. Falls back to
// CONTEXT_WINDOW_DEFAULT if nothing matches.
const CONTEXT_WINDOWS = [
  { match: /opus\s*4|sonnet\s*4|claude\s*4/i, tokens: 200000 },
  { match: /3\.7|3\.5|haiku/i, tokens: 200000 },
  { match: /opus|sonnet/i, tokens: 200000 },
];
const CONTEXT_WINDOW_DEFAULT = 200000;

function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  try {
    return encode(trimmed).length;
  } catch (err) {
    // Fallback heuristic (~4 chars/token) if the encoder chokes on some input.
    return Math.ceil(trimmed.length / 4);
  }
}

function getContextWindow(modelName) {
  const found = CONTEXT_WINDOWS.find((entry) => entry.match.test(modelName || ""));
  return found ? found.tokens : CONTEXT_WINDOW_DEFAULT;
}

/** Best-effort scrape of the currently selected model's display name. */
function detectModel(root = document) {
  const el = root.querySelector(MESSAGE_SELECTORS.modelPicker);
  const text = el ? (el.innerText || el.textContent || "").trim() : "";
  return text || null;
}

function collectConversationText(root = document) {
  const nodes = root.querySelectorAll(MESSAGE_SELECTORS.turn);
  const turns = [];
  nodes.forEach((node) => {
    const text = node.innerText || node.textContent || "";
    if (text.trim().length === 0) return;
    const isUser = node.matches(MESSAGE_SELECTORS.userTurn) || !!node.closest(MESSAGE_SELECTORS.userTurn);
    turns.push({ role: isUser ? "user" : "assistant", text, tokens: estimateTokens(text), node });
  });
  return turns;
}

class TokenCounter {
  constructor({ modelName = "claude" } = {}) {
    this.modelName = modelName;
    this.contextWindow = getContextWindow(modelName);
  }

  setModel(modelName) {
    this.modelName = modelName;
    this.contextWindow = getContextWindow(modelName);
  }

  /** Returns { usedTokens, remainingTokens, percentUsed, lastMessageTokens } */
  computeUsage(root = document) {
    const detected = detectModel(root);
    if (detected && detected !== this.modelName) this.setModel(detected);

    const turns = collectConversationText(root);
    const usedTokens = turns.reduce((sum, t) => sum + t.tokens, 0);
    const remainingTokens = Math.max(0, this.contextWindow - usedTokens);
    const percentUsed = this.contextWindow > 0
      ? Math.min(100, (usedTokens / this.contextWindow) * 100)
      : 0;
    const lastMessageTokens = turns.length > 0 ? turns[turns.length - 1].tokens : 0;

    return {
      usedTokens,
      remainingTokens,
      percentUsed: Math.round(percentUsed * 100) / 100, // 2 decimal places
      lastMessageTokens,
      contextWindow: this.contextWindow,
      turnCount: turns.length,
    };
  }
}

module.exports = { TokenCounter, estimateTokens, getContextWindow, detectModel, collectConversationText, MESSAGE_SELECTORS };

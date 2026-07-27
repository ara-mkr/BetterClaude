/**
 * Shared helper for writing text into claude.ai's message composer.
 * DOM-only, no Node/Electron APIs. Extracted out of
 * plugins/snippet-library.claudeplugin.js so Prompt Library and Conversation
 * Branching can both drive the composer the same, already-proven way.
 *
 * Claude currently uses a ProseMirror contenteditable element for the live
 * composer. Older builds used a controlled textarea, so this adapter supports
 * both forms and keeps every automation feature on the same verified hook.
 */

function findComposer(root = document) {
  return root.querySelector(
    '[data-testid="chat-input"], [data-testid="composer"] textarea, form textarea, textarea, [contenteditable="true"][role="textbox"]'
  );
}

function isTextArea(composer) {
  return composer && composer.tagName === "TEXTAREA";
}

function getComposerText(composer) {
  if (!composer) return "";
  return isTextArea(composer) ? composer.value : (composer.innerText || composer.textContent || "");
}

function emitInput(composer, value) {
  let event;
  try {
    event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: value });
  } catch (_e) {
    event = new Event("input", { bubbles: true });
  }
  composer.dispatchEvent(event);
}

function setComposerText(composer, value) {
  composer.focus();
  if (isTextArea(composer)) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(composer, value);
    emitInput(composer, value);
    return;
  }

  // ProseMirror observes real editing commands. Using selectAll/insertText
  // keeps its transaction state in sync; the DOM fallback still leaves a
  // usable draft on hosts that disable execCommand.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  const wrote = document.execCommand && document.execCommand("insertText", false, value);
  if (!wrote) {
    composer.textContent = value;
    emitInput(composer, value);
  }
}

// Same defensive-selector-chain style as core/token-counter.js's
// MESSAGE_SELECTORS: claude.ai's markup/class names aren't stable across
// releases, so this matches on the most likely data-testid/aria-label hooks
// first and falls back to a wider net rather than one brittle selector.
function findSendButton(root = document) {
  return root.querySelector(
    'button[aria-label*="Send" i], form button[type="submit"], [data-testid*="send-button" i]'
  );
}

// Plain "User: …\nAssistant: …" join of turns (as returned by
// core/token-counter.js's collectConversationText) — shared by Conversation
// Branching's fork preamble and Auto-Session Snapshots' stored transcripts,
// so both features format a transcript exactly the same way.
function buildTranscriptText(turns) {
  return (turns || []).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n");
}

// Appends (default) or replaces the composer's current text, then fires a
// real "input" event so claude.ai's own React state picks up the change.
// Returns true if a composer was found and written to.
function insertIntoComposer(text, { append = true, root = document } = {}) {
  const composer = findComposer(root);
  if (!composer) return false;
  const current = getComposerText(composer);
  const nextValue = append && current ? `${current}\n${text}` : text;
  setComposerText(composer, nextValue);
  return true;
}

// Polls briefly for the composer to exist — claude.ai's /new route doesn't
// guarantee the composer is mounted at DOMContentLoaded. Resolves false if
// it never shows up within the timeout instead of hanging forever.
function waitForComposer({ root = document, timeoutMs = 8000, intervalMs = 150 } = {}) {
  return new Promise((resolve) => {
    const existing = findComposer(root);
    if (existing) { resolve(existing); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      const found = findComposer(root);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, intervalMs);
  });
}

module.exports = {
  findComposer,
  findSendButton,
  getComposerText,
  setComposerText,
  insertIntoComposer,
  waitForComposer,
  buildTranscriptText,
};

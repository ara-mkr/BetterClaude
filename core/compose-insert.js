/**
 * Shared helper for writing text into claude.ai's message composer.
 * DOM-only, no Node/Electron APIs. Extracted out of
 * plugins/snippet-library.claudeplugin.js so Prompt Library and Conversation
 * Branching can both drive the composer the same, already-proven way.
 *
 * The native-setter dance is required because React tracks the textarea's
 * value through its own internal instance state; setting `.value` directly
 * updates the DOM but React's controlled-input re-render then stomps it back
 * to the old value on the next tick unless the write goes through the
 * textarea's *native* value setter before the "input" event fires (React's
 * change-detection compares against what it last saw the native setter emit).
 */

function findComposer(root = document) {
  return root.querySelector('[data-testid="composer"] textarea, form textarea, textarea');
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
  composer.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  const nextValue = append && composer.value ? `${composer.value}\n${text}` : text;
  nativeSetter.call(composer, nextValue);
  composer.dispatchEvent(new Event("input", { bubbles: true }));
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

module.exports = { findComposer, findSendButton, insertIntoComposer, waitForComposer, buildTranscriptText };

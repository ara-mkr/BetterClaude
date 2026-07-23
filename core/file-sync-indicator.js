/**
 * Native File Watcher Sync — composer-side helpers, DOM-only.
 *
 * Deliberately does NOT try to fake claude.ai's own native file-upload UI
 * (reproducing their attach button's internal DataTransfer/File handling
 * would be the same kind of fragile, unverifiable DOM mimicry already
 * avoided elsewhere in this app). Instead a watched file is represented in
 * the composer as a labeled fenced code block, inserted via the
 * already-proven core/compose-insert.js native-setter trick — real,
 * reliable text, not a simulated attachment.
 */

const { findComposer, insertIntoComposer } = require("./compose-insert");

function guessCodeFenceLang(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const map = {
    js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python",
    rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", json: "json", yml: "yaml",
    yaml: "yaml", md: "markdown", html: "html", css: "css", sql: "sql",
  };
  return map[ext] || "";
}

// The exact header line used both to build the block and to find it again
// later for an in-place resync — keep these two things using one function.
function marker(label) {
  return `--- ${label} (watched by BetterClaude) ---`;
}

function buildFileBlock(label, content) {
  const lang = guessCodeFenceLang(label);
  return `${marker(label)}\n\`\`\`${lang}\n${content}\n\`\`\``;
}

// Finds the exact previously-inserted block (by its marker line) in the
// live composer value and replaces just that block with fresh content.
// Returns true on success, false if the marker isn't present anymore (the
// message was already sent, or the user edited/deleted it) — the caller
// decides what "false" means (mark stale, notify, etc.), this never throws.
function findAndReplaceInComposer(label, newContent, root = document) {
  const composer = findComposer(root);
  if (!composer) return false;
  const value = composer.value || "";
  const head = marker(label);
  const startIdx = value.indexOf(head);
  if (startIdx === -1) return false;

  const fenceStart = value.indexOf("```", startIdx);
  if (fenceStart === -1) return false;
  const fenceEnd = value.indexOf("```", fenceStart + 3);
  const blockEnd = fenceEnd === -1 ? value.length : fenceEnd + 3;

  const newBlock = buildFileBlock(label, newContent);
  const nextValue = value.slice(0, startIdx) + newBlock + value.slice(blockEnd);

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  nativeSetter.call(composer, nextValue);
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function insertFileBlock(label, content) {
  return insertIntoComposer(buildFileBlock(label, content), { append: true });
}

module.exports = { buildFileBlock, findAndReplaceInComposer, insertFileBlock, marker, guessCodeFenceLang };

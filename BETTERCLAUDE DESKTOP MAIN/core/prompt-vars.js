/**
 * Pure {{variable}} helpers for the Prompt Library — no DOM, no Node.
 * `clipboard` and `selection` are recognized by name only here; actually
 * reading the clipboard/selection is the caller's job (core/prompt-picker.js),
 * since that needs real DOM/navigator access this module deliberately avoids
 * so it stays trivially unit-testable.
 */

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// Returns variable names in first-appearance order, deduped.
function extractVariables(body) {
  const seen = new Set();
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(body || "")) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

function fillTemplate(body, values = {}) {
  return String(body || "").replace(VAR_RE, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}

module.exports = { extractVariables, fillTemplate, VAR_RE };

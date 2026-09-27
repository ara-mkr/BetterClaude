/**
 * Markdown for the Code tab's chat transcript — bundled by esbuild into
 * build/ide-markdown.bundle.js (IIFE, global `BetterClaudeMarkdown`) because
 * the page it runs in has no require() (nodeIntegration off).
 *
 * Claude's replies are untrusted text as far as this page is concerned: the
 * view holds a preload bridge that can write files and spawn processes. So:
 *   - raw HTML in the markdown is escaped and shown as text, never parsed;
 *   - links are kept only for http(s)/mailto and carry data-external (the
 *     page opens them in the system browser; main.js also blocks navigation);
 *   - images never load (the CSP forbids remote images anyway) — they render
 *     as their alt text;
 *   - fenced code gets a header with the language and a Copy button.
 */
const { Marked } = require("marked");

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeHref(href) {
  const raw = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  return null;
}

// breaks: a single newline is a line break, as in Claude's own apps — with
// strict CommonMark a "one per line" answer collapsed into one paragraph.
const md = new Marked({ gfm: true, breaks: true, async: false });

md.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text || token.raw || "");
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens || []);
      const href = safeHref(token.href);
      if (!href) return label;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} data-external="1" rel="noreferrer noopener">${label}</a>`;
    },
    image(token) {
      return `<span class="bc-md-image">${escapeHtml(token.text || "image")}</span>`;
    },
    code(token) {
      const lang = String(token.lang || "").trim().split(/\s+/)[0];
      return `<div class="bc-md-code"><div class="bc-md-code-head"><span>${escapeHtml(lang || "text")}</span><button type="button" class="bc-md-copy" data-copy>Copy</button></div><pre><code>${escapeHtml(token.text)}</code></pre></div>`;
    },
  },
});

/** Markdown source -> sanitized HTML string. Never throws. */
function render(source) {
  try {
    return md.parse(String(source == null ? "" : source));
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}

module.exports = { render, escapeHtml };

/**
 * Conversation Export — adds a floating button that dumps the current
 * conversation's visible text to a downloaded .md file. Demonstrates
 * api.query / queryAll and api.notify.
 */
module.exports = {
  name: "Conversation Export",
  version: "1.0.0",

  onLoad(api) {
    api.injectCSS(`
      #bc-export-btn {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 2147482900;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(20,16,31,0.9);
        color: #ece7fb;
        font: 12px -apple-system, sans-serif;
        cursor: pointer;
      }
      #bc-export-btn:hover { background: rgba(139,92,246,0.35); }
    `);

    const btn = document.createElement("button");
    btn.id = "bc-export-btn";
    btn.textContent = "Export Chat";
    btn.addEventListener("click", () => this.exportConversation(api));
    document.body.appendChild(btn);
    this._btn = btn;
  },

  exportConversation(api) {
    const turns = api.queryAll('[data-testid="user-message"], [data-testid="chat-message"]');
    if (turns.length === 0) {
      api.notify("No messages found to export.");
      return;
    }
    const lines = turns.map((node) => {
      const isUser = node.matches('[data-testid="user-message"]');
      const text = (node.innerText || "").trim();
      return `### ${isUser ? "User" : "Assistant"}\n\n${text}\n`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-conversation-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    api.notify("Conversation exported.");
  },

  onUnload() {
    if (this._btn) this._btn.remove();
  },
};

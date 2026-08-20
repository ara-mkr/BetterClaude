/**
 * Quick Prompts — a small floating palette of canned prompts that get
 * inserted into the composer on click. Demonstrates api.registerSetting
 * for user-editable plugin data.
 */
const DEFAULT_PROMPTS = [
  "Explain this like I'm five.",
  "Summarize the above in 3 bullet points.",
  "What are the tradeoffs here?",
  "Rewrite this more concisely.",
];

module.exports = {
  name: "Quick Prompts",
  version: "1.0.0",

  onLoad(api) {
    const prompts = api.registerSetting("prompts", DEFAULT_PROMPTS);

    api.injectCSS(`
      #bc-quick-prompts {
        position: fixed;
        bottom: 60px;
        /* Clear the sidebar (whatever width the user has it set to)
           instead of a hardcoded offset that overlapped it. */
        left: calc(var(--bc-sidebar-width, 260px) + 16px);
        z-index: 2147482900;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-width: 220px;
      }
      #bc-quick-prompts button {
        font: 11px -apple-system, sans-serif;
        text-align: left;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(20,16,31,0.85);
        color: #ece7fb;
        cursor: pointer;
      }
      @media (hover: hover) and (pointer: fine) {
        #bc-quick-prompts button:hover { background: rgba(139,92,246,0.35); }
      }
    `);

    const container = document.createElement("div");
    container.id = "bc-quick-prompts";
    (prompts || DEFAULT_PROMPTS).forEach((text) => {
      const btn = document.createElement("button");
      btn.textContent = text;
      btn.addEventListener("click", () => this.insertPrompt(api, text));
      container.appendChild(btn);
    });
    document.body.appendChild(container);
    this._container = container;
  },

  insertPrompt(api, text) {
    if (!api.insertIntoComposer(text, { append: true })) {
      api.notify("Couldn't find the composer.");
    }
  },

  onUnload() {
    if (this._container) this._container.remove();
  },
};

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
  version: "1.0.1",

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
      /* Theme tokens, and !important because the page theme resets every
         button's background and colour (theme-engine PAGE_BTN). */
      #bc-quick-prompts button {
        font: 11px var(--bc-ui-font, -apple-system, sans-serif) !important;
        text-align: left;
        padding: 6px 10px !important;
        border-radius: 6px !important;
        border: 1px solid var(--bc-border, rgba(255,255,255,0.12)) !important;
        background: var(--bc-bg-elevated, rgba(20,16,31,0.92)) !important;
        color: var(--bc-text, #ece7fb) !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.18);
        cursor: pointer;
      }
      @media (hover: hover) and (pointer: fine) {
        #bc-quick-prompts button:hover {
          background: color-mix(in srgb, var(--bc-accent, #8b5cf6) 22%, var(--bc-bg-elevated, #14101f)) !important;
          border-color: var(--bc-accent, #8b5cf6) !important;
        }
      }
    `);

    const container = document.createElement("div");
    container.id = "bc-quick-prompts";
    container.dataset.bcOwn = ""; // keep the page theme's button reset off these
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

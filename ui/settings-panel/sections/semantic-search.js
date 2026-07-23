/**
 * Settings -> Semantic Search. Off by default (background indexing, like
 * Skill Marketplace). Indexing is opportunistic — only conversations
 * actually opened in BetterClaude get indexed, never a bulk import of
 * claude.ai's history. "Local" mode is dependency-free TF-IDF/cosine
 * similarity; "Hosted" adds a real neural-embedding blend via the user's
 * own API key.
 */

const { el, toggleField, selectField, textField } = require("../dom-helpers");

module.exports = {
  _renderSemanticSearch() {
    const { settings } = this;
    const ss = settings.semanticSearch;
    const wrap = el("div", { class: "bc-section" });
    wrap.appendChild(el("h2", { text: "Semantic Search" }));
    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: "Hybrid keyword + similarity search across every conversation you've opened in BetterClaude. Indexing "
        + "builds up over time as you use the app — a fresh install starts with an empty index, which is expected.",
    }));

    wrap.appendChild(toggleField("Enable Semantic Search", ss.enabled, (v) => this._set("semanticSearch.enabled", v)));

    wrap.appendChild(el("p", {
      class: "bc-hint",
      text: `Indexed: ${ss.indexed.conversations} conversation${ss.indexed.conversations === 1 ? "" : "s"}, ${ss.indexed.turns} message${ss.indexed.turns === 1 ? "" : "s"}.`,
    }));

    wrap.appendChild(selectField(
      "Embedding mode",
      [
        { value: "local", label: "Local TF-IDF (offline, no download)" },
        { value: "hosted", label: "Hosted embeddings API (your own key, true semantic search)" },
      ],
      ss.embeddings.mode,
      (v) => this._set("semanticSearch.embeddings.mode", v)
    ));

    if (ss.embeddings.mode === "hosted") {
      wrap.appendChild(textField(
        "Embeddings endpoint",
        ss.embeddings.endpoint,
        (v) => this._set("semanticSearch.embeddings.endpoint", v.trim()),
        { placeholder: "https://api.example.com/v1/embeddings (OpenAI-compatible)" }
      ));
      wrap.appendChild(textField(
        "API key",
        ss.embeddings.apiKey,
        (v) => this._set("semanticSearch.embeddings.apiKey", v.trim())
      ));
      wrap.appendChild(textField(
        "Model (optional)",
        ss.embeddings.model,
        (v) => this._set("semanticSearch.embeddings.model", v.trim())
      ));
      wrap.appendChild(el("p", {
        class: "bc-hint",
        text: "Called only from the main process, straight to the endpoint above — never sent anywhere else.",
      }));
    }

    const row = el("div", { class: "bc-theme-toolbar" });
    row.appendChild(el("button", {
      class: "bc-btn",
      text: "Open Search",
      onclick: () => this.host.openChatSearch(),
    }));
    row.appendChild(el("button", {
      class: "bc-btn bc-btn-secondary",
      text: "Clear index",
      onclick: async () => {
        await this.host.clearSearchIndex();
        this.settings = this.host.getSettings();
        this.renderSection();
      },
    }));
    wrap.appendChild(row);

    this.contentEl.appendChild(wrap);
  },
};

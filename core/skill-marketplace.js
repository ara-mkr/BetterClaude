/**
 * Skill Marketplace overlay — DOM-only, no Node/Electron APIs. Mirrors
 * core/command-palette.js's mount/open/close/toggle pattern but for a
 * bigger, two-pane surface: a searchable/filterable catalog of public
 * GitHub "claude-skill" repos on the left, a README preview + Install
 * action on the right.
 *
 * "Install" only ever downloads SKILL.md + assets into a local folder —
 * claude.ai has no public API to register a Skill programmatically, so
 * nothing here (or in electron/main.js) attempts to call one.
 *
 * `host` supplies everything that needs network/filesystem access (all of
 * it actually lives in electron/main.js, reached over IPC by
 * electron/preload.js):
 *   host.getCachedItems() -> item[]              (sync, reads local settings)
 *   host.getInstalledMap() -> { [id]: record }    (sync, reads local settings)
 *   host.searchSkills({query, sort, minStars}) -> Promise<{items, totalCount}>
 *   host.getReadme({owner, repo}) -> Promise<string|null>
 *   host.installSkill(item) -> Promise<record>
 *   host.revealSkill(id)
 *   host.notify(message)
 */

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class SkillMarketplaceOverlay {
  constructor(host) {
    this.host = host;
    this.el = null;
    this.items = [];
    this.selected = null;
    this.query = "";
    this.sort = "stars";
    this.minStars = 0;
    this._searchTimer = null;
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-skill-marketplace-overlay";
    overlay.innerHTML = `
      <div class="bc-skm-box">
        <div class="bc-skm-header">
          <input type="text" class="bc-skm-search" placeholder="Search claude-skill repos…" data-bc-skm-search />
          <select class="bc-skm-sort" data-bc-skm-sort>
            <option value="stars">Most stars</option>
            <option value="updated">Recently updated</option>
          </select>
          <input type="number" min="0" class="bc-skm-stars" placeholder="Min ★" data-bc-skm-stars />
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-skm-refresh>Search GitHub</button>
          <button type="button" class="bc-skm-close" data-bc-skm-close title="Close">✕</button>
        </div>
        <div class="bc-skm-body">
          <div class="bc-skm-list" data-bc-skm-list></div>
          <div class="bc-skm-detail" data-bc-skm-detail>
            <div class="bc-skm-empty">Select a skill to preview its README.</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector("[data-bc-skm-close]").addEventListener("click", () => this.close());
    overlay.querySelector("[data-bc-skm-refresh]").addEventListener("click", () => this.runSearch());

    const search = overlay.querySelector("[data-bc-skm-search]");
    search.addEventListener("input", () => {
      this.query = search.value;
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.runSearch(), 450);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter") { clearTimeout(this._searchTimer); this.runSearch(); }
    });

    const sort = overlay.querySelector("[data-bc-skm-sort]");
    sort.addEventListener("change", () => { this.sort = sort.value; this.runSearch(); });

    const stars = overlay.querySelector("[data-bc-skm-stars]");
    stars.addEventListener("change", () => { this.minStars = Number(stars.value) || 0; this.runSearch(); });

    return overlay;
  }

  open() {
    if (!this.el) this.mount();
    this.el.classList.add("bc-open");
    const search = this.el.querySelector("[data-bc-skm-search]");
    setTimeout(() => search.focus(), 0);
    this.items = this.host.getCachedItems() || [];
    this._renderList();
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  async runSearch() {
    const list = this.el.querySelector("[data-bc-skm-list]");
    list.innerHTML = `<div class="bc-skm-loading">Searching GitHub…</div>`;
    try {
      const { items } = await this.host.searchSkills({ query: this.query, sort: this.sort, minStars: this.minStars });
      this.items = items;
      this._renderList();
    } catch (err) {
      list.innerHTML = `<div class="bc-skm-error">${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  _renderList() {
    const list = this.el.querySelector("[data-bc-skm-list]");
    list.innerHTML = "";
    if (this.items.length === 0) {
      list.innerHTML = `<div class="bc-skm-empty">No skills loaded yet — try a search, or hit "Search GitHub".</div>`;
      return;
    }
    const installedMap = this.host.getInstalledMap() || {};
    this.items.forEach((item) => {
      const installed = installedMap[item.id];
      const updateAvailable = !!(installed && item.pushedAt && new Date(item.pushedAt).getTime() > installed.installedAt);
      const card = document.createElement("div");
      card.className = `bc-skm-card${this.selected && this.selected.id === item.id ? " bc-active" : ""}`;
      card.innerHTML = `
        <div class="bc-skm-card-title">${escapeHtml(item.fullName)}</div>
        <div class="bc-skm-card-desc">${escapeHtml(item.description || "No description.")}</div>
        <div class="bc-skm-card-meta">
          <span>★ ${item.stars}</span>
          <span>${(item.topics || []).slice(0, 3).map(escapeHtml).join(", ")}</span>
          ${installed ? `<span class="bc-skm-badge${updateAvailable ? " bc-skm-badge-update" : ""}">${updateAvailable ? "Update available" : "Installed"}</span>` : ""}
        </div>
      `;
      card.addEventListener("click", () => this.select(item));
      list.appendChild(card);
    });
  }

  async select(item) {
    this.selected = item;
    this._renderList();
    const detail = this.el.querySelector("[data-bc-skm-detail]");
    detail.innerHTML = `<div class="bc-skm-loading">Loading README…</div>`;

    let readme = null;
    let readmeError = null;
    try {
      readme = await this.host.getReadme({ owner: item.owner, repo: item.repo });
    } catch (err) {
      readmeError = err.message || String(err);
    }
    if (this.selected !== item) return; // user picked something else while this was loading

    detail.innerHTML = "";
    const header = document.createElement("div");
    header.className = "bc-skm-detail-header";
    header.innerHTML = `<h3>${escapeHtml(item.fullName)}</h3><p>${escapeHtml(item.description || "")}</p>`;
    detail.appendChild(header);

    const installedMap = this.host.getInstalledMap() || {};
    const installed = installedMap[item.id];

    const actions = document.createElement("div");
    actions.className = "bc-skm-detail-actions";
    const installBtn = document.createElement("button");
    installBtn.className = "bc-btn";
    installBtn.textContent = installed ? "Reinstall" : "Install";
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      installBtn.textContent = "Installing…";
      try {
        await this.host.installSkill(item);
        this.host.notify && this.host.notify(`Installed "${item.fullName}" — upload it via claude.ai Settings → Capabilities.`);
        this._renderList();
      } catch (err) {
        this.host.notify && this.host.notify(`Install failed: ${err.message}`);
      } finally {
        installBtn.disabled = false;
        installBtn.textContent = (this.host.getInstalledMap() || {})[item.id] ? "Reinstall" : "Install";
      }
    });
    actions.appendChild(installBtn);

    if (installed) {
      const revealBtn = document.createElement("button");
      revealBtn.className = "bc-btn bc-btn-secondary";
      revealBtn.textContent = "Reveal in folder";
      revealBtn.addEventListener("click", () => this.host.revealSkill(item.id));
      actions.appendChild(revealBtn);
    }
    detail.appendChild(actions);

    const readmeBox = document.createElement("pre");
    readmeBox.className = "bc-skm-readme";
    readmeBox.textContent = readmeError ? `Couldn't load README: ${readmeError}` : (readme || "No README available.");
    detail.appendChild(readmeBox);
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

module.exports = { SkillMarketplaceOverlay };

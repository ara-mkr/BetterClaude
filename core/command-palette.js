/**
 * Command Palette (Cmd/Ctrl+K) — DOM-only, no Node/Electron APIs.
 *
 * This module only renders the overlay and reports which command was
 * chosen; it has no opinion about what a command DOES. The host
 * (electron/preload.js) supplies the command list and executes them:
 *   - built-in commands carry a `run(ctx)` function (code-defined, safe)
 *   - user-defined custom commands (settings.commandPalette.customCommands)
 *     are bounded to `{ settingPath, value }` — "set setting X to value Y" —
 *     deliberately not arbitrary code execution.
 *
 * "For Everything": the host is expected to pass one flat, freshly-built
 * list covering every indexable surface — skills (installed + marketplace
 * cache), plugins, prompt library entries, settings pages, macros, and app
 * actions — each item optionally tagged with a `group` label shown next to
 * its result. Past chats are different in kind (an async, potentially slow
 * lookup against the Semantic Search index) rather than an in-memory list
 * to filter, so they're wired separately via setAsyncSource() instead of
 * being part of `commands`.
 *
 * Matching is a small hand-rolled fuzzy subsequence scorer (fuzzyScore),
 * not a substring filter — consistent with this app's existing preference
 * for a dependency-free approach where one reasonably fits (see Local
 * Semantic Search's "local" TF-IDF/cosine mode for the same call).
 *
 * mountKonamiListener is a small, unrelated global-keydown watcher colocated
 * here because both are "listen for a special key sequence" concerns.
 */

// Subsequence match: every character of `query` must appear in `text`, in
// order (not necessarily contiguous). Returns -1 (no match) or a score that
// rewards consecutive runs and matches right after a word boundary, so
// "cmdpal"-style abbreviations and prefix matches both rank above a
// scattered match.
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      score += 1 + consecutive * 2;
      if (ti === 0 || /[\s\-_/:.]/.test(t[ti - 1])) score += 3;
      consecutive += 1;
      qi += 1;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : -1;
}

// Best score for a command across its label, group, and any extra
// space-joined keywords — so e.g. typing "macro" surfaces items grouped
// under "Macros" even when a specific macro's own name doesn't contain it.
function scoreCommand(query, cmd) {
  const fields = [cmd.label, cmd.group, cmd.keywords].filter(Boolean);
  return Math.max(...fields.map((f) => fuzzyScore(query, f)), -1);
}

class CommandPalette {
  constructor({ onExecute } = {}) {
    this.onExecute = onExecute || (() => {});
    this.el = null;
    this.commands = [];
    this._filtered = [];
    this._activeIndex = 0;
    this._asyncSource = null; // (query) -> Promise<Command[]>
    this._asyncDebounce = null;
    this._queryToken = 0;
  }

  // fn(query) resolves extra commands (e.g. matching chats) to merge in
  // once the user has typed something — see core/semantic-search.js for
  // the same underlying query this reuses.
  setAsyncSource(fn) {
    this._asyncSource = fn;
  }

  mount() {
    if (this.el) return this.el;
    const overlay = document.createElement("div");
    overlay.id = "bc-command-palette-overlay";
    overlay.innerHTML = `
      <div class="bc-cp-box">
        <input type="text" class="bc-cp-input" placeholder="Type a command…" data-bc-cp-input />
        <div class="bc-cp-list" data-bc-cp-list></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });
    const input = overlay.querySelector("[data-bc-cp-input]");
    input.addEventListener("input", () => this._renderList(input.value));
    input.addEventListener("keydown", (e) => this._onInputKeydown(e));
    return overlay;
  }

  setCommands(commands) {
    this.commands = commands || [];
  }

  open() {
    if (!this.el) this.mount();
    this.el.classList.add("bc-open");
    const input = this.el.querySelector("[data-bc-cp-input]");
    input.value = "";
    this._renderList("");
    setTimeout(() => input.focus(), 0);
  }

  close() {
    if (this.el) this.el.classList.remove("bc-open");
    clearTimeout(this._asyncDebounce);
  }

  toggle() {
    if (this.el && this.el.classList.contains("bc-open")) this.close();
    else this.open();
  }

  _renderList(query) {
    const q = query.trim();
    this._lastQuery = q;

    if (!q) {
      this._filtered = this.commands.slice(0, 200); // unfiltered: original order, capped so an idle open stays cheap to paint
    } else {
      this._filtered = this.commands
        .map((cmd) => ({ cmd, score: scoreCommand(q, cmd) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.cmd);
    }
    this._paint();

    if (q && this._asyncSource) {
      clearTimeout(this._asyncDebounce);
      const token = (this._queryToken += 1);
      this._asyncDebounce = setTimeout(() => {
        Promise.resolve(this._asyncSource(q))
          .then((extra) => {
            if (token !== this._queryToken || this._lastQuery !== q || !extra || extra.length === 0) return;
            this._filtered = [...this._filtered, ...extra];
            this._paint();
          })
          .catch(() => {}); // best-effort — a failed chat lookup just means fewer results, not a broken palette
      }, 250);
    }
  }

  _paint() {
    const list = this.el.querySelector("[data-bc-cp-list]");
    list.innerHTML = "";
    this._activeIndex = 0;

    if (this._filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bc-cp-empty";
      empty.textContent = "No matching commands.";
      list.appendChild(empty);
      return;
    }

    this._filtered.forEach((cmd, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `bc-cp-item${i === 0 ? " bc-active" : ""}`;
      const label = document.createElement("span");
      label.className = "bc-cp-item-label";
      label.textContent = cmd.label;
      item.appendChild(label);
      if (cmd.group) {
        const group = document.createElement("span");
        group.className = "bc-cp-item-group";
        group.textContent = cmd.group;
        item.appendChild(group);
      }
      item.addEventListener("click", () => this._run(cmd));
      list.appendChild(item);
    });
  }

  _onInputKeydown(e) {
    const items = Array.from(this.el.querySelectorAll(".bc-cp-item"));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._activeIndex = Math.min(items.length - 1, this._activeIndex + 1);
      this._highlight(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this._activeIndex = Math.max(0, this._activeIndex - 1);
      this._highlight(items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = this._filtered[this._activeIndex];
      if (cmd) this._run(cmd);
    } else if (e.key === "Escape") {
      this.close();
    }
  }

  _highlight(items) {
    items.forEach((el, i) => el.classList.toggle("bc-active", i === this._activeIndex));
    if (items[this._activeIndex]) items[this._activeIndex].scrollIntoView({ block: "nearest" });
  }

  _run(cmd) {
    this.close();
    this.onExecute(cmd);
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

const KONAMI_SEQUENCE = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "b", "a",
];

// Returns an unmount function. onUnlock fires once per completed sequence;
// a wrong key resets progress (except when it happens to also be a valid
// restart of the sequence, e.g. re-pressing ArrowUp).
function mountKonamiListener(onUnlock) {
  let idx = 0;
  const handler = (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === KONAMI_SEQUENCE[idx]) {
      idx += 1;
      if (idx === KONAMI_SEQUENCE.length) {
        idx = 0;
        onUnlock();
      }
    } else {
      idx = key === KONAMI_SEQUENCE[0] ? 1 : 0;
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

module.exports = { CommandPalette, mountKonamiListener, KONAMI_SEQUENCE, fuzzyScore };

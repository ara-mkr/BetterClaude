/**
 * The Code tab's conversation renderer (page world, no require()).
 *
 * One `Transcript` per open session. It turns the chat engine's events
 * (electron/ide-chat.js) into the transcript the way Claude Code's own apps
 * show one:
 *   - your turns as a quiet right-aligned bubble;
 *   - Claude's prose as rendered markdown (build/ide-markdown.bundle.js —
 *     sanitized: raw HTML escaped, only http(s) links), never boxed;
 *   - tool calls as compact one-line rows ("Edited app.js +8 −2",
 *     "Ran npm test"), grouped per stretch and collapsed when there are many,
 *     each expandable to its input and output;
 *   - approval cards inline: Allow / Always allow / Deny for a tool, option
 *     pickers for AskUserQuestion, and the plan itself for ExitPlanMode.
 *
 * Exposes window.BetterClaudeTranscript = { create, describeTool }.
 */
(function () {
  "use strict";

  const md = window.BetterClaudeMarkdown || null;
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const renderMarkdown = (text) => (md ? md.render(text) : `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`);
  const basename = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  const lineCount = (s) => (s ? String(s).split("\n").length : 0);
  const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const truncate = (s, n) => {
    const flat = String(s || "").replace(/\s+/g, " ").trim();
    return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
  };

  /**
   * One edit's changed region: the lines `before` and `after` share at either
   * end are context, not changes — counting every line of both strings showed
   * a one-line fix as "+3 −3".
   */
  function editHunk(before, after) {
    const a = before ? String(before).split("\n") : [];
    const b = after ? String(after).split("\n") : [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { a, b, start, endA, endB, add: endB - start, del: endA - start };
  }

  // Present tense while a call is in flight (or waiting on your approval);
  // the row switches to describeTool's past tense once its result lands.
  const VERB_NOW = {
    Read: "Reading", Edited: "Editing", Wrote: "Writing", "Edited notebook": "Editing notebook",
    Ran: "Running", "Checked output": "Checking output", "Found files": "Finding files",
    "Searched for": "Searching for", Listed: "Listing", Fetched: "Fetching",
    "Searched the web": "Searching the web", "Ran agent": "Running agent",
    "Updated the plan": "Updating the plan", "Used skill": "Using skill",
  };

  /** A one-line description of a tool call: { verb, target, stat, kind, mono }. */
  function describeTool(name, input = {}) {
    const n = String(name || "tool");
    const file = input.file_path || input.notebook_path || input.path || "";
    switch (n) {
      case "Read":
        return { kind: "read", verb: "Read", target: basename(file), title: file };
      case "Edit": {
        const { add, del } = editHunk(input.old_string, input.new_string);
        return { kind: "edit", verb: "Edited", target: basename(file), title: file, add, del };
      }
      case "MultiEdit": {
        let add = 0;
        let del = 0;
        (Array.isArray(input.edits) ? input.edits : []).forEach((e) => { const h = editHunk(e && e.old_string, e && e.new_string); add += h.add; del += h.del; });
        return { kind: "edit", verb: "Edited", target: basename(file), title: file, add, del };
      }
      case "Write":
        return { kind: "edit", verb: "Wrote", target: basename(file), title: file, add: lineCount(input.content), del: 0 };
      case "NotebookEdit":
        return { kind: "edit", verb: "Edited notebook", target: basename(file), title: file };
      case "Bash":
        return { kind: "run", verb: "Ran", target: truncate(input.command, 90), title: input.command || "", mono: true };
      case "BashOutput":
        return { kind: "run", verb: "Checked output", target: input.bash_id || "" };
      case "KillShell":
      case "KillBash":
        return { kind: "run", verb: "Stopped a shell", target: "" };
      case "Glob":
        return { kind: "search", verb: "Found files", target: input.pattern || "", mono: true };
      case "Grep":
        return { kind: "search", verb: "Searched for", target: input.pattern || "", mono: true };
      case "LS":
        return { kind: "search", verb: "Listed", target: basename(file) || "folder" };
      case "WebFetch": {
        let host = "";
        try { host = new URL(input.url).host; } catch { host = input.url || ""; }
        return { kind: "web", verb: "Fetched", target: host, title: input.url || "" };
      }
      case "WebSearch":
        return { kind: "web", verb: "Searched the web", target: truncate(input.query, 70) };
      case "Task":
      case "Agent":
        return { kind: "agent", verb: "Ran agent", target: truncate(input.description || input.subagent_type || "", 70) };
      case "TodoWrite": {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        const done = todos.filter((t) => t && t.status === "completed").length;
        return { kind: "todo", verb: "Updated the plan", target: todos.length ? `${done}/${todos.length} done` : "" };
      }
      case "ExitPlanMode":
        return { kind: "plan", verb: "Proposed a plan", target: "" };
      case "AskUserQuestion":
        return { kind: "ask", verb: "Asked you", target: truncate(input.questions && input.questions[0] && input.questions[0].question, 70) };
      case "Skill":
        return { kind: "agent", verb: "Used skill", target: input.skill || input.command || "" };
      case "ToolSearch":
        return { kind: "other", verb: "Loaded tools", target: truncate(String(input.query || "").replace(/^select:/, "").replace(/,/g, ", "), 70) };
      default:
        if (n.startsWith("mcp__")) {
          const parts = n.split("__");
          return { kind: "mcp", verb: parts.slice(2).join(" ").replace(/_/g, " ") || "MCP tool", target: parts[1] || "" };
        }
        return { kind: "other", verb: n, target: "" };
    }
  }

  const KIND_ICON = { read: "FILE", edit: "EDIT", run: "TERMINAL", search: "SEARCH", web: "SPARKLE", agent: "BOLT", todo: "LIST", plan: "NOTE", ask: "CHAT", mcp: "EXTENSIONS", other: "CODE" };

  /** "Read 3 files · Edited 2 files · Ran 1 command" */
  function summarizeTools(rows) {
    const counts = {};
    rows.forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    const parts = [];
    const push = (k, one, many) => { if (counts[k]) parts.push(counts[k] === 1 ? one : many.replace("#", counts[k])); };
    push("read", "Read 1 file", "Read # files");
    push("edit", "Edited 1 file", "Edited # files");
    push("run", "Ran 1 command", "Ran # commands");
    push("search", "1 search", "# searches");
    push("web", "1 web lookup", "# web lookups");
    push("agent", "1 agent", "# agents");
    push("todo", "Updated the plan", "Updated the plan");
    push("mcp", "1 tool", "# tools");
    push("other", "1 step", "# steps");
    return parts.join(" · ");
  }

  function miniDiff(input) {
    const edits = Array.isArray(input.edits) ? input.edits : (input.old_string != null || input.new_string != null ? [input] : []);
    if (!edits.length && typeof input.content === "string") {
      return input.content.split("\n").slice(0, 40).map((l) => `<span class="bc-t-add">+ ${escapeHtml(l)}</span>`).join("\n");
    }
    const out = [];
    const CONTEXT = 2; // unchanged lines shown around each change, like a unified diff
    const ctx = (l) => out.push(`<span class="bc-t-ctx">  ${escapeHtml(l)}</span>`);
    edits.slice(0, 6).forEach((e, i) => {
      if (i) out.push('<span class="bc-t-hunk">⋯</span>');
      const h = editHunk(e && e.old_string, e && e.new_string);
      h.a.slice(Math.max(0, h.start - CONTEXT), h.start).forEach(ctx);
      h.a.slice(h.start, h.endA).slice(0, 20).forEach((l) => out.push(`<span class="bc-t-del">- ${escapeHtml(l)}</span>`));
      h.b.slice(h.start, h.endB).slice(0, 20).forEach((l) => out.push(`<span class="bc-t-add">+ ${escapeHtml(l)}</span>`));
      h.a.slice(h.endA, h.endA + CONTEXT).forEach(ctx);
    });
    return out.join("\n");
  }

  function toolDetailHtml(name, input, preview, isError) {
    const bits = [];
    if (name === "Bash" && input.command) bits.push(`<pre class="bc-t-cmd">$ ${escapeHtml(input.command)}</pre>`);
    else if (["Edit", "MultiEdit", "Write"].includes(name)) bits.push(`<pre class="bc-t-diff">${miniDiff(input)}</pre>`);
    else if (name === "TodoWrite" && Array.isArray(input.todos)) {
      bits.push(`<ul class="bc-t-todos">${input.todos.map((t) => `<li data-status="${escapeHtml(t.status || "pending")}">${escapeHtml(t.content || t.activeForm || "")}</li>`).join("")}</ul>`);
    } else if (input && Object.keys(input).length) {
      bits.push(`<pre class="bc-t-json">${escapeHtml(JSON.stringify(input, null, 2).slice(0, 3000))}</pre>`);
    }
    if (preview) bits.push(`<pre class="bc-t-out${isError ? " is-error" : ""}">${escapeHtml(preview)}</pre>`);
    return bits.join("");
  }

  // ---------------------------------------------------------------------------

  function create(host, options = {}) {
    const icon = options.icon || (() => "");
    const root = document.createElement("div");
    root.className = "bc-t";
    host.appendChild(root);

    let turn = null; // { el, body, segments: Map(key -> {el, text, raf}), group, groupRows, working }
    const tools = new Map(); // tool_use id -> { row, name, input, kind, preview, isError }
    const cards = new Map(); // requestId -> card element

    function scrollHint() { if (options.onContent) options.onContent(); }

    function removeWelcome() {
      const w = root.querySelector(".bc-t-welcome");
      if (w) w.remove();
    }

    function userMessage(text, meta = {}) {
      removeWelcome();
      endTurn();
      const el = document.createElement("div");
      el.className = "bc-t-user";
      // A teammate's message (agent team relay): same place as a prompt of
      // yours, but labelled with who sent it so it never reads as your own.
      if (meta.label) {
        el.dataset.from = "teammate";
        const label = document.createElement("div");
        label.className = "bc-t-user-label";
        label.textContent = meta.label;
        el.appendChild(label);
      }
      const bubble = document.createElement("div");
      bubble.className = "bc-t-user-bubble";
      bubble.textContent = text;
      el.appendChild(bubble);
      if (meta.attachments && meta.attachments.length) {
        const chips = document.createElement("div");
        chips.className = "bc-t-user-files";
        meta.attachments.forEach((p) => {
          const chip = document.createElement("span");
          chip.textContent = basename(p);
          chip.title = p;
          chips.appendChild(chip);
        });
        el.appendChild(chips);
      }
      root.appendChild(el);
      scrollHint();
      return el;
    }

    function ensureTurn() {
      if (turn) return turn;
      removeWelcome();
      const el = document.createElement("div");
      el.className = "bc-t-turn";
      const body = document.createElement("div");
      body.className = "bc-t-body";
      el.appendChild(body);
      root.appendChild(el);
      turn = { el, body, segments: new Map(), group: null, groupRows: [], rows: [], working: null };
      return turn;
    }

    function setWorking(label) {
      const t = ensureTurn();
      if (!t.working) {
        t.working = document.createElement("div");
        t.working.className = "bc-t-working";
        t.working.innerHTML = '<span class="bc-t-dots"><i></i><i></i><i></i></span><span class="bc-t-working-label"></span>';
        t.el.appendChild(t.working);
      }
      t.working.querySelector(".bc-t-working-label").textContent = label || "Working…";
      scrollHint();
    }

    function clearWorking() {
      if (turn && turn.working) { turn.working.remove(); turn.working = null; }
    }

    function closeGroup() {
      if (turn) { turn.group = null; turn.groupRows = []; }
    }

    function segmentFor(key) {
      const t = ensureTurn();
      let seg = t.segments.get(key);
      if (!seg) {
        closeGroup();
        const el = document.createElement("div");
        el.className = "bc-t-prose";
        t.body.appendChild(el);
        seg = { el, text: "", raf: 0 };
        t.segments.set(key, seg);
      }
      return seg;
    }

    function paint(seg) {
      seg.raf = 0;
      seg.el.innerHTML = renderMarkdown(seg.text);
      scrollHint();
    }

    function delta(key, text) {
      const seg = segmentFor(key || "main");
      seg.text += text;
      clearWorking();
      // Re-parse at most once per frame while tokens stream in.
      if (!seg.raf) seg.raf = requestAnimationFrame(() => paint(seg));
    }

    function setText(key, text) {
      const seg = segmentFor(key || "main");
      seg.text = text;
      clearWorking();
      paint(seg);
    }

    /** Free-model failover: drop the half-answer a failed provider streamed. */
    function resetText() {
      if (!turn) return;
      turn.segments.forEach((seg) => { if (seg.raf) cancelAnimationFrame(seg.raf); seg.el.remove(); });
      turn.segments.clear();
    }

    function newGroup() {
      const t = ensureTurn();
      const group = document.createElement("div");
      group.className = "bc-t-tools";
      const summary = document.createElement("button");
      summary.type = "button";
      summary.className = "bc-t-tools-summary";
      summary.hidden = true;
      summary.addEventListener("click", () => group.classList.toggle("is-open"));
      const list = document.createElement("div");
      list.className = "bc-t-tools-list";
      group.append(summary, list);
      t.body.appendChild(group);
      t.group = group;
      t.groupRows = [];
      return group;
    }

    function refreshGroup(t) {
      if (!t.group) return;
      const summary = t.group.querySelector(".bc-t-tools-summary");
      const many = t.groupRows.length > 3;
      t.group.classList.toggle("is-collapsible", many);
      summary.hidden = !many;
      if (many) summary.innerHTML = `<span class="bc-t-chev">${icon("CHEVRON")}</span><span>${escapeHtml(summarizeTools(t.groupRows))}</span>`;
    }

    function tool({ id, name, input = {}, parentId = null }) {
      clearWorking();
      // Subagent calls nest under their Task row instead of the main flow.
      if (parentId && tools.has(parentId)) {
        const parent = tools.get(parentId);
        let nest = parent.row.querySelector(".bc-t-nest");
        if (!nest) {
          nest = document.createElement("div");
          nest.className = "bc-t-nest";
          parent.row.appendChild(nest);
        }
        const d = describeTool(name, input);
        const line = document.createElement("div");
        line.className = "bc-t-nest-row";
        line.textContent = `${d.verb} ${d.target}`.trim();
        nest.appendChild(line);
        if (id) tools.set(id, { row: line, name, input, kind: d.kind, nested: true });
        return;
      }
      const t = ensureTurn();
      if (!t.group) newGroup();
      const d = describeTool(name, input);
      const row = document.createElement("div");
      row.className = "bc-t-tool";
      row.dataset.kind = d.kind;
      row.dataset.state = "running";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "bc-t-tool-head";
      head.title = d.title || "";
      head.innerHTML = `<span class="bc-t-tool-icon">${icon(KIND_ICON[d.kind] || "CODE")}</span><span class="bc-t-tool-verb"></span><span class="bc-t-tool-target${d.mono ? " is-mono" : ""}"></span>${d.add || d.del ? `<span class="bc-t-stat"><span class="bc-t-add">+${d.add || 0}</span><span class="bc-t-del">−${d.del || 0}</span></span>` : ""}<span class="bc-t-tool-state"></span>`;
      head.querySelector(".bc-t-tool-verb").textContent = VERB_NOW[d.verb] || d.verb;
      head.querySelector(".bc-t-tool-target").textContent = d.target;
      const detail = document.createElement("div");
      detail.className = "bc-t-tool-detail";
      detail.hidden = true;
      head.addEventListener("click", () => {
        const opening = detail.hidden;
        if (opening) {
          const record = tools.get(id) || { preview: "", isError: false };
          detail.innerHTML = toolDetailHtml(name, input, record.preview, record.isError);
          if (d.kind === "edit" && d.title && options.onOpenFile) {
            const open = document.createElement("button");
            open.type = "button";
            open.className = "bc-t-link";
            open.textContent = `Open ${d.target}`;
            open.addEventListener("click", () => options.onOpenFile(d.title));
            detail.appendChild(open);
          }
          if (d.kind === "edit" && d.title && options.onReviewFile) {
            const review = document.createElement("button");
            review.type = "button";
            review.className = "bc-t-link";
            review.textContent = "Review diff";
            review.addEventListener("click", () => options.onReviewFile(d.title));
            detail.appendChild(review);
          }
        }
        detail.hidden = !opening;
        row.classList.toggle("is-open", opening);
      });
      row.append(head, detail);
      t.group.querySelector(".bc-t-tools-list").appendChild(row);
      t.groupRows.push({ kind: d.kind });
      refreshGroup(t);
      const record = { row, name, input, kind: d.kind, verb: d.verb, preview: "", isError: false };
      t.rows.push(record);
      if (id) tools.set(id, record);
    }

    /** A row's result is in (or will never come): past tense, no spinner. */
    function settleRow(record, state) {
      record.row.dataset.state = state;
      const verb = record.row.querySelector(".bc-t-tool-verb");
      if (verb) verb.textContent = record.verb;
    }

    function toolResult({ id, isError, preview }) {
      const record = tools.get(id);
      if (!record) return;
      record.preview = preview || "";
      record.isError = !!isError;
      if (record.nested) {
        record.row.classList.toggle("is-error", !!isError);
        return;
      }
      // A plan sent back ("Keep planning") comes back as an error result;
      // it isn't one from the user's side, so no red row.
      settleRow(record, isError && record.name !== "ExitPlanMode" ? "error" : "done");
      const detail = record.row.querySelector(".bc-t-tool-detail");
      if (detail && !detail.hidden) detail.innerHTML = toolDetailHtml(record.name, record.input, record.preview, record.isError);
    }

    // --- approval / question / plan cards -----------------------------------

    function permission(req, respond) {
      clearWorking();
      closeGroup();
      const t = ensureTurn();
      const card = document.createElement("div");
      card.className = "bc-t-card";
      card.tabIndex = -1;
      card.dataset.requestId = req.requestId;
      const toolName = req.toolName;
      const input = req.input || {};
      const finish = (decision, extra = {}) => {
        if (card.classList.contains("is-answered")) return;
        card.classList.add("is-answered");
        card.querySelectorAll("button, textarea, input").forEach((b) => { b.disabled = true; });
        respond({ requestId: req.requestId, decision, ...extra });
      };
      card.bcDeny = () => finish("deny");

      if (toolName === "AskUserQuestion") {
        renderQuestionCard(card, req, finish);
      } else if (toolName === "ExitPlanMode") {
        card.classList.add("is-plan");
        card.innerHTML = `<div class="bc-t-card-head"><span class="bc-t-card-icon">${icon("NOTE")}</span><strong>Claude's plan</strong><span class="bc-t-card-sub">Approve it to let Claude start</span></div><div class="bc-t-plan bc-t-prose"></div><div class="bc-t-card-feedback" hidden><textarea rows="2" placeholder="What should change in the plan? (Enter to send, Esc to cancel)"></textarea></div><div class="bc-t-card-actions"><button type="button" class="bc-t-btn is-primary" data-act="allow">Approve plan</button><button type="button" class="bc-t-btn" data-act="keep">Keep planning</button></div>`;
        card.querySelector(".bc-t-plan").innerHTML = renderMarkdown(input.plan || "");
        const feedback = card.querySelector(".bc-t-card-feedback");
        const textarea = feedback.querySelector("textarea");
        const keep = card.querySelector('[data-act="keep"]');
        const keepPlanning = () => {
          // Read by permissionSettled: this "deny" is a send-back, not a refusal.
          card.dataset.keptPlanning = feedback.hidden ? "" : textarea.value.trim();
          finish("deny", { message: feedback.hidden ? "Keep planning." : `Keep planning. ${textarea.value.trim()}`.trim() });
        };
        const closeFeedback = () => {
          feedback.hidden = true;
          keep.textContent = "Keep planning";
          try { card.focus({ preventScroll: true }); } catch {}
        };
        card.querySelector('[data-act="allow"]').addEventListener("click", () => finish("allow"));
        keep.addEventListener("click", () => {
          if (feedback.hidden) {
            feedback.hidden = false;
            keep.textContent = "Send feedback";
            textarea.focus();
            return;
          }
          keepPlanning();
        });
        textarea.addEventListener("keydown", (event) => {
          if (event.isComposing) return;
          if (event.key === "Escape") {
            // Backs out of the feedback box. Left to the window's Esc, it
            // denied the plan outright and dropped what was typed.
            event.preventDefault();
            event.stopPropagation();
            closeFeedback();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            keepPlanning();
          }
        });
        // Esc from outside the box (window keydown) still means "keep planning".
        card.bcDeny = keepPlanning;
      } else {
        const d = describeTool(toolName, input);
        const question = toolName === "Bash" ? "Run this command?"
          : d.kind === "edit" ? `${d.verb === "Wrote" ? "Create" : "Edit"} ${escapeHtml(d.target || "this file")}?`
          : d.kind === "web" ? `${escapeHtml(d.verb)} ${escapeHtml(d.target)}?`
          : `Allow ${escapeHtml(req.displayName || toolName)}?`;
        // For Bash without its own `description`, Claude Code sends the
        // (truncated) command as the description — the preview shows it already.
        const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();
        const note = flat(req.description).replace(/(…|\.\.\.)$/, "");
        const noteRepeatsCommand = toolName === "Bash" && !!note && flat(input.command).startsWith(note);
        let preview = "";
        if (toolName === "Bash") preview = `<pre class="bc-t-cmd">$ ${escapeHtml(input.command || "")}</pre>`;
        else if (["Edit", "MultiEdit", "Write"].includes(toolName)) preview = `<div class="bc-t-card-path">${escapeHtml(input.file_path || "")}</div><pre class="bc-t-diff">${miniDiff(input)}</pre>`;
        else if (input && Object.keys(input).length) preview = `<pre class="bc-t-json">${escapeHtml(JSON.stringify(input, null, 2).slice(0, 1500))}</pre>`;
        card.innerHTML = `
          <div class="bc-t-card-head"><span class="bc-t-card-icon">${icon(KIND_ICON[d.kind] || "WARNING")}</span><strong>${question}</strong></div>
          ${req.description && !noteRepeatsCommand ? `<div class="bc-t-card-note">${escapeHtml(req.description)}</div>` : ""}
          ${preview}
          ${req.decisionReason ? `<div class="bc-t-card-reason">${escapeHtml(req.decisionReason)}</div>` : ""}
          <div class="bc-t-card-actions">
            <button type="button" class="bc-t-btn is-primary" data-act="allow">Allow</button>
            ${req.alwaysLabel ? `<button type="button" class="bc-t-btn" data-act="always"></button>` : ""}
            <span class="bc-ide-flex"></span>
            <button type="button" class="bc-t-btn is-quiet" data-act="deny">Deny</button>
          </div>
          <div class="bc-t-card-keys">${req.defaultToNo ? "" : '<span class="bc-t-keys-enter">Enter to allow · </span>'}Esc to deny</div>`;
        const always = card.querySelector('[data-act="always"]');
        if (always) {
          always.textContent = req.alwaysLabel;
          always.title = "Saved as a Claude Code permission rule (project rules go in .claude/settings.local.json)";
          always.addEventListener("click", () => finish("always"));
        }
        card.querySelector('[data-act="allow"]').addEventListener("click", () => finish("allow"));
        card.querySelector('[data-act="deny"]').addEventListener("click", () => finish("deny"));
        card.addEventListener("keydown", (event) => {
          if (card.classList.contains("is-answered")) return;
          if (event.key === "Enter" && !event.shiftKey && !req.defaultToNo && event.target === card) { event.preventDefault(); finish("allow"); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish("deny"); }
        });
      }
      t.body.appendChild(card);
      cards.set(req.requestId, card);
      scrollHint();
      // Take focus only when it isn't somewhere the user is typing: a card
      // that grabbed focus mid-sentence turned the composer's Enter into
      // "Allow". Switching to this conversation (activate) focuses it.
      requestAnimationFrame(() => {
        if (card.classList.contains("is-answered") || isEditable(document.activeElement)) return;
        try { card.focus({ preventScroll: true }); } catch {}
      });
      return card;
    }

    function renderQuestionCard(card, req, finish) {
      const questions = Array.isArray(req.input && req.input.questions) ? req.input.questions : [];
      card.classList.add("is-question");
      const picks = questions.map(() => new Set());
      const others = questions.map(() => "");
      const head = `<div class="bc-t-card-head"><span class="bc-t-card-icon">${icon("CHAT")}</span><strong>${questions.length > 1 ? "Claude has a few questions" : "Claude has a question"}</strong></div>`;
      const blocks = questions.map((q, qi) => `
        <div class="bc-t-q" data-q="${qi}">
          ${q.header ? `<span class="bc-t-q-chip">${escapeHtml(q.header)}</span>` : ""}
          <div class="bc-t-q-text">${escapeHtml(q.question || "")}</div>
          <div class="bc-t-q-opts">${(Array.isArray(q.options) ? q.options : []).map((o, oi) => `<button type="button" class="bc-t-q-opt" data-o="${oi}"><strong>${escapeHtml(o.label || "")}</strong>${o.description ? `<small>${escapeHtml(o.description)}</small>` : ""}</button>`).join("")}</div>
          <input class="bc-t-q-other" type="text" placeholder="Or type your own answer" />
        </div>`).join("");
      card.innerHTML = `${head}${blocks}<div class="bc-t-card-actions"><button type="button" class="bc-t-btn is-primary" data-act="submit" disabled>Answer</button><span class="bc-ide-flex"></span><button type="button" class="bc-t-btn is-quiet" data-act="skip">Skip</button></div>`;
      const submit = card.querySelector('[data-act="submit"]');
      const sync = () => { submit.disabled = !questions.every((_, i) => picks[i].size || others[i].trim()); };
      card.querySelectorAll(".bc-t-q").forEach((block) => {
        const qi = Number(block.dataset.q);
        const q = questions[qi];
        block.querySelectorAll(".bc-t-q-opt").forEach((btn) => {
          btn.addEventListener("click", () => {
            const label = (q.options[Number(btn.dataset.o)] || {}).label || "";
            if (q.multiSelect) {
              if (picks[qi].has(label)) picks[qi].delete(label); else picks[qi].add(label);
            } else {
              picks[qi] = new Set([label]);
            }
            block.querySelectorAll(".bc-t-q-opt").forEach((b) => b.classList.toggle("is-picked", picks[qi].has((q.options[Number(b.dataset.o)] || {}).label)));
            sync();
          });
        });
        const other = block.querySelector(".bc-t-q-other");
        other.addEventListener("input", (e) => { others[qi] = e.target.value; sync(); });
        // Esc leaves the field rather than reaching the window's Esc, which
        // would skip the question and drop the typed answer.
        other.addEventListener("keydown", (e) => {
          if (e.key !== "Escape" || e.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          try { card.focus({ preventScroll: true }); } catch {}
        });
      });
      submit.addEventListener("click", () => {
        const answers = {};
        questions.forEach((q, i) => {
          const chosen = Array.from(picks[i]);
          if (others[i].trim()) chosen.push(others[i].trim());
          answers[q.question] = chosen.join(", ");
        });
        finish("allow", { answers });
      });
      card.querySelector('[data-act="skip"]').addEventListener("click", () => finish("deny", { message: "The user skipped the question — continue with your best judgement." }));
    }

    function permissionSettled(requestId, decision) {
      const card = cards.get(requestId);
      if (!card) return;
      cards.delete(requestId);
      card.classList.add("is-answered");
      card.querySelectorAll("button, textarea, input").forEach((b) => { b.disabled = true; });
      const keptPlanning = decision === "deny" && card.dataset.keptPlanning !== undefined;
      const label = keptPlanning
        ? (card.dataset.keptPlanning ? `Sent back to keep planning: “${card.dataset.keptPlanning}”` : "Sent back to keep planning")
        : decision === "deny" ? "Denied" : decision === "always" ? "Always allowed" : decision === "cancel" ? "No longer needed" : "Allowed";
      // Collapse an answered card to its heading + outcome.
      card.querySelectorAll(".bc-t-card-actions, .bc-t-card-keys, .bc-t-card-feedback, .bc-t-q-other").forEach((el) => el.remove());
      const stamp = document.createElement("div");
      stamp.className = "bc-t-card-stamp";
      stamp.dataset.decision = keptPlanning ? "keep" : decision;
      stamp.textContent = label;
      card.appendChild(stamp);
    }

    function pendingCard() {
      for (const card of cards.values()) if (!card.classList.contains("is-answered")) return card;
      return null;
    }

    // --- notes, errors, footer ---------------------------------------------------

    function note(text, kind = "info") {
      const el = document.createElement("div");
      el.className = "bc-t-note";
      el.dataset.kind = kind;
      el.textContent = text;
      (turn ? turn.body : root).appendChild(el);
      scrollHint();
      return el;
    }

    function error(message, actions = []) {
      clearWorking();
      const el = document.createElement("div");
      el.className = "bc-t-error";
      el.innerHTML = `<span class="bc-t-error-icon">${icon("WARNING")}</span><div class="bc-t-error-copy"><div class="bc-t-error-text"></div></div>`;
      el.querySelector(".bc-t-error-text").textContent = message;
      if (actions.length) {
        const row = document.createElement("div");
        row.className = "bc-t-error-actions";
        actions.forEach((a) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "bc-t-btn";
          b.textContent = a.label;
          b.addEventListener("click", a.run);
          row.appendChild(b);
        });
        el.querySelector(".bc-t-error-copy").appendChild(row);
      }
      (turn ? turn.body : root).appendChild(el);
      scrollHint();
      return el;
    }

    function footer(text, { free = false } = {}) {
      if (!turn) return;
      const el = document.createElement("div");
      el.className = "bc-t-foot";
      if (free) el.dataset.free = "true";
      el.textContent = text;
      turn.el.appendChild(el);
      scrollHint();
    }

    function endTurn() {
      if (!turn) return;
      clearWorking();
      turn.segments.forEach((seg) => { if (seg.raf) { cancelAnimationFrame(seg.raf); paint(seg); } });
      // Calls that never got a result (Stop, a crash) must not spin forever.
      turn.rows.forEach((record) => { if (record.row.dataset.state === "running") settleRow(record, "stopped"); });
      turn = null;
    }

    /** A reopened session's saved turns ({role:user|assistant|tool, …}). */
    function loadTurns(turns) {
      root.textContent = "";
      turn = null;
      (turns || []).forEach((t, i) => {
        // A relayed teammate message is saved as a user line under the
        // relay's header (electron/main.js teamDeliveryText) — label it again.
        const team = t.role === "user" ? /^\[BetterClaude team · from ([^\]\n]{1,80}?)(?: → you[^\]\n]*)?\]\n/.exec(t.text || "") : null;
        if (team) userMessage(t.text.slice(team[0].length), { label: `Message from ${team[1]}` });
        else if (t.role === "user") userMessage(t.text);
        else if (t.role === "assistant") setText(`h${i}`, t.text);
        else if (t.role === "note") note(t.text, "muted");
        else if (t.role === "tool") {
          tool({ id: t.id || `h${i}`, name: t.name, input: t.input || {} });
          toolResult({ id: t.id || `h${i}`, isError: t.isError, preview: t.preview || "" });
        }
      });
      endTurn();
    }

    function welcome(html) {
      root.innerHTML = `<div class="bc-t-welcome">${html}</div>`;
    }

    return {
      el: root,
      userMessage,
      delta,
      setText,
      resetText,
      tool,
      toolResult,
      permission,
      permissionSettled,
      pendingCard,
      note,
      error,
      footer,
      setWorking,
      clearWorking,
      endTurn,
      loadTurns,
      welcome,
      hasOpenTurn: () => !!turn,
      isEmpty: () => !root.querySelector(".bc-t-user, .bc-t-turn"),
      firstUserText: () => { const el = root.querySelector(".bc-t-user:not([data-from]) .bc-t-user-bubble"); return el ? el.textContent : ""; },
      lastAssistantText: () => {
        const prose = root.querySelectorAll(".bc-t-prose");
        return prose.length ? prose[prose.length - 1].textContent : "";
      },
      /** Plain {role, text} history for free-model follow-ups. */
      history: () => {
        const out = [];
        root.querySelectorAll(".bc-t-user-bubble, .bc-t-turn").forEach((el) => {
          if (el.classList.contains("bc-t-user-bubble")) out.push({ role: "user", text: el.textContent });
          else {
            const text = Array.from(el.querySelectorAll(".bc-t-body > .bc-t-prose")).map((p) => p.textContent).join("\n\n").trim();
            if (text) out.push({ role: "assistant", text });
          }
        });
        return out;
      },
    };
  }

  window.BetterClaudeTranscript = { create, describeTool, summarizeTools };
})();

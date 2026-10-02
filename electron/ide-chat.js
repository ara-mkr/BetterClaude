/**
 * The Code tab's Claude Code engine: one long-lived `claude` process per open
 * chat tab, driven over Claude Code's own host protocol (the same stdin/stdout
 * control protocol the official Agent SDK uses).
 *
 *   claude --print --input-format stream-json --output-format stream-json
 *          --permission-prompt-tool stdio …
 *
 * Why this shape (vs. the old one-shot `--print` per turn):
 *   - Real permission prompts. With `--permission-prompt-tool stdio` the CLI
 *     sends a `control_request {subtype:"can_use_tool"}` whenever a tool needs
 *     approval; the renderer shows an Allow / Always / Deny card and the answer
 *     goes back as a `control_response`. The one-shot path had no way to ask,
 *     so anything that would prompt was silently denied — and Bash was simply
 *     removed from the toolset.
 *   - Follow-up turns reuse the warm process (no re-spawn, no re-reading the
 *     transcript), and Stop is a clean `interrupt`, not a kill.
 *   - Everything Claude Code does is visible: tool calls, tool results,
 *     subagents, plan-mode exits, questions — not just the final text.
 *
 * Wire shapes verified against the installed CLI (2.1.283) and the Agent SDK
 * sources (claude-agent-sdk-python _internal/query.py, @anthropic-ai/claude-
 * agent-sdk sdk.d.ts):
 *   user turn  ->  {"type":"user","message":{"role":"user","content":…},"parent_tool_use_id":null,"session_id":""}
 *   approve    ->  {"type":"control_response","response":{"subtype":"success","request_id":…,
 *                    "response":{"behavior":"allow","updatedInput":…,"updatedPermissions"?:[…]}}}
 *   deny       ->  … "response":{"behavior":"deny","message":…}
 *   interrupt  ->  {"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}
 *
 * Billing: the child runs with subscriptionEnv() (claude-cli.js), which strips
 * every API-key / provider override, so Claude Code authenticates with the
 * user's claude.ai login and each turn counts against their plan. The CLI's
 * `system/init` event reports `apiKeySource` BEFORE the first API request; if
 * a project's own settings would switch billing to an API key, the process is
 * stopped right there unless the user has explicitly allowed that.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { subscriptionEnv } = require("./claude-cli");

// `apiKeySource` values that mean "the user's own Claude plan" (claude.ai
// OAuth login, or a `claude setup-token` subscription token). Anything else —
// ANTHROPIC_API_KEY, apiKeyHelper, a Console "/login managed key", a
// project/org key — bills API usage instead.
const SUBSCRIPTION_KEY_SOURCES = new Set(["none", "oauth"]);

// Settings-file `env` keys that take Claude Code off the claude.ai login: an
// API key or bearer token, another endpoint, or a cloud provider.
const PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const PROVIDER_SWITCH_KEYS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
// Claude Code's own stderr notice when some other credential outranks the
// claude.ai login — a backstop for sources the file check can't see.
const AUTH_OVERRIDE_STDERR_RE = /takes precedence over your claude\.ai login/i;
const OAUTH_TOKEN_RE = /CLAUDE_CODE_OAUTH_TOKEN|setup-token/i;
const API_CREDENTIAL_RE = /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|apiKeyHelper|api[ _-]?key/i;

/**
 * Whether a stderr line says a non-plan credential outranks the claude.ai
 * login. A `claude setup-token` token (CLAUDE_CODE_OAUTH_TOKEN, which
 * subscriptionEnv deliberately keeps) also "takes precedence" over the
 * interactive login but still bills the user's plan — so a notice naming it,
 * or one naming nothing while that token is set, is not a billing change.
 */
function isBillingOverrideNotice(line, oauthTokenInEnv) {
  if (!AUTH_OVERRIDE_STDERR_RE.test(line)) return false;
  if (OAUTH_TOKEN_RE.test(line)) return false;
  if (oauthTokenInEnv && !API_CREDENTIAL_RE.test(line)) return false;
  return true;
}

function managedSettingsPath() {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return path.join(process.env.ProgramData || "C:\\ProgramData", "ClaudeCode", "managed-settings.json");
  return "/etc/claude-code/managed-settings.json";
}

/**
 * The settings files a chat would load that move Claude Code off the user's
 * Claude plan. The CLI applies every loaded file's `env` block to itself —
 * after BetterClaude scrubbed its environment (subscriptionEnv) — and still
 * reports apiKeySource "none" for a bearer token + base URL (verified: a
 * user-level ANTHROPIC_BASE_URL/AUTH_TOKEN pair sent every request to a local
 * router under a "Claude plan" label). So the files are read here, before
 * anything is sent. Values are never returned — only key names and hosts.
 * @returns {{scope:string, label:string, detail:string}[]}
 */
function settingsProviderOverrides({ cwd, loadUserSettings }) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const files = [
    { scope: "managed", label: "your organisation's managed Claude Code settings", file: managedSettingsPath() },
    loadUserSettings ? { scope: "user", label: "your Claude Code user settings (~/.claude/settings.json)", file: path.join(configDir, "settings.json") } : null,
    cwd ? { scope: "project", label: "this project's .claude/settings.json", file: path.join(cwd, ".claude", "settings.json") } : null,
    cwd ? { scope: "local", label: "this project's .claude/settings.local.json", file: path.join(cwd, ".claude", "settings.local.json") } : null,
  ].filter(Boolean);
  const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
  const found = [];
  for (const { scope, label, file } of files) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!settings || typeof settings !== "object") continue;
    const env = settings.env && typeof settings.env === "object" ? settings.env : {};
    const bits = PROVIDER_ENV_KEYS.filter((k) => typeof env[k] === "string" && env[k].trim()).map((k) => {
      if (k !== "ANTHROPIC_BASE_URL") return k;
      try { return `${k} → ${new URL(env[k]).host}`; } catch { return k; }
    });
    PROVIDER_SWITCH_KEYS.forEach((k) => { if (truthy(env[k])) bits.push(k); });
    if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) bits.push("apiKeyHelper");
    if (bits.length) found.push({ scope, label, detail: bits.join(", ") });
  }
  return found;
}

// Composer mode id -> `--permission-mode`. "manual"/"normal" are older ids
// still found in persisted renderer state.
const CLI_MODES = {
  ask: "default",
  manual: "default",
  default: "default",
  acceptEdits: "acceptEdits",
  normal: "acceptEdits",
  plan: "plan",
  auto: "auto",
  bypass: "bypassPermissions",
};

const IDLE_MS = 15 * 60 * 1000; // a quiet tab's process is released after this
const MAX_LIVE = 3; // live processes kept warm; the least-recently-used idle one goes first
const STOP_GRACE_MS = 4000; // interrupt -> hard kill if no result by then
const KILL_GRACE_MS = 3000; // SIGTERM -> SIGKILL
const CONTROL_TIMEOUT_MS = 6000;
const AUTO_REASON_GRACE_MS = 3000; // see finishTurn
const ATTACHMENT_BUDGET_BYTES = 512 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_TEXT_RE = /(hit your (usage )?limit|usage limit|rate.?limit|limit (has been |was )?reached|out of (extra )?usage|credit balance|insufficient credits|quota exceeded)/i;
const AUTH_TEXT_RE = /(\/login|not (logged|signed) in|invalid api key|authenticat|unauthori[sz]ed|oauth (token|session))/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

const stripAnsi = (text) => String(text == null ? "" : text).replace(ANSI_RE, "");

function cliModeFor(mode, allowBypass) {
  const cli = CLI_MODES[mode] || "acceptEdits";
  if (cli === "bypassPermissions" && !allowBypass) return "acceptEdits";
  return cli;
}

/** Tool results can be a string or an array of content blocks. */
function toolResultPreview(content, limit = 4000) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((part) => {
      if (!part) return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return "[image]";
      return "";
    }).join("\n");
  }
  text = stripAnsi(text);
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/**
 * The single "Always allow" choice offered for a permission request, derived
 * from the CLI's own `permission_suggestions`. Deliberately NOT all of them:
 * the CLI suggests a precise rule, a directory grant AND a session-wide mode
 * change together, and passing them all back (verified) silently switched the
 * session to accept-edits — so the next command ran without asking. The most
 * specific suggestion wins: an allow rule, then a mode change, then a dir.
 */
function pickAlwaysOption(request) {
  if (request.suppress_always_allow_rule) return null;
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const rules = suggestions.filter((s) => s && s.type === "addRules" && s.behavior === "allow" && Array.isArray(s.rules) && s.rules.length);
  if (rules.length) {
    const names = rules.flatMap((s) => s.rules).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
    const where = rules[0].destination === "session" ? " this session" : " in this project";
    return { label: `Always allow ${names.join(", ")}${where}`, updates: rules };
  }
  const mode = suggestions.find((s) => s && s.type === "setMode" && s.mode === "acceptEdits");
  if (mode) return { label: "Allow all edits this session", updates: [mode] };
  const dirs = suggestions.find((s) => s && s.type === "addDirectories" && Array.isArray(s.directories) && s.directories.length);
  if (dirs) return { label: `Always allow access to ${dirs.directories[0]}`, updates: [dirs] };
  return null;
}

function friendlyError(turn, resultEvent, lastStderr) {
  const api = turn.apiError;
  const resultText = resultEvent && typeof resultEvent.result === "string" ? resultEvent.result : "";
  const text = stripAnsi((api && api.text) || resultText || "").trim();
  if ((api && api.kind === "authentication_failed") || AUTH_TEXT_RE.test(text)) {
    // Seen live: "Failed to authenticate: OAuth session expired and could not
    // be refreshed". The CLI's own claude.ai login (macOS keychain) is
    // separate from any router/token the user's terminal claude is set up
    // with, so it can lapse while their terminal still works.
    const expired = /expired|refresh/i.test(text);
    return {
      code: "auth",
      message: expired
        ? "Claude Code's sign-in to your Claude account has expired. Sign in again with your Claude account (your subscription, no API key), then send again."
        : "Claude Code isn't signed in to your Claude account. Sign in with your Claude account (your subscription, no API key), then send again.",
    };
  }
  if (turn.limitHit || (api && (api.kind === "rate_limit" || api.kind === "billing_error")) || LIMIT_TEXT_RE.test(text)) {
    return { code: "limit", message: text || "You've reached your Claude usage limit for now." };
  }
  if (api && api.kind === "model_not_found") {
    return { code: "model", message: "That model isn't available on your plan. Pick another one in the model menu." };
  }
  const subtype = resultEvent && resultEvent.subtype;
  if (subtype === "error_max_turns") return { code: "max-turns", message: "Claude stopped after reaching the turn limit for one request. Send a follow-up to continue." };
  if (text) return { code: "error", message: text };
  if (subtype === "error_during_execution") return { code: "error", message: `Claude Code hit an error while working${lastStderr ? `: ${lastStderr}` : "."}` };
  return { code: "error", message: lastStderr || "Claude could not complete that request." };
}

/**
 * @param {object} host
 * @param {(payload:object)=>void} host.send            post an ide:chat-event to the renderer
 * @param {()=>object} host.getConfig                    { loadUserSettings, loadMcpServers, allowApiKeyBilling, allowBypassMode }
 * @param {()=>string} host.locateBinary                 absolute path to `claude` (throws when missing)
 * @param {(ctx:object)=>boolean} [host.onLimit]         usage-limit failover; return true when it took the turn over
 * @param {()=>void} [host.onActivity]                   aggregate working/waiting state changed
 * @param {(n:object)=>void} [host.notify]               OS notification (host decides when the window is unfocused)
 */
function createIdeChatEngine(host) {
  const procs = new Map(); // tabId -> proc
  // What a tab last ran with — { cwd, sessionId, model, permissionMode } — so
  // a team delivery can respawn a tab whose process was released as idle.
  const tabMeta = new Map();
  // Tabs on an agent team: tabId -> { prompt } (the protocol appendix).
  const teams = new Map();
  let seq = 0;

  const send = (tabId, payload) => {
    try { host.send({ ...payload, tabId }); } catch { /* view gone */ }
  };
  const activity = () => { try { if (host.onActivity) host.onActivity(); } catch {} };

  function writeLine(proc, obj) {
    if (!proc.child || proc.exited || !proc.child.stdin || proc.child.stdin.destroyed) return false;
    try {
      proc.child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Host -> CLI control request, resolved by the matching control_response. */
  function controlRequest(proc, request, timeoutMs = CONTROL_TIMEOUT_MS) {
    const requestId = `bc_${Date.now().toString(36)}_${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.hostRequests.delete(requestId);
        resolve({ subtype: "error", error: "timeout" });
      }, timeoutMs);
      proc.hostRequests.set(requestId, (response) => { clearTimeout(timer); resolve(response || {}); });
      if (!writeLine(proc, { type: "control_request", request_id: requestId, request })) {
        clearTimeout(timer);
        proc.hostRequests.delete(requestId);
        resolve({ subtype: "error", error: "not running" });
      }
    });
  }

  function killProc(proc) {
    if (proc.exited || proc.killing) return;
    proc.killing = true;
    clearTimeout(proc.idleTimer);
    try { proc.child.stdin.end(); } catch {}
    const signal = (sig) => {
      if (proc.exited) return;
      // The process group, so commands Claude's Bash tool started die with it.
      if (process.platform !== "win32" && proc.child.pid) {
        try { process.kill(-proc.child.pid, sig); return; } catch {}
      }
      try { proc.child.kill(sig); } catch {}
    };
    signal("SIGTERM");
    const hard = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    if (hard.unref) hard.unref();
  }

  function cancelPending(proc) {
    if (!proc.pending.size) return;
    for (const requestId of proc.pending.keys()) send(proc.tabId, { type: "permission-cancel", requestId });
    proc.pending.clear();
    activity();
  }

  function scheduleIdle(proc) {
    clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => {
      // Never while a background task is still running: killing the process
      // would kill the task and lose the follow-up Claude owes on it.
      if (proc.turn || proc.pending.size || proc.tasks.size) { scheduleIdle(proc); return; }
      // The renderer keeps the sessionId, so the next message resumes it.
      disposeProc(proc, { quiet: true });
    }, IDLE_MS);
    if (proc.idleTimer.unref) proc.idleTimer.unref();
  }

  function enforceCap(exceptTabId) {
    const live = Array.from(procs.values()).filter((p) => !p.exited && p.tabId !== exceptTabId);
    if (live.length < MAX_LIVE) return;
    const idle = live.filter((p) => !p.turn && !p.pending.size && !p.tasks.size).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const overflow = live.length - (MAX_LIVE - 1);
    idle.slice(0, overflow).forEach((p) => disposeProc(p, { quiet: true }));
  }

  function spawnProc({ tabId, cwd, sessionId, mode, model }) {
    const config = host.getConfig() || {};
    const binaryPath = host.locateBinary();
    const cliMode = cliModeFor(mode, !!config.allowBypassMode);
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", cliMode,
    ];
    if (config.allowBypassMode) args.push("--allow-dangerously-skip-permissions");
    // `=` form: these options take an optional value, so a separate argv
    // entry that happened to start with "-" would be read as another flag.
    if (model) args.push(`--model=${model}`);
    if (sessionId && UUID_RE.test(sessionId)) args.push(`--resume=${sessionId}`);
    // ~/.claude/settings.json is opt-in (codeWindow.chat.loadUserSettings —
    // see core/settings-schema.js for why); the repo's own settings always load.
    args.push("--setting-sources", config.loadUserSettings === true ? "user,project,local" : "project,local");
    if (!config.loadMcpServers) args.push("--strict-mcp-config");
    args.push("--no-chrome");
    // A tab on an agent team carries the coordination protocol in every
    // process it spawns; the session itself resumes as usual.
    const team = teams.get(tabId);
    if (team && team.prompt) args.push("--append-system-prompt", team.prompt);

    const isWinScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
    const env = subscriptionEnv({ binaryPath, extra: { TERM: "dumb" } });
    const oauthTokenInEnv = !!(env.CLAUDE_CODE_OAUTH_TOKEN && String(env.CLAUDE_CODE_OAUTH_TOKEN).trim());
    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group (POSIX) so Stop / close can take the Bash tool's
      // children down with it.
      detached: process.platform !== "win32",
      shell: isWinScript,
      windowsHide: true,
    });

    const proc = {
      tabId,
      child,
      cwd,
      model: model || null,
      cliMode,
      sessionId: sessionId && UUID_RE.test(sessionId) ? sessionId : null,
      initKey: "",
      apiKeySource: null,
      pending: new Map(), // requestId -> { input, toolName, always, suggestions }
      hostRequests: new Map(), // our own control requests awaiting a response
      turn: null,
      lastCost: 0,
      lastUsedAt: Date.now(),
      idleTimer: null,
      stdoutBuf: "",
      stderrTail: [],
      exited: false,
      killing: false,
      quietExit: false,
      curMsgId: null,
      tasks: new Map(), // live background task id -> description
      endedTasks: new Map(), // recently ended id -> description, awaiting task_notification
      // Why Claude Code is about to start a turn on its own:
      // { text, turnId (the host turn it arrived during, 0 if idle), expiresAt }.
      autoReason: null,
    };
    procs.set(tabId, proc);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => { /* EPIPE after exit — the exit handler reports */ });
    child.stdout.on("data", (chunk) => {
      proc.stdoutBuf += chunk;
      let newline;
      while ((newline = proc.stdoutBuf.indexOf("\n")) !== -1) {
        const line = proc.stdoutBuf.slice(0, newline);
        proc.stdoutBuf = proc.stdoutBuf.slice(newline + 1);
        if (line.trim()) handleLine(proc, line);
      }
    });
    child.stderr.on("data", (chunk) => {
      const lines = stripAnsi(chunk).split("\n").map((l) => l.trim()).filter(Boolean);
      proc.stderrTail.push(...lines);
      if (proc.stderrTail.length > 12) proc.stderrTail.splice(0, proc.stderrTail.length - 12);
      if (!config.allowApiKeyBilling && lines.some((l) => isBillingOverrideNotice(l, oauthTokenInEnv))) {
        billingStop(proc, "Stopped: Claude Code says another credential takes precedence over your claude.ai login here, so this chat would not run on your Claude plan.");
      }
    });
    child.on("error", (err) => onExit(proc, null, null, err));
    child.on("close", (code, signal) => onExit(proc, code, signal, null));
    return proc;
  }

  function onExit(proc, code, signal, err) {
    if (proc.exited) return;
    proc.exited = true;
    clearTimeout(proc.idleTimer);
    for (const resolve of proc.hostRequests.values()) resolve({ subtype: "error", error: "exited" });
    proc.hostRequests.clear();
    if (procs.get(proc.tabId) === proc) procs.delete(proc.tabId);
    cancelPending(proc);
    const turn = proc.turn;
    proc.turn = null;
    if (turn && !turn.ended) {
      turn.ended = true;
      if (turn.stopping) {
        send(proc.tabId, { type: "stopped" });
      } else if (!proc.quietExit) {
        const tail = proc.stderrTail[proc.stderrTail.length - 1] || "";
        const why = err ? err.message : `exit ${code == null ? signal || "?" : code}`;
        send(proc.tabId, {
          type: "error",
          code: err && err.code === "ENOENT" ? "not-found" : "crash",
          message: `Claude Code stopped unexpectedly (${why})${tail ? `: ${tail}` : "."}`,
        });
      }
    }
    activity();
  }

  /** Stops a process that would bill something other than the user's Claude plan. */
  function billingStop(proc, message, extra = {}) {
    if (proc.billingStopped) return;
    proc.billingStopped = true;
    if (proc.turn) proc.turn.ended = true;
    proc.quietExit = true;
    killProc(proc);
    send(proc.tabId, { type: "error", code: "billing", message, ...extra });
  }

  function disposeProc(proc, { quiet = false } = {}) {
    if (!proc) return;
    proc.quietExit = true;
    if (procs.get(proc.tabId) === proc) procs.delete(proc.tabId);
    if (proc.turn && !proc.turn.ended) {
      proc.turn.ended = true;
      if (!quiet) send(proc.tabId, { type: "stopped" });
    }
    cancelPending(proc);
    killProc(proc);
    activity();
  }

  function newTurn({ prompt = "", attachments = [], auto = false } = {}) {
    return {
      id: ++seq,
      prompt,
      attachments,
      auto,
      startedAt: Date.now(),
      streamedMsgIds: new Set(),
      toolsRan: false,
      stopping: false,
      ended: false,
      limitHit: false,
      apiError: null,
      modelId: null,
    };
  }

  /**
   * A turn Claude Code started by itself: a background task finishing queues
   * a <task-notification> and the model answers it (verified — task_notification
   * -> init -> a normal turn with its own result, all after the host's turn
   * ended). Without this, that reply was dropped, and its `result` could end
   * the user's next turn early.
   */
  function beginAutoTurn(proc) {
    clearTimeout(proc.idleTimer);
    proc.lastUsedAt = Date.now();
    proc.turn = newTurn({ auto: true });
    const reason = proc.autoReason && !(proc.autoReason.expiresAt && Date.now() > proc.autoReason.expiresAt) ? proc.autoReason.text : "";
    send(proc.tabId, { type: "start", auto: true, reason, sessionId: proc.sessionId });
    proc.autoReason = null;
    activity();
  }

  const startsTurn = (ev) => (ev.type === "system" && ev.subtype === "init")
    || (ev.type === "stream_event" && !ev.parent_tool_use_id)
    || ev.type === "assistant"
    || (ev.type === "control_request" && ev.request && ev.request.subtype === "can_use_tool");

  // --- stdout event handling --------------------------------------------------

  function handleLine(proc, line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    const tabId = proc.tabId;
    if (!proc.turn && !proc.exited && !proc.killing && startsTurn(ev)) beginAutoTurn(proc);
    const turn = proc.turn;

    switch (ev.type) {
      case "system":
        handleSystem(proc, ev);
        return;
      case "stream_event": {
        if (ev.parent_tool_use_id || !turn) return; // subagent token streams stay collapsed
        const se = ev.event || {};
        if (se.type === "message_start" && se.message) {
          proc.curMsgId = se.message.id || `m${++seq}`;
        } else if (se.type === "content_block_start" && se.content_block && se.content_block.type === "thinking") {
          send(tabId, { type: "thinking" });
        } else if (se.type === "content_block_delta" && se.delta && se.delta.type === "text_delta" && se.delta.text) {
          turn.streamedMsgIds.add(proc.curMsgId);
          send(tabId, { type: "delta", segment: `${proc.curMsgId}:${se.index}`, text: se.delta.text });
        }
        return;
      }
      case "assistant":
        handleAssistant(proc, ev);
        return;
      case "user":
        handleToolResults(proc, ev);
        return;
      case "rate_limit_event": {
        const info = ev.rate_limit_info || {};
        send(tabId, {
          type: "plan-usage",
          info: {
            status: info.status || null,
            utilization: typeof info.utilization === "number" ? info.utilization : null,
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null,
            rateLimitType: info.rateLimitType || null,
            isUsingOverage: !!info.isUsingOverage,
            // Both plan windows at once when the CLI reports them
            // (rate_limit_info.unifiedWindows), so the meter can show the
            // 5-hour and weekly limits side by side.
            windows: ["five_hour", "seven_day"].reduce((out, key) => {
              const w = info.unifiedWindows && info.unifiedWindows[key];
              if (w && typeof w.utilization === "number") out[key] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null };
              return out;
            }, {}),
          },
        });
        if (info.status === "rejected" && turn) turn.limitHit = true;
        return;
      }
      case "control_request":
        handleControlRequest(proc, ev);
        return;
      case "control_response": {
        const response = ev.response || {};
        const resolve = proc.hostRequests.get(response.request_id);
        if (resolve) {
          proc.hostRequests.delete(response.request_id);
          resolve(response);
        }
        return;
      }
      case "control_cancel_request": {
        const requestId = ev.request_id;
        if (proc.pending.delete(requestId)) {
          send(tabId, { type: "permission-cancel", requestId });
          activity();
        }
        return;
      }
      case "result":
        finishTurn(proc, ev);
        return;
      default:
        return;
    }
  }

  function handleSystem(proc, ev) {
    const tabId = proc.tabId;
    if (ev.subtype === "init") {
      if (ev.session_id && ev.session_id !== proc.sessionId) {
        proc.sessionId = ev.session_id;
        send(tabId, { type: "session", sessionId: ev.session_id });
      }
      const meta = tabMeta.get(tabId);
      if (meta && ev.session_id && procs.get(tabId) === proc) meta.sessionId = ev.session_id;
      proc.apiKeySource = ev.apiKeySource || null;
      if (ev.permissionMode) proc.cliMode = ev.permissionMode;
      // Billing guard — `init` precedes the turn's first API request.
      const config = host.getConfig() || {};
      if (proc.apiKeySource && !SUBSCRIPTION_KEY_SOURCES.has(proc.apiKeySource) && !config.allowApiKeyBilling) {
        billingStop(proc, `Stopped before sending anything: Claude Code would bill an API key (${proc.apiKeySource}) here instead of your Claude plan.`, { apiKeySource: proc.apiKeySource });
        return;
      }
      const key = [proc.sessionId, ev.model, ev.permissionMode, proc.apiKeySource].join("|");
      if (key !== proc.initKey) {
        proc.initKey = key;
        send(tabId, {
          type: "init",
          sessionId: proc.sessionId,
          model: ev.model || null,
          permissionMode: ev.permissionMode || null,
          apiKeySource: proc.apiKeySource,
          subscription: SUBSCRIPTION_KEY_SOURCES.has(proc.apiKeySource),
          version: ev.claude_code_version || null,
        });
      }
      return;
    }
    if (ev.subtype === "status") {
      if (ev.permissionMode && ev.permissionMode !== proc.cliMode) {
        proc.cliMode = ev.permissionMode;
        send(tabId, { type: "mode", permissionMode: ev.permissionMode });
      }
      if (ev.status === "compacting") send(tabId, { type: "status", text: "Compacting the conversation…" });
      return;
    }
    if (ev.subtype === "task_started") {
      if (ev.task_id) proc.tasks.set(ev.task_id, stripAnsi(ev.description || ""));
      return;
    }
    if (ev.subtype === "background_tasks_changed") {
      // The CLI's authoritative set ("REPLACE semantics" in its SDK schema):
      // every live background task after a start, finish, kill or
      // foreground move. task_notification alone missed tasks that ended any
      // other way, which kept the process pinned against the idle release.
      if (Array.isArray(ev.tasks)) {
        const live = new Map();
        ev.tasks.forEach((t) => {
          if (t && typeof t.task_id === "string") live.set(t.task_id, stripAnsi(t.description || proc.tasks.get(t.task_id) || ""));
        });
        // Keep what just ended for its task_notification, which can arrive
        // after this event.
        for (const [id, description] of proc.tasks) if (!live.has(id)) proc.endedTasks.set(id, description);
        while (proc.endedTasks.size > 20) proc.endedTasks.delete(proc.endedTasks.keys().next().value);
        proc.tasks = live;
      }
      return;
    }
    if (ev.subtype === "task_notification") {
      // Precedes the turn Claude Code starts to answer it (beginAutoTurn).
      const description = proc.tasks.get(ev.task_id) || proc.endedTasks.get(ev.task_id) || stripAnsi(ev.summary || "");
      proc.tasks.delete(ev.task_id);
      proc.endedTasks.delete(ev.task_id);
      const outcome = ev.status === "completed" ? "finished" : ev.status === "failed" ? "failed" : ev.status === "stopped" ? "was stopped" : "ended";
      proc.autoReason = {
        text: `Background task ${outcome}${description ? `: ${description.slice(0, 120)}` : ""}`,
        turnId: proc.turn ? proc.turn.id : 0,
        expiresAt: 0,
      };
      return;
    }
    if (ev.subtype === "api_retry") {
      // Claude Code backs off up to ~10 times (minutes, all told) before it
      // gives up — say so, rather than "Thinking…" the whole while.
      const status = Number(ev.error_status) || 0;
      const why = status === 429 ? "Rate limited"
        : status === 529 || status === 503 ? "Claude is overloaded"
        : status ? `Claude's API returned ${status}`
        : "Can't reach Claude";
      const attempt = Number(ev.attempt) || 0;
      const max = Number(ev.max_retries) || 0;
      send(tabId, { type: "status", text: `${why} — retrying${attempt && max ? ` (${attempt}/${max})` : ""}…` });
      return;
    }
    if (ev.subtype === "compact_boundary") {
      send(tabId, { type: "note", text: "Earlier messages were compacted to free up context." });
    }
  }

  function handleAssistant(proc, ev) {
    const turn = proc.turn;
    if (!turn) return;
    const msg = ev.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const parentId = ev.parent_tool_use_id || null;
    if (msg.model && msg.model !== "<synthetic>" && !parentId) turn.modelId = msg.model;
    // Errors surface as a synthetic assistant message ("You've hit your
    // limit…", "Please run /login…") on stdout — never stderr. Captured here
    // and turned into a real error at `result`, not rendered as a reply.
    if (ev.error || msg.model === "<synthetic>") {
      turn.apiError = {
        kind: ev.error || "unknown",
        text: blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n"),
      };
      return;
    }
    blocks.forEach((block, i) => {
      if (!block) return;
      if (block.type === "tool_use") {
        turn.toolsRan = true;
        send(proc.tabId, { type: "tool", id: block.id, name: block.name, input: block.input || {}, parentId });
      } else if (block.type === "text" && block.text && !parentId && !turn.streamedMsgIds.has(msg.id)) {
        // Only when no token stream arrived for this message (partial
        // messages dropped) — otherwise the deltas already drew it.
        send(proc.tabId, { type: "text", segment: `${msg.id || "m"}:a${i}`, text: block.text });
      }
    });
  }

  function handleToolResults(proc, ev) {
    if (!proc.turn) return;
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      send(proc.tabId, {
        type: "tool-result",
        id: block.tool_use_id,
        isError: !!block.is_error,
        preview: toolResultPreview(block.content),
        parentId: ev.parent_tool_use_id || null,
      });
    }
  }

  function handleControlRequest(proc, ev) {
    const request = ev.request || {};
    const requestId = ev.request_id;
    if (request.subtype !== "can_use_tool") {
      // Hook / SDK-MCP callbacks this host doesn't register. Answer rather
      // than leave the CLI waiting on us forever.
      writeLine(proc, { type: "control_response", response: { subtype: "error", request_id: requestId, error: `BetterClaude does not handle ${request.subtype || "this request"}` } });
      return;
    }
    const always = pickAlwaysOption(request);
    proc.pending.set(requestId, {
      input: request.input || {},
      toolName: request.tool_name,
      always,
      suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [],
    });
    send(proc.tabId, {
      type: "permission",
      requestId,
      toolUseId: request.tool_use_id || null,
      toolName: request.tool_name || "tool",
      displayName: request.display_name || request.tool_name || "tool",
      title: stripAnsi(request.title || ""),
      description: stripAnsi(request.description || ""),
      input: request.input || {},
      decisionReason: stripAnsi(request.decision_reason || ""),
      blockedPath: request.blocked_path || null,
      alwaysLabel: always ? always.label : null,
      defaultToNo: !!request.default_to_no,
    });
    activity();
    if (host.notify) {
      const input = request.input || {};
      const body = request.tool_name === "Bash" && input.command
        ? `Run: ${String(input.command).slice(0, 120)}`
        : request.tool_name === "ExitPlanMode" ? "Claude has a plan ready for review."
        : request.tool_name === "AskUserQuestion" ? "Claude has a question for you."
        : `${request.display_name || request.tool_name} needs your approval.`;
      try { host.notify({ title: "Claude needs your input", body }); } catch {}
    }
  }

  function finishTurn(proc, ev) {
    const turn = proc.turn;
    // total_cost_usd is cumulative for the life of the process (verified),
    // so each turn's share is the delta.
    const total = Number(ev.total_cost_usd) || 0;
    const costDelta = Math.max(0, total - proc.lastCost);
    proc.lastCost = total;
    if (!turn || turn.ended) return;
    turn.ended = true;
    proc.turn = null;
    proc.lastUsedAt = Date.now();
    // A task that finished during this turn was either folded into it (no
    // follow-up turn comes, and a later, unrelated auto turn must not wear
    // its reason) or is answered by a turn Claude Code starts right after
    // this result — so its reason only holds for a moment.
    if (proc.autoReason && proc.autoReason.turnId === turn.id && !proc.autoReason.expiresAt) {
      proc.autoReason.expiresAt = Date.now() + AUTO_REASON_GRACE_MS;
    }
    cancelPending(proc);
    scheduleIdle(proc);
    // Joined (or left) a team mid-turn: this process lacks (or still has) the
    // protocol. Release it once the turn is done; the next message resumes
    // the session in a process spawned with the right prompt.
    if (proc.respawnForTeam) setTimeout(() => { if (!proc.turn && !proc.pending.size && !proc.tasks.size) disposeProc(proc, { quiet: true }); }, 0);
    activity();

    if (turn.stopping) {
      send(proc.tabId, { type: "stopped" });
      return;
    }

    const usage = ev.usage || null;
    if (turn.apiError || turn.limitHit || ev.is_error) {
      const err = friendlyError(turn, ev, proc.stderrTail[proc.stderrTail.length - 1]);
      // Not for a turn Claude Code started itself: there's no prompt to replay.
      if (err.code === "limit" && !turn.toolsRan && !turn.auto && host.onLimit) {
        let tookOver = false;
        try {
          tookOver = !!host.onLimit({ tabId: proc.tabId, cwd: proc.cwd, prompt: turn.prompt, attachments: turn.attachments, sessionId: proc.sessionId, message: err.message });
        } catch {}
        if (tookOver) return;
      }
      send(proc.tabId, { type: "error", code: err.code, message: err.message, sessionId: proc.sessionId });
      return;
    }

    if (host.notify) {
      try { host.notify({ title: "Claude finished", body: "The reply is ready in BetterClaude.", done: true }); } catch {}
    }
    send(proc.tabId, {
      type: "done",
      sessionId: proc.sessionId,
      modelId: turn.modelId || proc.model || "claude",
      usage,
      costUsd: costDelta,
      durationMs: Number(ev.duration_ms) || (Date.now() - turn.startedAt),
      apiKeySource: proc.apiKeySource,
      subscription: SUBSCRIPTION_KEY_SOURCES.has(proc.apiKeySource),
      free: false,
    });
  }

  // --- public API ---------------------------------------------------------------

  /**
   * The tab's process, spawned (resuming `sessionId`) when there is none or
   * the running one is for another project or model. The billing guard runs
   * before any spawn. Returns { proc, cold } or { error }.
   */
  function ensureProc({ tabId, cwd, sessionId, model, permissionMode }) {
    let proc = procs.get(tabId);
    if (proc && (proc.exited || proc.cwd !== cwd || proc.model !== model)) {
      disposeProc(proc, { quiet: true });
      proc = null;
    }
    if (proc) return { proc, cold: false };
    const config = host.getConfig() || {};
    // Billing guard, part one: settings files that would route this chat
    // off the user's Claude plan are caught before anything is spawned.
    if (!config.allowApiKeyBilling) {
      const overrides = settingsProviderOverrides({ cwd, loadUserSettings: config.loadUserSettings === true });
      if (overrides.length) {
        const where = overrides.map((o) => `${o.label} ${o.scope === "user" || o.scope === "managed" ? "set" : "sets"} ${o.detail}`).join("; ");
        send(tabId, {
          type: "error",
          code: "billing",
          scopes: overrides.map((o) => o.scope),
          message: `Stopped before sending anything: ${where} — so this chat would not run on your Claude plan.`,
        });
        return { error: "billing" };
      }
    }
    try {
      enforceCap(tabId);
      return { proc: spawnProc({ tabId, cwd, sessionId, mode: permissionMode, model }), cold: true };
    } catch (err) {
      send(tabId, { type: "error", code: err && err.name === "ClaudeNotFoundError" ? "not-found" : "spawn", message: (err && err.message) || "Claude Code could not start." });
      return { error: "spawn" };
    }
  }

  /** Opens a turn and writes its user line. False (and the process released) if the CLI won't take it. */
  function startTurn(proc, { content, prompt, attachments = [], auto = false, startPayload }) {
    clearTimeout(proc.idleTimer);
    proc.lastUsedAt = Date.now();
    // A queued task notification now rides along with this prompt.
    proc.autoReason = null;
    proc.turn = newTurn({ prompt, attachments, auto });
    send(proc.tabId, startPayload);
    const wrote = writeLine(proc, {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    });
    if (!wrote) {
      proc.turn.ended = true;
      proc.turn = null;
      send(proc.tabId, { type: "error", code: "spawn", message: "Claude Code isn't accepting input right now. Try again." });
      disposeProc(proc, { quiet: true });
      return false;
    }
    activity();
    return true;
  }

  /**
   * Sends one user turn. Reuses the tab's warm process when its project and
   * model still match; otherwise (re)spawns, resuming the session when known.
   */
  async function sendMessage({ tabId, cwd, prompt, attachments = [], sessionId = null, claudeModel = null, permissionMode = "acceptEdits" }) {
    if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, error: "empty" };
    let proc = procs.get(tabId);
    if (proc && proc.turn) return { ok: false, error: "busy" };
    const model = claudeModel || null;
    const knownSession = (proc && proc.sessionId) || (sessionId && UUID_RE.test(sessionId) ? sessionId : null);
    tabMeta.set(tabId, { cwd, sessionId: knownSession, model, permissionMode });

    let fullPrompt = prompt.trim();
    let used = 0;
    for (const file of Array.isArray(attachments) ? attachments : []) {
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;
      const part = `\n\n--- ${file.path} ---\n${file.content}`;
      const bytes = Buffer.byteLength(part, "utf8");
      if (used + bytes > ATTACHMENT_BUDGET_BYTES) break;
      fullPrompt += part;
      used += bytes;
    }

    // Images go first as image blocks, then the prompt (with any text files).
    const images = (Array.isArray(attachments) ? attachments : [])
      .filter((file) => file && file.image && typeof file.image.data === "string")
      .map((file) => ({ type: "image", source: { type: "base64", media_type: file.image.mediaType, data: file.image.data } }));
    const content = images.length ? [...images, { type: "text", text: fullPrompt }] : fullPrompt;

    const config = host.getConfig() || {};
    const ensured = ensureProc({ tabId, cwd, sessionId: knownSession, model, permissionMode });
    if (ensured.error) return { ok: false, error: ensured.error };
    proc = ensured.proc;
    const cold = ensured.cold;
    if (!cold) {
      const wanted = cliModeFor(permissionMode, !!config.allowBypassMode);
      if (wanted !== proc.cliMode) {
        const response = await controlRequest(proc, { subtype: "set_permission_mode", mode: wanted });
        if (response.subtype === "success") {
          proc.cliMode = wanted;
          send(tabId, { type: "mode", permissionMode: wanted });
        } else {
          send(tabId, { type: "note", text: `Couldn't switch to ${wanted}: ${stripAnsi(response.error || "not available")}. Staying in ${proc.cliMode}.` });
          send(tabId, { type: "mode", permissionMode: proc.cliMode });
        }
      }
      if (proc.exited || proc.turn) return { ok: false, error: proc.turn ? "busy" : "exited" };
    }

    // `cold`: a process was just spawned, so the CLI is still starting up.
    const started = startTurn(proc, {
      content,
      prompt,
      // Kept for a free-model takeover at the limit, which only reads text.
      attachments: (Array.isArray(attachments) ? attachments : []).filter((file) => file && typeof file.content === "string"),
      startPayload: { type: "start", sessionId: proc.sessionId, modelLabel: "Claude", cold },
    });
    return started ? { ok: true } : { ok: false, error: "write" };
  }

  /**
   * A teammate's message for a tab on an agent team, as a user turn of its
   * own. Only when the tab is truly free — no turn running (a user line
   * written mid-turn would ride into it) and no approval card open (a user
   * line can never answer one, but it mustn't queue behind one either). A tab
   * whose process was released is respawned, resuming its session.
   */
  function deliver(tabId, text, { cwd = null, team = null } = {}) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty" };
    const existing = procs.get(tabId);
    if (existing && (existing.turn || existing.pending.size || existing.killing)) return { ok: false, error: "busy" };
    const meta = tabMeta.get(tabId) || (cwd ? { cwd, sessionId: null, model: null, permissionMode: "default" } : null);
    if (!meta) return { ok: false, error: "no-session" };
    tabMeta.set(tabId, meta);
    const ensured = ensureProc({ tabId, cwd: meta.cwd, sessionId: meta.sessionId, model: meta.model, permissionMode: meta.permissionMode || "default" });
    if (ensured.error) return { ok: false, error: ensured.error };
    const started = startTurn(ensured.proc, {
      content: text,
      prompt: text,
      auto: true,
      startPayload: {
        type: "start",
        auto: true,
        cold: ensured.cold,
        sessionId: ensured.proc.sessionId,
        reason: team && team.from ? `Message from ${team.from}` : "Message from a teammate",
        team: team ? { from: String(team.from || "a teammate"), body: String(team.body || "") } : null,
      },
    });
    return started ? { ok: true } : { ok: false, error: "write" };
  }

  /**
   * Puts a tab on (or takes it off) an agent team. The protocol goes in at
   * spawn time, so a warm process is released — right away when idle, else
   * after its current turn — and the next turn resumes in a fresh one.
   */
  function setTeam(tabId, team) {
    if (team && team.prompt) {
      teams.set(tabId, { prompt: String(team.prompt) });
      const known = tabMeta.get(tabId);
      if (known) {
        // Joined (or re-joined) with a mode chip that may have moved since the
        // tab last sent something: the chip at join time is the authority.
        if (team.permissionMode) known.permissionMode = team.permissionMode;
      } else if (team.cwd) {
        // The chat's own mode chip, never a looser default: a teammate's turn
        // gets exactly the approvals the user's own would.
        tabMeta.set(tabId, { cwd: team.cwd, sessionId: team.sessionId && UUID_RE.test(team.sessionId) ? team.sessionId : null, model: null, permissionMode: team.permissionMode || "default" });
      }
    } else {
      teams.delete(tabId);
    }
    const proc = procs.get(tabId);
    if (!proc || proc.exited) return;
    if (!proc.turn && !proc.pending.size && !proc.tasks.size) disposeProc(proc, { quiet: true });
    else proc.respawnForTeam = true;
  }

  /**
   * The mode chip moved on a chat that is on a team. A teammate's message can
   * start a turn before the user sends anything, so the stored mode has to
   * follow the chip — otherwise tightening to "Ask" still let the next teammate
   * turn edit files unasked. A warm process runs in its old mode, so it is
   * released (now if idle, else after its turn) and the next turn resumes
   * in a fresh one started in the new mode.
   */
  function setTeamMode(tabId, permissionMode) {
    const meta = tabMeta.get(tabId);
    if (!meta || !teams.has(tabId) || typeof permissionMode !== "string" || !permissionMode) return false;
    if (meta.permissionMode === permissionMode) return true;
    meta.permissionMode = permissionMode;
    const proc = procs.get(tabId);
    if (!proc || proc.exited) return true;
    if (!proc.turn && !proc.pending.size && !proc.tasks.size) disposeProc(proc, { quiet: true });
    else proc.respawnForTeam = true;
    return true;
  }

  /**
   * The mode chip changed. A running process switches now (Claude Code takes
   * `set_permission_mode` mid-turn), so the turn in progress stops asking
   * straight away instead of from the next message. Approval cards already
   * open that the new mode would never have asked about are answered: every
   * tool under Bypass, file edits under Accept edits. Questions and plan
   * approvals always stay with the user.
   */
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const USER_ONLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
  async function setMode(tabId, permissionMode) {
    const meta = tabMeta.get(tabId);
    if (meta) meta.permissionMode = permissionMode;
    const proc = procs.get(tabId);
    if (!proc || proc.exited || proc.killing) return { ok: true, live: false };
    const config = host.getConfig() || {};
    const wanted = cliModeFor(permissionMode, !!config.allowBypassMode);
    if (wanted !== proc.cliMode) {
      const response = await controlRequest(proc, { subtype: "set_permission_mode", mode: wanted });
      if (response.subtype !== "success") {
        const why = stripAnsi(response.error || "");
        send(tabId, { type: "note", text: /auto mode unavailable/i.test(why) ? "Auto mode isn't available for this model. Pick another model to use Auto." : `Couldn't switch to ${wanted}: ${why || "not available"}. Staying in ${proc.cliMode}.` });
        send(tabId, { type: "mode", permissionMode: proc.cliMode });
        return { ok: false, live: true };
      }
      proc.cliMode = wanted;
      send(tabId, { type: "mode", permissionMode: wanted });
    }
    for (const [requestId, pending] of Array.from(proc.pending.entries())) {
      if (USER_ONLY_TOOLS.has(pending.toolName)) continue;
      if (wanted === "bypassPermissions" || (wanted === "acceptEdits" && EDIT_TOOLS.has(pending.toolName))) {
        respondPermission({ tabId, requestId, decision: "allow" });
      }
    }
    return { ok: true, live: true };
  }

  /** "waiting" (an approval card is open), "working", "idle", or "closed" (nothing known about the tab). */
  function tabState(tabId) {
    const proc = procs.get(tabId);
    if (proc && !proc.exited) return proc.pending.size ? "waiting" : proc.turn ? "working" : "idle";
    return tabMeta.has(tabId) || teams.has(tabId) ? "idle" : "closed";
  }

  /** The renderer's answer to a permission / question / plan card. */
  function respondPermission({ tabId, requestId, decision, answers = null, message = "" }) {
    const proc = procs.get(tabId);
    if (!proc) return false;
    const pending = proc.pending.get(requestId);
    if (!pending) return false;
    proc.pending.delete(requestId);
    let response;
    if (decision === "allow" || decision === "always") {
      const updatedInput = answers && typeof answers === "object" ? { ...pending.input, answers } : pending.input;
      response = { behavior: "allow", updatedInput };
      if (decision === "always" && pending.always) response.updatedPermissions = pending.always.updates;
      // Approving a plan leaves plan mode the way Claude Code's own dialog
      // does: with the CLI's suggested follow-up mode, when it offers one.
      if (pending.toolName === "ExitPlanMode") {
        const next = pending.suggestions.filter((s) => s && s.type === "setMode");
        if (next.length) response.updatedPermissions = next;
      }
    } else {
      response = { behavior: "deny", message: String(message || "").trim() || "The user declined this in BetterClaude." };
    }
    writeLine(proc, { type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    send(tabId, { type: "permission-resolved", requestId, decision });
    activity();
    return true;
  }

  /** Stop the tab's current turn: a clean interrupt, a hard kill as backstop. */
  function stop(tabId) {
    const proc = procs.get(tabId);
    if (!proc || !proc.turn) return false;
    const turn = proc.turn;
    if (turn.stopping) {
      disposeProc(proc);
      return true;
    }
    turn.stopping = true;
    // Deny anything still waiting on a card so the interrupt isn't queued
    // behind it, then interrupt.
    for (const requestId of proc.pending.keys()) {
      writeLine(proc, { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message: "Stopped by the user.", interrupt: true } } });
    }
    cancelPending(proc);
    controlRequest(proc, { subtype: "interrupt" });
    const backstop = setTimeout(() => {
      if (proc.turn === turn && !turn.ended) disposeProc(proc);
    }, STOP_GRACE_MS);
    if (backstop.unref) backstop.unref();
    return true;
  }

  function dispose(tabId) {
    disposeProc(procs.get(tabId), { quiet: true });
    tabMeta.delete(tabId);
    teams.delete(tabId);
  }

  function disposeAll() {
    for (const proc of Array.from(procs.values())) disposeProc(proc, { quiet: true });
    tabMeta.clear();
    teams.clear();
  }

  /**
   * Releases every process that isn't mid-turn, awaiting a card, or running a
   * background task, so a settings change (setting sources, MCP, billing)
   * applies from the next message — which respawns with `--resume`.
   */
  function disposeIdle() {
    for (const proc of Array.from(procs.values())) {
      if (!proc.turn && !proc.pending.size && !proc.tasks.size) disposeProc(proc, { quiet: true });
    }
  }

  /** "waiting" if any tab needs approval, else "working" if any is busy, else "idle". */
  function aggregateState() {
    let working = false;
    for (const proc of procs.values()) {
      if (proc.pending.size) return "waiting";
      if (proc.turn) working = true;
    }
    return working ? "working" : "idle";
  }

  const isBusy = (tabId) => {
    const proc = procs.get(tabId);
    return !!(proc && proc.turn);
  };

  /**
   * What each model choice resolves to, straight from Claude Code: the same
   * `initialize` handshake the Agent SDK opens with returns `models` with a
   * `resolvedModel` per entry, "default" included (the plan tier's pick, or a
   * project's `model` setting). No user message is sent, so no API request is
   * made and nothing counts against the plan. Same binary, flags and scrubbed
   * env as a chat, so the answer matches what a send would use.
   * @returns {Promise<{value:string, resolvedModel:string, displayName:string, description:string}[]|null>}
   */
  const modelsCache = new Map(); // cwd -> { at, models }

  /**
   * A throwaway Claude Code process that only answers control requests:
   * `initialize`, then each of `requests` in turn, then it's killed. No user
   * message is written, so no model call is made and nothing is billed.
   * Same binary, flags and scrubbed env as a chat. `resume` loads a saved
   * session (for its context usage). Resolves to { [subtype]: response|null }.
   */
  function probe({ cwd, requests = [], resume = null, timeoutMs = 15000 }) {
    const config = host.getConfig() || {};
    let binaryPath;
    try { binaryPath = host.locateBinary(); } catch { return Promise.resolve(null); }
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      "--setting-sources", config.loadUserSettings === true ? "user,project,local" : "project,local",
      "--strict-mcp-config", "--no-chrome"];
    if (resume && UUID_RE.test(resume)) args.push("--resume", resume);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(binaryPath, args, {
          // No project yet: a neutral folder. The home folder would read
          // ~/.claude/settings.json as *project* settings (model overrides,
          // routers) that the Code tab deliberately leaves out.
          cwd: cwd || os.tmpdir(),
          env: subscriptionEnv({ binaryPath, extra: { TERM: "dumb" } }),
          stdio: ["pipe", "pipe", "ignore"],
          shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath),
          windowsHide: true,
        });
      } catch { resolve(null); return; }
      const wanted = ["initialize", ...requests];
      const results = {};
      let buf = "";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* gone */ }
        try { child.kill(); } catch { /* gone */ }
        resolve(Object.keys(results).length ? results : null);
      };
      const ask = (i) => {
        if (i >= wanted.length) { finish(); return; }
        try {
          child.stdin.write(JSON.stringify({ type: "control_request", request_id: `bc-probe-${i}`, request: { subtype: wanted[i] } }) + "\n");
        } catch { finish(); }
      };
      const timer = setTimeout(finish, timeoutMs);
      child.on("error", finish);
      child.on("exit", finish);
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          const m = ev.type === "control_response" && ev.response && /^bc-probe-(\d+)$/.exec(ev.response.request_id || "");
          if (!m) continue;
          const i = Number(m[1]);
          results[wanted[i]] = ev.response.subtype === "success" ? (ev.response.response || {}) : null;
          ask(i + 1);
        }
      });
      ask(0);
    });
  }

  /**
   * What each model choice resolves to in `cwd`, from the `initialize`
   * handshake (see probe).
   * @returns {Promise<{value:string, resolvedModel:string, displayName:string, description:string, supportsAutoMode:boolean}[]|null>}
   */
  async function listModels({ cwd, force = false } = {}) {
    const config = host.getConfig() || {};
    const key = `${config.loadUserSettings === true ? "u" : "p"}|${cwd || ""}`;
    const hit = modelsCache.get(key);
    if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.models;
    const results = await probe({ cwd });
    const init = results && results.initialize;
    if (!init) return null;
    // Only the model fields leave this function (the handshake also
    // carries account details).
    const models = (Array.isArray(init.models) ? init.models : []).filter((m) => m && typeof m.value === "string").map((m) => ({
      value: m.value,
      resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : "",
      displayName: typeof m.displayName === "string" ? m.displayName : "",
      description: typeof m.description === "string" ? m.description : "",
      supportsAutoMode: m.supportsAutoMode === true,
    }));
    modelsCache.set(key, { at: Date.now(), models });
    return models;
  }

  /** Just the plan windows from `get_usage` (it also carries account and spend details). */
  function shapeUsage(raw) {
    if (!raw || typeof raw !== "object") return null;
    const limits = raw.rate_limits || {};
    const window = (w) => (w && typeof w.utilization === "number"
      ? { percent: Math.max(0, Math.min(100, w.utilization)), resetsAt: typeof w.resets_at === "string" ? w.resets_at : null }
      : null);
    return {
      available: raw.rate_limits_available !== false,
      plan: typeof raw.subscription_type === "string" ? raw.subscription_type : null,
      session: window(limits.five_hour),
      weekly: window(limits.seven_day),
      weeklyOpus: window(limits.seven_day_opus),
      weeklySonnet: window(limits.seven_day_sonnet),
      at: Date.now(),
    };
  }
  let usageCache = null;
  let usagePromise = null;
  /** The plan's session (5-hour) and weekly limits, from Claude Code's own `get_usage`. */
  async function getUsage({ force = false } = {}) {
    if (!force && usageCache && Date.now() - usageCache.at < 60 * 1000) return usageCache;
    // A warm chat process answers without spawning anything.
    for (const proc of procs.values()) {
      if (proc.exited || proc.killing) continue;
      const response = await controlRequest(proc, { subtype: "get_usage" });
      if (response.subtype === "success") { usageCache = shapeUsage(response.response) || usageCache; return usageCache; }
      break;
    }
    if (!usagePromise) {
      usagePromise = probe({ requests: ["get_usage"] }).then((results) => {
        usagePromise = null;
        const shaped = shapeUsage(results && results.get_usage);
        if (shaped) usageCache = shaped;
        return usageCache;
      });
    }
    return usagePromise;
  }

  function shapeContext(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.categories)) return null;
    return {
      totalTokens: Number(raw.totalTokens) || 0,
      maxTokens: Number(raw.maxTokens) || 0,
      percent: Number(raw.percentage) || 0,
      model: typeof raw.model === "string" ? raw.model : null,
      categories: raw.categories
        .filter((c) => c && typeof c.name === "string" && Number(c.tokens) > 0)
        .map((c) => ({ name: c.name, tokens: Number(c.tokens), kind: typeof c.kind === "string" ? c.kind : "used", deferred: !!c.isDeferred })),
    };
  }
  /**
   * The context window for a conversation, broken down like Claude Code's
   * /context: from its live process, else a probe that resumes the saved
   * session (or a fresh one for a new conversation).
   */
  async function getContextUsage({ tabId, cwd = null, sessionId = null }) {
    const proc = procs.get(tabId);
    if (proc && !proc.exited && !proc.killing) {
      const response = await controlRequest(proc, { subtype: "get_context_usage" });
      if (response.subtype === "success") return shapeContext(response.response);
    }
    const meta = tabMeta.get(tabId) || {};
    const resume = sessionId || meta.sessionId || null;
    const results = await probe({ cwd: cwd || meta.cwd || null, requests: ["get_context_usage"], resume });
    return shapeContext(results && results.get_context_usage);
  }

  return { sendMessage, setMode, respondPermission, stop, dispose, disposeAll, disposeIdle, aggregateState, isBusy, deliver, setTeam, setTeamMode, tabState, listModels, getUsage, getContextUsage };
}

module.exports = { createIdeChatEngine, pickAlwaysOption, friendlyError, cliModeFor, settingsProviderOverrides, isBillingOverrideNotice, SUBSCRIPTION_KEY_SOURCES, CLI_MODES };

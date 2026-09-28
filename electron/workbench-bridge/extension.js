/**
 * BetterClaude Bridge — the workbench half of the link between the full-IDE
 * workbench and BetterClaude (electron/main.js; docs/ADR-0001). Installed as a
 * built-in extension of the engine (electron/workbench.js), never from a
 * gallery.
 *
 * Transport: server-sent events from BetterClaude (GET /events) and JSON
 * POSTs back (POST /msg), on 127.0.0.1, authenticated with a per-launch token
 * BetterClaude hands the server process (BC_BRIDGE_URL, BC_BRIDGE_TOKEN).
 * Everything it sends BetterClaude is data for the user to act on — a
 * selection lands in the chat composer, unsent; nothing here can send a
 * prompt, approve anything, or run a command in BetterClaude.
 */
const vscode = require("vscode");
const http = require("http");

let bridge = null; // { url, token }
let status = null; // status bar items
let appliedTheme = null; // the colour theme this extension last set
let lastTheme = null; // BetterClaude's theme as last sent, for turning sync back on

function post(message) {
  if (!bridge) return;
  const body = Buffer.from(JSON.stringify(message));
  const req = http.request(new URL("/msg", bridge.url), {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length, "x-bc-bridge": bridge.token },
  });
  req.on("error", () => {});
  req.end(body);
}

function listen(context) {
  let stopped = false;
  let delay = 1000;
  const reconnect = () => {
    if (stopped) return;
    setTimeout(open, delay);
    delay = Math.min(delay * 2, 15000);
  };
  const open = () => {
    if (stopped) return;
    const req = http.get(new URL("/events", bridge.url), { headers: { "x-bc-bridge": bridge.token, accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reconnect();
        return;
      }
      delay = 1000;
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          let message;
          try { message = JSON.parse(data); } catch { continue; }
          handle(message).catch(() => {});
        }
      });
      res.on("end", reconnect);
      res.on("error", reconnect);
    });
    req.on("error", reconnect);
  };
  open();
  context.subscriptions.push({ dispose: () => { stopped = true; } });
}

async function handle(message) {
  if (message.type === "theme") {
    lastTheme = message;
    return applyTheme(message);
  }
  if (message.type === "open") return openFile(message.file, message.line);
  if (message.type === "diff") return openDiff(message.file);
  if (message.type === "status") return showStatus(message);
  return undefined;
}

async function applyTheme({ colorTheme, colors, settings }) {
  const config = vscode.workspace.getConfiguration();
  if (config.get("betterclaude.syncTheme") === false) return;
  const global = vscode.ConfigurationTarget.Global;
  appliedTheme = colorTheme;
  await config.update("workbench.colorTheme", colorTheme, global);
  await config.update("workbench.colorCustomizations", colors || {}, global);
  for (const [key, value] of Object.entries(settings || {})) await config.update(key, value, global);
}

async function openFile(file, line) {
  if (typeof file !== "string" || !file) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  if (Number.isFinite(line) && line > 0) {
    const pos = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

/** Claude's edit to `file`, as the working tree against HEAD, in the diff editor. */
async function openDiff(file) {
  if (typeof file !== "string" || !file) return;
  try {
    await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(file));
  } catch {
    await openFile(file);
  }
}

function showStatus({ model, mode, state, usage }) {
  if (!status) return;
  const { claude, activity } = status;
  claude.text = `$(sparkle) ${model || "Claude"}${mode ? ` · ${mode}` : ""}${Number.isFinite(usage) ? ` · ${Math.round(usage)}%` : ""}`;
  claude.tooltip = Number.isFinite(usage) ? `Claude plan usage ${Math.round(usage)}% — chat in the panel on the right` : "Claude Code chat is in the panel on the right";
  claude.show();
  if (state === "waiting") {
    activity.text = "$(bell-dot) Claude needs your input";
    activity.show();
  } else if (state === "working") {
    activity.text = "$(loading~spin) Claude is working";
    activity.show();
  } else {
    activity.hide();
  }
}

function activate(context) {
  const url = process.env.BC_BRIDGE_URL;
  const token = process.env.BC_BRIDGE_TOKEN;
  if (!url || !token) return; // not running under BetterClaude
  bridge = { url, token };

  status = {
    claude: vscode.window.createStatusBarItem("betterclaude.claude", vscode.StatusBarAlignment.Right, 100),
    activity: vscode.window.createStatusBarItem("betterclaude.activity", vscode.StatusBarAlignment.Right, 99),
  };
  status.claude.name = "Claude";
  status.activity.name = "Claude activity";
  context.subscriptions.push(status.claude, status.activity);

  context.subscriptions.push(vscode.commands.registerCommand("betterclaude.addSelectionToChat", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel.isEmpty ? undefined : sel);
    post({
      type: "selection",
      file: editor.document.uri.fsPath,
      startLine: sel.isEmpty ? 1 : sel.start.line + 1,
      endLine: sel.isEmpty ? editor.document.lineCount : sel.end.line + 1,
      text: text.slice(0, 200000),
    });
    vscode.window.setStatusBarMessage("$(check) Added to the Claude chat", 2500);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("betterclaude.createPr", () => post({ type: "create-pr" })));

  // Picking another colour theme here means the user wants that one: stop
  // following BetterClaude's until they turn syncing back on.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    // Sync turned back on: apply BetterClaude's theme now, not at its next change.
    if (event.affectsConfiguration("betterclaude.syncTheme") && lastTheme
      && vscode.workspace.getConfiguration().get("betterclaude.syncTheme") !== false) {
      applyTheme(lastTheme).catch(() => {});
      return;
    }
    if (!event.affectsConfiguration("workbench.colorTheme") || !appliedTheme) return;
    const current = vscode.workspace.getConfiguration().get("workbench.colorTheme");
    if (current && current !== appliedTheme) {
      appliedTheme = null;
      const global = vscode.ConfigurationTarget.Global;
      vscode.workspace.getConfiguration().update("betterclaude.syncTheme", false, global);
      vscode.workspace.getConfiguration().update("workbench.colorCustomizations", {}, global);
    }
  }));

  // BetterClaude's chat sits right of the workbench, so VS Code's secondary
  // side bar (the built-in Chat view, empty without an AI extension) is a
  // second empty chat column: hidden by default in new workspaces unless
  // that preference was set here, and closed once in this one. Reopen it
  // for Codex or Claude Code and it stays open.
  const workbenchConfig = vscode.workspace.getConfiguration("workbench");
  const visibility = workbenchConfig.inspect("secondarySideBar.defaultVisibility");
  if (visibility && visibility.globalValue === undefined) {
    workbenchConfig.update("secondarySideBar.defaultVisibility", "hidden", vscode.ConfigurationTarget.Global).then(undefined, () => {});
  }
  if (!context.workspaceState.get("betterclaude.auxiliaryBarClosed")) {
    context.workspaceState.update("betterclaude.auxiliaryBarClosed", true);
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
  }

  listen(context);
  post({ type: "hello", folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath) });
}

function deactivate() {}

module.exports = { activate, deactivate };

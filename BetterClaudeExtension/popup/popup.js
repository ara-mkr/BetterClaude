/**
 * Toolbar popup — the closest browser-extension analog of the Electron
 * app's tray menu. It has no direct access to claude.ai's page, so every
 * action here is a message forwarded to that tab's content script (see
 * content/content-script.js's onBroadcast("betterclaude:open-settings", ...)
 * and the "open-command-palette" chrome.commands handler it shares).
 */
async function activeClaudeTab() {
  const [tab] = await chrome.tabs.query({ url: "https://claude.ai/*", active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const [anyTab] = await chrome.tabs.query({ url: "https://claude.ai/*" });
  return anyTab || null;
}

async function sendToClaudeTab(type) {
  const tab = await activeClaudeTab();
  if (!tab) {
    chrome.tabs.create({ url: "https://claude.ai" });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.tabs.sendMessage(tab.id, { type });
}

document.getElementById("bc-open-settings").addEventListener("click", () => sendToClaudeTab("betterclaude:open-settings"));
document.getElementById("bc-open-palette").addEventListener("click", () => sendToClaudeTab("betterclaude:open-palette"));
document.getElementById("bc-open-claude").addEventListener("click", () => chrome.tabs.create({ url: "https://claude.ai" }));

activeClaudeTab().then((tab) => {
  document.getElementById("bc-popup-status").textContent = tab ? "Connected to claude.ai" : "No claude.ai tab open";
});

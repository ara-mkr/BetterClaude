/**
 * Floating per-turn "Fork" / "Copy for compare" buttons for Conversation
 * Branching — DOM-only, no Node/Electron APIs. Deliberately never touches
 * claude.ai's own message DOM (that's a React-managed tree we don't own —
 * inserting into it risks fighting their reconciliation). Instead this
 * draws a single fixed, viewport-pinned overlay layer and keeps each
 * button aligned to its turn's real on-screen position via
 * getBoundingClientRect(), which is already viewport-relative regardless
 * of which ancestor is actually scrolling.
 *
 * getTurns() should return the same shape core/token-counter.js's
 * collectConversationText() produces: [{ role, text, node }, ...].
 */

function mountBranchForkButtons({ getTurns, onFork, onCopyForCompare }) {
  let layer = document.getElementById("bc-fork-buttons-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "bc-fork-buttons-layer";
    document.body.appendChild(layer);
  }

  const buttonsByNode = new Map(); // turn.node -> { wrap, forkBtn, copyBtn }
  let rafPending = false;

  function sync() {
    const turns = getTurns() || [];
    const liveNodes = new Set();

    turns.forEach((turn, idx) => {
      if (!turn.node || !turn.node.isConnected) return;
      liveNodes.add(turn.node);

      let entry = buttonsByNode.get(turn.node);
      if (!entry) {
        const wrap = document.createElement("div");
        wrap.className = "bc-fork-btn-wrap";

        const forkBtn = document.createElement("button");
        forkBtn.type = "button";
        forkBtn.className = "bc-fork-btn";
        forkBtn.textContent = "⑂ Fork";
        forkBtn.title = "Fork the conversation from here into a new window";

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "bc-fork-btn bc-fork-btn-copy";
        copyBtn.textContent = "⧉";
        copyBtn.title = "Copy this message's text (for the Diff Viewer)";

        wrap.appendChild(forkBtn);
        wrap.appendChild(copyBtn);
        layer.appendChild(wrap);
        entry = { wrap, forkBtn, copyBtn };
        buttonsByNode.set(turn.node, entry);
      }

      entry.forkBtn.onclick = () => onFork(turns, idx);
      entry.copyBtn.onclick = () => onCopyForCompare(turn.text);

      const rect = turn.node.getBoundingClientRect();
      // rect is already viewport-relative, same frame the fixed layer lives
      // in — no scroll-offset math needed regardless of which ancestor
      // (window or an inner claude.ai scroll container) actually scrolls.
      const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.width === 0;
      entry.wrap.style.display = offscreen ? "none" : "flex";
      if (!offscreen) {
        entry.wrap.style.top = `${Math.max(0, rect.top + 4)}px`;
        entry.wrap.style.left = `${Math.max(0, rect.right - 74)}px`;
      }
    });

    buttonsByNode.forEach((entry, node) => {
      if (!liveNodes.has(node)) {
        entry.wrap.remove();
        buttonsByNode.delete(node);
      }
    });
  }

  function scheduleSync() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      sync();
    });
  }

  window.addEventListener("scroll", scheduleSync, true);
  window.addEventListener("resize", scheduleSync);

  function setVisible(visible) {
    layer.style.display = visible ? "block" : "none";
  }

  function destroy() {
    window.removeEventListener("scroll", scheduleSync, true);
    window.removeEventListener("resize", scheduleSync);
    layer.remove();
  }

  return { sync, setVisible, destroy };
}

module.exports = { mountBranchForkButtons };

const { screen } = require("electron");

/**
 * Tracks and restores a BrowserWindow's size/position via the given
 * electron-store instance, under the "window" settings key.
 */
function attachWindowState(win, store) {
  const save = () => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    store.set("window.width", bounds.width);
    store.set("window.height", bounds.height);
    store.set("window.x", bounds.x);
    store.set("window.y", bounds.y);
  };

  let saveTimer = null;
  const debouncedSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  };

  win.on("resize", debouncedSave);
  win.on("move", debouncedSave);
  win.on("close", save);
}

function getInitialBounds(store) {
  const width = store.get("window.width", 1280);
  const height = store.get("window.height", 860);
  let x = store.get("window.x", undefined);
  let y = store.get("window.y", undefined);

  if (x != null && y != null) {
    const displays = screen.getAllDisplays();
    const onScreen = displays.some((d) => {
      const b = d.bounds;
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    });
    if (!onScreen) {
      x = undefined;
      y = undefined;
    }
  }

  return { width, height, x, y };
}

module.exports = { attachWindowState, getInitialBounds };

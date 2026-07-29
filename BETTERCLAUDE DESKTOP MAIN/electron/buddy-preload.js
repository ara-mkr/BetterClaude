/**
 * Preload for the buddy overlay window.
 *
 * Separate from the main preload.js on purpose: that one is injected into
 * claude.ai and carries the whole settings/theme/plugin surface, none of which
 * this window needs. Keeping contextIsolation on means the overlay page gets
 * exactly these calls and no ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buddyAPI", {
  // { buddy: {id, label, cycle}, assets: {state: fileUrl}, animations, hitBox }
  getState: () => ipcRenderer.invoke("buddy:get-state"),

  onState: (cb) => ipcRenderer.on("buddy:state", (_e, state) => cb(state)),
  onWorking: (cb) => ipcRenderer.on("buddy:working", (_e, working) => cb(!!working)),

  // Drag is done by repositioning the window from the main process rather than
  // with -webkit-app-region: drag, which on a transparent always-on-top window
  // swallows the mouse events the hit-testing below depends on.
  dragStart: (screenX, screenY) => ipcRenderer.send("buddy:drag-start", { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send("buddy:drag-move", { screenX, screenY }),
  dragEnd: () => ipcRenderer.send("buddy:drag-end"),

  // Toggles click-through so the transparent margin around the sprite doesn't
  // eat clicks aimed at whatever is behind the overlay.
  setInteractive: (interactive) => ipcRenderer.send("buddy:set-interactive", !!interactive),
});

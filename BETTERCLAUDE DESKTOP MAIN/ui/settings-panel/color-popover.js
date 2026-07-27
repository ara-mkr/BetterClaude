/**
 * Small reusable HSV color-picker popover: a saturation/value square with a
 * draggable selector dot, a hue slider, and a hex field. DOM-only, no host
 * dependency, so it's usable from anywhere in the settings panel (the
 * Appearance accent picker and the per-element pickers in the Appearance
 * Editor tab both use it).
 */

function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const num = m ? parseInt(m[1], 16) : 0x8b5cf6;
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toByte = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Opens a color popover anchored below `anchorEl`. Calls onChange(hex) live
 * as the user drags/types, and onClose() once when it's dismissed.
 */
function openColorPopover(anchorEl, initialHex, onChange, onClose) {
  const existing = document.querySelector(".bc-color-popover");
  if (existing) existing.remove();

  let { h, s, v } = hexToHsv(initialHex);

  const pop = document.createElement("div");
  pop.className = "bc-color-popover";
  pop.innerHTML = `
    <div class="bc-cp-square" data-bc-cp-square>
      <div class="bc-cp-square-sat"></div>
      <div class="bc-cp-square-val"></div>
      <div class="bc-cp-dot" data-bc-cp-dot></div>
    </div>
    <input type="range" class="bc-cp-hue" data-bc-cp-hue min="0" max="360" step="1" />
    <div class="bc-cp-hex-row">
      <input type="text" class="bc-cp-hex" data-bc-cp-hex maxlength="7" />
    </div>
  `;
  document.body.appendChild(pop);

  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;

  const square = pop.querySelector("[data-bc-cp-square]");
  const dot = pop.querySelector("[data-bc-cp-dot]");
  const hue = pop.querySelector("[data-bc-cp-hue]");
  const hexInput = pop.querySelector("[data-bc-cp-hex]");

  function render() {
    square.style.background = `hsl(${h}, 100%, 50%)`;
    dot.style.left = `${s * 100}%`;
    dot.style.top = `${(1 - v) * 100}%`;
    hue.value = String(h);
    const hex = hsvToHex(h, s, v);
    hexInput.value = hex;
    onChange(hex);
  }

  function setFromSquare(clientX, clientY) {
    const r = square.getBoundingClientRect();
    s = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    v = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    render();
  }

  // The whole reason this exists as a bespoke handler: dragging the dot
  // must never let the pointerdown bubble to the document-level
  // "click outside closes the popover" listener below, otherwise the very
  // first pixel of drag closes the picker instead of starting the drag.
  square.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    square.setPointerCapture(e.pointerId);
    setFromSquare(e.clientX, e.clientY);
    const onMove = (ev) => {
      ev.stopPropagation();
      setFromSquare(ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      ev.stopPropagation();
      square.releasePointerCapture(e.pointerId);
      square.removeEventListener("pointermove", onMove);
      square.removeEventListener("pointerup", onUp);
    };
    square.addEventListener("pointermove", onMove);
    square.addEventListener("pointerup", onUp);
  });

  hue.addEventListener("pointerdown", (e) => e.stopPropagation());
  hue.addEventListener("input", () => {
    h = Number(hue.value);
    render();
  });

  hexInput.addEventListener("pointerdown", (e) => e.stopPropagation());
  hexInput.addEventListener("change", () => {
    const parsed = hexToHsv(hexInput.value);
    h = parsed.h; s = parsed.s; v = parsed.v;
    render();
  });

  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  function close() {
    document.removeEventListener("pointerdown", outsideHandler, true);
    document.removeEventListener("keydown", escHandler, true);
    pop.remove();
    if (onClose) onClose();
  }

  function outsideHandler(e) {
    if (pop.contains(e.target) || e.target === anchorEl) return;
    close();
  }
  function escHandler(e) {
    if (e.key === "Escape") close();
  }

  // Deferred so the same pointerdown/click that opened this popover
  // (which is still bubbling up to `document` right now) doesn't
  // immediately count as an "outside" click and close it again.
  setTimeout(() => {
    document.addEventListener("pointerdown", outsideHandler, true);
    document.addEventListener("keydown", escHandler, true);
  }, 0);

  render();
  return { close };
}

module.exports = { openColorPopover, hexToHsv, hsvToHex };

/**
 * Small reusable 12-hour time-picker popover (hour/minute steppers + AM/PM
 * toggle). Replaces the OS-native <input type="time"> on the Themes tab's
 * schedule fields: Chromium fires "change" on that control per keystroke
 * (each digit that completes a segment commits immediately, not just on
 * blur), and panel.js's onSettingsChanged handler does a full
 * `contentEl.innerHTML = ""` re-render whenever settings change while the
 * panel is open — so typing "29" into the native field got the DOM node
 * torn down and rebuilt after the "2", losing focus before the "9" landed.
 *
 * DOM-only, no host dependency — same architecture as color-popover.js:
 * onChange fires live (for local preview only, never touches settings), and
 * the caller only ever commits to storage once, in onClose, after the user
 * is done interacting. That single deferred commit is what actually fixes
 * the bug above, independent of the native-input replacement.
 */

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function parse24(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  const h24 = m ? clamp(Number(m[1]), 0, 23) : 7;
  const min = m ? clamp(Number(m[2]), 0, 59) : 0;
  return { h24, min };
}

function to12(h24) {
  const period = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return { h12, period };
}

function to24(h12, period) {
  let h24 = h12 % 12;
  if (period === "PM") h24 += 12;
  return h24;
}

function format24(h24, min) {
  return `${String(h24).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Exported so panel.js can render the trigger button's label without
// duplicating the 24h -> 12h conversion.
function formatTime12(value24h) {
  const { h24, min } = parse24(value24h);
  const { h12, period } = to12(h24);
  return `${h12}:${String(min).padStart(2, "0")} ${period}`;
}

// One hour/minute stepper: up chevron, editable 2-digit field, down chevron.
// Click/wheel/arrow-keys adjust by 1 with wraparound. Typed digits accumulate
// locally (input.value) and only call back once 2 digits are in or the field
// blurs, so a single "2" is never clamped/reformatted out from under a user
// still typing "29" — there is no external re-render here to race against
// anyway, but this keeps the field's own behavior predictable too.
function buildSpinner(initial, { min, max }, onChange) {
  let value = initial;
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 2;
  input.className = "bc-tp-spinner-input";
  input.value = String(value).padStart(2, "0");

  function set(next) {
    value = clamp(next, min, max);
    input.value = String(value).padStart(2, "0");
    onChange(value);
  }
  function step(delta) {
    const span = max - min + 1;
    set(min + (((value - min + delta) % span) + span) % span);
  }

  const up = document.createElement("button");
  up.type = "button";
  up.className = "bc-tp-spinner-btn";
  up.setAttribute("aria-label", "Increase");
  up.textContent = "▲";
  up.addEventListener("click", () => step(1));

  const down = document.createElement("button");
  down.type = "button";
  down.className = "bc-tp-spinner-btn";
  down.setAttribute("aria-label", "Decrease");
  down.textContent = "▼";
  down.addEventListener("click", () => step(-1));

  input.addEventListener("wheel", (e) => {
    e.preventDefault();
    step(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 2);
    input.value = digits;
    if (digits.length === 2) {
      set(Number(digits));
      input.select();
    }
  });
  input.addEventListener("blur", () => {
    const n = Number(input.value);
    set(input.value && Number.isFinite(n) ? n : value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
  });

  const wrap = document.createElement("div");
  wrap.className = "bc-tp-spinner";
  wrap.appendChild(up);
  wrap.appendChild(input);
  wrap.appendChild(down);
  return { el: wrap, input };
}

/**
 * Opens a time popover anchored below `anchorEl`. `initialValue24h` and the
 * value passed to onChange/onClose are always "HH:MM" 24h strings (the
 * format appearance.schedule.lightStart/darkStart are stored and read as).
 */
function openTimePopover(anchorEl, initialValue24h, onChange, onClose) {
  const existing = document.querySelector(".bc-time-popover");
  if (existing) existing.remove();

  const { h24: initH24, min: initMin } = parse24(initialValue24h);
  const initial12 = to12(initH24);
  let h12 = initial12.h12;
  let period = initial12.period;
  let minute = initMin;

  function emit() {
    onChange(format24(to24(h12, period), minute));
  }

  const pop = document.createElement("div");
  pop.className = "bc-time-popover";

  const spinners = document.createElement("div");
  spinners.className = "bc-tp-spinners";
  const hourSpin = buildSpinner(h12, { min: 1, max: 12 }, (v) => { h12 = v; emit(); });
  const minSpin = buildSpinner(minute, { min: 0, max: 59 }, (v) => { minute = v; emit(); });
  const colon = document.createElement("span");
  colon.className = "bc-tp-colon";
  colon.textContent = ":";
  spinners.appendChild(hourSpin.el);
  spinners.appendChild(colon);
  spinners.appendChild(minSpin.el);

  const ampm = document.createElement("div");
  ampm.className = "bc-tp-ampm";
  const ampmBtns = ["AM", "PM"].map((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `bc-tp-ampm-btn${period === p ? " bc-active" : ""}`;
    btn.textContent = p;
    btn.addEventListener("click", () => {
      period = p;
      ampmBtns.forEach((b) => b.classList.toggle("bc-active", b.textContent === period));
      emit();
    });
    ampm.appendChild(btn);
    return btn;
  });

  pop.appendChild(spinners);
  pop.appendChild(ampm);
  document.body.appendChild(pop);

  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;

  // Same reason as color-popover.js: keep interaction inside the popover
  // from ever bubbling to the document-level "click outside closes" listener.
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());

  function close() {
    document.removeEventListener("pointerdown", outsideHandler, true);
    document.removeEventListener("keydown", escHandler, true);
    pop.remove();
    if (onClose) onClose(format24(to24(h12, period), minute));
  }
  function outsideHandler(e) {
    if (pop.contains(e.target) || e.target === anchorEl) return;
    close();
  }
  function escHandler(e) {
    if (e.key === "Escape") close();
    else if (e.key === "Enter") close();
  }
  // Deferred so the same click that opened this popover doesn't immediately
  // count as an "outside" click and close it again.
  setTimeout(() => {
    document.addEventListener("pointerdown", outsideHandler, true);
    document.addEventListener("keydown", escHandler, true);
  }, 0);

  hourSpin.input.focus();
  hourSpin.input.select();

  return { close };
}

module.exports = { openTimePopover, formatTime12 };

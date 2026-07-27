/**
 * Small DOM builder helpers shared between panel.js and the new
 * ui/settings-panel/sections/*.js mixins. Extracted to their own module
 * (rather than left private to panel.js) so the section files can import
 * them without a circular require back into panel.js, which itself
 * requires the section modules to mix their render methods in.
 */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.forEach((c) => c && node.appendChild(c));
  return node;
}

function field(labelText, controlNode) {
  return el("label", { class: "bc-field" }, [
    el("span", { class: "bc-field-label", text: labelText }),
    controlNode,
  ]);
}

// A slider + live value label wired to call onInput(numericValue) on every
// input event. format(value) controls the label text.
function rangeField(labelText, { min, max, step = 1, value, format = (v) => String(v), onInput }) {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const label = el("span", { class: "bc-range-value", text: format(Number(value)) });
  input.addEventListener("input", () => {
    const num = Number(input.value);
    label.textContent = format(num);
    onInput(num);
  });
  return field(labelText, el("div", { class: "bc-range-row" }, [input, label]));
}

function selectField(labelText, options, value, onChange) {
  const select = el("select", {}, options.map((o) => el("option", { value: o.value, text: o.label })));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return field(labelText, select);
}

function toggleField(labelText, checked, onChange) {
  const input = el("input", { type: "checkbox" });
  input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked));
  return field(labelText, input);
}

function textField(labelText, value, onChange, { placeholder = "" } = {}) {
  const input = el("input", { type: "text", value: value || "", placeholder });
  input.addEventListener("change", () => onChange(input.value));
  return field(labelText, input);
}

module.exports = { el, field, rangeField, selectField, toggleField, textField };

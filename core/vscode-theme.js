/**
 * The active BetterClaude theme, as VS Code workbench colours — so the
 * full-IDE workbench (docs/ADR-0001-full-ide-workbench.md) matches the rest
 * of the app and follows theme changes live.
 *
 * Pure: a theme's --bc-* variables (tokens.extractThemeVars) in, and out
 *   { kind, colorTheme, colors, settings }
 * where colorTheme is VS Code's own dark or light base, colors goes into
 * workbench.colorCustomizations, and settings carries the editor fonts.
 * main.js pushes it to the workbench through the bridge extension
 * (electron/workbench-bridge), which applies it as user settings.
 */
const tokens = require("./tokens");

function mix(a, b, t) {
  const x = tokens.parseColor(a);
  const y = tokens.parseColor(b);
  if (!x || !y) return a;
  return tokens.toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/** #rrggbb + alpha as #rrggbbaa, the form VS Code's colour settings take. */
function withAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
  return `${hex.slice(0, 7)}${a}`;
}

function buildVSCodeTheme(vars = {}, { accent = "", codeFont = "", ligatures = true } = {}) {
  const opaque = (value, under, fallback) => tokens.resolveOpaqueColor(value || fallback, under) || fallback;
  const bg = opaque(vars["--bc-bg"], "#000000", "#262624");
  const dark = tokens.relativeLuminance(bg) < 0.4;
  const text = opaque(vars["--bc-text"], bg, dark ? "#faf9f5" : "#141413");
  const muted = opaque(vars["--bc-text-muted"], bg, mix(text, bg, 0.4));
  const sidebar = opaque(vars["--bc-bg-sidebar"], bg, mix(bg, dark ? "#000000" : "#ffffff", 0.2));
  const elevated = opaque(vars["--bc-bg-elevated"], bg, mix(bg, text, 0.06));
  const border = opaque(vars["--bc-border"], bg, mix(bg, text, 0.14));
  const acc = opaque(accent || vars["--bc-accent"], bg, "#d97757");
  const accFg = (tokens.pickButtonFg(acc) || {}).color || (dark ? "#111111" : "#ffffff");
  const danger = opaque(vars["--bc-danger"], bg, "#e5484d");
  const hover = mix(bg, text, 0.07);
  const selected = mix(bg, text, 0.12);

  const colors = {
    foreground: text,
    descriptionForeground: muted,
    disabledForeground: mix(muted, bg, 0.35),
    errorForeground: danger,
    focusBorder: withAlpha(acc, 0.7),
    "icon.foreground": muted,
    "widget.border": border,
    "widget.shadow": withAlpha("#000000", dark ? 0.36 : 0.16),
    "selection.background": withAlpha(acc, 0.35),
    "textLink.foreground": acc,
    "textLink.activeForeground": acc,
    "progressBar.background": acc,

    "titleBar.activeBackground": sidebar,
    "titleBar.inactiveBackground": sidebar,
    "titleBar.activeForeground": text,
    "titleBar.inactiveForeground": muted,
    "titleBar.border": border,
    "commandCenter.background": elevated,
    "commandCenter.border": border,
    "commandCenter.foreground": muted,

    "activityBar.background": sidebar,
    "activityBar.foreground": text,
    "activityBar.inactiveForeground": muted,
    "activityBar.border": border,
    "activityBar.activeBorder": acc,
    "activityBarBadge.background": acc,
    "activityBarBadge.foreground": accFg,

    "sideBar.background": sidebar,
    "sideBar.foreground": text,
    "sideBar.border": border,
    "sideBarTitle.foreground": muted,
    "sideBarSectionHeader.background": sidebar,
    "sideBarSectionHeader.foreground": muted,
    "sideBarSectionHeader.border": border,

    "editor.background": bg,
    "editor.foreground": text,
    "editorLineNumber.foreground": mix(muted, bg, 0.35),
    "editorLineNumber.activeForeground": text,
    "editor.lineHighlightBackground": withAlpha(text, 0.04),
    "editor.lineHighlightBorder": withAlpha(text, 0),
    "editor.selectionBackground": withAlpha(acc, 0.3),
    "editor.inactiveSelectionBackground": withAlpha(acc, 0.16),
    "editorCursor.foreground": acc,
    "editorIndentGuide.background1": withAlpha(text, 0.08),
    "editorIndentGuide.activeBackground1": withAlpha(text, 0.2),
    "editorWidget.background": elevated,
    "editorWidget.border": border,
    "editorGroup.border": border,
    "editorGroupHeader.tabsBackground": sidebar,
    "editorGroupHeader.tabsBorder": border,
    "breadcrumb.background": bg,
    "breadcrumb.foreground": muted,

    "tab.activeBackground": bg,
    "tab.activeForeground": text,
    "tab.inactiveBackground": sidebar,
    "tab.inactiveForeground": muted,
    "tab.border": border,
    "tab.activeBorderTop": acc,
    "tab.hoverBackground": hover,

    "panel.background": bg,
    "panel.border": border,
    "panelTitle.activeForeground": text,
    "panelTitle.inactiveForeground": muted,
    "panelTitle.activeBorder": acc,
    "terminal.background": bg,
    "terminal.foreground": text,
    "terminalCursor.foreground": acc,

    "statusBar.background": sidebar,
    "statusBar.foreground": muted,
    "statusBar.border": border,
    "statusBar.noFolderBackground": sidebar,
    "statusBar.debuggingBackground": acc,
    "statusBar.debuggingForeground": accFg,
    "statusBarItem.hoverBackground": hover,
    "statusBarItem.remoteBackground": sidebar,
    "statusBarItem.remoteForeground": muted,

    "list.hoverBackground": hover,
    "list.activeSelectionBackground": selected,
    "list.activeSelectionForeground": text,
    "list.inactiveSelectionBackground": hover,
    "list.focusOutline": withAlpha(acc, 0.7),
    "list.highlightForeground": acc,

    "input.background": elevated,
    "input.foreground": text,
    "input.border": border,
    "input.placeholderForeground": muted,
    "dropdown.background": elevated,
    "dropdown.foreground": text,
    "dropdown.border": border,
    "checkbox.background": elevated,
    "checkbox.border": border,

    "button.background": acc,
    "button.foreground": accFg,
    "button.hoverBackground": mix(acc, text, 0.14),
    "button.secondaryBackground": elevated,
    "button.secondaryForeground": text,
    "button.secondaryHoverBackground": hover,
    "badge.background": acc,
    "badge.foreground": accFg,

    "quickInput.background": elevated,
    "quickInput.foreground": text,
    "pickerGroup.foreground": muted,
    "menu.background": elevated,
    "menu.foreground": text,
    "menu.border": border,
    "menu.selectionBackground": selected,
    "notifications.background": elevated,
    "notifications.foreground": text,
    "notifications.border": border,
    "notificationCenterHeader.background": elevated,
    "banner.background": elevated,
    "banner.foreground": text,

    "scrollbarSlider.background": withAlpha(muted, 0.22),
    "scrollbarSlider.hoverBackground": withAlpha(muted, 0.34),
    "scrollbarSlider.activeBackground": withAlpha(muted, 0.46),
  };

  const settings = {};
  if (codeFont) {
    settings["editor.fontFamily"] = codeFont;
    settings["terminal.integrated.fontFamily"] = codeFont;
  }
  settings["editor.fontLigatures"] = !!ligatures;

  return { kind: dark ? "dark" : "light", colorTheme: dark ? "Default Dark Modern" : "Default Light Modern", colors, settings };
}

module.exports = { buildVSCodeTheme };

/**
 * Notifications — pure functions only, no DOM. The actual toast rendering
 * stays in electron/preload.js's existing notify() (shared with the plugin
 * API's api.notify()); this module decides WHETHER a notification should
 * show (per-category enable + Do Not Disturb) and what CSS class its style
 * variant maps to.
 */

// Which categories may bypass Do Not Disturb. achievement/update are the
// only two — cosmetic theme/plugin toasts never interrupt quiet hours.
const PRIORITY = {
  theme: false,
  plugin: false,
  achievement: true,
  update: true,
};

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Same wrap-past-midnight window logic as core/theme-engine.js's
// resolveScheduledTheme, applied to a Do Not Disturb window instead of a
// light/dark theme schedule.
function isWithinDnd(dnd, now = new Date()) {
  if (!dnd || !dnd.enabled) return false;
  const startMin = toMinutes(dnd.start);
  const endMin = toMinutes(dnd.end);
  if (startMin == null || endMin == null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return startMin > endMin
    ? (nowMin >= startMin || nowMin < endMin)
    : (nowMin >= startMin && nowMin < endMin);
}

// category: "theme" | "plugin" | "achievement" | "update"
function shouldSuppress(notifications, category, now = new Date()) {
  const types = (notifications && notifications.types) || {};
  const typeConfig = types[category];
  if (typeConfig && typeConfig.enabled === false) return true;
  const dnd = notifications && notifications.dnd;
  if (isWithinDnd(dnd, now) && !PRIORITY[category]) return true;
  return false;
}

function notificationStyleClass(style) {
  return { banner: "bc-toast-banner", popup: "bc-toast-popup", badge: "bc-toast-badge" }[style] || "bc-toast-banner";
}

module.exports = { PRIORITY, isWithinDnd, shouldSuppress, notificationStyleClass };

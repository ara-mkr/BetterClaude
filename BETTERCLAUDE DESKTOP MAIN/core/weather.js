/**
 * Weather-based theming — pure mapping only, no fetch here. The actual
 * network call happens in electron/main.js (an ipcMain handler to
 * Open-Meteo, keyless), for the same CSP reason themes:import-url already
 * fetches from the main process instead of the renderer: claude.ai's page
 * CSP governs what preload's own fetch() calls are allowed to reach.
 *
 * Maps a WMO weather code (as returned by Open-Meteo's `weathercode` field)
 * onto one of the existing Vibe Bundles (core/vibe-bundles.js) rather than
 * inventing a parallel weather-specific palette system.
 */

const { getBundle } = require("./vibe-bundles");

function mapWeatherCodeToBundleId(code, isDay = true) {
  if (code === 0) return isDay ? "y2k-vaporwave" : "midnight-tokyo"; // clear
  if (code >= 1 && code <= 3) return isDay ? "sakura-dream" : "midnight-tokyo"; // partly cloudy
  if (code === 45 || code === 48) return "brutalist-mono"; // fog
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "cottagecore-calm"; // drizzle/rain
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "midnight-tokyo"; // snow
  if (code >= 95) return "cyberpunk-pulse"; // thunderstorm
  return "cottagecore-calm";
}

function mapWeatherCodeToBundle(code, isDay = true) {
  return getBundle(mapWeatherCodeToBundleId(code, isDay));
}

module.exports = { mapWeatherCodeToBundleId, mapWeatherCodeToBundle };

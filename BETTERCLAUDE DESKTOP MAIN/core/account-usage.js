/**
 * Real Claude account usage — DOM-only, no Node/Electron APIs.
 *
 * Unlike core/token-counter.js (which estimates context-window usage by
 * scraping message text, because no such API exists), claude.ai's own web
 * client DOES call a real backend endpoint for plan-level rate limits —
 * it just doesn't render a persistent dashboard from it on most plans. This
 * fetches that same endpoint (same-origin, cookie session, nothing special)
 * so the numbers shown are the account's actual usage, not an estimate.
 *
 * Two calls: `/api/account` resolves the current organization uuid (small,
 * cheap — the alternative /edge-api/bootstrap payload is 500KB+), then
 * `/api/organizations/{uuid}/usage` returns the real "session" (rolling
 * 5-hour) and "weekly_all" rate-limit utilization straight from the backend.
 * The organization uuid doesn't change during a session, so it's cached
 * after the first successful lookup.
 */

let cachedOrgUuid = null;

async function getOrgUuid() {
  if (cachedOrgUuid) return cachedOrgUuid;
  const res = await fetch("/api/account", { credentials: "include" });
  if (!res.ok) throw new Error(`/api/account responded ${res.status}`);
  const data = await res.json();
  const uuid = data.memberships
    && data.memberships[0]
    && data.memberships[0].organization
    && data.memberships[0].organization.uuid;
  if (!uuid) throw new Error("/api/account response had no organization uuid");
  cachedOrgUuid = uuid;
  return uuid;
}

function findLimit(limits, kind) {
  const match = (limits || []).find((l) => l.kind === kind);
  if (!match) return null;
  return {
    percent: match.percent,
    resetsAt: match.resets_at,
    severity: match.severity,
    isActive: match.is_active,
  };
}

/** Returns { session, weekly } — either may be null if the account/plan
 *  doesn't expose that limit (e.g. no weekly cap on some tiers). */
async function fetchAccountUsage() {
  const org = await getOrgUuid();
  const res = await fetch(`/api/organizations/${org}/usage`, { credentials: "include" });
  if (!res.ok) throw new Error(`usage endpoint responded ${res.status}`);
  const data = await res.json();

  return {
    session: findLimit(data.limits, "session"),
    weekly: findLimit(data.limits, "weekly_all"),
  };
}

module.exports = { fetchAccountUsage, getOrgUuid };

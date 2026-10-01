/**
 * Team relay policy — decides which Team Hub messages reach which live
 * teammate, and when.
 *
 * electron/team-hub.js owns the files; electron/main.js owns the sessions and
 * the actual writes into them. This module sits between the two and holds no
 * fs, pty or Electron state, so scripts/audit.js can drive it headlessly.
 *
 * The rules it enforces:
 *
 *   - Only messages that appear while the app is running are relayed. Every
 *     message already in a hub when it is first loaded is `seed`ed as seen —
 *     otherwise the first hub change after a launch typed old messages
 *     (broadcasts especially) into live sessions.
 *   - The sender must be a teammate of this run (by id or name), or a message
 *     the app itself wrote for the user (`trust`). Anything else — a file a
 *     repo shipped, a stale teammate from an earlier run — is shown in the
 *     feed but never typed into a session.
 *   - Recipients resolve by id OR name ("Nova", "@nova"), plus the broadcast
 *     aliases. A message to nobody is marked undeliverable rather than
 *     silently dropped.
 *   - Delivery waits until the recipient is ready (the caller's `isReady`),
 *     queueing meanwhile. A recipient that comes back gets its queue.
 *   - Throttles: a per-sender rate cap, a ping-pong pause after N automatic
 *     hops between the same two agents, dedupe of identical bodies, and a
 *     per-recipient queue cap. The user's own messages bypass all of them.
 *   - Bodies are sanitised before they go anywhere near a terminal: control
 *     characters (ESC above all — it could close the bracketed paste and turn
 *     the rest into keystrokes) are stripped, and no line may pose as the
 *     delivery header.
 */

"use strict";

const BROADCAST_TARGETS = new Set(["all", "everyone", "team", "*", "@all", "@everyone", "@team"]);

const DEFAULT_LIMITS = {
  senderPerMinute: 6, // relays one agent can start per rolling minute
  pairLimit: 8, // automatic hops between the same two agents before a pause
  dedupeMs: 2 * 60 * 1000, // identical sender/recipient/body inside this window
  queueCap: 50, // per recipient; the oldest is dropped past this
  bodyMax: 4000, // characters of one message that are delivered
  batchMax: 6000, // characters delivered to one recipient in one go
};

function canonical(value) {
  return String(value == null ? "" : value).trim().replace(/^@/, "").toLowerCase();
}

function isBroadcast(value) {
  return BROADCAST_TARGETS.has(String(value == null ? "" : value).trim().toLowerCase());
}

/**
 * A member of `members` ({ id, name, aliases? }) by id first, then by its current
 * name, then by a name it used to have; null if none. The last step is for
 * renames: the agent still knows itself (and is known to its teammates, from
 * files they already read) by the old name, and a message signed with it must
 * not be dropped as unverified.
 */
function resolveMember(ref, members) {
  const key = canonical(ref);
  if (!key) return null;
  return members.find((m) => canonical(m.id) === key)
    || members.find((m) => canonical(m.name) === key)
    || members.find((m) => Array.isArray(m.aliases) && m.aliases.some((a) => canonical(a) === key))
    || null;
}

/**
 * The text of a message as it may be delivered: C0/C1 controls except tab and
 * newline removed (so no escape sequence survives), bidi overrides removed,
 * header look-alikes quoted, and the length capped.
 */
function sanitizeBody(body, max = DEFAULT_LIMITS.bodyMax) {
  let text = String(body == null ? "" : body).replace(/\r\n?/g, "\n");
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
  text = text.replace(/^(\s*)\[BetterClaude/gim, "$1> [BetterClaude");
  text = text.trim();
  if (text.length > max) text = `${text.slice(0, max).trimEnd()}…`;
  return text;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function createTeamRelay({ now = () => Date.now(), limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const hubs = new Map(); // hubKey -> { seen:Set, trusted:Set, status:Map<msgId, status> }
  const queues = new Map(); // memberId -> [item]
  const senderLog = new Map(); // senderId -> [{ msgId, at }]
  const pairs = new Map(); // pairKey -> { count, paused, noted }
  const recent = []; // [{ key, at }] — dedupe window
  const notes = []; // [{ id, hubKey, ts, text }]
  let seq = 0;

  function hubState(hubKey) {
    let state = hubs.get(hubKey);
    if (!state) {
      state = { seen: new Set(), trusted: new Set(), status: new Map() };
      hubs.set(hubKey, state);
    }
    return state;
  }

  function addNote(hubKey, text) {
    notes.push({ id: `note-${++seq}`, hubKey, ts: now(), text });
    if (notes.length > 100) notes.splice(0, notes.length - 100);
  }

  /**
   * Marks messages already on disk as seen — called whenever a hub is (re)loaded,
   * so whatever is there at that moment is history, never a delivery.
   */
  function seed(hubKey, ids) {
    const state = hubState(hubKey);
    let n = 0;
    for (const id of ids || []) {
      if (!state.seen.has(id)) { state.seen.add(id); n += 1; }
    }
    return n;
  }

  /** A message the app wrote on the user's behalf (sender "you"). */
  function trust(hubKey, id) {
    hubState(hubKey).trusted.add(id);
  }

  function setStatus(hubKey, msgId, patch) {
    const state = hubState(hubKey);
    const prev = state.status.get(msgId) || { state: "seen", recipients: [], delivered: [] };
    state.status.set(msgId, { ...prev, ...patch });
  }

  function enqueue(memberId, item) {
    let queue = queues.get(memberId);
    if (!queue) { queue = []; queues.set(memberId, queue); }
    queue.push(item);
    if (queue.length > L.queueCap) {
      const dropped = queue.shift();
      if (dropped.hubKey && dropped.msgId) setStatus(dropped.hubKey, dropped.msgId, { state: "dropped" });
      if (dropped.hubKey) addNote(dropped.hubKey, `Dropped an old queued message to ${item.toName || "a teammate"} — its queue was full.`);
    }
  }

  function isDuplicate(key) {
    const t = now();
    while (recent.length && t - recent[0].at > L.dedupeMs) recent.shift();
    if (recent.some((r) => r.key === key)) return true;
    recent.push({ key, at: t });
    if (recent.length > 500) recent.shift();
    return false;
  }

  /**
   * Considers every not-yet-seen message of one hub. `members` are the hub's
   * teammates in THIS run: [{ id, name, live }]. Returns how many were queued.
   */
  function observe(hubKey, messages, members) {
    const state = hubState(hubKey);
    let queued = 0;
    for (const msg of messages || []) {
      if (!msg || typeof msg.id !== "string" || state.seen.has(msg.id)) continue;
      state.seen.add(msg.id);

      const fromUser = msg.from === "you" && state.trusted.has(msg.id);
      const sender = fromUser ? null : resolveMember(msg.from, members);
      if (!fromUser && !sender) {
        setStatus(hubKey, msg.id, { state: "unverified" });
        continue;
      }
      const fromId = fromUser ? "you" : sender.id;

      let recipients;
      if (isBroadcast(msg.to)) {
        recipients = members.filter((m) => m.live && m.id !== fromId);
      } else {
        const target = resolveMember(msg.to, members);
        if (!target) {
          setStatus(hubKey, msg.id, { state: "undeliverable", why: `no teammate called “${String(msg.to).slice(0, 40)}”` });
          continue;
        }
        if (target.id === fromId) {
          setStatus(hubKey, msg.id, { state: "undeliverable", why: "addressed to its own sender" });
          continue;
        }
        recipients = [target];
      }

      const body = sanitizeBody(msg.body, L.bodyMax);
      if (!body) {
        setStatus(hubKey, msg.id, { state: "undeliverable", why: "empty" });
        continue;
      }
      // The user resending the same words is deliberate, never an echo loop.
      const fresh = fromUser ? recipients : recipients.filter((r) => !isDuplicate(`${fromId}>${r.id}>${body}`));
      if (!fresh.length) {
        setStatus(hubKey, msg.id, { state: recipients.length ? "duplicate" : "undeliverable", why: recipients.length ? undefined : "nobody else is on the team" });
        continue;
      }
      setStatus(hubKey, msg.id, { state: "queued", recipients: fresh.map((r) => r.id), delivered: [] });
      for (const r of fresh) {
        enqueue(r.id, {
          hubKey,
          msgId: msg.id,
          fromId,
          fromName: fromUser ? "the user" : sender.name,
          toName: r.name,
          // Goes into the delivery header, so letters only — never a control char.
          kind: String(msg.kind || "chat").replace(/[^A-Za-z_-]/g, "").slice(0, 16).toLowerCase() || "chat",
          body,
          user: fromUser,
          at: now(),
        });
        queued += 1;
      }
    }
    return queued;
  }

  /** A delivery that isn't a hub file — the join prompt, a status nudge. Always the user's. */
  function enqueueDirect(memberId, { body, kind = "system", fromName = "BetterClaude", hubKey = null }) {
    const text = sanitizeBody(body, Math.max(L.bodyMax, 12000));
    if (!text) return false;
    enqueue(memberId, { hubKey, msgId: null, fromId: "you", fromName, kind, body: text, user: true, at: now() });
    return true;
  }

  function senderAllowed(fromId, msgId, inBatch = []) {
    const t = now();
    const log = (senderLog.get(fromId) || []).filter((e) => t - e.at < 60 * 1000);
    senderLog.set(fromId, log);
    if (msgId && log.some((e) => e.msgId === msgId)) return true; // the rest of one broadcast
    // Items already picked for the batch being built count too — otherwise a
    // backlog from one sender all went out in a single paste.
    const ids = new Set(log.map((e) => e.msgId));
    for (const item of inBatch) if (item.fromId === fromId) ids.add(item.msgId || item);
    return ids.size < L.senderPerMinute;
  }

  function pairState(a, b) {
    const key = pairKey(a, b);
    let state = pairs.get(key);
    if (!state) { state = { count: 0, paused: false, noted: false }; pairs.set(key, state); }
    return state;
  }

  /** Why one queued item can't go out right now (null when it can). */
  function blockedBy(item, memberId, force, batch = []) {
    if (item.user || force) return null;
    const pair = pairState(item.fromId, memberId);
    if (pair.paused) return "paused";
    // The pair limit, too, counts what this batch already carries.
    if (pair.count + batch.filter((b) => !b.user && b.fromId === item.fromId).length >= L.pairLimit) return "paused";
    if (!senderAllowed(item.fromId, item.msgId, batch)) return "throttled";
    return null;
  }

  /**
   * Delivers what can be delivered. `isReady(memberId, force)` says whether a
   * member can take input now; `deliver(memberId, items)` performs the write and
   * returns true on success. `force` is a Set of member ids whose pause and
   * throttle are lifted for this pass (readiness still applies).
   */
  function flush({ isReady, deliver, force = new Set() } = {}) {
    let delivered = 0;
    for (const [memberId, queue] of queues) {
      if (!queue.length) continue;
      const forced = force.has(memberId);
      if (!isReady(memberId, forced)) continue;
      const batch = [];
      let size = 0;
      for (const item of queue) {
        if (blockedBy(item, memberId, forced, batch)) continue;
        if (batch.length && size + item.body.length > L.batchMax) break;
        batch.push(item);
        size += item.body.length;
      }
      if (!batch.length) continue;
      let ok = false;
      try { ok = !!deliver(memberId, batch); } catch { ok = false; }
      if (!ok) continue;
      const t = now();
      for (const item of batch) {
        queue.splice(queue.indexOf(item), 1);
        delivered += 1;
        if (item.hubKey && item.msgId) {
          const status = hubState(item.hubKey).status.get(item.msgId) || { recipients: [], delivered: [] };
          const done = [...new Set([...(status.delivered || []), memberId])];
          const all = (status.recipients || []).every((id) => done.includes(id));
          setStatus(item.hubKey, item.msgId, { delivered: done, state: all ? "delivered" : "queued" });
        }
        if (item.user) {
          // The user speaking to a teammate is the "someone's watching" signal
          // that re-opens any paused back-and-forth involving it.
          userActed(memberId);
          continue;
        }
        const log = senderLog.get(item.fromId) || [];
        log.push({ msgId: item.msgId || `direct-${t}`, at: t });
        senderLog.set(item.fromId, log);
        const pair = pairState(item.fromId, memberId);
        pair.count += 1;
        if (pair.count >= L.pairLimit && !pair.paused) {
          pair.paused = true;
          if (!pair.noted && item.hubKey) {
            pair.noted = true;
            addNote(item.hubKey, `Paused the automatic back-and-forth between ${item.fromName} and ${item.toName || "a teammate"} after ${pair.count} messages. Message either of them, or press Resume on their card, to let it continue.`);
          }
        }
      }
      if (!queue.length) queues.delete(memberId);
    }
    return { delivered };
  }

  /** The user did something with this member (typed to it, messaged it): re-open its pairs. */
  function userActed(memberId) {
    for (const [key, state] of pairs) {
      if (key.split("|").includes(memberId)) {
        state.count = 0;
        state.paused = false;
        state.noted = false;
      }
    }
  }

  /** A member left for good: whatever was queued for it can never arrive. */
  function forget(memberId) {
    const queue = queues.get(memberId) || [];
    queues.delete(memberId);
    for (const item of queue) {
      if (item.hubKey && item.msgId) setStatus(item.hubKey, item.msgId, { state: "undeliverable", why: `${item.toName || "the teammate"} left` });
    }
    userActed(memberId);
    return queue.length;
  }

  /** What is waiting for one member, and how much of it is paused. */
  function pending(memberId) {
    const queue = queues.get(memberId) || [];
    const paused = queue.filter((item) => !item.user && pairState(item.fromId, memberId).paused).length;
    return { count: queue.length, paused };
  }

  function hasQueued() {
    for (const queue of queues.values()) if (queue.length) return true;
    return false;
  }

  function statusOf(hubKey, msgId) {
    const state = hubs.get(hubKey);
    return state ? state.status.get(msgId) || null : null;
  }

  function notesFor(hubKey) {
    return notes.filter((n) => n.hubKey === hubKey);
  }

  return { seed, trust, observe, enqueueDirect, flush, userActed, forget, pending, hasQueued, statusOf, notesFor };
}

module.exports = {
  BROADCAST_TARGETS,
  DEFAULT_LIMITS,
  createTeamRelay,
  isBroadcast,
  resolveMember,
  sanitizeBody,
};

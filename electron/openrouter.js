/**
 * Free-model fallback for the Code workspace chat.
 *
 * When the Claude subscription runs dry (usage limit, rate limit, credit
 * errors) BetterClaude can keep going on models that cost nothing right now:
 *
 *   1. The OpenRouter free tier. The model list at
 *      https://openrouter.ai/api/v1/models is public — no account needed to
 *      read it, which is how this module "scrapes" it: every entry whose
 *      pricing is 0/0 (or whose id ends in `:free`) is currently free. That
 *      list changes constantly (a stealth drop like `stealth/ox-alpha` can
 *      appear and vanish within days), so it is fetched fresh and cached for
 *      a few minutes rather than ever being hardcoded here.
 *   2. A keyless fallback endpoint for the no-login case. OpenRouter itself
 *      always requires an API key to run inference — listing models is free,
 *      generating through it is not. So the chain ends with Pollinations'
 *      anonymous OpenAI-compatible endpoint, which genuinely needs no signup,
 *      guaranteeing "continue automatically with the next free provider" does
 *      not silently dead-end into 401s when the user has logged in nowhere.
 *
 * An optional stored OpenRouter key upgrades step 1 from "may work" to
 * "works"; without one the request is still attempted keyless-first so a
 * future/changed OpenRouter policy that permits anonymous free-tier calls
 * keeps working with zero code change.
 *
 * Main-process only (network + persistence of nothing beyond what callers
 * keep). Every function is stateless except the short-lived model cache.
 */

const FREE_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
// Short enough that a model going away (or a stealth drop appearing) shows up
// within one coffee break rather than ten minutes; the picker also passes
// `force` on an explicit refresh, which ignores this entirely.
const CACHE_TTL_MS = 3 * 60 * 1000;

/**
 * Providers that need no account at all. Tried last, after every OpenRouter
 * candidate has been exhausted, so they are the safety net rather than the
 * headline.
 *
 * Local Ollama comes first among these: genuinely free, genuinely no-login,
 * OpenAI-compatible at /v1, and detected live (its model list is read from
 * the local server; nothing is included when it isn't running). Pollinations
 * stays as a last-ditch remote entry even though its anonymous tier has been
 * shrinking — if it works for you, it costs nothing.
 */
const KEYLESS_PROVIDERS = [
  {
    id: "keyless:pollinations-openai",
    displayName: "Pollinations · GPT class (best effort)",
    provider: "Pollinations",
    endpoint: "https://gen.pollinations.ai/v1/chat/completions",
    model: "openai",
    // As of 2026-09-26 its anonymous tier mostly answers 401 or a credits
    // notice; kept as the last, best-effort rung — Ollama and OpenRouter
    // (with a free key) are the dependable free options.
    description: "Anonymous OpenAI-compatible endpoint. Best effort — often asks for an account now.",
    keyless: true,
  },
];

// OLLAMA_HOST is often written without a scheme ("0.0.0.0:11434", Ollama's
// own docs do this), which is not a URL fetch() accepts.
const OLLAMA_BASE = (() => {
  const raw = String(process.env.OLLAMA_HOST || "").trim().replace(/\/+$/, "");
  if (!raw) return "http://127.0.0.1:11434";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace("//0.0.0.0", "//127.0.0.1");
})();
// Per-attempt stall limit: one stalled provider must not hang the whole chain
// until the user presses Stop. It's the longest wait for the first sign of
// life and between stream events — not a cap on the whole answer, which cut
// long (still streaming) replies off and rotated them away.
const ATTEMPT_IDLE_MS = 60000;
// An unstreamed reply sends no events to reset that watchdog, so for those the
// limit covers the whole answer and has to be a generous one.
const UNSTREAMED_ATTEMPT_MS = 180000;
const BILLING_NOTICE_RE = /(valid api key is required|doesn'?t have enough credits|top[- ]?up|enter\.pollinations\.ai|insufficient (credits|balance))/i;
// Keeps a fallback turn inside small free-model context windows.
const HISTORY_CHAR_BUDGET = 24000;
const ATTACHMENT_BUDGET_CHARS = 200000;
// OpenRouter asks apps to identify themselves; optional, but it also puts
// requests under the app's own rate-limit bucket.
const OPENROUTER_APP_HEADERS = { "http-referer": "https://github.com/ara-mkr/betterclaude", "x-title": "BetterClaude" };
let ollamaCache = { models: null, fetchedAt: 0 };

/**
 * Text-generation models on a locally running Ollama, exposed as keyless
 * candidates. Fails soft: no server, no models, empty list.
 */
async function fetchOllamaModels() {
  if (ollamaCache.models && Date.now() - ollamaCache.fetchedAt < 60000) return ollamaCache.models;
  let models = [];
  try {
    const response = await fetch(`${OLLAMA_BASE}/v1/models`, {
      signal: AbortSignal.timeout(2500),
      headers: { accept: "application/json" },
    });
    if (response.ok) {
      const json = await response.json();
      models = (Array.isArray(json && json.data) ? json.data : [])
        .filter((model) => model && typeof model.id === "string" && !/embed/i.test(model.id))
        .slice(0, 5)
        .map((model) => ({
          kind: "ollama",
          id: `ollama:${model.id}`,
          displayName: `${model.id} (local)`,
          provider: "Ollama",
          contextLength: null,
          description: "Running locally via Ollama. Free, private, no login.",
          keyless: true,
          endpoint: `${OLLAMA_BASE}/v1/chat/completions`,
          model: model.id,
        }));
    }
  } catch {
    models = [];
  }
  ollamaCache = { models, fetchedAt: Date.now() };
  return models;
}

let cache = { models: null, fetchedAt: 0 };

/**
 * True when an OpenRouter entry costs nothing right now. Two shapes exist in
 * the wild: explicit `:free` ids and zero-priced entries (which is what
 * stealth drops like ox-alpha ship as), so both are accepted.
 */
function isFreePricing(model) {
  const pricing = model && model.pricing;
  if (!pricing) return false;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const prompt = num(pricing.prompt);
  const completion = num(pricing.completion);
  if (!Number.isNaN(prompt) && !Number.isNaN(completion)) return prompt === 0 && completion === 0;
  return false;
}

/** Splits "vendor/model-name" into its provider half for display/grouping. */
function providerOf(id) {
  const slash = String(id || "").indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "other";
}

function prettifyProvider(slug) {
  return String(slug || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Other";
}

async function fetchFreeModels({ force = false } = {}) {
  if (!force && cache.models && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  const response = await fetch(FREE_MODELS_URL, {
    headers: { accept: "application/json", "user-agent": "BetterClaude" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
  const json = await response.json();
  const entries = Array.isArray(json && json.data) ? json.data : [];
  const models = entries
    .filter((model) => model && typeof model.id === "string" && (isFreePricing(model) || /:free$/.test(model.id)))
    // Chat models only: the free list also carries music/image generators
    // (e.g. google/lyria-*) that can't answer a coding question.
    .filter((model) => {
      const out = model.architecture && model.architecture.output_modalities;
      return !Array.isArray(out) || (out.length === 1 && out[0] === "text");
    })
    .map((model) => ({
      kind: "openrouter",
      id: model.id,
      displayName: (model.name || model.id).replace(/\s*\(free\)\s*$/i, ""),
      provider: prettifyProvider(providerOf(model.id)),
      contextLength: Number(model.context_length) || null,
      description: typeof model.description === "string" ? model.description.slice(0, 240) : "",
      // OpenRouter's inference endpoint always wants an API key (a free one
      // is enough) — listing is public, generating is not. The picker says so.
      needsKey: true,
    }))
    // Longest context first: when someone is about to paste a whole project,
    // the models that can hold it are the useful ones to show first.
    .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  cache = { models, fetchedAt: Date.now() };
  return models;
}

/** The full picker list: scraped free models, then keyless options. */
async function listPickableModels({ force = false } = {}) {
  let openRouter = [];
  try {
    openRouter = await fetchFreeModels({ force });
  } catch {
    // Listing failed (offline, blocked): the keyless providers still stand alone.
  }
  const ollama = await fetchOllamaModels();
  return [...openRouter, ...ollama, ...KEYLESS_PROVIDERS.map((entry) => ({ ...entry }))].map((model) => ({ ...model, free: true }));
}

/**
 * Ordered failover candidates: the user's preferred model leads, then the
 * remaining OpenRouter free models, then the keyless providers.
 */
function buildFailoverChain(models, preferredModelId) {
  const preferred = preferredModelId ? models.filter((m) => m.id === preferredModelId) : [];
  const rest = models.filter((m) => m.id !== preferredModelId);
  return [...preferred, ...rest];
}

/**
 * Errors worth rotating on. 401/403 rotate too: without a stored key every
 * OpenRouter candidate will say this, and the chain's job is to land on the
 * keyless providers instead of stopping there.
 */
function shouldRotate(status) {
  return status == null || status === 401 || status === 402 || status === 403 || status === 408 || status === 429 || status >= 500;
}

function describeStatus(status) {
  switch (status) {
    case 401:
    case 403:
      return "needs authentication";
    case 402:
      return "out of credits / usage-capped";
    case 429:
      return "rate-limited";
    default:
      return status ? `error ${status}` : "unreachable";
  }
}

async function readSseStream(response, onDelta, signal, onActivity = () => {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    if (signal && signal.aborted) {
      try { await reader.cancel(); } catch {}
      throw new Error("stopped");
    }
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal && signal.aborted) throw new Error("stopped");
      throw err;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        // Any real event counts as progress (reasoning tokens included);
        // ": keep-alive" comment lines never reach here, so a provider that
        // only sends those still times out.
        onActivity();
        const choice = parsed.choices && parsed.choices[0];
        const delta = choice && choice.delta;
        const piece = (delta && typeof delta.content === "string" && delta.content)
          || (choice && choice.message && typeof choice.message.content === "string" && choice.message.content)
          || "";
        if (piece) {
          text += piece;
          onDelta(piece);
        }
        if (parsed.error && parsed.error.message) throw new Error(parsed.error.message);
      } catch (err) {
        if (err instanceof SyntaxError) continue; // partial line
        throw err;
      }
    }
  }
  return text;
}

/**
 * One chat attempt against one OpenAI-compatible endpoint.
 * Resolves with the full text or throws { status, message }.
 *
 * `stream: true` consumes SSE deltas; `false` reads one JSON response and
 * emits it as a single delta. The split exists because some anonymous tiers
 * (Pollinations') permit plain completions but reject streaming without an
 * API key — hosted keyless candidates therefore run unstreamed.
 */
async function runChatAttempt({ endpoint, headers, body, stream, onDelta, signal, onActivity }) {
  // stream:false is OMITTED rather than sent as an explicit false: some
  // anonymous tiers (Pollinations') treat any stream field at all — even
  // false — as the streaming/authenticated path and 401 it.
  const payload = stream ? { ...body, stream: true } : { ...body };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", "user-agent": "BetterClaude", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = await response.json();
      detail = (parsed.error && (parsed.error.message || parsed.error.code)) || "";
    } catch {
      detail = response.statusText || "";
    }
    const err = new Error(detail || describeStatus(response.status));
    err.status = response.status;
    throw err;
  }
  if (!stream) {
    const parsed = await response.json();
    const choice = parsed && parsed.choices && parsed.choices[0];
    const text = (choice && choice.message && typeof choice.message.content === "string" && choice.message.content)
      || (typeof parsed === "string" ? parsed : "");
    // Some anonymous tiers answer 200 with their billing notice AS the reply
    // ("…doesn't have enough credits. Please top up…", "A valid API key is
    // required…") — seen live from Pollinations on 2026-09-26. Treat that as
    // the failure it is so the chain moves on instead of showing it as an answer.
    if (BILLING_NOTICE_RE.test(text) && text.length < 600) {
      const err = new Error("provider wants an account / credits");
      err.status = 402;
      throw err;
    }
    if (text) onDelta(text);
    return text;
  }
  return readSseStream(response, onDelta, signal, onActivity);
}

/**
 * The OpenAI-style message list for one turn. `history` is the conversation
 * so far ({role:"user"|"assistant", text}), newest last — without it every
 * follow-up (and every mid-conversation failover from Claude) started from a
 * blank slate. Trimmed from the oldest end to fit small free context windows.
 */
function buildMessages({ prompt, attachments = [], projectName, history = [] }) {
  const parts = [prompt.trim()];
  let attached = 0;
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (file && typeof file.path === "string" && typeof file.content === "string") {
      const part = `\n\n--- ${file.path} ---\n${file.content}`;
      if (attached + part.length > ATTACHMENT_BUDGET_CHARS) break;
      parts.push(part);
      attached += part.length;
    }
  }
  const prior = [];
  let budget = HISTORY_CHAR_BUDGET;
  for (let i = (Array.isArray(history) ? history.length : 0) - 1; i >= 0 && budget > 0; i -= 1) {
    const turn = history[i];
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string" || !turn.text.trim()) continue;
    const text = turn.text.length > budget ? `…${turn.text.slice(-budget)}` : turn.text;
    budget -= text.length;
    prior.unshift({ role: turn.role, content: text });
  }
  // Providers reject two same-role messages in a row; merge any run.
  const merged = [];
  for (const message of prior) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content += `\n\n${message.content}`;
    else merged.push({ ...message });
  }
  if (merged.length && merged[merged.length - 1].role === "user") merged.pop();
  return [
    {
      role: "system",
      content: [
        "You are assisting inside BetterClaude's Code workspace, an IDE around the Claude Code CLI.",
        projectName ? `The active project folder is "${projectName}".` : "",
        "Answer directly and concretely; prefer short code blocks over prose when proposing changes.",
        "You are a fallback model running because the primary Claude subscription was unavailable - just answer well.",
      ].filter(Boolean).join(" "),
    },
    ...merged,
    { role: "user", content: parts.join("") },
  ];
}

/**
 * Runs the whole free chain for one user turn.
 *
 * @param {object} opts
 * @param {Array<{path:string,content:string}>} opts.attachments
 * @param {string|null} opts.preferredModelId   Picker selection, if any.
 * @param {string} opts.openRouterKey           Optional stored key ("").
 * @param {Function} opts.onEvent               Chat-event sink ({type,...}).
 * @param {AbortSignal} opts.signal             Stop button.
 * @returns {{ text: string, modelId: string }} The winning model + full text.
 */
async function runFreeChat({ prompt, attachments, history = [], projectName, preferredModelId, openRouterKey, onEvent, signal }) {
  const models = await fetchFreeModels().catch(() => []);
  const ollama = await fetchOllamaModels();
  // Local models lead the keyless tail: they are the only ones that work with
  // zero accounts and zero network. Pollinations trails as best-effort.
  const chain = buildFailoverChain([...models, ...ollama, ...KEYLESS_PROVIDERS], preferredModelId);
  if (!chain.length) throw new Error("No free models are available right now.");

  const messages = buildMessages({ prompt, attachments, projectName, history });
  const failures = [];
  // OpenRouter's inference endpoint always demands a key (verified: keyless
  // calls get 401 "No cookie auth credentials found"). With no key stored, or
  // once the stored key is rejected or the account's daily free cap is hit,
  // every remaining OpenRouter candidate would fail the same way — skip them
  // and go straight to the keyless tail instead of knocking on ~20 doors.
  let openRouterUsable = !!openRouterKey;
  if (!openRouterUsable && chain.some((c) => c.kind === "openrouter")) {
    onEvent({ type: "note", text: "OpenRouter's free models need a free API key (add one in the model menu) — using no-login providers." });
  }
  let streamedSomething = false;

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (signal && signal.aborted) throw new Error("stopped");
    if (candidate.kind === "openrouter" && !openRouterUsable) {
      failures.push({ id: candidate.id, reason: openRouterKey ? "skipped (key rejected or capped)" : "needs a free API key" });
      continue;
    }
    const label = candidate.displayName || candidate.id;
    // A previous provider may have streamed half an answer before failing;
    // the renderer discards it so two models' text never splice together.
    if (streamedSomething) onEvent({ type: "reset" });
    streamedSomething = false;
    onEvent({
      type: "model-switch",
      modelId: candidate.id,
      modelLabel: label,
      keyless: !!candidate.keyless,
      attempt: index + 1,
      total: chain.length,
      failuresSoFar: failures.slice(),
    });

    // Deliberately NO Authorization header when no key is stored: the request
    // goes out login-free, exactly as advertised. If OpenRouter still demands
    // credentials the 401 simply rotates to the next candidate.
    const headers = {};
    if (candidate.kind === "openrouter") {
      Object.assign(headers, OPENROUTER_APP_HEADERS);
      headers.authorization = `Bearer ${openRouterKey}`;
    }

    // OpenRouter and a local Ollama stream (SSE); the hosted keyless tiers run
    // unstreamed because they reject streaming without an account. Ollama
    // must stream: unstreamed, nothing resets the stall watchdog, so any
    // local answer longer than ATTEMPT_IDLE_MS was cut off and rotated away.
    const stream = candidate.kind === "openrouter" || candidate.kind === "ollama";
    const body = { model: candidate.kind === "openrouter" ? candidate.id : candidate.model, messages };
    const endpoint = candidate.kind === "openrouter" ? OPENROUTER_CHAT_URL : candidate.endpoint;

    // This attempt's own abort: the user's Stop, or the stall watchdog (reset
    // by every stream event). Kept apart so a stall rotates to the next
    // provider instead of reading as Stop and ending the whole chain.
    const attempt = new AbortController();
    let stalled = false;
    let watchdog = null;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; attempt.abort(); }, stream ? ATTEMPT_IDLE_MS : UNSTREAMED_ATTEMPT_MS);
    };
    const onStop = () => attempt.abort();
    if (signal) signal.addEventListener("abort", onStop, { once: true });
    armWatchdog();
    try {
      const text = await runChatAttempt({
        endpoint,
        headers,
        body,
        stream,
        onDelta: (piece) => { streamedSomething = true; onEvent({ type: "delta", text: piece }); },
        onActivity: armWatchdog,
        signal: attempt.signal,
      });
      if (!text.trim()) throw Object.assign(new Error("empty response"), { status: null });
      return { text, modelId: candidate.id, modelLabel: label };
    } catch (err) {
      if (signal && signal.aborted) throw new Error("stopped");
      const timedOut = stalled || (err && err.name === "TimeoutError");
      if (!timedOut && err.message === "stopped") throw new Error("stopped");
      const reason = timedOut ? "timed out" : err.status != null ? describeStatus(err.status) : err.message;
      failures.push({ id: candidate.id, reason });
      // Key-wide failures end OpenRouter for this turn: a rejected key, or
      // the account's daily free-model cap (429 mentioning the free tier /
      // per-day limit) — not just this one model being busy.
      if (candidate.kind === "openrouter" && (err.status === 401 || err.status === 403
        || (err.status === 429 && /free|per.?day|daily/i.test(String(err.message || ""))))) {
        openRouterUsable = false;
      }
      if (err.status != null && !shouldRotate(err.status)) {
        // A hard non-rotating failure (400 bad request, 404 unknown model):
        // rotating cannot help THIS candidate class, but later candidates may
        // still differ, so record and move on regardless.
        onEvent({ type: "diagnostic", message: `${label}: ${reason} — trying the next free provider` });
        continue;
      }
      onEvent({ type: "diagnostic", message: `${label}: ${reason} — trying the next free provider` });
    } finally {
      clearTimeout(watchdog);
      if (signal) signal.removeEventListener("abort", onStop);
    }
  }

  // One entry per distinct reason, not per model: with no key stored, twenty-
  // odd OpenRouter models each "need a free API key" and that list buried the
  // one thing the user has to do.
  const byReason = new Map();
  failures.forEach((f) => {
    if (!byReason.has(f.reason)) byReason.set(f.reason, []);
    byReason.get(f.reason).push(f.id);
  });
  const summary = Array.from(byReason, ([reason, ids]) => (ids.length > 2 ? `${ids.length} models: ${reason}` : `${ids.join(", ")}: ${reason}`)).join("; ");
  const advice = openRouterKey
    ? "Free models are often busy — try again in a bit, or install Ollama for a local fallback."
    : "Add a free OpenRouter key in the model menu (openrouter.ai/keys), or install Ollama for a no-login local fallback.";
  throw Object.assign(new Error(`No free model answered${summary ? ` (${summary})` : ""}. ${advice}`), {
    code: openRouterKey ? "free-failed" : "free-needs-key",
  });
}

module.exports = {
  KEYLESS_PROVIDERS,
  buildFailoverChain,
  fetchFreeModels,
  listPickableModels,
  runFreeChat,
};

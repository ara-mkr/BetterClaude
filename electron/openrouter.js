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
const CACHE_TTL_MS = 10 * 60 * 1000;

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
    description: "Anonymous OpenAI-compatible endpoint. No account, heavily rate-limited.",
    keyless: true,
  },
];

const OLLAMA_BASE = (process.env.OLLAMA_HOST || "").replace(/\/+$/, "") || "http://127.0.0.1:11434";
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
        .filter((model) => model && typeof model.id === "string")
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
    .filter((model) => isFreePricing(model))
    .map((model) => ({
      kind: "openrouter",
      id: model.id,
      displayName: (model.name || model.id).replace(/\s*\(free\)\s*$/i, ""),
      provider: prettifyProvider(providerOf(model.id)),
      contextLength: Number(model.context_length) || null,
      description: typeof model.description === "string" ? model.description.slice(0, 240) : "",
    }))
    // Longest context first: when someone is about to paste a whole project,
    // the models that can hold it are the useful ones to show first.
    .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  cache = { models, fetchedAt: Date.now() };
  return models;
}

/** The full picker list: scraped free models, then keyless options. */
async function listPickableModels() {
  let openRouter = [];
  try {
    openRouter = await fetchFreeModels();
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

async function readSseStream(response, onDelta, signal) {
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
 * API key — keyless candidates therefore run unstreamed.
 */
async function runChatAttempt({ endpoint, headers, body, stream, onDelta, signal }) {
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
    if (text) onDelta(text);
    return text;
  }
  return readSseStream(response, onDelta, signal);
}

function buildMessages({ prompt, attachments = [], projectName }) {
  const parts = [prompt.trim()];
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (file && typeof file.path === "string" && typeof file.content === "string") {
      parts.push(`\n\n--- ${file.path} ---\n${file.content}`);
    }
  }
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
async function runFreeChat({ prompt, attachments, projectName, preferredModelId, openRouterKey, onEvent, signal }) {
  const models = await fetchFreeModels().catch(() => []);
  const ollama = await fetchOllamaModels();
  // Local models lead the keyless tail: they are the only ones that work with
  // zero accounts and zero network. Pollinations trails as best-effort.
  const chain = buildFailoverChain([...models, ...ollama, ...KEYLESS_PROVIDERS], preferredModelId);
  if (!chain.length) throw new Error("No free models are available right now.");

  const messages = buildMessages({ prompt, attachments, projectName });
  const failures = [];
  // Without a stored key every OpenRouter candidate will answer 401 — its
  // inference endpoint always demands credentials, unlike its public catalog.
  // After three consecutive auth rejections from OpenRouter candidates, skip
  // straight to the keyless providers rather than knocking on twenty-odd more
  // doors that are all locked for the same reason.
  let consecutiveAuthFailures = 0;

  for (let index = 0; index < chain.length; index += 1) {
    const candidate = chain[index];
    if (signal && signal.aborted) throw new Error("stopped");
    const noKeyStored = candidate.kind === "openrouter" && !openRouterKey;
    if (noKeyStored && consecutiveAuthFailures >= 3) {
      failures.push({ id: candidate.id, reason: describeStatus(401) });
      continue;
    }
    const label = candidate.displayName || candidate.id;
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
    if (candidate.kind === "openrouter" && openRouterKey) {
      headers.authorization = `Bearer ${openRouterKey}`;
    }

    // OpenRouter streams (SSE); keyless providers run unstreamed because
    // their anonymous tiers reject streaming without an account.
    const stream = candidate.kind === "openrouter";
    const body = { model: candidate.kind === "openrouter" ? candidate.id : candidate.model, messages };
    const endpoint = candidate.kind === "openrouter" ? OPENROUTER_CHAT_URL : candidate.endpoint;

    try {
      const text = await runChatAttempt({
        endpoint,
        headers,
        body,
        stream,
        onDelta: (piece) => onEvent({ type: "delta", text: piece }),
        signal,
      });
      if (!text.trim()) throw Object.assign(new Error("empty response"), { status: null });
      return { text, modelId: candidate.id, modelLabel: label };
    } catch (err) {
      if ((signal && signal.aborted) || err.message === "stopped") throw new Error("stopped");
      const reason = err.status != null ? describeStatus(err.status) : err.message;
      failures.push({ id: candidate.id, reason });
      consecutiveAuthFailures = err.status === 401 || err.status === 403 ? consecutiveAuthFailures + 1 : 0;
      if (err.status != null && !shouldRotate(err.status)) {
        // A hard non-rotating failure (400 bad request, 404 unknown model):
        // rotating cannot help THIS candidate class, but later candidates may
        // still differ, so record and move on regardless.
        onEvent({ type: "diagnostic", message: `${label}: ${reason} — trying the next free provider` });
        continue;
      }
      onEvent({ type: "diagnostic", message: `${label}: ${reason} — trying the next free provider` });
    }
  }

  const summary = failures.map((f) => `${f.id}: ${f.reason}`).join("; ");
  throw new Error(
    "Every free provider was tried and none answered." +
    (summary ? ` (${summary})` : "") +
    " OpenRouter's free models need a free API key — paste one in the model picker. " +
    "Or install Ollama for a no-login local fallback, and try again."
  );
}

module.exports = {
  KEYLESS_PROVIDERS,
  buildFailoverChain,
  fetchFreeModels,
  listPickableModels,
  runFreeChat,
};

// Per-token prices for the token usage page, from LiteLLM's public model list. Only the direct-provider entries and the
// four rates a cost needs are kept on disk. Costs are what the tokens would cost on the API, not a subscription's bill.
const fs = require("node:fs");
const path = require("node:path");

const PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const REFRESH_MS = 24 * 3_600_000;
// After a failed fetch, wait this long before trying again.
const RETRY_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

const rate = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** The rates of each model LiteLLM prices per token, keyed by its plain name (no provider prefix). */
function slimPrices(catalog) {
  const models = {};
  for (const [name, entry] of Object.entries(catalog ?? {})) {
    if (name.includes("/") || !entry || typeof entry !== "object") continue;
    const input = rate(entry.input_cost_per_token);
    const output = rate(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    models[name] = {
      input,
      output,
      cacheRead: rate(entry.cache_read_input_token_cost) ?? input,
      cacheWrite: rate(entry.cache_creation_input_token_cost) ?? input,
    };
  }
  return models;
}

/** A model name as transcripts write it, matched to a priced one: exact, then without a date suffix or provider prefix. */
function priceOf(models, model) {
  if (!models || !model) return null;
  if (models[model]) return models[model];
  const bare = model.replace(/^.*[/.](?=claude-|gpt-|o\d)/, "");
  if (models[bare]) return models[bare];
  const undated = bare.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return models[undated] ?? null;
}

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.fetchedAt === "string" && parsed.models && typeof parsed.models === "object") return parsed;
  } catch {}
  return null;
}

/**
 * The price list, read from its file and refreshed from LiteLLM at most once a day. `current()` never waits on the
 * network: it returns what is known and starts a refresh when the list is old.
 */
function createTokenPricing({ file, fetchCatalog, now = Date.now, onChange = () => {} }) {
  let saved = file ? load(file) : null;
  let refreshing = null;
  let failedAt = -Infinity;

  const download =
    fetchCatalog ??
    (async () => {
      const response = await fetch(PRICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`LiteLLM's price list answered ${response.status}`);
      return response.json();
    });

  async function refresh() {
    try {
      const models = slimPrices(await download());
      if (Object.keys(models).length === 0) throw new Error("LiteLLM's price list had no models");
      saved = { fetchedAt: new Date(now()).toISOString(), models };
      if (file) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(saved));
        await fs.promises.rename(`${file}.tmp`, file);
      }
      onChange();
    } catch (error) {
      failedAt = now();
      console.warn("Milagre couldn't refresh model prices:", error.message);
    }
  }

  function stale() {
    if (refreshing || now() - failedAt < RETRY_MS) return false;
    return !saved || now() - Date.parse(saved.fetchedAt) > REFRESH_MS;
  }

  return {
    current() {
      if (stale()) {
        refreshing = refresh().finally(() => {
          refreshing = null;
        });
      }
      return saved;
    },
    /** Waits for a refresh in flight (tests, quitting). */
    idle: () => refreshing ?? Promise.resolve(),
    status() {
      if (!saved) return { status: refreshing ? "loading" : "unavailable" };
      return { status: now() - Date.parse(saved.fetchedAt) > 2 * REFRESH_MS ? "stale" : "ok", fetchedAt: saved.fetchedAt };
    },
  };
}

module.exports = { createTokenPricing, priceOf, slimPrices };

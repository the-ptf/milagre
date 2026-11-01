const { spawnCommand } = require("./agents/command.cjs");
const { resolveExecutable } = require("./agents/environment.cjs");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createUsageStore, cachedSnapshot } = require("./usage-cache.cjs");
const { readAntigravityUsage } = require("./antigravity-usage.cjs");

const PROVIDER_TIMEOUT_MS = 10_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_EXPIRED = "Claude sign-in expired. Running any Claude agent refreshes it.";
const SESSION = { id: "session", label: "Session", shortLabel: "5h" };
const WEEKLY = { id: "weekly", label: "Weekly", shortLabel: "wk" };
const RATE_LIMITED = "Claude is rate limiting usage checks.";
const DEFAULT_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;
const CLAUDE_RANK = { session: 0, weekly: 1 };

/**
 * @typedef {object} ProviderUsage
 * @property {string} provider
 * @property {"ok"|"error"|"unavailable"} status
 * @property {object[]} windows
 * @property {string} updatedAt ISO time of the numbers; the original read time when they are last-known.
 * @property {string} [message]
 * @property {number} [retryAfterMs] On a 429 from readClaudeUsage: how long to leave the endpoint alone (5 to 30 minutes).
 * @property {number} [bankedResets] Rate-limit resets the account has banked; absent when there are none.
 */
function providerResult(provider, now, status, windows = [], message, extra = {}) {
  return { provider, status, windows, updatedAt: new Date(now()).toISOString(), ...(message ? { message } : {}), ...extra };
}

// Retry-After is delta-seconds or an HTTP date; anything unreadable or already past gets the default.
function retryAfterMs(header, nowMs) {
  const value = typeof header === "string" ? header.trim() : "";
  let wait = Number.NaN;
  if (/^\d+$/.test(value)) wait = Number(value) * 1000;
  else if (value) wait = Date.parse(value) - nowMs;
  if (!(wait > 0)) wait = DEFAULT_RETRY_MS;
  return Math.min(wait, MAX_RETRY_MS);
}

function percentOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

// Never surface JSON.parse errors: V8 quotes the input, which here is a credential.
function parseOauth(raw) {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return typeof oauth?.accessToken === "string" && oauth.accessToken ? oauth : null;
  } catch {
    return null;
  }
}

function readKeychain(execFileImpl, timeoutMs) {
  return new Promise((resolve) => {
    execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout) => resolve(error ? null : parseOauth(stdout)),
    );
  });
}

async function readClaudeCredentials({ platform, execFileImpl, readFile, home, timeoutMs }) {
  if (platform === "darwin") {
    const oauth = await readKeychain(execFileImpl, timeoutMs);
    if (oauth) return oauth;
  }
  try {
    return parseOauth(await readFile(path.join(home, ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

function claudeWindow(meta, percent, resetsAt) {
  const usedPercent = percentOrNull(percent);
  if (usedPercent === null) return null;
  return { ...meta, usedPercent, resetsAt: typeof resetsAt === "string" ? resetsAt : null };
}

function claudeWindows(body) {
  if (!Array.isArray(body?.limits)) {
    return [
      claudeWindow(SESSION, body?.five_hour?.utilization, body?.five_hour?.resets_at),
      claudeWindow(WEEKLY, body?.seven_day?.utilization, body?.seven_day?.resets_at),
    ].filter(Boolean);
  }
  return body.limits
    .map((limit) => {
      if (limit?.kind === "session") return claudeWindow(SESSION, limit.percent, limit.resets_at);
      if (limit?.kind === "weekly_all") return claudeWindow(WEEKLY, limit.percent, limit.resets_at);
      const model = limit?.kind === "weekly_scoped" ? limit.scope?.model?.display_name : null;
      if (typeof model !== "string" || !model) return null;
      return claudeWindow({ id: `weekly:${model.toLowerCase()}`, label: model, shortLabel: "wk" }, limit.percent, limit.resets_at);
    })
    .filter(Boolean)
    .sort((a, b) => (CLAUDE_RANK[a.id] ?? 2) - (CLAUDE_RANK[b.id] ?? 2));
}

async function readClaudeUsage(deps = {}) {
  const {
    platform = process.platform,
    execFileImpl = execFile,
    readFile = fs.readFile,
    home = os.homedir(),
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = PROVIDER_TIMEOUT_MS,
  } = deps;
  const done = (status, windows, message) => providerResult("claude", now, status, windows, message);

  const oauth = await readClaudeCredentials({ platform, execFileImpl, readFile, home, timeoutMs });
  if (!oauth) return done("unavailable", [], "Not signed in to Claude Code.");
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now()) return done("error", [], CLAUDE_EXPIRED);

  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return done("error", [], error?.name === "TimeoutError" ? "Claude usage timed out." : "Couldn't reach Claude.");
  }
  if (response.status === 401) return done("error", [], CLAUDE_EXPIRED);
  if (response.status === 429) {
    const wait = retryAfterMs(response.headers?.get?.("retry-after"), now());
    return providerResult("claude", now, "error", [], RATE_LIMITED, { retryAfterMs: wait });
  }
  if (!response.ok) return done("error", [], `Claude usage failed (HTTP ${response.status}).`);

  let body;
  try {
    body = await response.json();
  } catch {
    return done("error", [], "Claude returned an unreadable usage response.");
  }
  const windows = claudeWindows(body);
  return windows.length ? done("ok", windows) : done("error", [], "Claude returned no usage windows.");
}

const APP_SERVER_CLIENT = { name: "milagre", title: "Milagre", version: "0.1.0" };

function codexWindowMeta(minutes) {
  if (minutes === 300) return SESSION;
  if (minutes === 10080) return WEEKLY;
  const short = minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return { id: `window:${minutes}`, label: `${short} window`, shortLabel: short };
}

function codexWindows(rateLimits) {
  return [rateLimits?.primary, rateLimits?.secondary]
    .filter((item) => percentOrNull(item?.usedPercent) !== null && Number.isInteger(item.windowDurationMins) && item.windowDurationMins > 0)
    .sort((a, b) => a.windowDurationMins - b.windowDurationMins)
    .map((item) => ({
      ...codexWindowMeta(item.windowDurationMins),
      usedPercent: percentOrNull(item.usedPercent),
      resetsAt: typeof item.resetsAt === "number" ? new Date(item.resetsAt * 1000).toISOString() : null,
    }));
}

// Only a positive whole count is worth showing; zero and anything malformed mean "no bank".
function bankedResetsOf(count) {
  return Number.isInteger(count) && count > 0 ? { bankedResets: count } : {};
}

async function readCodexUsage(deps = {}) {
  const { spawnImpl = spawn, now = Date.now, timeoutMs = PROVIDER_TIMEOUT_MS } = deps;
  const done = (status, windows, message) => providerResult("codex", now, status, windows, message);

  const command = deps.command || (process.platform === "win32" ? await resolveExecutable("codex") : "codex");
  if (!command) return done("unavailable", [], "Codex CLI not found.");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: deps.env || process.env, windowsHide: true }, spawnImpl);
    } catch {
      resolve(done("error", [], "Codex could not start."));
      return;
    }
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => finish(done("error", [], "Codex usage timed out.")), timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    }

    function send(message) {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handle(message) {
      if (message.error && [1, 2, 3].includes(message.id)) return finish(done("error", [], "Codex couldn't read usage."));
      if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: {} });
      } else if (message.id === 2) {
        const account = message.result?.account;
        if (!account) return finish(done("unavailable", [], "Not signed in to Codex."));
        // Plan windows only exist for ChatGPT sign-ins; API-key and Bedrock accounts have none to show.
        if (account.type !== "chatgpt") return finish(done("unavailable", [], "Codex plan limits need a ChatGPT sign-in."));
        send({ id: 3, method: "account/rateLimits/read" });
      } else if (message.id === 3) {
        const windows = codexWindows(message.result?.rateLimits);
        const banked = bankedResetsOf(message.result?.rateLimitResetCredits?.availableCount);
        finish(windows.length ? providerResult("codex", now, "ok", windows, undefined, banked) : done("error", [], "Codex returned no usage windows."));
      }
    }

    child.on("error", (error) =>
      finish(error?.code === "ENOENT" ? done("unavailable", [], "Codex CLI not found.") : done("error", [], "Couldn't start Codex.")),
    );
    child.on("close", () => finish(done("error", [], "Codex exited before reporting usage.")));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        handle(message);
      }
    });

    send({ id: 1, method: "initialize", params: { clientInfo: APP_SERVER_CLIENT } });
  });
}

// On an error, keep showing the last good numbers (minus windows that have since reset).
function withLastGood(result, last, nowMs) {
  if (result.status !== "error" || !last) return result;
  const windows = last.windows.filter((item) => !item.resetsAt || Date.parse(item.resetsAt) > nowMs);
  return windows.length ? { ...result, windows, updatedAt: last.updatedAt, ...bankedResetsOf(last.bankedResets) } : result;
}

function createUsageReader(deps = {}) {
  // `ready` resolves once the login environment is applied: opened from Finder the app's PATH is bare until then,
  // and the Codex lookup starts `codex` from it.
  const {
    readClaude = readClaudeUsage,
    readCodex = readCodexUsage,
    readAntigravity = () => readAntigravityUsage({ now }),
    // The runtime reads Kiro's credits from kiro-cli (kiro-usage.cjs); without that reader the sidebar leaves Kiro out.
    readKiro = () => providerResult("kiro", now, "unavailable", [], "Kiro credits aren't read here."),
    now = Date.now,
    store = createUsageStore(),
    ready = () => undefined,
  } = deps;
  const readProvider = async (provider, read) => {
    const { blocked } = store.get(provider);
    let result;
    if (blocked && now() < blocked.until) {
      result = providerResult(provider, now, "error", [], blocked.message);
    } else {
      result = await Promise.resolve()
        .then(() => read())
        .catch(() => providerResult(provider, now, "error", [], "Couldn't read usage."));
      store.setBlocked(provider, result.retryAfterMs > 0 ? { until: now() + result.retryAfterMs, message: result.message } : null);
      if (result.status === "ok") store.setLast(provider, result);
    }
    return withLastGood(result, store.get(provider).last, now());
  };
  const pending = new Map();
  const latest = new Map();
  const readers = { claude: readClaude, codex: readCodex, antigravity: readAntigravity, kiro: readKiro };
  let environment;
  const waitReady = () =>
    (environment ??= Promise.resolve()
      .then(ready)
      .catch(() => {}));
  function providerUsage(provider) {
    if (!Object.hasOwn(readers, provider)) throw new Error("Unknown usage provider");
    if (!pending.has(provider)) {
      pending.set(
        provider,
        waitReady()
          .then(() => readProvider(provider, readers[provider]))
          .then((result) => {
            latest.set(provider, result);
            return result;
          })
          .finally(() => pending.delete(provider)),
      );
    }
    return pending.get(provider);
  }
  let inFlight = null;
  function readUsage() {
    inFlight ??= Promise.resolve()
      .then(() => Promise.all([providerUsage("claude"), providerUsage("codex"), providerUsage("antigravity"), providerUsage("kiro")]))
      .then((providers) => ({ providers }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }
  readUsage.provider = providerUsage;
  readUsage.cached = (provider) => {
    const result = latest.get(provider);
    return result
      ? { ...result, windows: result.windows.filter((window) => !window.resetsAt || Date.parse(window.resetsAt) > now()) }
      : cachedSnapshot(store, now()).providers.find((item) => item.provider === provider);
  };
  return readUsage;
}

// The CLI owns the per-profile Keychain name and token refresh. Ask its control API without
// starting a model turn, instead of depending on the credential store's private naming scheme.
async function readClaudeProfileUsage({
  command,
  env,
  loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
  now = Date.now,
  timeoutMs = PROVIDER_TIMEOUT_MS,
}) {
  let session, timer;
  const done = (status, windows, message) => providerResult("claude", now, status, windows, message);
  try {
    const { query } = await loadSdk();
    session = query({
      prompt: {
        // oxlint-disable-next-line require-yield -- async generator stub that throws or never settles on purpose to simulate a failing or idle stream
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
      },
      options: {
        pathToClaudeCodeExecutable: command,
        env,
        cwd: os.homedir(),
        settingSources: [],
        persistSession: false,
      },
    });
    const result = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (!result.rate_limits_available) return done("unavailable", [], "Plan usage is unavailable for this account.");
    if (!result.rate_limits) return done("error", [], "Could not read usage for this account.");
    return done("ok", claudeWindows(result.rate_limits));
  } catch {
    return done("error", [], "Could not read usage for this account.");
  } finally {
    clearTimeout(timer);
    session?.close?.();
  }
}

module.exports = { createUsageReader, readClaudeUsage, readClaudeProfileUsage, readCodexUsage, readAntigravityUsage };

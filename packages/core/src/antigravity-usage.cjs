const fs = require("node:fs/promises");
const path = require("node:path");

// Antigravity plan usage (docs/providers.md). Google's Cloud Code backend reports the Gemini
// quota for the signed-in account. The agent owns <GEMINI_HOME>/antigravity-acp/acp_token.json and rewrites it, so this
// module only ever reads it: it exchanges the refresh token for an access token in memory and keeps that per profile.
// No token or secret is written anywhere, logged, or put in an error message.

const TOKEN_FILE = path.join("antigravity-acp", "acp_token.json");
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
// Cloud Code only answers the Antigravity Hub client family.
const USER_AGENT_PRODUCT = "antigravity/hub/2.9.1";
const TIMEOUT_MS = 10_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const FIVE_HOUR = { id: "gemini:5h", label: "Gemini 5-hour", shortLabel: "5h" };
const WEEKLY = { id: "gemini:weekly", label: "Gemini weekly", shortLabel: "wk" };

const SIGNED_OUT = "Not signed in to Antigravity.";
const EXPIRED = "Antigravity sign-in expired. Sign in again from Settings.";

// Access tokens by profile (the token file's path), shared by every reader in this process.
const sharedTokens = new Map();

class UsageProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function userAgent(platform, arch) {
  const system = { darwin: "darwin", linux: "linux", win32: "windows" }[platform] ?? platform;
  return `${USER_AGENT_PRODUCT} ${system}/${arch === "arm64" ? "arm64" : "x64"}`;
}

// The credentials only go to Google; a tampered token_uri elsewhere is ignored.
function trustedTokenUri(uri) {
  try {
    const url = new URL(uri);
    if (
      url.protocol === "https:" &&
      (url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com") || url.hostname === "accounts.google.com")
    ) {
      return url.href;
    }
  } catch {
    // fall through
  }
  return DEFAULT_TOKEN_URI;
}

async function readCredentials(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  // Never surface JSON.parse errors: V8 quotes the input, which here holds secrets.
  try {
    const parsed = JSON.parse(raw);
    const text = (value) => (typeof value === "string" && value ? value : "");
    const credentials = {
      clientId: text(parsed?.client_id),
      clientSecret: text(parsed?.client_secret),
      refreshToken: text(parsed?.refresh_token),
      tokenUri: trustedTokenUri(text(parsed?.token_uri)),
      projectId: text(parsed?.project_id),
    };
    return credentials.clientId && credentials.clientSecret && credentials.refreshToken ? credentials : null;
  } catch {
    return null;
  }
}

async function post(fetchImpl, url, init, timeoutMs) {
  try {
    return await fetchImpl(url, { method: "POST", ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new UsageProblem("error", error?.name === "TimeoutError" ? "Antigravity usage timed out." : "Couldn't reach Google.");
  }
}

async function json(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function refresh(file, { fetchImpl, now, timeoutMs }) {
  const credentials = await readCredentials(file);
  if (!credentials) throw new UsageProblem("unavailable", SIGNED_OUT);
  const response = await post(
    fetchImpl,
    credentials.tokenUri,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    },
    timeoutMs,
  );
  if (!response.ok) {
    // invalid_grant: the refresh token was revoked or replaced.
    if (response.status === 400 || response.status === 401) throw new UsageProblem("error", EXPIRED);
    throw new UsageProblem("error", `Antigravity sign-in refresh failed (HTTP ${response.status}).`);
  }
  const body = await json(response);
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new UsageProblem("error", "Google returned an unreadable sign-in response.");
  const seconds = Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : 3000;
  return { accessToken, expiresAt: now() + seconds * 1000, projectId: credentials.projectId };
}

function headers(accessToken, agent) {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": agent };
}

// Without a project_id in the token file, Cloud Code says which project the account uses.
async function discoverProject(session, { fetchImpl, agent, timeoutMs }) {
  const response = await post(
    fetchImpl,
    LOAD_CODE_ASSIST_URL,
    {
      headers: headers(session.accessToken, agent),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
    },
    timeoutMs,
  );
  if (response.status === 401) return { unauthorized: true };
  if (!response.ok) throw new UsageProblem("error", `Antigravity usage failed (HTTP ${response.status}).`);
  const body = await json(response);
  const project = body?.cloudaicompanionProject;
  const id = typeof project === "string" ? project : project?.id;
  if (typeof id !== "string" || !id) throw new UsageProblem("error", "Google didn't say which Antigravity project to check.");
  return { projectId: id };
}

function windowOf(bucket) {
  const id = typeof bucket?.bucketId === "string" ? bucket.bucketId.toLowerCase() : "";
  const length = typeof bucket?.window === "string" ? bucket.window.toLowerCase() : id.split("-").at(-1);
  if (length === "5h") return { meta: FIVE_HOUR, order: 0 };
  if (length === "weekly") return { meta: WEEKLY, order: 1 };
  return null;
}

// Assumed response shape (observed 2026-10-08):
//   { groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h" | "weekly",
//     remainingFraction: 0..1, resetTime: ISO, disabled?: boolean }] }, { displayName: "Claude and GPT models", ... }] }
// Only the Gemini group is shown. A bucket without a numeric remainingFraction, or a disabled one, has no window.
function geminiWindows(body) {
  const groups = body?.groups ?? body?.quotaSummary?.groups ?? body?.summary?.groups;
  if (!Array.isArray(groups)) return [];
  const isGemini = (group) =>
    /gemini/i.test(`${group?.displayName ?? group?.name ?? ""}`) ||
    (Array.isArray(group?.buckets) && group.buckets.length > 0 && group.buckets.every((bucket) => /^gemini/i.test(`${bucket?.bucketId ?? ""}`)));
  const windows = [];
  for (const group of groups.filter(isGemini)) {
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (bucket?.disabled === true) continue;
      const found = windowOf(bucket);
      const fraction = bucket?.remainingFraction;
      if (!found || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const usedPercent = Math.min(100, Math.max(0, (1 - fraction) * 100));
      const reset = typeof bucket.resetTime === "string" && !Number.isNaN(Date.parse(bucket.resetTime)) ? bucket.resetTime : null;
      windows.push({ ...found, window: { ...found.meta, usedPercent, resetsAt: reset } });
    }
  }
  return windows.sort((a, b) => a.order - b.order).map((item) => item.window);
}

/**
 * Reads the Gemini quota windows ("Gemini 5-hour", "Gemini weekly") for the Antigravity profile in `env.GEMINI_HOME`.
 * Resolves to the same shape as the Claude and Codex readers and never throws.
 */
async function readAntigravityUsage(deps = {}) {
  const {
    env = process.env,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    tokens = sharedTokens,
    platform = process.platform,
    arch = process.arch,
    timeoutMs = TIMEOUT_MS,
  } = deps;
  const done = (status, windows, message) => ({
    provider: "antigravity",
    status,
    windows,
    updatedAt: new Date(now()).toISOString(),
    ...(message ? { message } : {}),
  });
  const home = env?.GEMINI_HOME;
  if (!home) return done("unavailable", [], SIGNED_OUT);
  const file = path.join(home, TOKEN_FILE);
  const agent = userAgent(platform, arch);
  const request = { fetchImpl, now, timeoutMs, agent };

  async function session(force) {
    const cached = tokens.get(file);
    if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached;
    tokens.delete(file);
    const fresh = await refresh(file, request);
    tokens.set(file, fresh);
    return fresh;
  }

  // One attempt with the cached token; a 401 drops it, re-reads the token file and refreshes once.
  async function attempt(force) {
    const current = await session(force);
    let projectId = current.projectId;
    if (!projectId) {
      const found = await discoverProject(current, request);
      if (found.unauthorized) return { unauthorized: true };
      projectId = found.projectId;
    }
    const response = await post(
      fetchImpl,
      QUOTA_URL,
      { headers: headers(current.accessToken, agent), body: JSON.stringify({ project: projectId }) },
      timeoutMs,
    );
    if (response.status === 401) return { unauthorized: true };
    if (!response.ok) throw new UsageProblem("error", `Antigravity usage failed (HTTP ${response.status}).`);
    return { body: await json(response) };
  }

  try {
    let result = await attempt(false);
    if (result.unauthorized) result = await attempt(true);
    if (result.unauthorized) {
      tokens.delete(file);
      return done("error", [], EXPIRED);
    }
    const windows = geminiWindows(result.body);
    return windows.length ? done("ok", windows) : done("error", [], "Google returned no Gemini usage windows.");
  } catch (error) {
    // Only messages written in this file reach the UI; anything else is generic.
    return error instanceof UsageProblem ? done(error.status, [], error.message) : done("error", [], "Couldn't read Antigravity usage.");
  }
}

module.exports = { readAntigravityUsage, geminiWindows, TOKEN_FILE };

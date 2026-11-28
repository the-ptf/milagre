const { execFile } = require("node:child_process");
const { CodexRpc } = require("./codex-rpc.cjs");
const { PROVIDERS } = require("@milagre/shared/providers");
const { hasToken } = require("./antigravity-install.cjs");
const { loginMessage } = require("./events.cjs");
const { kiroLoggedOut } = require("../kiro-account.cjs");
const { grokLoggedOut } = require("../grok-account.cjs");
const { piReady } = require("./pi-profile.cjs");

const piLoggedOut = async (_command, { env } = {}) => !(await piReady({ env: env ?? process.env }));

//              Codex: account/read answers { account: null, requiresOpenaiAuth: true }
//              Antigravity: the account's GEMINI_HOME has no antigravity-acp/acp_token.json (nothing is spawned)
//              Kiro: `kiro-cli whoami` says "Not logged in"
//              Grok: no `auth.json` under GROK_HOME (default ~/.grok) and no XAI_API_KEY (nothing is spawned)

const READY_TTL_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const ACCOUNT_TIMEOUT_MS = 8_000;

function claudeLoggedOut(command, { execFileImpl = execFile, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFileImpl(command, ["auth", "status"], { encoding: "utf8", timeout: AUTH_TIMEOUT_MS, ...(env ? { env } : {}) }, (error, stdout) => {
        try {
          const text = String(stdout);
          const status = JSON.parse(text.slice(text.indexOf("{")));
          resolve(status.loggedIn === false && status.apiProvider === "firstParty");
        } catch {
          // oxlint-disable-next-line promise/no-multiple-resolved -- the catch only runs when parsing threw before resolve, and a promise ignores later resolves anyway
          resolve(false);
        }
      });
    } catch {
      resolve(false);
      return;
    }
    child?.stdin?.end?.();
  });
}

async function codexLoggedOut(command, { cwd, env, clientVersion = "0.0.0", createRpc = (options) => new CodexRpc(options) } = {}) {
  let rpc;
  try {
    rpc = createRpc({ command, cwd, ...(env ? { env } : {}) });
    rpc.start();
    await rpc.request(
      "initialize",
      { clientInfo: { name: "milagre", title: "Milagre", version: clientVersion }, capabilities: null },
      { timeoutMs: AUTH_TIMEOUT_MS },
    );
    rpc.notify("initialized");
    const account = await rpc.request("account/read", { refreshToken: false }, { timeoutMs: ACCOUNT_TIMEOUT_MS });
    return !account.account && account.requiresOpenaiAuth === true;
  } catch {
    return false;
  } finally {
    rpc?.close();
  }
}

// Antigravity is signed in when its profile directory holds the token file; a profile that has never
function antigravityLoggedOutAt(home) {
  return typeof home === "string" && home !== "" && !hasToken(home);
}
const antigravityLoggedOut = async (_command, { env } = {}) => antigravityLoggedOutAt(env?.GEMINI_HOME);

function cliState(status) {
  if (!status.problem) return null;
  if (!status.command) return "missing";
  return status.version ? "outdated" : "broken";
}

async function inspect(name, { cli, loggedOut, cwd, clientVersion }) {
  const status = await cli(name);
  const state = cliState(status);
  if (state) return { state, message: status.problem };
  const env = status.env ? { env: status.env } : {};
  const out = name === "codex" ? await loggedOut.codex(status.command, { cwd, clientVersion, ...env }) : await loggedOut[name](status.command, env);
  return out ? { state: "logged-out", message: loginMessage(name) } : { state: "ready" };
}

function createCliStatus({
  cli,
  cwd,
  clientVersion,
  now = Date.now,
  ttlMs = READY_TTL_MS,
  loggedOut = { claude: claudeLoggedOut, codex: codexLoggedOut, antigravity: antigravityLoggedOut, kiro: kiroLoggedOut, grok: grokLoggedOut, pi: piLoggedOut },
}) {
  const cache = new Map();
  function lookup(name) {
    const cached = cache.get(name);
    if (cached && (cached.pending || now() - cached.at < ttlMs)) return cached.promise;
    const entry = { at: now(), pending: true, promise: null };
    entry.promise = inspect(name, { cli, loggedOut, cwd, clientVersion })
      .catch(() => ({ state: "ready" }))
      .then((result) => {
        entry.pending = false;
        entry.at = now();
        if (result.state !== "ready" && cache.get(name) === entry) cache.delete(name);
        return result;
      });
    cache.set(name, entry);
    return entry.promise;
  }
  const check = async () => {
    const states = await Promise.all(PROVIDERS.map(lookup));
    return Object.fromEntries(PROVIDERS.map((name, index) => [name, states[index]]));
  };
  check.invalidate = (name) => {
    cache.delete(name);
  };
  return check;
}

/**
 * `cli`, except that a logged-out Claude counts as a CLI with a problem. Claude Code answers supportedModels()
 * with only its four aliases ("Opus", "Fable", "Sonnet", "Haiku") until it is logged in, and a model list is
 * asked once per run; this way the lookup is skipped, and asked again, until the login is done.
 */
function cliWhenLoggedIn(cli, status, names = ["claude"]) {
  return async (name) => {
    const result = await cli(name);
    if (result.problem || !names.includes(name)) return result;
    const current = (await status().catch(() => ({})))[name];
    return current?.state === "logged-out" ? { ...result, problem: current.message } : result;
  };
}

module.exports = { READY_TTL_MS, claudeLoggedOut, cliWhenLoggedIn, codexLoggedOut, createCliStatus, antigravityLoggedOut, antigravityLoggedOutAt };

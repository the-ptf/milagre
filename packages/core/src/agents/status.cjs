const { execFile } = require("node:child_process");
const { CodexRpc } = require("./codex-rpc.cjs");
const { PROVIDERS } = require("@milagre/shared/providers");
const { hasToken } = require("./antigravity-install.cjs");
const { loginMessage } = require("./events.cjs");
const { kiroLoggedOut } = require("../kiro-account.cjs");

// What the model picker shows about each agent's CLI: { state, message? }, where state is
//   ready      nothing to flag
//   missing    not installed                       (cli.cjs)
//   outdated   older than Milagre supports          (cli.cjs)
//   broken     found, but `--version` doesn't run   (cli.cjs)
//   logged-out Claude: `claude auth status` says "loggedIn": false
//              Codex: account/read answers { account: null, requiresOpenaiAuth: true }
//              Antigravity: the account's GEMINI_HOME has no antigravity-acp/acp_token.json (nothing is spawned)
//              Kiro: `kiro-cli whoami` says "Not logged in"
// `message` is the same text a turn fails with. The login check never blocks anything: a check that fails
// in any other way counts as ready. A ready status is kept for READY_TTL_MS; a problem is looked at again
// on every call, so fixing it needs neither a restart nor waiting.

const READY_TTL_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
// account/read answers in well under a second.
const ACCOUNT_TIMEOUT_MS = 8_000;

// `claude auth status` prints JSON and exits 1 when logged out, so the output is read either way, from its
// first "{" (a notice line may come before it). Only an explicit `"loggedIn": false` on Anthropic's own API
// (`"apiProvider": "firstParty"`) counts: on Bedrock, Vertex or Foundry the CLI authenticates through the
// cloud account and `claude auth login` is no remedy. Anything unreadable is not a reason to flag the CLI.
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
    // Nothing is written to it; closing it keeps a CLI that reads stdin from waiting.
    child?.stdin?.end?.();
  });
}

// A short-lived `codex app-server`, asked who is logged in. Any failure counts as logged in.
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
// signed in has none. Without a GEMINI_HOME the account isn't known yet, and that is no reason to flag it.
function antigravityLoggedOutAt(home) {
  return typeof home === "string" && home !== "" && !hasToken(home);
}
const antigravityLoggedOut = async (_command, { env } = {}) => antigravityLoggedOutAt(env?.GEMINI_HOME);

// The state cli.cjs's check implies, or null when the CLI runs.
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

/**
 * `() => Promise<{ [provider]: CliStatus }>`, one entry per provider. Waits for the login environment (through `cli`).
 */
function createCliStatus({
  cli,
  cwd,
  clientVersion,
  now = Date.now,
  ttlMs = READY_TTL_MS,
  loggedOut = { claude: claudeLoggedOut, codex: codexLoggedOut, antigravity: antigravityLoggedOut, kiro: kiroLoggedOut },
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
        // A lookup that finishes after invalidate() must not delete the newer entry that replaced it.
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
  // A turn just failed with this provider's login message: a status kept as ready is out of date.
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

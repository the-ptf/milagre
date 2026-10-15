const path = require("node:path");
const { execFile } = require("node:child_process");
const { toClaudeConfig, safeDetail } = require("./definitions.cjs");

// One Claude account's MCP servers, from an idle SDK session's mcpServerStatus() (the listClaudeModels pattern in
// agents/models.cjs). The session sends no prompt, so it costs no tokens; it only starts the servers.

const SCOPES = { user: "user", local: "local", project: "project", dynamic: "plugin", claudeai: "claude.ai" };
const STATES = { connected: "connected", failed: "failed", "needs-auth": "needs-sign-in", disabled: "disabled", pending: "pending" };
const TIMEOUT_ERROR = "Timed out. Check this server in a terminal.";

function transportOf(type) {
  if (type === "http" || type === "sse" || type === "ws") return "url";
  if (type === "claudeai-proxy") return "connector";
  return "command";
}

/** One SDK McpServerStatus as a report; null for an in-process SDK server, which the user never configured. */
function claudeServer(status, { timedOut = false, everywhereNames = new Set() } = {}) {
  if (status.config?.type === "sdk") return null;
  const pending = status.status === "pending";
  return {
    name: status.name,
    transport: transportOf(status.config?.type),
    scope: everywhereNames.has(status.name) ? "everywhere" : (SCOPES[status.scope] ?? "built-in"),
    state: pending && timedOut ? "failed" : (STATES[status.status] ?? "failed"),
    tools: Array.isArray(status.tools) ? status.tools.length : 0,
    error: pending && timedOut ? TIMEOUT_ERROR : (status.error ?? null),
    detail: safeDetail(status.config),
  };
}

async function checkClaude({
  command,
  env,
  cwd,
  everywhere = [],
  loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
  signal,
  timeoutMs = 30_000,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { query } = await loadSdk();
  const idle = {
    // oxlint-disable-next-line require-yield -- never yields: the session stays idle and sends no prompt
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const mcpServers = Object.fromEntries(everywhere.map((def) => [def.name, toClaudeConfig(def)]));
  const session = query({
    prompt: idle,
    options: { pathToClaudeCodeExecutable: command, cwd, ...(env ? { env } : {}), ...(everywhere.length ? { mcpServers } : {}) },
  });
  const onAbort = () => session.close?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const deadline = now() + timeoutMs;
    let list = await session.mcpServerStatus();
    while (list.some((status) => status.status === "pending") && now() < deadline) {
      await sleep(pollMs);
      list = await session.mcpServerStatus();
    }
    const timedOut = now() >= deadline;
    const everywhereNames = new Set(everywhere.map((def) => def.name));
    return list.map((status) => claudeServer(status, { timedOut, everywhereNames })).filter(Boolean);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    session.close?.();
  }
}

// A CLI call with no shell; a failure carries the CLI's own stderr, which the sheet shows. Node's error.message
// repeats the whole command line (config JSON with tokens), so it is never used, and long arguments are redacted.
function runCli(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: env ?? process.env, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      let text = String(stderr ?? "");
      for (const arg of args) if (arg.length > 40) text = text.split(arg).join("[config]");
      text = text.trim();
      reject(new Error(text || `${path.basename(command)} ${args.slice(0, 2).join(" ")} failed (${error.killed ? "timed out" : `exit ${error.code}`}).`));
    });
  });
}

// The config travels as argv because `claude mcp add-json` has no stdin form, so it is briefly visible in `ps`.
async function addClaude({ command, env, def, run = runCli }) {
  await run(command, ["mcp", "add-json", def.name, JSON.stringify(toClaudeConfig(def)), "--scope", "user"], { env });
}

async function removeClaude({ command, env, name, run = runCli }) {
  await run(command, ["mcp", "remove", name, "--scope", "user"], { env });
}

const SIGN_IN_TIMEOUT = "Sign-in timed out after 5 minutes. Try again.";

// One account's OAuth sign-in to one server through the SDK's unlisted mcpAuthenticate (probed 2026-10-15):
// the CLI listens on a localhost port and swaps the code for a token itself; Milagre only opens the browser and
// watches mcpServerStatus. The session stays open until then because it hosts the callback. Everywhere servers
// are passed exactly as a Chat passes them, because the CLI keys the token by name and config.
async function signInClaude({
  command,
  env,
  cwd,
  name,
  everywhere = [],
  openUrl,
  signal,
  timeoutMs = 300_000,
  pollMs = 1000,
  loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { query } = await loadSdk();
  const idle = {
    // oxlint-disable-next-line require-yield -- never yields: the session stays idle and sends no prompt
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const mcpServers = Object.fromEntries(everywhere.map((def) => [def.name, toClaudeConfig(def)]));
  const session = query({
    prompt: idle,
    options: { pathToClaudeCodeExecutable: command, cwd, ...(env ? { env } : {}), ...(everywhere.length ? { mcpServers } : {}) },
  });
  try {
    const auth = await session.mcpAuthenticate(name);
    if (auth?.authUrl) openUrl(auth.authUrl);
    if (auth?.callbackExpected === false) return { opened: true };
    const deadline = now() + timeoutMs;
    // oxlint-disable-next-line no-unmodified-loop-condition -- the abort signal flips from outside the loop
    while (!signal?.aborted && now() < deadline) {
      const status = (await session.mcpServerStatus()).find((item) => item.name === name);
      if (status?.status === "connected") return { ok: true };
      if (status?.status === "failed") return { ok: false, error: status.error ?? "Sign-in failed." };
      await sleep(pollMs);
    }
    return signal?.aborted ? { cancelled: true } : { ok: false, error: SIGN_IN_TIMEOUT };
  } catch (error) {
    // Never rejects: a failed authenticate, a throwing openUrl or a dead status poll is an outcome, not a crash.
    return signal?.aborted ? { cancelled: true } : { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    session.close?.();
  }
}

module.exports = { checkClaude, claudeServer, addClaude, removeClaude, runCli, signInClaude };

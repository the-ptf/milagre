const path = require("node:path");
const fs = require("node:fs");
const { checkClaude, addClaude, removeClaude, signInClaude } = require("./claude.cjs");
const { checkCodex, addCodex, removeCodex, readCodexDefinition, signInCodex } = require("./codex.cjs");
const { claudeConfigNames, codexConfigNames, detailOf, fromClaudeConfig, maskDefinition, unmaskDefinition } = require("./definitions.cjs");

// Settings › MCP: which accounts to check, one account's check (capped), and the edits: Everywhere servers and
// the off list in mcp.json, Claude and Codex user servers through their CLIs, and OAuth sign-in. Grouping for the
// screens lives in @milagre/shared/mcp; Chat start asks forSession for the extra servers and the off list.

const PROVIDERS = new Set(["claude", "codex", "antigravity"]);
// The caller waits longer than this cap (45 s): SLOW_METHODS in apps/daemon/src/client.cjs and MCP_CALLS in apps/mobile/src/client.ts.
const TIMEOUT_PROBLEM = "Timed out after 30 s. Check the servers in a terminal.";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const URL_PATTERN = /^https?:\/\/\S+$/;

// The same rules as validateMcpServer in @milagre/shared/mcp; the runtime checks again because phones call it too.
function invalid(def) {
  if (!def || !NAME.test(String(def.name))) return "Use letters, numbers, - and _ only.";
  if (def.name === "milagre") return "milagre is Milagre’s own server. Pick another name.";
  if (def.type === "stdio") return String(def.command ?? "").trim() ? null : "Enter the command to run.";
  if (def.type !== "http" && def.type !== "sse") return "Pick URL or Command.";
  return URL_PATTERN.test(String(def.url)) ? null : "Enter an http or https URL.";
}

function createMcp({
  accounts,
  routing,
  cwd,
  clientVersion,
  store,
  openUrl = () => {},
  emit = () => {},
  home = require("node:os").homedir(),
  checkers = {},
  writers = {},
  signers = {},
  timeoutMs = 30_000,
}) {
  const run = { claude: checkers.claude ?? checkClaude, codex: checkers.codex ?? checkCodex };
  const write = {
    claude: { add: addClaude, remove: removeClaude, ...writers.claude },
    codex: { add: addCodex, remove: removeCodex, read: readCodexDefinition, ...writers.codex },
  };
  const sign = { claude: signers.claude ?? signInClaude, codex: signers.codex ?? signInCodex };
  const signIns = new Map(); // server name → AbortController

  async function listed() {
    // The cheap snapshot: it inspects nothing, so a first open never waits on identity checks.
    const snapshot = await accounts.snapshot();
    return snapshot.providers.filter((group) => PROVIDERS.has(group.provider)).flatMap((group) => group.accounts.map((account) => ({ group, account })));
  }

  async function list() {
    return (await listed()).map(({ group, account }) => ({ provider: group.provider, accountId: account.id, label: account.email || account.label }));
  }

  function configNames(provider, env = {}) {
    if (provider === "claude") return claudeConfigNames(path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json"));
    if (provider === "codex") return codexConfigNames(path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"));
    return new Set();
  }

  function forSessionWith(provider, accountId, env) {
    const own = configNames(provider, env);
    return { servers: store.read().everywhere.filter((def) => !own.has(def.name)), off: store.offFor(provider, accountId) };
  }

  async function check(provider, accountId) {
    const controller = new AbortController();
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT_PROBLEM);
      }, timeoutMs);
    });
    let base = { provider, accountId, label: accountId };
    const answer = (problem, servers = []) => ({ ...base, problem, servers });
    const work = async () => {
      const found = (await listed()).find(({ group, account }) => group.provider === provider && account.id === accountId);
      if (!found) return answer("Account not found. Refresh and try again.");
      base = { provider, accountId, label: found.account.email || found.account.label };
      if (found.account.state === "signed-out") return answer("Not signed in. Sign in from Accounts.");
      const off = new Set(store.offFor(provider, accountId));
      const everywhere = store.read().everywhere;
      if (provider === "antigravity")
        return answer(
          null,
          everywhere.map((def) => ({
            name: def.name,
            transport: def.type === "stdio" ? "command" : "url",
            scope: "everywhere",
            state: off.has(def.name) ? "disabled" : "unchecked",
            tools: 0,
            error: null,
            detail: detailOf(def),
          })),
        );
      const cli = await routing.forAccount(provider, accountId);
      if (cli.problem || !cli.command) return answer(cli.problem || "Install the provider CLI first.");
      const session = forSessionWith(provider, accountId, cli.env);
      const shadowed = new Set(everywhere.map((def) => def.name).filter((name) => !session.servers.some((def) => def.name === name)));
      const servers = await run[provider]({
        command: cli.command,
        env: cli.env,
        cwd,
        clientVersion,
        signal: controller.signal,
        timeoutMs: Math.max(0, timeoutMs - 5000),
        everywhere: session.servers,
      });
      const reports = servers.map((server) => ({
        ...server,
        ...(off.has(server.name) ? { state: "disabled" } : {}),
        ...(shadowed.has(server.name) && server.scope === "user" ? { shadowedBy: provider } : {}),
      }));
      return answer(null, reports);
    };
    try {
      const result = await Promise.race([work(), cap]);
      return result === TIMEOUT_PROBLEM ? answer(TIMEOUT_PROBLEM) : result;
    } catch (error) {
      return answer(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async function storedDefinition(name, target) {
    if (target === "everywhere") return store.read().everywhere.find((def) => def.name === name) ?? null;
    const cli = await routing.forAccount(target, "default");
    if (target === "claude") {
      try {
        const file = path.join(cli.env?.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
        return fromClaudeConfig(name, JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.[name]);
      } catch {
        return null;
      }
    }
    return write.codex.read({ command: cli.command, env: cli.env, cwd, name, clientVersion });
  }

  async function definition(name, target) {
    const def = await storedDefinition(name, target);
    return def ? maskDefinition(def) : null;
  }

  async function removeFrom(name, target) {
    if (target === "everywhere") return store.setEverywhere(store.read().everywhere.filter((def) => def.name !== name));
    const cli = await routing.forAccount(target, "default");
    await write[target].remove({ command: cli.command, env: cli.env, name });
  }

  async function save(def, target, previous) {
    const problem = invalid(def);
    if (problem) throw new Error(problem);
    const stored = previous ? await storedDefinition(previous.name, previous.target) : null;
    const full = unmaskDefinition(def, stored);
    if (previous) await removeFrom(previous.name, previous.target);
    if (target === "everywhere") store.setEverywhere([...store.read().everywhere.filter((item) => item.name !== full.name), full]);
    else {
      const cli = await routing.forAccount(target, "default");
      await write[target].add({ command: cli.command, env: cli.env, cwd, clientVersion, def: full });
    }
    emit("mcp:changed", { name: full.name });
  }

  async function saveUrl(def, target, previous) {
    if (def?.type === "stdio") throw new Error("Add command servers on the Mac.");
    return save(def, target, previous);
  }

  async function remove(name, target) {
    await removeFrom(name, target);
    emit("mcp:changed", { name });
  }

  async function toggle(provider, accountId, name, on) {
    store.setOff(provider, accountId, name, !on);
    emit("mcp:changed", { name, provider, accountId });
  }

  // One account at a time, so each browser tab belongs to one sign-in. Resolves once the first account has
  // opened its URL (or finished); the rest runs on and reports through mcp:changed.
  async function signIn(name, targets) {
    signIns.get(name)?.abort();
    const controller = new AbortController();
    signIns.set(name, controller);
    let firstOpened;
    const opened = new Promise((resolve) => (firstOpened = resolve));
    const all = (async () => {
      for (const [index, { provider, accountId }] of targets.entries()) {
        if (controller.signal.aborted) break;
        if (!sign[provider]) continue;
        const cli = await routing.forAccount(provider, accountId);
        // Each runner gets its own signal, so a cancel that lands while the CLI lookup was still pending reaches it too.
        const own = new AbortController();
        controller.signal.addEventListener("abort", () => own.abort(), { once: true });
        const running = sign[provider]({
          command: cli.command,
          env: cli.env,
          cwd,
          clientVersion,
          name,
          everywhere: forSessionWith(provider, accountId, cli.env).servers,
          signal: own.signal,
          openUrl: (url) => {
            openUrl(url);
            firstOpened();
          },
        });
        if (controller.signal.aborted) own.abort();
        const result = await running.catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        firstOpened();
        const signInState = result.cancelled ? "cancelled" : result.ok || result.opened ? "done" : "failed";
        emit("mcp:changed", {
          name,
          provider,
          accountId,
          signIn: signInState,
          error: result.error ?? null,
          last: result.cancelled || index === targets.length - 1,
        });
        if (result.cancelled) break;
      }
      if (signIns.get(name) === controller) signIns.delete(name);
      firstOpened();
    })();
    await Promise.race([opened, all]);
    return { started: true };
  }

  function cancelSignIn(name) {
    signIns.get(name)?.abort();
  }

  async function forSession(provider, accountId) {
    const cli = provider === "antigravity" ? { env: {} } : await routing.forAccount(provider, accountId);
    return forSessionWith(provider, accountId, cli.env);
  }

  return { accounts: list, check, definition, save, saveUrl, remove, toggle, signIn, cancelSignIn, forSession };
}

module.exports = { createMcp };

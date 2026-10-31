const path = require("node:path");
const fs = require("node:fs");
const { checkClaude, addClaude, removeClaude, signInClaude } = require("./claude.cjs");
const { checkCodex, addCodex, removeCodex, readCodexConfig, signInCodex } = require("./codex.cjs");
const { claudeConfigNames, codexConfigNames, detailOf, fromClaudeConfig, fromCodexConfig, maskDefinition, unmaskDefinition } = require("./definitions.cjs");

// Settings › MCP: which accounts to check, one account's check (capped), and the edits: Everywhere servers and
// the off list in mcp.json, Claude and Codex user servers through their CLIs, and OAuth sign-in. Grouping for the
// screens lives in @milagre/shared/mcp; Chat start asks forSession for the extra servers and the off list.

const PROVIDERS = new Set(["claude", "codex", "antigravity", "kiro"]);
// Agents whose own MCP config Milagre doesn't read: a session gets only the Everywhere servers.
const EVERYWHERE_ONLY = new Set(["antigravity", "kiro"]);
// The caller waits longer than this cap (45 s): SLOW_METHODS in apps/daemon/src/client.cjs and MCP_CALLS in apps/mobile/src/client.ts.
const TIMEOUT_PROBLEM = "Timed out after 30 s. Check the servers in a terminal.";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TARGETS = new Set(["everywhere", "claude", "codex"]);
// Server names as providers report them: plugin and connector names can hold ":", "." and spaces ("claude.ai Gmail").
const SERVER_NAME = /^[A-Za-z0-9_.:@ -]{1,128}$/;
const URL_PATTERN = /^https?:\/\/\S+$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value : "");
const stringRecord = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) : {});

/** A definition as it may be written: the known fields only, with string values. Anything else a caller sent is dropped. */
function normalizeDefinition(def) {
  if (!isObject(def)) return null;
  if (def.type === "stdio")
    return {
      name: text(def.name),
      type: "stdio",
      command: text(def.command),
      args: Array.isArray(def.args) ? def.args.filter((arg) => typeof arg === "string") : [],
      env: stringRecord(def.env),
    };
  return { name: text(def.name), type: text(def.type), url: text(def.url), headers: stringRecord(def.headers) };
}

// Names reach the provider CLIs as arguments (`claude mcp remove <name>`), so a leading "-" would read as a flag.
function assertServerName(name) {
  if (typeof name !== "string" || !SERVER_NAME.test(name) || name.startsWith("-")) throw new Error("Unknown server name.");
}

// The config keys each writer regenerates from a definition; any other key in a stored config is the user's own.
const KNOWN_KEYS = { claude: new Set(["type", "url", "headers", "command", "args", "env"]), codex: new Set(["url", "http_headers", "command", "args", "env"]) };
const extraKeys = (raw, target) =>
  isObject(raw) && KNOWN_KEYS[target] ? Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS[target].has(key))) : {};

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
    codex: { add: addCodex, remove: removeCodex, read: readCodexConfig, ...writers.codex },
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

  // Everywhere servers the provider's own config doesn't already define (check and sign-in probe all of these).
  function forSessionWith(provider, accountId, env) {
    const own = configNames(provider, env);
    return { servers: store.read().everywhere.filter((def) => !own.has(def.name)), off: store.offFor(provider, accountId), own };
  }

  // What a Chat start needs: Everywhere servers to add (never the ones switched off) and the names to switch off.
  // Codex merges `enabled: false` into the user's own definition, so a name it doesn't have in config.toml is dropped.
  function sessionPlan(provider, accountId, env) {
    const { servers, off, own } = forSessionWith(provider, accountId, env);
    const stopped = new Set(off);
    return { servers: servers.filter((def) => !stopped.has(def.name)), off: provider === "codex" ? off.filter((name) => own.has(name)) : off };
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
      if (EVERYWHERE_ONLY.has(provider))
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
      // Only names a Chat start would switch off read as off (see sessionPlan): Codex drops a name it has neither in
      // config.toml nor among the Everywhere servers. A server off in the provider's own config stays as it reports.
      const everywhereNames = new Set(everywhere.map((def) => def.name));
      const switchedOff = (server) =>
        off.has(server.name) && server.disabledBy !== "provider" && (provider !== "codex" || session.own.has(server.name) || everywhereNames.has(server.name));
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
        ...(switchedOff(server) ? { state: "disabled" } : {}),
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

  /** The stored server as a definition, with its raw provider config (`raw`, null for Everywhere); null when missing. */
  async function storedDefinition(name, target) {
    if (target === "everywhere") {
      const def = store.read().everywhere.find((item) => item.name === name);
      return def ? { def, raw: null } : null;
    }
    const cli = await routing.forAccount(target, "default");
    let raw;
    if (target === "claude") {
      try {
        const file = path.join(cli.env?.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
        raw = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.[name];
      } catch {
        return null;
      }
    } else raw = await write.codex.read({ command: cli.command, env: cli.env, cwd, name, clientVersion });
    const def = target === "claude" ? fromClaudeConfig(name, raw) : fromCodexConfig(name, raw);
    return def ? { def, raw } : null;
  }

  function assertTarget(target) {
    if (!TARGETS.has(target)) throw new Error("Pick where to load it.");
  }

  async function definition(name, target) {
    assertTarget(target);
    assertServerName(name);
    const stored = await storedDefinition(name, target);
    return stored ? maskDefinition(stored.def) : null;
  }

  async function removeFrom(name, target) {
    if (target === "everywhere") return store.setEverywhere(store.read().everywhere.filter((def) => def.name !== name));
    const cli = await routing.forAccount(target, "default");
    await write[target].remove({ command: cli.command, env: cli.env, name });
  }

  // `extra` holds the stored config's keys the sheet doesn't know (oauth, timeouts, enabled_tools, …); the writer keeps them.
  async function addTo(full, target, extra = {}) {
    if (target === "everywhere") return store.setEverywhere([...store.read().everywhere.filter((item) => item.name !== full.name), full]);
    const cli = await routing.forAccount(target, "default");
    await write[target].add({ command: cli.command, env: cli.env, cwd, clientVersion, def: full, extra });
  }

  /** Off-list entries for `name` whose account no longer has the server anywhere (Everywhere or its own config) go. */
  async function pruneOff(name) {
    const everywhere = store.read().everywhere.some((def) => def.name === name);
    for (const [key, names] of Object.entries(store.read().off)) {
      if (!names.includes(name)) continue;
      const at = key.indexOf(":");
      const [provider, accountId] = [key.slice(0, at), key.slice(at + 1)];
      try {
        const env = EVERYWHERE_ONLY.has(provider) ? {} : (await routing.forAccount(provider, accountId)).env;
        if (!everywhere && !configNames(provider, env).has(name)) store.setOff(provider, accountId, name, false);
      } catch {
        // An account that can't be looked up keeps its entry; it does no harm.
      }
    }
  }

  /** A renamed server keeps its switches: every account that had the old name off gets the new one. */
  function renameOff(from, to) {
    for (const [key, names] of Object.entries(store.read().off)) {
      if (!names.includes(from)) continue;
      const at = key.indexOf(":");
      store.setOff(key.slice(0, at), key.slice(at + 1), to, true);
    }
  }

  function previousOf(previous) {
    if (previous === undefined || previous === null) return undefined;
    if (!isObject(previous)) throw new Error("Pick where to load it.");
    assertTarget(previous.target);
    assertServerName(previous.name);
    return { name: previous.name, target: previous.target };
  }

  async function save(input, target, previousInput) {
    // Everything is checked before anything is read or written.
    assertTarget(target);
    const previous = previousOf(previousInput);
    const def = normalizeDefinition(input);
    const problem = invalid(def);
    if (problem) throw new Error(problem);
    const stored = previous ? await storedDefinition(previous.name, previous.target) : null;
    const full = unmaskDefinition(def, stored?.def ?? null);
    // Keys the sheet doesn't know survive an edit in the same config that keeps the transport type.
    const extra = stored && previous.target === target && stored.def.type === full.type ? extraKeys(stored.raw, target) : {};
    if (!previous) await addTo(full, target);
    else if (previous.name !== full.name || previous.target !== target) {
      // Moved or renamed: the new server lands first, so a failed add leaves the old one (and its secrets) in place.
      await addTo(full, target, extra);
      await removeFrom(previous.name, previous.target);
      if (previous.name !== full.name) renameOff(previous.name, full.name);
      await pruneOff(previous.name);
    } else {
      // Same place: the CLIs refuse a duplicate name, so remove first and put the old definition back if the add fails.
      await removeFrom(previous.name, previous.target);
      try {
        await addTo(full, target, extra);
      } catch (error) {
        if (stored) await addTo(stored.def, previous.target, extraKeys(stored.raw, previous.target)).catch(() => {});
        throw error;
      }
    }
    emit("mcp:changed", { name: full.name });
  }

  async function saveUrl(def, target, previous) {
    if (def?.type === "stdio") throw new Error("Add command servers on the Mac.");
    return save(def, target, previous);
  }

  async function remove(name, target) {
    assertTarget(target);
    assertServerName(name);
    await removeFrom(name, target);
    await pruneOff(name);
    emit("mcp:changed", { name });
  }

  async function toggle(provider, accountId, name, on) {
    if (!PROVIDERS.has(provider)) throw new Error("Unknown provider.");
    if (typeof accountId !== "string" || !accountId) throw new Error("Unknown account.");
    assertServerName(name);
    store.setOff(provider, accountId, name, !on);
    emit("mcp:changed", { name, provider, accountId });
  }

  // One account at a time, so each browser tab belongs to one sign-in. Resolves once the first account has
  // opened its URL (or finished); the rest runs on and reports through mcp:changed. Every account ends with an
  // event, even when its CLI lookup or runner fails, so no row stays on "signing in".
  async function signIn(name, targets) {
    signIns.get(name)?.abort();
    const controller = new AbortController();
    signIns.set(name, controller);
    const list = (Array.isArray(targets) ? targets : []).filter(
      (target) => target && typeof target === "object" && typeof target.accountId === "string" && sign[target.provider],
    );
    if (!list.length) {
      // Nothing can sign in (an Antigravity-only row, say): end the row's "signing in" at once.
      signIns.delete(name);
      emit("mcp:changed", { name, signIn: "failed", error: "Nothing to sign in to.", last: true });
      return { started: true };
    }
    let firstOpened;
    const opened = new Promise((resolve) => (firstOpened = resolve));
    const all = (async () => {
      try {
        for (const [index, { provider, accountId }] of list.entries()) {
          const last = index === list.length - 1;
          const finish = (signInState, error = null, isLast = last) => {
            // A run that was replaced stays silent; the newer one owns the row.
            if (signIns.get(name) === controller) emit("mcp:changed", { name, provider, accountId, signIn: signInState, error, last: isLast });
          };
          if (controller.signal.aborted) {
            finish("cancelled", null, true);
            break;
          }
          let cancelled = false;
          try {
            const cli = await routing.forAccount(provider, accountId);
            if (controller.signal.aborted) {
              finish("cancelled", null, true);
              break;
            }
            if (cli.problem || !cli.command) {
              finish("failed", cli.problem || "Install the provider CLI first.");
              continue;
            }
            const result = await sign[provider]({
              command: cli.command,
              env: cli.env,
              cwd,
              clientVersion,
              name,
              everywhere: forSessionWith(provider, accountId, cli.env).servers,
              signal: controller.signal,
              openUrl: (url) => {
                openUrl(url);
                firstOpened();
              },
            });
            cancelled = Boolean(result?.cancelled);
            if (cancelled) finish("cancelled", null, true);
            else if (result?.ok || result?.opened) finish("done");
            else finish("failed", result?.error ?? null);
          } catch (error) {
            finish("failed", error instanceof Error ? error.message : String(error));
          }
          firstOpened();
          if (cancelled) break;
        }
      } finally {
        if (signIns.get(name) === controller) signIns.delete(name);
        firstOpened();
      }
    })();
    await Promise.race([opened, all]);
    return { started: true };
  }

  function cancelSignIn(name) {
    signIns.get(name)?.abort();
  }

  async function forSession(provider, accountId) {
    const cli = EVERYWHERE_ONLY.has(provider) ? { env: {} } : await routing.forAccount(provider, accountId);
    return sessionPlan(provider, accountId, cli.env);
  }

  return { accounts: list, check, definition, save, saveUrl, remove, toggle, signIn, cancelSignIn, forSession };
}

module.exports = { createMcp };

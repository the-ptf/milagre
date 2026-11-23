const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createGit } = require("./git/client.cjs");
const { background, scheduled } = require("./process-lanes.cjs");
const { fromGraphql, readPullRequests, PULL_REQUEST_FIELDS, PR_REF, MAX_REFS, pushedBranch } = require("./pull-request.cjs");

const ALIASES = 25;
const RUNNING_MS = 20_000;
const SHOWN_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const LEASE_MS = 90_000;
const FORGET_MS = 30 * 60_000;
const GRID_MS = 5000;
const POKE_MS = 300;
const GATHER_MS = 50;
const BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const QUOTA_FLOOR = 0.2;
const GITHUB_PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;

const grid = (at) => Math.ceil(at / GRID_MS) * GRID_MS;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The GraphQL documents for one repository's reads, at most ALIASES per document. @param {Array<object>} items */
function queries(items) {
  const documents = [];
  for (let start = 0; start < items.length; start += ALIASES) {
    const chunk = items.slice(start, start + ALIASES);
    const local = chunk
      .filter((item) => item.kind !== "url")
      .map((item) =>
        item.kind === "branch"
          ? `${item.alias}: pullRequests(headRefName: ${JSON.stringify(item.branch)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...F } }`
          : `${item.alias}: pullRequest(number: ${item.number}) { ...F }`,
      );
    const remote = chunk
      .filter((item) => item.kind === "url")
      .map(
        (item) =>
          `${item.alias}: repository(owner: ${JSON.stringify(item.owner)}, name: ${JSON.stringify(item.name)}) { pullRequest(number: ${item.number}) { ...F } }`,
      );
    documents.push({
      items: chunk,
      query: `query($owner: String!, $name: String!) { rateLimit { remaining limit resetAt } repository(owner: $owner, name: $name) { id ${local.join(" ")} } ${remote.join(" ")} } fragment F on PullRequest { ${PULL_REQUEST_FIELDS} }`,
    });
  }
  return documents;
}

/** How the repository's query reads a Chat's ref (a pushed branch as that branch's newest PR), or null for gh alone. */
function refItem(ref) {
  const pushed = pushedBranch(ref);
  if (pushed) return { kind: "branch", branch: pushed };
  if (/^\d+$/.test(ref)) return { kind: "number", number: Number(ref) };
  const url = GITHUB_PR.exec(ref);
  return url ? { kind: "url", owner: url[1], name: url[2], number: Number(url[3]) } : null;
}

function createPullRequestWatch({
  exec = promisify(execFile),
  git,
  readRefs,
  onChange = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  env = process.env,
} = {}) {
  const targets = new Map();
  const repos = new Map();
  let timer = null;
  let quotaUntil = 0;
  let closed = false;
  const controller = new AbortController();
  const waiting = new Set();
  const execute = (command, args, options) => {
    controller.signal.throwIfAborted();
    return exec(command, args, { ...options, signal: controller.signal });
  };
  const run = scheduled(execute);
  git ??= createGit({
    execFile(command, args, options, done) {
      controller.signal.throwIfAborted();
      return execFile(command, args, { ...options, signal: controller.signal }, done);
    },
  }).read;
  readRefs ??= (cwd, refs) => readPullRequests(cwd, refs, execute);

  const ghOptions = (cwd) => ({ cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });

  function ask(path, { refs = [], shown = true } = {}) {
    let target = targets.get(path);
    if (!target) {
      target = { path, repo: undefined, resolving: null, head: null, branch: undefined, refs: new Map(), askedAt: 0, leasedUntil: 0 };
      targets.set(path, target);
    }
    target.askedAt = now();
    if (shown) {
      target.leasedUntil = now() + LEASE_MS;
      const repo = target.repo ? repos.get(target.repo) : null;
      if (repo && repo.nextAt > (repo.readAt ?? 0) + SHOWN_MS) {
        repo.nextAt = grid(Math.max(now(), (repo.readAt ?? 0) + SHOWN_MS));
        schedule();
      }
    }
    for (const ref of refs.slice(0, MAX_REFS)) if (typeof ref === "string" && PR_REF.test(ref) && !target.refs.has(ref)) target.refs.set(ref, {});
    return target;
  }

  const unread = (target) => target.branch === undefined || [...target.refs.values()].some((entry) => !("value" in entry));

  function resolveRepo(target) {
    target.resolving ??= (async () => {
      const repo = await background(() => git.commonDir(target.path)).catch(() => null);
      target.repo = repo;
      if (repo && !repos.has(repo)) repos.set(repo, { key: repo, nextAt: Infinity, readAt: null, failures: 0, polling: null });
    })();
    return target.resolving;
  }

  async function ensure(target) {
    if (closed || !unread(target)) return;
    const stopped = Promise.withResolvers();
    waiting.add(stopped.resolve);
    try {
      await Promise.race([readTarget(target), stopped.promise]);
    } finally {
      waiting.delete(stopped.resolve);
    }
  }

  async function readTarget(target) {
    if (closed || !unread(target)) return;
    await resolveRepo(target);
    if (closed) return;
    if (!target.repo) {
      const changed = new Set();
      settle(target, new Map(), new Set(), changed);
      if (changed.size) onChange([...changed]);
      return;
    }
    const repo = repos.get(target.repo);
    for (let attempt = 0; attempt < 2 && unread(target); attempt++) {
      if (closed) return;
      if (repo.polling) {
        await repo.polling;
        continue;
      }
      await new Promise((resolve) => timers.setTimeout(resolve, GATHER_MS));
      if (closed) return;
      if (unread(target)) await (repo.polling ?? poll(repo));
    }
  }

  function poll(repo) {
    if (closed) return Promise.resolve();
    if (repo.polling) return repo.polling;
    repo.polling = background(() => readRepo(repo))
      .catch(() => {})
      .finally(() => {
        repo.polling = null;
        schedule();
      });
    return repo.polling;
  }

  async function graphql(cwd, query) {
    let stdout;
    try {
      ({ stdout } = await run("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${query}`], ghOptions(cwd)));
    } catch (error) {
      // A missing PR number fails only its alias: gh exits 1 but prints the rest of the answer.
      stdout = error?.stdout;
      if (!stdout) throw error;
    }
    const parsed = JSON.parse(stdout);
    if (!parsed?.data) throw new Error(parsed?.errors?.[0]?.message || "GitHub didn't answer.");
    return parsed.data;
  }

  async function readRepo(repo) {
    const startedAt = now();
    const members = [...targets.values()].filter((target) => target.repo === repo.key);
    for (const target of members) if (startedAt - target.askedAt > FORGET_MS) targets.delete(target.path);
    const live = members.filter((target) => targets.has(target.path));
    if (!live.length) {
      repos.delete(repo.key);
      return;
    }
    await Promise.all(
      live.map(async (target) => {
        target.head = (await git.out(target.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null)) || null;
      }),
    );
    if (closed) return;
    const items = [];
    const byKey = new Map();
    const add = (key, item) => {
      if (byKey.has(key)) return;
      const entry = { ...item, alias: `a${items.length}`, key };
      byKey.set(key, entry);
      items.push(entry);
    };
    const others = [];
    for (const target of live) {
      if (target.head) add(`branch:${target.head}`, { kind: "branch", branch: target.head });
      for (const [ref, entry] of target.refs) {
        if (entry.value?.state === "MERGED") continue;
        const item = refItem(ref);
        if (item) add(`ref:${ref}`, item);
        else others.push([target, ref]);
      }
    }
    const found = new Map();
    const missed = new Set();
    let failed = false;
    const cwd = live[0].path;
    await Promise.all(
      queries(items).map(async ({ items: chunk, query }) => {
        try {
          const data = await graphql(cwd, query);
          for (const item of chunk) {
            const node =
              item.kind === "branch"
                ? data.repository?.[item.alias]?.nodes?.[0]
                : item.kind === "number"
                  ? data.repository?.[item.alias]
                  : data[item.alias]?.pullRequest;
            found.set(item.key, fromGraphql(node));
          }
          const quota = data.rateLimit;
          if (quota && Number.isFinite(quota.remaining) && Number.isFinite(quota.limit) && quota.remaining < quota.limit * QUOTA_FLOOR) {
            quotaUntil = Math.max(quotaUntil, Date.parse(quota.resetAt) || now() + IDLE_MS);
          }
        } catch {
          failed = true;
          for (const item of chunk) missed.add(item.key);
        }
      }),
    );
    if (closed) return;
    await Promise.all(
      others.map(async ([target, ref]) => {
        const [value] = await readRefs(target.path, [ref]).catch(() => [undefined]);
        if (value === undefined) missed.add(`ref:${ref}`);
        else found.set(`ref:${ref}`, value ?? null);
      }),
    );
    if (closed) return;
    const changed = new Set();
    for (const target of live) settle(target, found, missed, changed);
    repo.readAt = startedAt;
    repo.failures = failed ? repo.failures + 1 : 0;
    repo.nextAt = failed
      ? now() + Math.min(BACKOFF_MS * 2 ** (repo.failures - 1), MAX_BACKOFF_MS)
      : grid(startedAt + Math.min(...live.map((target) => intervalOf(target, startedAt))));
    if (changed.size) onChange([...changed]);
  }

  function settle(target, found, missed, changed) {
    const take = (current, key) => (found.has(key) && !missed.has(key) ? found.get(key) : (current ?? null));
    const branch = target.head ? take(target.branch, `branch:${target.head}`) : null;
    if (target.branch === undefined || !same(target.branch, branch)) {
      target.branch = branch;
      changed.add(target.path);
    }
    for (const [ref, entry] of target.refs) {
      if (entry.value?.state === "MERGED") continue;
      const value = take(entry.value, `ref:${ref}`);
      if (!("value" in entry) || !same(entry.value, value)) {
        entry.value = value;
        changed.add(target.path);
      }
    }
  }

  function intervalOf(target, at) {
    const values = [target.branch, ...[...target.refs.values()].map((entry) => entry.value)];
    if (values.some((pr) => pr?.state === "OPEN" && pr.checks === "running")) return RUNNING_MS;
    return target.leasedUntil > at ? SHOWN_MS : IDLE_MS;
  }

  function schedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (closed) return;
    let earliest = Infinity;
    for (const repo of repos.values()) if (!repo.polling) earliest = Math.min(earliest, repo.nextAt);
    if (earliest === Infinity) return;
    timer = timers.setTimeout(tick, Math.max(0, earliest - now()));
    timer?.unref?.();
  }

  function tick() {
    timer = null;
    const at = now();
    for (const repo of repos.values()) {
      if (repo.polling || repo.nextAt > at) continue;
      if (at < quotaUntil) repo.nextAt = quotaUntil;
      else void poll(repo);
    }
    schedule();
  }

  return {
    async branch(path) {
      if (closed) return targets.get(path)?.branch ?? null;
      const target = ask(path);
      await ensure(target);
      return target.branch ?? null;
    },
    async refs(path, refs) {
      if (!Array.isArray(refs)) return [];
      if (closed) return refs.slice(0, MAX_REFS).map((ref) => targets.get(path)?.refs.get(ref)?.value ?? null);
      const target = ask(path, { refs });
      await ensure(target);
      return refs.slice(0, MAX_REFS).map((ref) => target.refs.get(ref)?.value ?? null);
    },
    snapshot(entries) {
      if (closed) return { worktrees: {}, chats: {}, pending: false };
      const worktrees = {};
      const chats = {};
      let pending = false;
      for (const { path, refs = [] } of entries) {
        const target = ask(path, { refs });
        if (target.branch !== undefined) worktrees[path] = target.branch;
        for (const ref of refs.slice(0, MAX_REFS)) {
          const entry = target.refs.get(ref);
          if (entry && "value" in entry) (chats[path] ??= {})[ref] = entry.value;
        }
        if (unread(target)) {
          pending = true;
          void ensure(target);
        }
      }
      return { worktrees, chats, pending };
    },
    poke(path) {
      const target = targets.get(path);
      const repo = target?.repo ? repos.get(target.repo) : null;
      if (!repo) return;
      repo.nextAt = Math.min(repo.nextAt, now() + POKE_MS);
      schedule();
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      for (const resolve of waiting) resolve();
      waiting.clear();
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createPullRequestWatch, queries, ALIASES, RUNNING_MS, SHOWN_MS, IDLE_MS, LEASE_MS, FORGET_MS };

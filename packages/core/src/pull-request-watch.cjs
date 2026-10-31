const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createGit } = require("./git/client.cjs");
const { background, scheduled } = require("./process-lanes.cjs");
const { fromGraphql, readPullRequests, PULL_REQUEST_FIELDS, PR_REF, MAX_REFS } = require("./pull-request.cjs");

// The PR each Worktree's branch opened, and the PRs its Chats named, polled by the host for every client: one GraphQL
// query per repository answers up to ALIASES branches and PR numbers, and a client's read answers from what the last
// poll found. A read never waits on GitHub unless nothing was read for it yet. Spec:
// docs/superpowers/specs/2026-10-30-daemon-pr-polling-design.md.

const ALIASES = 25;
// How often a repository is read: while one of its PRs' checks run, while a client shows it, otherwise.
const RUNNING_MS = 20_000;
const SHOWN_MS = 60_000;
const IDLE_MS = 5 * 60_000;
// A client read keeps its Worktree "shown" this long; one nobody asks about for FORGET_MS is no longer polled.
const LEASE_MS = 90_000;
const FORGET_MS = 30 * 60_000;
// Due repositories share one timer on this grid; a poke (a turn's end, a PR write) reads after POKE_MS instead.
const GRID_MS = 5000;
const POKE_MS = 300;
const GATHER_MS = 50;
const BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
// Background polling stops for the hour when less than this share of the GitHub quota is left.
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
      // `id` keeps the repository selection valid when the chunk has only other repositories' PRs.
      query: `query($owner: String!, $name: String!) { rateLimit { remaining limit resetAt } repository(owner: $owner, name: $name) { id ${local.join(" ")} } ${remote.join(" ")} } fragment F on PullRequest { ${PULL_REQUEST_FIELDS} }`,
    });
  }
  return documents;
}

function createPullRequestWatch({
  exec = scheduled(promisify(execFile)),
  git = createGit().read,
  readRefs = (cwd, refs) => readPullRequests(cwd, refs),
  onChange = () => {},
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  env = process.env,
} = {}) {
  /** Worktree path -> what is watched there and what the last read found. */
  const targets = new Map();
  /** Repository (git common dir) -> its polling state. */
  const repos = new Map();
  let timer = null;
  let quotaUntil = 0;
  let closed = false;

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
      // A Worktree someone looks at now is read within SHOWN_MS of the last read, not on the idle cadence.
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

  /** Reads `target` now if nothing was read for it yet; resolves once it has a value (null when GitHub can't say). */
  async function ensure(target) {
    if (!unread(target)) return;
    await resolveRepo(target);
    if (!target.repo) {
      // Not in a Git repository (or it is gone): nothing to ask GitHub.
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
      // First reads arriving together (a snapshot of every Worktree) gather into one poll.
      await new Promise((resolve) => timers.setTimeout(resolve, GATHER_MS));
      if (unread(target)) await (repo.polling ?? poll(repo));
    }
  }

  // Every poll runs in the background lane, a first read too: a slot of each kind stays free for what a person is
  // waiting on (a PR's detail, an open diff), which a burst of first reads would otherwise fill.
  function poll(repo) {
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
      ({ stdout } = await exec("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${query}`], ghOptions(cwd)));
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
    // What to ask: each branch once, and each PR a Chat named that could still change (a merged one can't).
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
        const url = GITHUB_PR.exec(ref);
        if (/^\d+$/.test(ref)) add(`ref:${ref}`, { kind: "number", number: Number(ref) });
        else if (url) add(`ref:${ref}`, { kind: "url", owner: url[1], name: url[2], number: Number(url[3]) });
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
    // PRs on another host than github.com, one by one as before.
    await Promise.all(
      others.map(async ([target, ref]) => {
        const [value] = await readRefs(target.path, [ref]).catch(() => [undefined]);
        if (value === undefined) missed.add(`ref:${ref}`);
        else found.set(`ref:${ref}`, value ?? null);
      }),
    );
    const changed = new Set();
    for (const target of live) settle(target, found, missed, changed);
    repo.readAt = startedAt;
    repo.failures = failed ? repo.failures + 1 : 0;
    repo.nextAt = failed
      ? now() + Math.min(BACKOFF_MS * 2 ** (repo.failures - 1), MAX_BACKOFF_MS)
      : grid(startedAt + Math.min(...live.map((target) => intervalOf(target, startedAt))));
    if (changed.size) onChange([...changed]);
  }

  /** Takes what a read found for `target`; a failed read keeps the last value, or settles a first read as null. */
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
      // Low on GitHub quota: background reads wait for its reset; a client's first read still goes.
      if (at < quotaUntil) repo.nextAt = quotaUntil;
      else void poll(repo);
    }
    schedule();
  }

  return {
    /** The PR `path`'s branch opened (null for none), read now only if never read; keeps `path` shown. */
    async branch(path) {
      const target = ask(path);
      await ensure(target);
      return target.branch ?? null;
    },
    /** The PRs named by `refs` (numbers or URLs), as `readPullRequests` returns them. */
    async refs(path, refs) {
      if (!Array.isArray(refs)) return [];
      const target = ask(path, { refs });
      await ensure(target);
      return refs.slice(0, MAX_REFS).map((ref) => target.refs.get(ref)?.value ?? null);
    },
    /**
     * What is known now for each `{ path, refs }`, without waiting: `pending` when some were never read, which are
     * read right away and reported through `onChange`.
     */
    snapshot(entries) {
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
    /** Reads `path`'s repository again shortly: a turn ended there, or a PR write went through. */
    poke(path) {
      const target = targets.get(path);
      const repo = target?.repo ? repos.get(target.repo) : null;
      if (!repo) return;
      repo.nextAt = Math.min(repo.nextAt, now() + POKE_MS);
      schedule();
    },
    close() {
      closed = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createPullRequestWatch, queries, ALIASES, RUNNING_MS, SHOWN_MS, IDLE_MS, LEASE_MS, FORGET_MS };

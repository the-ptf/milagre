// The token usage page's report (token-usage:read): the transcript scan's rows for a range, priced, cut into hours or
// local days, and credited to Milagre's Projects and Chats. A session is a Chat's when it is (or was) the Chat's
// Claude session or Codex thread; otherwise it belongs to the Project whose folder or Worktree it ran in.
const os = require("node:os");
const path = require("node:path");
const { chatTitle } = require("@milagre/shared/chats");
const { isLinkScopeKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { CHATS_ACCOUNT_LABEL } = require("@milagre/shared/chats-home");
const { priceOf } = require("./token-usage-pricing.cjs");
const { HOUR } = require("./token-usage-scan.cjs");

const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
// The calendar's days, today included; a picked span of days must fall inside it.
const CALENDAR_DAYS = 90;
const TOP_CHATS = 20;
const TOP_PROJECTS = 25;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
// A read starts a scan when the last one is older than this.
const RESCAN_MS = 30_000;
// Projects' Chats are read again at most this often.
const ATTRIBUTION_MS = 30_000;

function emptyTotals() {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    costUsd: 0,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cacheSavingsUsd: 0,
    unpricedTokens: 0,
  };
}

function priceRow(row, price) {
  if (!price) return null;
  return {
    input: row.input * price.input,
    cacheRead: row.cacheRead * price.cacheRead,
    cacheWrite: row.cacheWrite * price.cacheWrite,
    output: row.output * price.output,
    savings: row.cacheRead * Math.max(0, price.input - price.cacheRead),
  };
}

function add(totals, row, cost) {
  totals.input += row.input;
  totals.cacheRead += row.cacheRead;
  totals.cacheWrite += row.cacheWrite;
  totals.output += row.output;
  totals.reasoning += row.reasoning;
  totals.requests += row.requests;
  if (cost) {
    totals.cost.input += cost.input;
    totals.cost.cacheRead += cost.cacheRead;
    totals.cost.cacheWrite += cost.cacheWrite;
    totals.cost.output += cost.output;
    totals.costUsd += cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
    totals.cacheSavingsUsd += cost.savings;
  } else {
    totals.unpricedTokens += row.input + row.cacheRead + row.cacheWrite + row.output;
  }
}

function mergeTotals(into, from) {
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning", "requests", "costUsd", "cacheSavingsUsd", "unpricedTokens"]) {
    into[key] += from[key];
  }
  for (const key of Object.keys(into.cost)) into.cost[key] += from.cost[key];
}

function addSplit(split, provider, tokens, costUsd) {
  const point = (split[provider] ??= { tokens: 0, costUsd: 0 });
  point.tokens += tokens;
  point.costUsd += costUsd;
}

const tokensOf = (totals) => totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
const byCost = (a, b) => b.totals.costUsd - a.totals.costUsd || tokensOf(b.totals) - tokensOf(a.totals);

function validTimeZone(timeZone) {
  if (typeof timeZone === "string" && timeZone) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The calendar's local days, oldest first, each with its hours (hour indexes since the epoch). */
function calendarDays(timeZone, now) {
  const currentHour = Math.floor(now / HOUR);
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const byKey = new Map();
  // Enough hours back to reach the start of the first day in any time zone.
  for (let hour = currentHour - (CALENDAR_DAYS + 1) * 24; hour <= currentHour; hour++) {
    const key = dayOf.format(new Date(hour * HOUR));
    const day = byKey.get(key) ?? { start: hour * HOUR, key, hours: [] };
    day.hours.push(hour);
    byKey.set(key, day);
  }
  return [...byKey.values()].slice(-CALENDAR_DAYS);
}

/**
 * What the report covers: a span of calendar days the user picked (one day reads by the hour), else the range: the last
 * 24 hours, or the last N days with today.
 */
function selection(range, days, calendar, now) {
  const hourly = (hours) => hours.map((hour) => ({ start: hour * HOUR, key: new Date(hour * HOUR).toISOString(), hours: [hour] }));
  if (days) {
    const picked = calendar.filter((day) => day.key >= days.from && day.key <= days.to);
    if (picked.length === 1) return { resolution: "hour", buckets: hourly(picked[0].hours), days };
    if (picked.length > 1) return { resolution: "day", buckets: picked, days };
  }
  if (range === "24h") {
    const currentHour = Math.floor(now / HOUR);
    return { resolution: "hour", buckets: hourly(Array.from({ length: 24 }, (_, i) => currentHour - 23 + i)) };
  }
  return { resolution: "day", buckets: calendar.slice(-RANGES[range]) };
}

function cleanDays(days) {
  if (!days || !DAY_KEY.test(days.from) || !DAY_KEY.test(days.to)) return null;
  return days.from <= days.to ? { from: days.from, to: days.to } : { from: days.to, to: days.from };
}

/** Every Chat owner, including those deliberately kept out of the Project registry. Metadata readers don't open Chats. */
async function readTokenUsageScopes({ registry, chatsHome, projectState, linkState }) {
  const projects = [...(await registry.list())];
  if ((await chatsHome.exists()) && !projects.some((project) => chatsHome.isHome(project.path)))
    projects.push({ path: chatsHome.path, name: CHATS_ACCOUNT_LABEL });
  const entries = await Promise.all(
    projects.map(async (project) => ({
      path: project.path,
      name: chatsHome.isHome(project.path) ? CHATS_ACCOUNT_LABEL : project.name || path.basename(project.path),
      state: await Promise.resolve()
        .then(() => projectState(project.path))
        .catch(() => null),
    })),
  );
  for (const link of await registry.listProjectGroups()) {
    entries.push({
      path: scopeKey({ kind: "link", linkId: link.id }),
      name: link.name,
      state: await Promise.resolve()
        .then(() => linkState(link.id))
        .catch(() => null),
    });
  }
  return entries;
}

/** Projects, Chats home and named Links, their folders and their Chats' native session ids. */
function attributionIndex(projects, worktreeRoot) {
  const sessions = new Map();
  const folders = [];
  const byName = new Map();
  for (const project of projects) {
    const entry = { path: project.path, name: project.name };
    if (!isLinkScopeKey(project.path)) {
      folders.push([project.path, entry]);
      if (!byName.has(path.basename(project.path))) byName.set(path.basename(project.path), entry);
    }
    const state = project.state;
    for (const worktree of Object.values(state?.worktrees ?? {})) {
      if (typeof worktree?.path === "string" && worktree.path !== project.path) folders.push([worktree.path, entry]);
    }
    const firstMessages = new Map();
    for (const message of Array.isArray(state?.messages) ? state.messages : []) {
      if (!firstMessages.has(message.session_id) && message.role !== "assistant" && message.body?.trim()) firstMessages.set(message.session_id, message);
    }
    for (const session of Object.values(state?.sessions ?? {})) {
      if (!session || typeof session.id !== "number") continue;
      const messages = firstMessages.has(session.id) ? [firstMessages.get(session.id)] : [];
      const chat = { project: entry, sessionId: session.id, title: chatTitle(session, messages) };
      if (typeof session.workspacePath === "string") folders.push([session.workspacePath, entry]);
      const ids = [session.native_session_id, ...Object.values(session.native_sessions ?? {})];
      for (const id of ids) if (typeof id === "string" && id) sessions.set(id, chat);
    }
  }
  folders.sort((a, b) => b[0].length - a[0].length || Number(isLinkScopeKey(a[1].path)) - Number(isLinkScopeKey(b[1].path)));
  const projectOfFolder = (cwd) => {
    if (!cwd) return null;
    for (const [folder, entry] of folders) {
      if (cwd === folder || cwd.startsWith(`${folder}${path.sep}`)) return entry;
    }
    // A Worktree Milagre made and later removed: ~/.milagre/worktrees/<project folder name>/<worktree>.
    if (worktreeRoot && cwd.startsWith(`${worktreeRoot}${path.sep}`)) {
      const name = cwd.slice(worktreeRoot.length + 1).split(path.sep)[0];
      return byName.get(name) ?? null;
    }
    return null;
  };
  return { sessions, projectOfFolder };
}

/** "let-s-design-a-pr-7tea" → "Let s design a pr": the name Milagre gave a Worktree from its Chat's first message. */
function worktreeTitle(cwd, worktreeRoot) {
  if (!cwd || !worktreeRoot || !cwd.startsWith(`${worktreeRoot}${path.sep}`)) return "";
  const name = path
    .basename(cwd)
    .replace(/-[a-z0-9]{4}$/, "")
    .replaceAll("-", " ")
    .trim();
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : "";
}

function folderName(cwd) {
  if (!cwd) return "Unknown folder";
  if (cwd === os.homedir()) return "~";
  return path.basename(cwd) || cwd;
}

const homeRelative = (cwd) => (cwd.startsWith(`${os.homedir()}${path.sep}`) ? `~${cwd.slice(os.homedir().length)}` : cwd);

/**
 * The page's report from rows (token-usage-scan rows()), prices (token-usage-pricing models) and Projects
 * ({ path, name, state }). Pure, so tests feed it directly.
 */
function buildReport({ rows, prices, projects, range, days, timeZone, now, worktreeRoot }) {
  range = RANGES[range] ? range : "7d";
  timeZone = validTimeZone(timeZone);
  const calendar = calendarDays(timeZone, now);
  const picked = selection(range, cleanDays(days), calendar, now);
  const { resolution, buckets } = picked;
  const bucketOf = new Map();
  buckets.forEach((bucket, i) => bucket.hours.forEach((hour) => bucketOf.set(hour, i)));
  const dayOf = new Map();
  calendar.forEach((day, i) => day.hours.forEach((hour) => dayOf.set(hour, i)));
  const index = attributionIndex(projects, worktreeRoot);

  const totals = emptyTotals();
  const series = buckets.map((bucket) => ({ start: bucket.start, key: bucket.key, providers: {} }));
  const days90 = calendar.map((day) => ({ key: day.key, start: day.start, tokens: 0, costUsd: 0 }));
  const providers = new Map();
  const models = new Map();
  const groups = new Map();
  const priceCache = new Map();

  for (const row of rows) {
    const inCalendar = dayOf.get(row.hour);
    const at = bucketOf.get(row.hour);
    if (inCalendar === undefined && at === undefined) continue;
    if (!priceCache.has(row.model)) priceCache.set(row.model, priceOf(prices, row.model));
    const price = priceCache.get(row.model);
    const cost = priceRow(row, price);
    const costUsd = cost ? cost.input + cost.cacheRead + cost.cacheWrite + cost.output : 0;
    const tokens = row.input + row.cacheRead + row.cacheWrite + row.output;
    if (inCalendar !== undefined) {
      days90[inCalendar].tokens += tokens;
      days90[inCalendar].costUsd += costUsd;
    }
    if (at === undefined) continue;
    add(totals, row, cost);
    addSplit(series[at].providers, row.provider, tokens, costUsd);

    if (!providers.has(row.provider)) providers.set(row.provider, { provider: row.provider, totals: emptyTotals() });
    add(providers.get(row.provider).totals, row, cost);

    const modelKey = `${row.provider}\t${row.model}`;
    if (!models.has(modelKey)) models.set(modelKey, { provider: row.provider, model: row.model, priced: !!price, totals: emptyTotals() });
    add(models.get(modelKey).totals, row, cost);

    // A session no Chat holds now is an archived or deleted Chat when Milagre started it, else a run outside Milagre.
    // Folders no Project holds go together under Outside Milagre, one row each.
    const chat = row.session ? index.sessions.get(row.session) : undefined;
    const project = chat?.project ?? index.projectOfFolder(row.cwd);
    const groupKey = project ? `project:${project.path}` : "outside";
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        path: project?.path ?? "",
        name: project?.name ?? "Outside Milagre",
        milagre: !!project,
        totals: emptyTotals(),
        providers: {},
        chats: new Map(),
      });
    }
    const group = groups.get(groupKey);
    add(group.totals, row, cost);
    addSplit(group.providers, row.provider, tokens, costUsd);
    const chatKey = chat ? `chat:${chat.sessionId}` : project ? `session:${row.session}` : `folder:${row.cwd}`;
    if (!group.chats.has(chatKey)) {
      group.chats.set(chatKey, {
        ...(chat ? { sessionId: chat.sessionId } : {}),
        kind: chat ? "chat" : !project ? "folder" : row.milagre ? "archived" : "outside",
        title: chat
          ? chat.title || row.title || "Untitled Chat"
          : project
            ? row.title || worktreeTitle(row.cwd, worktreeRoot) || "Untitled session"
            : folderName(row.cwd),
        ...(!project && row.cwd ? { detail: homeRelative(row.cwd) } : {}),
        providers: [],
        totals: emptyTotals(),
        lastAt: 0,
      });
    }
    const entry = group.chats.get(chatKey);
    add(entry.totals, row, cost);
    if (!entry.providers.includes(row.provider)) entry.providers.push(row.provider);
    entry.lastAt = Math.max(entry.lastAt, Math.min(now, (row.hour + 1) * HOUR));
  }

  const projectList = [...groups.values()]
    .map((group) => {
      const chats = [...group.chats.values()].sort(byCost);
      const rest = chats.slice(TOP_CHATS);
      const restTotals = emptyTotals();
      for (const chat of rest) mergeTotals(restTotals, chat.totals);
      return {
        path: group.path,
        name: group.name,
        milagre: group.milagre,
        totals: group.totals,
        providers: group.providers,
        count: chats.length,
        chats: chats.slice(0, TOP_CHATS),
        ...(rest.length ? { more: { count: rest.length, totals: restTotals } } : {}),
      };
    })
    .sort(byCost);
  // Two clones of one repository share a name: each says the folder it sits in.
  const names = new Map();
  for (const project of projectList) if (project.milagre) names.set(project.name, (names.get(project.name) ?? 0) + 1);
  for (const project of projectList) {
    if (project.milagre && names.get(project.name) > 1) project.name = `${project.name} · ${path.basename(path.dirname(project.path))}`;
  }
  const moreProjects = projectList.slice(TOP_PROJECTS);
  const moreTotals = emptyTotals();
  for (const project of moreProjects) mergeTotals(moreTotals, project.totals);

  return {
    range,
    ...(picked.days ? { days: picked.days } : {}),
    timeZone,
    resolution,
    since: buckets[0].start,
    until: (buckets.at(-1).hours.at(-1) + 1) * HOUR,
    generatedAt: now,
    totals,
    series,
    calendar: days90,
    providers: [...providers.values()].sort(byCost),
    models: [...models.values()].sort(byCost),
    projects: projectList.slice(0, TOP_PROJECTS),
    ...(moreProjects.length ? { moreProjects: { count: moreProjects.length, totals: moreTotals } } : {}),
  };
}

/**
 * token-usage:read. A read answers at once from the cache and starts a scan when the last is older than RESCAN_MS;
 * `emit("token-usage:changed")` tells clients to read again when a scan or a price refresh changed something.
 */
function createTokenUsage({ scan, pricing, projects, worktreeRoot, emit = () => {}, now = Date.now }) {
  let attribution = { at: -Infinity, value: null };

  async function readProjects() {
    if (attribution.value && now() - attribution.at < ATTRIBUTION_MS) return attribution.value;
    const value = await projects().catch((error) => {
      console.warn("Milagre couldn't read Projects for token usage:", error.message);
      return [];
    });
    attribution = { at: now(), value };
    return value;
  }

  function startScan() {
    if (scan.scanning() || now() - scan.scannedAt() < RESCAN_MS) return;
    scan.scan().then(
      (changed) => {
        if (changed) emit("token-usage:changed", {});
      },
      (error) => console.warn("Milagre couldn't read token usage:", error.message),
    );
  }

  return {
    async read(request) {
      const firstScan = !scan.finished();
      startScan();
      const report = buildReport({
        rows: scan.rows(),
        prices: pricing.current()?.models ?? null,
        projects: await readProjects(),
        range: request?.range,
        days: request?.days,
        timeZone: request?.timeZone,
        now: now(),
        worktreeRoot,
      });
      return { ...report, refreshing: scan.scanning(), firstScan, pricing: pricing.status() };
    },
  };
}

module.exports = { buildReport, createTokenUsage, readTokenUsageScopes };

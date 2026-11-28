import { doneDueAt } from "./done.mjs";
import { limitHeadline } from "./usage-limit.mjs";
import { currentModelId, currentProvider } from "./providers.mjs";

export const ORCHESTRATOR_MASCOT = Object.freeze({
  version: 1,
  id: "pebble",
  name: "Pebble",
  body: Object.freeze({ path: "M50 18C70 18 88 32 88 54C88 74 72 86 50 86C28 86 12 74 12 54C12 32 30 18 50 18Z" }),
  eyes: Object.freeze({ x: 50, y: 50, spacing: 18, scale: 1.25 }),
});
export const MASCOT_COLORS = Object.freeze(["#ffffff", "#3e9afd", "#3cbb72", "#f68f3c", "#ad46ff", "#ee5c61"]);

export const AUTOPILOT_MODES = Object.freeze(["answer", "ask", "off"]);
export const COMPUTER_PREFERENCES = Object.freeze(["prefer", "normal", "less", "manual", "never"]);
export const VETO_SECONDS = Object.freeze([0, 30, 120, 600]);
export const BOARD_COLUMNS = Object.freeze(["running", "needs", "review", "done"]);
export const TASK_OUTCOMES = Object.freeze([
  { value: "pull-request", label: "PR created" },
  { value: "merged", label: "PR merged" },
  { value: "reply", label: "Agent finished" },
]);
export const TASK_OUTCOME_DESCRIPTION =
  "Applies to new tasks. PR created needs a verified PR; PR merged waits for merge. Choose Agent finished for work that needs no PR.";
export const TASK_PERMISSION_MODES = Object.freeze([
  { value: "chat", label: "Same as new Chats" },
  { value: "ask", label: "Ask for approval" },
  { value: "auto", label: "Auto mode" },
  { value: "full", label: "Full permissions" },
]);
export const TASK_PERMISSION_DESCRIPTION = "Applies to new tasks. Same as new Chats uses the default permission mode of the device you send from.";
export const MEMORY_GROUPS = Object.freeze(["work", "projects", "tools", "other"]);

const PROVIDER_IDS = new Set(["claude", "codex", "antigravity", "kiro", "pi"]);
const HINTS_MAX = 600;
const INSTRUCTIONS_MAX = 4000;
const NOTE_MAX = 300;
const TASKS_KEPT = 200;
const NOTES_KEPT = 200;
export const ORCHESTRATOR_MAX_IMAGES = 10;

export const DEFAULT_ROLES = Object.freeze(
  [
    {
      id: "architecture",
      name: "Architecture",
      description: "Plans structure, boundaries and technical direction.",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "high",
    },
    {
      id: "build",
      name: "Build",
      description: "Fixes bugs and ships features end to end.",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    },
    {
      id: "design",
      name: "Design",
      description: "Works on interface, interaction and visual design.",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    },
    {
      id: "security",
      name: "Security",
      description: "Researches vulnerabilities and recommends hardening.",
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
    },
    { id: "test", name: "Test", description: "Writes and runs tests.", provider: null, model: null, effort: null },
    {
      id: "research",
      name: "Research",
      description: "Reads code and the web to answer a question. Changes nothing.",
      provider: "claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
    },
  ].map((role) => Object.freeze({ ...role, instructions: null })),
);

export const ORCHESTRATOR_DEFAULTS = Object.freeze({
  enabled: false,
  autopilot: "answer",
  vetoSeconds: 30,
  useOtherComputers: true,
  computerPreferences: Object.freeze({}),
  router: Object.freeze({ provider: "claude", model: "claude-haiku-4-5" }),
  whenUnsure: "ask",
  account: "least-used",
  roles: DEFAULT_ROLES,
  projects: Object.freeze({}),
  hideTaskChats: true,
  notify: true,
  outcome: "pull-request",
  permissionMode: "chat",
  mascotColor: "#ffffff",
  name: "Orchestrator",
  boardHidden: false,
  tourDone: false,
});

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const oneLine = (value, max) => (typeof value === "string" ? text(value.replace(/[\r\n]+/g, " "), max) : null);
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);

function normalizeRole(raw, fallback) {
  const base = fallback ?? { id: "", name: "", description: "", provider: null, model: null, effort: null, instructions: null };
  if (!isObject(raw)) return base;
  const saved = currentProvider(raw.provider);
  const provider = PROVIDER_IDS.has(saved) ? saved : raw.provider === null ? null : base.provider;
  const model = provider === null ? null : (currentModelId(text(raw.model, 120)) ?? (provider === base.provider ? base.model : null));
  return {
    id: text(raw.id, 40) ?? base.id,
    name: text(raw.name, 40) ?? base.name,
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, 200) : base.description,
    provider: model ? provider : null,
    model,
    effort: model ? (text(raw.effort, 20) ?? base.effort) : null,
    instructions: text(raw.instructions, INSTRUCTIONS_MAX),
  };
}

function normalizeRoles(raw) {
  if (!Array.isArray(raw)) return DEFAULT_ROLES.map((role) => ({ ...role }));
  const seen = new Set();
  const roles = [];
  for (const entry of raw) {
    const fallback = DEFAULT_ROLES.find((role) => role.id === entry?.id);
    const role = normalizeRole(entry, fallback);
    if (!role.id || !role.name || seen.has(role.id)) continue;
    seen.add(role.id);
    roles.push(role);
  }
  if (!roles.some((role) => role.model)) return DEFAULT_ROLES.map((role) => ({ ...role }));
  return roles;
}

export function normalizeOrchestratorSettings(raw) {
  const value = isObject(raw) ? raw : {};
  const preferences = {};
  if (isObject(value.computerPreferences))
    for (const [id, preference] of Object.entries(value.computerPreferences))
      if (COMPUTER_PREFERENCES.includes(preference)) preferences[String(id).slice(0, 200)] = preference;
  const projects = {};
  if (isObject(value.projects))
    for (const [projectPath, entry] of Object.entries(value.projects))
      if (isObject(entry)) projects[projectPath] = { included: entry.included !== false, hints: text(entry.hints, HINTS_MAX) };
  const router =
    isObject(value.router) && PROVIDER_IDS.has(currentProvider(value.router.provider)) && text(value.router.model, 120)
      ? { provider: currentProvider(value.router.provider), model: currentModelId(text(value.router.model, 120)) }
      : { ...ORCHESTRATOR_DEFAULTS.router };
  return {
    enabled: value.enabled === true,
    autopilot: oneOf(value.autopilot, AUTOPILOT_MODES, ORCHESTRATOR_DEFAULTS.autopilot),
    vetoSeconds: oneOf(value.vetoSeconds, VETO_SECONDS, ORCHESTRATOR_DEFAULTS.vetoSeconds),
    useOtherComputers: value.useOtherComputers !== false,
    computerPreferences: preferences,
    router,
    whenUnsure: oneOf(value.whenUnsure, ["ask", "guess"], ORCHESTRATOR_DEFAULTS.whenUnsure),
    account: oneOf(value.account, ["least-used", "project"], ORCHESTRATOR_DEFAULTS.account),
    roles: normalizeRoles(value.roles),
    projects,
    hideTaskChats: value.hideTaskChats !== false,
    notify: value.notify !== false,
    outcome: normalizeTaskOutcome(value.outcome),
    permissionMode: oneOf(
      value.permissionMode,
      TASK_PERMISSION_MODES.map((option) => option.value),
      ORCHESTRATOR_DEFAULTS.permissionMode,
    ),
    mascotColor:
      typeof value.mascotColor === "string" && /^#[0-9a-f]{6}$/i.test(value.mascotColor) ? value.mascotColor.toLowerCase() : ORCHESTRATOR_DEFAULTS.mascotColor,
    name: oneLine(value.name, 40) ?? ORCHESTRATOR_DEFAULTS.name,
    boardHidden: value.boardHidden === true,
    tourDone: value.tourDone === true,
  };
}

export function normalizeOrchestratorTask(raw) {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.prompt !== "string") return null;
  const reason = isObject(raw.reason) ? raw.reason : {};
  return {
    id: raw.id,
    prompt: raw.prompt.slice(0, 20000),
    outcome: normalizeTaskOutcome(raw.outcome, "reply"),
    title: text(raw.title, 120) ?? titleFromPrompt(raw.prompt),
    projectPath: typeof raw.projectPath === "string" ? raw.projectPath : null,
    worktreeId: typeof raw.worktreeId === "string" ? raw.worktreeId : null,
    sessionId: Number.isInteger(raw.sessionId) ? raw.sessionId : null,
    computer: typeof raw.computer === "string" ? raw.computer : null,
    remoteComputerId: typeof raw.remoteComputerId === "string" ? raw.remoteComputerId : null,
    remoteTaskId: typeof raw.remoteTaskId === "string" ? raw.remoteTaskId : null,
    role: typeof raw.role === "string" ? raw.role : "build",
    provider: PROVIDER_IDS.has(currentProvider(raw.provider)) ? currentProvider(raw.provider) : null,
    model: typeof raw.model === "string" ? raw.model : null,
    effort: typeof raw.effort === "string" ? raw.effort : null,
    accountId: typeof raw.accountId === "string" ? raw.accountId : null,
    reason: {
      project: text(reason.project, 200),
      role: text(reason.role, 200),
      account: text(reason.account, 200),
      computer: text(reason.computer, 200),
    },
    state: oneOf(raw.state, ["routing", "started", "needs-project", "failed"], "routing"),
    error: text(raw.error, 300),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    permissionMode: oneOf(raw.permissionMode, ["ask", "auto", "full"], "auto"),
    answered: Array.isArray(raw.answered) ? raw.answered.filter(isObject).slice(-50) : [],
    images: Number.isInteger(raw.images) && raw.images > 0 ? Math.min(raw.images, ORCHESTRATOR_MAX_IMAGES) : 0,
    limit:
      isObject(raw.limit) && PROVIDER_IDS.has(raw.limit.provider)
        ? { provider: raw.limit.provider, resetsAt: typeof raw.limit.resetsAt === "string" ? raw.limit.resetsAt : null }
        : null,
  };
}

/** What a task's card says while its provider is at its usage limit; `null` when it isn't. */
export function taskLimitText(task, now = new Date()) {
  if (!task?.limit) return null;
  const { title, detail } = limitHeadline(task.limit, now);
  return `${title}. ${detail}`;
}

export function normalizeOrchestratorTasks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeOrchestratorTask).filter(Boolean).slice(-TASKS_KEPT);
}

export function normalizeMemoryNote(raw) {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const value = text(raw.text, NOTE_MAX);
  if (!value) return null;
  return {
    id: raw.id,
    text: value,
    group: oneOf(raw.group, MEMORY_GROUPS, "other"),
    source: text(raw.source, 60) ?? "Milagre",
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
  };
}

export function normalizeOrchestratorMemory(raw) {
  const value = isObject(raw) ? raw : {};
  const trust = {};
  if (isObject(value.trust))
    for (const [kind, entry] of Object.entries(value.trust))
      if (isObject(entry))
        trust[kind] = {
          answered: Math.max(0, Math.floor(Number(entry.answered) || 0)),
          corrected: Math.max(0, Math.floor(Number(entry.corrected) || 0)),
        };
  return {
    notes: Array.isArray(value.notes) ? value.notes.map(normalizeMemoryNote).filter(Boolean).slice(-NOTES_KEPT) : [],
    trust,
    sources: Array.isArray(value.sources)
      ? value.sources.filter(isObject).map((source) => ({
          name: String(source.name ?? "").slice(0, 40),
          count: Math.max(0, Number(source.count) || 0),
          unit: source.unit === "rules" ? "rules" : "notes",
          found: source.found === true,
        }))
      : [],
    importedAt: Number.isFinite(value.importedAt) ? value.importedAt : null,
    importStartedAt: Number.isFinite(value.importStartedAt) ? value.importStartedAt : null,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

const IMPORT_STALE_MS = 5 * 60_000;

/** Whether a memory read is under way; one started over five minutes ago was cut off by a restart and counts as over. */
export function isMemoryImporting(memory, now = Date.now()) {
  const started = memory?.importStartedAt;
  return started != null && (memory.importedAt == null || started > memory.importedAt) && now - started < IMPORT_STALE_MS;
}

export function titleFromPrompt(prompt) {
  let line = String(prompt ?? "")
    .trim()
    .split(/[.?!](?=\s|$)|\n/)[0]
    .replace(/^(can you|could you|please|hey|i want to|i wanna|let's|lets)\s+/i, "")
    .trim();
  if (line.length > 60) line = line.slice(0, 58).replace(/\s+\S*$/, "") + "…";
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "New task";
}

function words(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .filter((word) => word.length > 2);
}

/** Scores each Project by the prompt's overlap with its name and hints; the router model's fallback and its tie-breaker. */
export function keywordRoute(prompt, projects) {
  const asked = ` ${String(prompt ?? "").toLowerCase()} `;
  const prompted = new Set(words(prompt));
  let best = null;
  for (const project of projects) {
    const name = String(project.name ?? "").toLowerCase();
    let score = 0;
    let hit = null;
    if (name && asked.includes(name)) {
      score += 10;
      hit = project.name;
    }
    for (const word of words(project.hints)) {
      if (!prompted.has(word)) continue;
      score += 1;
      hit ??= word;
    }
    if (score > 0 && (!best || score > best.score)) best = { projectPath: project.path, score, hit };
  }
  return best;
}

export function activeRoles(roles) {
  return roles.filter((role) => role.provider && role.model);
}

export function roleById(roles, id) {
  const active = activeRoles(roles);
  return active.find((role) => role.id === id) ?? active.find((role) => role.id === "build") ?? active[0] ?? null;
}

/** The mode a new task runs in: the Orchestrator's setting, or the sending device's own default when it says Same as new Chats. */
export function taskPermissionMode(setting, sent) {
  if (setting === "ask" || setting === "auto" || setting === "full") return setting;
  return sent === "ask" || sent === "full" ? sent : "auto";
}

/** Unknown settings require a PR; a task saved before outcomes existed keeps finishing when its agent does. */
export function normalizeTaskOutcome(value, fallback = ORCHESTRATOR_DEFAULTS.outcome) {
  return oneOf(
    value,
    TASK_OUTCOMES.map((option) => option.value),
    fallback,
  );
}

export const TASK_BLOCKED_TOOL = "task_blocked";
const BLOCKED_PROMPT = `If you can't finish without the owner (an MCP server that needs sign-in, a missing credential or permission, an error only they can fix, a decision only they can make), call the milagre ${TASK_BLOCKED_TOOL} tool with what they must do before you end your turn, and say the same in your reply. The task then waits in Needs you instead of counting as finished.`;

export function taskOutcomePrompt(outcome) {
  if (outcome === "reply") return `Complete the requested work and report the result, including validation and any remaining blockers. ${BLOCKED_PROMPT}`;
  const requirement =
    outcome === "merged"
      ? "The task is Done only after its pull request is merged. Open a pull request with the completed work, then ask the owner before merging. An open PR stays In review."
      : "The task is Done only after a pull request exists for the completed work. Commit the changes, push the task branch and open a pull request.";
  return `${requirement} Include the PR URL in your final reply. Do not stop at local changes or a summary. If a PR cannot be created or the request needs no code changes, explain the blocker to the owner. ${BLOCKED_PROMPT} Never make an empty or unrelated PR to satisfy this requirement. Merging, deploying and publishing still require the owner's approval.`;
}

export const TASK_BLOCKED_MAX = 300;

/** A task_blocked reason as stored: one line, at most TASK_BLOCKED_MAX characters; null when empty. */
export function taskBlockedReason(value) {
  return oneLine(value, TASK_BLOCKED_MAX);
}

/** Why a task waits on its owner, as its agent said with task_blocked; null while a turn runs or once its Chat is Done. */
export function taskBlockedText(session, running = false) {
  if (running || !session || session.done_at || session.archived) return null;
  const reason = taskBlockedReason(session.orchestrator?.blocked?.reason);
  return reason ? `Blocked: ${reason}` : null;
}

/** A Chat's pull requests as one state for the board: an open one wins, then a merged one. */
export function pullRequestState(states) {
  if (states.includes("OPEN")) return "open";
  if (states.includes("MERGED")) return "merged";
  if (states.includes("CLOSED")) return "closed";
  return null;
}

export function taskOutcomeDetail(outcome, pullRequest) {
  if (outcome === "reply") return null;
  if (pullRequest === "closed") return "The PR was closed without merging. Reopen it or create a replacement.";
  if (!pullRequest) return "Required outcome missing: no PR verified. Open the Chat to finish it.";
  if (outcome === "merged" && pullRequest === "open") return "Waiting for the PR to merge.";
  return null;
}

/** A finished turn waits for the task's recorded outcome; marking the Chat Done accepts the task as it is. */
/** The column the owner moved a task Chat to by hand, which holds until its next turn starts; Done is the Chat's own Done mark. */
export function placedColumn(session) {
  const column = session?.orchestrator?.column;
  return column && column !== "done" && BOARD_COLUMNS.includes(column) && !session.archived ? column : null;
}

export function boardColumn({ done, needsYou, pullRequest, finished = false, active = false, outcome = "reply", placed = null }) {
  if (placed) return placed;
  if (needsYou) return "needs";
  if (active) return "running";
  if (done) return "done";
  if (outcome === "reply") return finished ? "done" : "running";
  if (pullRequest === "merged") return "done";
  if (pullRequest === "closed") return "needs";
  if (pullRequest === "open") return outcome === "merged" ? "review" : "done";
  if (finished) return "needs";
  return "running";
}

/** The sidebar's line for tasks in Needs you: the task and why when only one is, else how many; null when none is. */
export function needsYouLine(needs) {
  if (needs.length === 0) return null;
  if (needs.length === 1) return `${needs[0].task.title}. ${needs[0].detail}`;
  return `${needs.length} need you`;
}

/** When a task's Chat became Done on the board's clock (ms): marked Done, or idle after a turn that ended with no pull request; null while it isn't. */
export function taskDoneAt(session, busy = false) {
  if (!session) return null;
  if (session.done_at) return session.done_at;
  const summary = session.summary;
  if (busy || summary?.pullRequests?.length || taskBlockedText(session)) return null;
  return summary?.lastOutcome === "completed" || summary?.lastOutcome === "cancelled" ? (summary.lastAt ?? null) : null;
}

/** Whether a task leaves the board: its Chat is archived or gone, or it has been Done as long as a Done Chat stays in the sidebar. */
export function taskSwept(session, { busy = false, retentionHours, now = Date.now(), outcome = "reply" }) {
  if (!session || session.archived) return true;
  if (placedColumn(session)) return false;
  const doneAt = outcome === "reply" ? taskDoneAt(session, busy) : (session.done_at ?? null);
  if (doneAt === null) return false;
  const due = doneDueAt({ done_at: doneAt }, retentionHours);
  return due !== null && due <= now;
}

const IRREVERSIBLE = [
  /\bgit\s+push\b[^\n;|&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s(origin\s+)?(main|master|production|release)\b)/,
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+release\s+create\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+(branch|tag)\s+-D\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r\b/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\beas(-cli)?\s+(submit|update)\b|\beas(-cli)?\s+build\b[^\n]*--auto-submit/,
  /\bvercel\b[^\n]*--prod\b/,
  /\bwrangler\s+(deploy|publish|delete)\b/,
  /\b(kubectl|terraform)\s+(apply|delete|destroy)\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\b(delete\s+from|truncate(\s+table)?\s+["\w]|alter\s+table|insert\s+into|update\s+["\w.]+\s+set)\b/i,
  /\bsupabase\s+(db\s+(push|reset)|migration\s+(up|repair))\b/,
  /\bcurl\b[^\n]*(-X\s*|--request\s+)(DELETE|POST|PUT|PATCH)\b/,
  /\bgh\s+api\b[^\n]*(-X\s*|--method\s+)(DELETE|POST|PUT|PATCH)\b/,
  /\bsecurity\s+(find-(generic|internet)-password|dump-keychain)\b/,
  /\bstripe\b[^\n]*\b(charges|payouts|refunds)\b/,
];

const IRREVERSIBLE_TOOLS = /^(mcp__.*(send|post|publish|delete|merge|pay|charge|invite|create_issue|comment)|.*(slack|gmail|email|whatsapp|discord).*send)/i;

/** True when an approval or question would do something the user can't take back: never answered by autopilot. */
export function isIrreversible({ tool, command, text: question } = {}) {
  if (typeof command === "string" && IRREVERSIBLE.some((pattern) => pattern.test(command))) return true;
  if (typeof tool === "string" && IRREVERSIBLE_TOOLS.test(tool)) return true;
  if (typeof question === "string" && /\b(merge|deploy|publish|release|delete|pay|purchase|send (it|this|the) (to|email|message))\b/i.test(question))
    return true;
  return false;
}

/** 0 to 1: how much the owner has let autopilot decide this kind of thing without correcting it. */
export function trustScore(entry) {
  const answered = entry?.answered ?? 0;
  const corrected = entry?.corrected ?? 0;
  return (answered + 1) / (answered + corrected * 3 + 2);
}

/** What autopilot does with one pending approval or question. */
export function autopilotDecision({ mode, irreversible, confidence, trust }) {
  if (mode === "off" || irreversible) return "ask";
  const score = (confidence ?? 0.5) * 0.6 + (trust ?? 0.5) * 0.4;
  if (mode === "ask") return score >= 0.5 ? "propose" : "ask";
  if (score >= 0.7) return "answer";
  if (score >= 0.45) return "veto";
  return "ask";
}

/** The autopilot answer waiting out its veto window for a request the task's run still has open, if any. */
export function autopilotPending(task, run, now = Date.now()) {
  const waiting = new Set([...(run?.approvals ?? []), ...(run?.questions ?? [])].map((request) => request.requestId).filter((id) => !run?.answered?.[id]));
  const entries = task?.answered ?? [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!waiting.has(entry.requestId)) continue;
    if (entry.decision !== "vetoed") return null;
    return typeof entry.until === "number" && entry.until > now ? entry : null;
  }
  return null;
}

/** A note autopilot left in a task Chat after answering for the owner. */
export function isOrchestratorAnswer(message) {
  return message?.context?.kind === "orchestrator-answer" && typeof message.context.summary === "string";
}

/** Back-to-back autopilot answers show as one line: the first carries every summary, the rest are hidden. */
const ANSWER_NOTE = /^The Orchestrator answered for you: ([\s\S]*?)\.?$/;

function answerSummary(message) {
  if (isOrchestratorAnswer(message)) return message.context.summary;
  return !message?.context && typeof message?.body === "string" ? (ANSWER_NOTE.exec(message.body.trim())?.[1] ?? null) : null;
}

export function foldOrchestratorAnswers(entries) {
  let lead = null;
  return entries.map((entry) => {
    if (entry.hidden) return entry;
    const summary = answerSummary(entry.message);
    if (summary === null) {
      lead = null;
      return entry;
    }
    if (!lead) {
      lead = { ...entry, message: { ...entry.message, context: { kind: "orchestrator-answer", summary, summaries: [summary] } } };
      return lead;
    }
    lead.message.context.summaries.push(summary);
    return { ...entry, hidden: true };
  });
}

export function recordTrust(trust, kind, outcome) {
  const entry = trust[kind] ?? { answered: 0, corrected: 0 };
  return { ...trust, [kind]: outcome === "corrected" ? { ...entry, corrected: entry.corrected + 1 } : { ...entry, answered: entry.answered + 1 } };
}

/** Picks among a provider's saved accounts: the least used one under its limit, else the Project's. */
export function pickAccount({ mode, accounts, projectAccountId }) {
  const usable = accounts.filter((account) => !account.limited);
  if (mode === "project" || usable.length === 0) return { accountId: projectAccountId ?? null, reason: "The Project's account" };
  const sorted = [...usable].sort((a, b) => (a.usedPercent ?? 0) - (b.usedPercent ?? 0));
  const pick = sorted[0];
  return { accountId: pick.id, reason: Number.isFinite(pick.usedPercent) ? `Least used today (${Math.round(pick.usedPercent)}%)` : "Least used today" };
}

const PREFERENCE_WEIGHT = { prefer: 1.25, normal: 1, less: 0.6, manual: 0, never: 0 };

/** Picks the computer with the most room among those that have the Project; `null` when only this one qualifies. */
export function pickComputer({ candidates, preferences }) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate.online) continue;
    const weight = PREFERENCE_WEIGHT[preferences[candidate.id] ?? "normal"] ?? 1;
    if (weight === 0 && !candidate.local) continue;
    const room =
      (1 - Math.min(1, candidate.cpu ?? 0.5)) * 0.5 + Math.min(1, candidate.memoryFree ?? 0.5) * 0.4 + (1 - Math.min(1, (candidate.agents ?? 0) / 8)) * 0.1;
    const score = room * (weight || 1) + (candidate.local ? 0.05 : 0);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  return best;
}

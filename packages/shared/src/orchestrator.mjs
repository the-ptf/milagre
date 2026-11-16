export const AUTOPILOT_MODES = Object.freeze(["answer", "ask", "off"]);
export const COMPUTER_PREFERENCES = Object.freeze(["prefer", "normal", "less", "manual"]);
export const VETO_SECONDS = Object.freeze([0, 30, 120, 600]);
export const BOARD_COLUMNS = Object.freeze(["running", "needs", "review", "done"]);
export const MEMORY_GROUPS = Object.freeze(["work", "projects", "tools", "other"]);

const PROVIDER_IDS = new Set(["claude", "codex", "antigravity", "kiro"]);
const HINTS_MAX = 600;
const INSTRUCTIONS_MAX = 4000;
const NOTE_MAX = 300;
const TASKS_KEPT = 200;
const NOTES_KEPT = 200;

export const DEFAULT_ROLES = Object.freeze(
  [
    {
      id: "architecture",
      name: "Architecture",
      description: "Plans structure, boundaries and technical direction.",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "high",
      delegation: "prefer",
    },
    {
      id: "build",
      name: "Build",
      description: "Fixes bugs and ships features end to end.",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      delegation: "prefer",
    },
    {
      id: "design",
      name: "Design",
      description: "Works on interface, interaction and visual design.",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      delegation: "prefer",
    },
    {
      id: "security",
      name: "Security",
      description: "Researches vulnerabilities and recommends hardening.",
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      delegation: "always",
    },
    { id: "test", name: "Test", description: "Writes and runs tests.", provider: null, model: null, effort: null, delegation: "prefer" },
    {
      id: "research",
      name: "Research",
      description: "Reads code and the web to answer a question. Changes nothing.",
      provider: "claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
      delegation: "prefer",
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
  mascotColor: "#ffffff",
  boardHidden: false,
  tourDone: false,
});

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);

function normalizeRole(raw, fallback) {
  const base = fallback ?? { id: "", name: "", description: "", provider: null, model: null, effort: null, delegation: "prefer", instructions: null };
  if (!isObject(raw)) return base;
  const provider = PROVIDER_IDS.has(raw.provider) ? raw.provider : raw.provider === null ? null : base.provider;
  const model = provider === null ? null : (text(raw.model, 120) ?? (provider === base.provider ? base.model : null));
  return {
    id: text(raw.id, 40) ?? base.id,
    name: text(raw.name, 40) ?? base.name,
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, 200) : base.description,
    provider: model ? provider : null,
    model,
    effort: model ? (text(raw.effort, 20) ?? base.effort) : null,
    delegation: oneOf(raw.delegation, ["prefer", "always"], base.delegation),
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
    isObject(value.router) && PROVIDER_IDS.has(value.router.provider) && text(value.router.model, 120)
      ? { provider: value.router.provider, model: text(value.router.model, 120) }
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
    mascotColor:
      typeof value.mascotColor === "string" && /^#[0-9a-f]{6}$/i.test(value.mascotColor) ? value.mascotColor.toLowerCase() : ORCHESTRATOR_DEFAULTS.mascotColor,
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
    title: text(raw.title, 120) ?? titleFromPrompt(raw.prompt),
    projectPath: typeof raw.projectPath === "string" ? raw.projectPath : null,
    worktreeId: typeof raw.worktreeId === "string" ? raw.worktreeId : null,
    sessionId: Number.isInteger(raw.sessionId) ? raw.sessionId : null,
    computer: typeof raw.computer === "string" ? raw.computer : null,
    role: typeof raw.role === "string" ? raw.role : "build",
    provider: PROVIDER_IDS.has(raw.provider) ? raw.provider : null,
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
    answered: Array.isArray(raw.answered) ? raw.answered.filter(isObject).slice(-50) : [],
  };
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
      ? value.sources
          .filter(isObject)
          .map((source) => ({ name: String(source.name ?? "").slice(0, 40), count: Math.max(0, Number(source.count) || 0), found: source.found === true }))
      : [],
    importedAt: Number.isFinite(value.importedAt) ? value.importedAt : null,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function titleFromPrompt(prompt) {
  let line = String(prompt ?? "")
    .trim()
    .split(/[.?!\n]/)[0]
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

/** Which board column a task's Chat belongs in. */
export function boardColumn({ done, needsYou, pullRequest }) {
  if (done || pullRequest === "merged" || pullRequest === "closed") return "done";
  if (needsYou) return "needs";
  if (pullRequest === "open") return "review";
  return "running";
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

const PREFERENCE_WEIGHT = { prefer: 1.25, normal: 1, less: 0.6, manual: 0 };

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

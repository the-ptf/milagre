export type AutopilotMode = "answer" | "ask" | "off";
export type ComputerPreference = "prefer" | "normal" | "less" | "manual";
export type BoardColumn = "running" | "needs" | "review" | "done";
export type MemoryGroup = "work" | "projects" | "tools" | "other";
export type OrchestratorProvider = "claude" | "codex" | "antigravity" | "kiro";

export interface OrchestratorRole {
  id: string;
  name: string;
  description: string;
  provider: OrchestratorProvider | null;
  model: string | null;
  effort: string | null;
  delegation: "prefer" | "always";
  instructions: string | null;
}

export interface OrchestratorSettings {
  enabled: boolean;
  autopilot: AutopilotMode;
  vetoSeconds: number;
  useOtherComputers: boolean;
  computerPreferences: Record<string, ComputerPreference>;
  router: { provider: OrchestratorProvider; model: string };
  whenUnsure: "ask" | "guess";
  account: "least-used" | "project";
  roles: OrchestratorRole[];
  projects: Record<string, { included: boolean; hints: string | null }>;
  hideTaskChats: boolean;
  notify: boolean;
  mascotColor: string;
  boardHidden: boolean;
  tourDone: boolean;
}

export interface OrchestratorAnswer {
  at: number;
  kind: string;
  summary: string;
  decision: "answered" | "vetoed" | "asked";
  undone?: boolean;
}

export interface OrchestratorTask {
  id: string;
  prompt: string;
  title: string;
  projectPath: string | null;
  worktreeId: string | null;
  sessionId: number | null;
  computer: string | null;
  role: string;
  provider: OrchestratorProvider | null;
  model: string | null;
  effort: string | null;
  accountId: string | null;
  reason: { project: string | null; role: string | null; account: string | null; computer: string | null };
  state: "routing" | "started" | "needs-project" | "failed";
  error: string | null;
  createdAt: number;
  answered: OrchestratorAnswer[];
}

export interface OrchestratorMemoryNote {
  id: string;
  text: string;
  group: MemoryGroup;
  source: string;
  enabled: boolean;
  createdAt: number;
}

export interface OrchestratorMemory {
  notes: OrchestratorMemoryNote[];
  trust: Record<string, { answered: number; corrected: number }>;
  sources: { name: string; count: number; found: boolean }[];
  importedAt: number | null;
  updatedAt: number;
}

export interface OrchestratorSnapshot {
  settings: OrchestratorSettings;
  tasks: OrchestratorTask[];
  memory: OrchestratorMemory;
}

export const ORCHESTRATOR_MASCOT: {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly body: { readonly path: string };
  readonly eyes: { readonly x: number; readonly y: number; readonly spacing: number; readonly scale: number };
};
export const MASCOT_COLORS: readonly string[];
export const AUTOPILOT_MODES: readonly AutopilotMode[];
export const COMPUTER_PREFERENCES: readonly ComputerPreference[];
export const VETO_SECONDS: readonly number[];
export const BOARD_COLUMNS: readonly BoardColumn[];
export const MEMORY_GROUPS: readonly MemoryGroup[];
export const DEFAULT_ROLES: readonly OrchestratorRole[];
export const ORCHESTRATOR_DEFAULTS: Readonly<OrchestratorSettings>;

export function normalizeOrchestratorSettings(raw: unknown): OrchestratorSettings;
export function normalizeOrchestratorTask(raw: unknown): OrchestratorTask | null;
export function normalizeOrchestratorTasks(raw: unknown): OrchestratorTask[];
export function normalizeMemoryNote(raw: unknown): OrchestratorMemoryNote | null;
export function normalizeOrchestratorMemory(raw: unknown): OrchestratorMemory;
export function titleFromPrompt(prompt: string): string;
export function keywordRoute(
  prompt: string,
  projects: readonly { path: string; name: string; hints: string | null }[],
): { projectPath: string; score: number; hit: string | null } | null;
export function activeRoles(roles: readonly OrchestratorRole[]): OrchestratorRole[];
export function roleById(roles: readonly OrchestratorRole[], id: string): OrchestratorRole | null;
export function boardColumn(input: { done: boolean; needsYou: boolean; pullRequest?: "open" | "merged" | "closed" | null }): BoardColumn;
export function isIrreversible(input?: { tool?: string; command?: string; text?: string }): boolean;
export function trustScore(entry: { answered: number; corrected: number } | undefined): number;
export function autopilotDecision(input: {
  mode: AutopilotMode;
  irreversible: boolean;
  confidence?: number;
  trust?: number;
}): "answer" | "veto" | "propose" | "ask";
export function recordTrust(
  trust: Record<string, { answered: number; corrected: number }>,
  kind: string,
  outcome: "answered" | "corrected",
): Record<string, { answered: number; corrected: number }>;
export function pickAccount(input: {
  mode: "least-used" | "project";
  accounts: readonly { id: string; usedPercent?: number; limited?: boolean }[];
  projectAccountId: string | null;
}): { accountId: string | null; reason: string };
export function pickComputer<T extends { id: string; online: boolean; local: boolean; cpu?: number; memoryFree?: number; agents?: number }>(input: {
  candidates: readonly T[];
  preferences: Record<string, ComputerPreference>;
}): (T & { score: number }) | null;

declare module "./model.ts" {
  interface AgentSession {
    /** An Orchestrator task: off the sidebar while `hidden`, on the account it picked per provider. */
    orchestrator?: { taskId: string; hidden: boolean; accounts?: Partial<Record<string, string>> };
  }
}

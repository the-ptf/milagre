import type { ProjectKind } from "./chats-home.mjs";
import type { ProviderAccount } from "./account-model.js";
import type {
  SubchatAnsweredByContext,
  SubchatEscalationContext,
  SubchatSuggestionContext,
  SubchatSuggestionOutcomeContext,
  SubchatWaitingContext,
  SubchatWakeContext,
} from "./subchat-escalation.mjs";

import type { ContextUsage, ModelMeta, TurnMetrics } from "./model-meta.ts";
import type { GithubIssueContext } from "./github-issue.mjs";
import type { LinearIssueContext } from "./linear.ts";
import type { ValidationContext } from "./validation.mjs";
import type { CheckpointRestoreContext } from "./checkpoint-restore.mjs";

import type { HandoffContext } from "./handoff.mjs";
import type { MessageEditContext } from "./message-edit.mjs";
import type { FlowApproval, FlowPullRequestPreview, FlowReceipt } from "./model-flow-approval.ts";
export type { FlowApproval, FlowPullRequestPreview, FlowReceipt } from "./model-flow-approval.ts";
export type { ChatEditRequest, MessageEditContext } from "./message-edit.mjs";
export type { HandoffContext, CheckpointRestoreContext, GithubIssueContext, LinearIssueContext, ValidationContext };

export type SessionStatus = "Created" | "Running" | "Stopped";
export type ModelProvider = "codex" | "claude" | "antigravity" | "kiro" | "grok" | "pi";
export type PermissionMode = "ask" | "auto" | "full";
export type Isolation = "local" | "worktree";

/** Effort ids come from the agents themselves (Claude: low…max, Codex adds ultra). */
export type EffortLevel = string;

export interface ModelCapability {
  /** Effort levels the model accepts, lightest first. Empty when it has no effort control. */
  efforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  /** Claude only: standing multi-agent orchestration on top of any effort level. */
  ultracode: boolean;
  /** Faster output at higher usage rates: Claude's fast mode (some Opus models), Codex's "priority" tier. */
  fastMode: boolean;
}

export type ModelCapabilities = Record<ModelProvider, Record<string, ModelCapability>>;

export interface ModelOption extends ModelMeta {
  id: string;
  name: string;
  provider: ModelProvider;
  description: string;
  recommended?: boolean;
}

export interface ReportedModel extends ModelCapability, ModelMeta {
  id: string;
  name: string;
  description: string;
  recommended: boolean;
}

/** Each agent's reported models; null when its CLI is missing, too old, or couldn't be asked. */
export type AgentModels = Record<ModelProvider, ReportedModel[] | null>;

/** How an agent's CLI stands, for the model picker (agent:cli-status). `message` is what a turn would fail with. */
export type CliState = "ready" | "missing" | "outdated" | "logged-out" | "broken";
export interface CliStatus {
  state: CliState;
  message?: string;
}
export type { ProviderUpdate } from "./provider-update-view.ts";

export type AgentCliStatus = Record<ModelProvider, CliStatus>;

export interface Project {
  id: number;
  name: string;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  /** CLOSED: closed without merging. Hosts before it came with OPEN and MERGED only. */
  state: "OPEN" | "MERGED" | "CLOSED";
  /** An open draft; absent from hosts that predate it. */
  isDraft?: boolean;
  readyToMerge: boolean;
  hasConflicts: boolean;
  conflictStatusKnown?: boolean;
  /** The base branch requires PRs to be up to date and this one isn't. */
  isBehind?: boolean;
  /** A reviewer requested changes, so the PR can't merge until they're addressed. */
  changesRequested?: boolean;
  /** CI on the open PR. Unset when it has none, or from hosts that predate "passed". */
  checks?: "running" | "failed" | "passed";
}

/** A Project's PRs as the host's poll last found them: each Worktree's branch PR, and each Chat-named PR by folder and ref. */
export interface PullRequestSnapshot {
  worktrees: Record<string, PullRequest | null>;
  chats: Record<string, Record<string, PullRequest | null>>;
  /** Some were never read yet; they come with the next `pull-requests:changed`. */
  pending: boolean;
}

export interface Worktree {
  /** The exact branch Milagre generated; custom templates need no fixed prefix. */
  generatedBranch?: string;
  branchSuffix?: string;
  id: number;
  project_id: number;
  path: string;
  /** The checked-out branch, or the folder name when HEAD is detached. */
  name: string;
  /** The ref a worktree Milagre created started from; its changes are measured against it. */
  base?: string;
  /** A stored Linear issue key. Null means explicitly unlinked; absent allows detection from the branch name. */
  linearIssue?: string | null;
  /** The Linear workspace (its URL key) `linearIssue` belongs to; links saved before workspaces have none. */
  linearWorkspace?: string;
  /** Lines changed against the base, refreshed in the background so the hover card shows it at once. */
  diff?: DiffStat;
  sharedChat?: { linkId: string; sessionId: number };
}

export interface ChatSummary {
  count: number;
  /** The first and last message in the Project's order: when the Chat started, and its latest activity. */
  firstId?: number;
  lastId?: number;
  /** When the Chat last got a message or a reply ended (ms since epoch); absent until that happens on a host that keeps it. */
  lastAt?: number;
  /** When the Chat got its first message (ms since epoch), so Chats of different Projects can be ordered by age; absent on a Chat that began before the host kept it. */
  firstAt?: number;
  /** The first line of the first thing the user wrote, which names a Chat that has no title. */
  titleLine?: string;
  /** How many images that first message carried, so `[Image #N]` in the title line is known to name them; absent when none or not counted. */
  titleImages?: number;
  lastOutcome?: "completed" | "failed" | "cancelled";
  pullRequests?: string[];
  lastModel?: string;
  openHandoff?: number;
  /** The clientMessageId of the Chat's last few sends, so a window without messages finds the Chat its preview became. */
  clientMessageIds?: string[];
  /** The Linear issue the Chat's first message is the card of (key and workspace), so a comment on it finds the Chat. */
  linearIssue?: string;
  linearWorkspace?: string;
}

export interface AgentSession {
  id: number;
  worktree_id: number;
  agent_name: string;
  status: SessionStatus;
  summary?: ChatSummary;
  provider?: ModelProvider;
  native_session_id?: string;
  /** Session ids of the providers this chat is not on right now, so switching back resumes them. */
  native_sessions?: Partial<Record<ModelProvider, string>>;
  subagents?: Subagent[];
  /**
   * The background work the Chat's agent process reports besides its subagents (a command run in the background, an MCP
   * task, a workflow), live while that process runs; absent when there is none (chat-activity.mjs).
   */
  backgroundTasks?: BackgroundTask[];
  plan?: ChatPlan;
  generatedTitle?: string;
  titlePending?: boolean;
  /** A name the user gave the chat. */
  title?: string;
  /** A turn ended while the chat wasn't open, or the user marked it unread. */
  unread?: boolean;
  /** Hidden from the chat list. */
  archived?: boolean;
  /** Shown in the chat list's Pinned section, above the rest, in `pin_order`. */
  pinned?: boolean;
  /** Where a pinned chat sits among the pinned ones, lowest first. Kept when unpinned; only read while pinned. */
  pin_order?: number;
  /** When the user marked the chat Done (host clock, ms): it sits in the Done list until the host archives it (done.mjs). */
  done_at?: number;
  /** While ahead (ms): the chat is snoozed, in the Snoozed list and quiet, until then or until it needs the user (snooze.mjs). */
  snoozed_until?: number;
  /** Legacy (before in-place handoff): the chat this one was handed over to, on the other provider. Read, never written. */
  handedOverTo?: number;
  /** Legacy (before in-place handoff): the chat this one was handed over from. Read, never written. */
  handedOverFrom?: number;
  /** Legacy (before in-place handoff): set while the handover brief is being written; the composer waits. Read, never written. */
  handoverPending?: boolean;
  /** Legacy (before in-place handoff): the handover brief, waiting in the composer for the user to review and send. Read, never written. */
  handoverDraft?: string;
  /** Set when a quit stopped this chat's turn: when, so a stale one waits for Continue instead of resuming by itself. */
  resumeTurn?: { stoppedAt?: number };
  limitResume?: LimitResume;
  limitTurn?: { sourceMessageId: number };
  contextUsage?: ContextUsage;
  suggestion?: { text: string; turnId: string };
  suggestionTurnId?: string;
  /**
   * The Routine and Run that started this Chat; set only on a Chat a Run created. `hidden` keeps it out of every Chat list
   * until it waits on an approval or question; it is absent on a Chat made before Run Chats were hidden.
   */
  routine?: { routineId: string; runId: string; hidden?: boolean };
  /**
   * Set on a Run's Chat whose Worktree Milagre removed once the Run ended leaving nothing in it: the Chat is archived and
   * kept on the Project folder's Worktree so its Run's history still opens it, and a send into it is refused.
   */
  formerWorktree?: { path: string; name: string; branch?: string };
  readOnlyReason?: string;
  /** The permission mode the Chat's composer last set (a pick, or a person's message); a heartbeat's beat runs in it. */
  permissionMode?: PermissionMode;
  /**
   * The Chat (session id, same Project) whose Delegation first reached this one: it shows as that Chat's subchat, nested
   * under it in the Chat lists and opened beside it (subchats.ts). Set once by the host; absent on a top-level Chat.
   */
  parent?: number;
  /**
   * Messages waiting for a later turn, by explicit choice or because the provider can't steer, oldest first. Each
   * starts a turn of its own when the one before it completes; Send now and Remove act on one (chat-host.cjs).
   */
  queued?: QueuedMessage[];
  /** Stop, or a turn that failed, ended the turn the queue waited on: the queue waits for Send now instead of starting. */
  queueHeld?: boolean;
  /**
   * The suggestion cards in this Chat that have no outcome yet, kept so a restart can close them: a request is in memory,
   * so its card would otherwise stay answerable forever (subchat-escalation.cjs in core).
   */
  openSuggestions?: { id: string; fromTitle: string }[];
  forkedFrom?: { sessionId: number; messageId?: number };
}

/**
 * A message waiting for the running turn to end (AgentSession.queued). It becomes a ChatMessage when its turn starts.
 * The host also keeps the send's prompt and turn options on it, which clients don't read.
 */
export interface QueuedMessage {
  id: string;
  body: string;
  images?: ImageAttachment[];
  files?: string[];
  context?: ChatContext;
  model: string;
  provider: ModelProvider;
  queuedAt: number;
  clientMessageId?: string;
}

export interface BackgroundTask {
  id: string;
  kind: string;
  title: string;
  startedAt: number;
}

/** The end of a background command's output (chat:task-output): the last 8 KiB it wrote, escape sequences included. */
export interface BackgroundTaskOutput {
  output: string;
  totalBytes: number;
  truncated: boolean;
}

export type { ContextUsage, TurnMetrics } from "./model-meta.ts";

export type ChatScope = { kind: "project"; projectPath: string } | { kind: "link"; linkId: string };
export interface NamedProjectLink {
  id: string;
  name: string;
  projectIds: string[];
  createdAt: string;
  hidden?: boolean;
  /** An existing canvas Link whose Worktrees were adopted, rather than created for this group. */
  canvasLinkId?: string;
  /** The member whose design system the Link's Chats follow; the first member when absent. Not a member: its Chats' screens are frozen. */
  designSystemProjectId?: string;
}
export type NamedLinkDeleteCheck = { chats: number; running: string[] };
export interface NamedLinkDeleted {
  removed: string[];
  kept: string[];
}
export interface WorktreeBinding {
  projectId: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  base: string;
  alias?: string;
}
export interface LinkChatSession extends Omit<AgentSession, "worktree_id"> {
  workspacePath: string;
  worktrees: WorktreeBinding[];
}
export interface LinkPreparation {
  operationId: string;
  chatId: number;
  /** "ready" once the workspace folder exists. The others come from preparations saved before Worktrees were made on demand. */
  status: "reserved" | "creating" | "setup" | "ready" | "failed";
  members: Array<WorktreeBinding & { created?: boolean; setupDone?: boolean; setupDeferred?: boolean; retained?: boolean; error?: string }>;
  workspacePath: string;
  error?: string;
  retainedPaths?: string[];
}
export interface PersistenceFailure {
  error: string;
  code?: string;
  saving: boolean;
}

export interface LinkState {
  adoptionPending?: boolean;
  releasedAt?: string;
  persistence?: PersistenceFailure;
  /** From a host that keeps messages by Chat (chat-pages-v1): `messages` is empty, and the Chats on screen read their own. */
  messagesInChats?: boolean;
  next_id: number;
  sessions: Record<string, LinkChatSession>;
  messages: ChatMessage[];
  preparations: Record<string, LinkPreparation>;
  /** When link:delete marked the Link deleted; every device leaves a Link whose state has it. */
  deletedAt?: string;
}
export interface OpenLink {
  link: NamedProjectLink;
  state: LinkState;
  projects: Array<{ id: string; path: string; name: string }>;
}

export interface ChatMessage {
  id: number;
  clientMessageId?: string;
  session_id: number;
  body: string;
  context: ChatContext;
  role?: "user" | "assistant";
  model?: string;
  images?: ImageAttachment[];
  files?: string[];
  /** Legacy (before in-place handoff): on the first message of a handed-over chat, the brief it was sent with, ahead of `body`. Read, never written. */
  handoverBrief?: string;
  outcome?: "completed" | "failed" | "cancelled";
  steps?: ChatStep[];
  /** Kiro only: what the turn cost, in credits, as the agent reported it. */
  credits?: number;
  /** The host's sidecar with the long details of these steps (each marked `hasDetail`); read with the chat:message command. */
  detailFile?: string;
  operationId?: string;
  answered?: AnsweredQuestion[];
  /** The host's handle on this message in the provider's own session, so editing it can rewind there. */
  native?: { provider: ModelProvider; prompt?: string; turn?: string; steered?: boolean };
}

/** One question the user answered, as their message keeps it. A typed answer to a secret question is masked. */
export interface AnsweredQuestion {
  header: string;
  question: string;
  answers: string[];
}

/**
 * A manual or automatic compaction, shown as a divider like a handoff. A manual request keeps `/compact` as its body;
 * an automatic compaction is an assistant message with an empty body. `before` and `after` are the window's tokens
 * around it; `size` is the window.
 */
export type CompactionContext = {
  automatic?: boolean;
  quiet?: boolean;
  threshold?: number;
  kind: "compaction";
  status: "preparing" | "done" | "failed";
  before?: number;
  after?: number;
  size?: number;
};

export type AdvisorResultContext = {
  kind: "advisor-result";
  advisorId: string;
  completionId: string;
  title: string;
  provider: ModelProvider;
  outcome: "completed" | "failed" | "cancelled";
  mode?: "analysis" | "execution";
  images?: ImageAttachment[];
};

export type PullRequestBlocker = "conflicts" | "changes-requested" | "checks-failed" | "behind";

export type PullRequestActionContext = { kind: "pr-action"; action: PullRequestBlocker; pr: number; url: string };

export type WorktreeLinkedContext = {
  kind: "worktree-linked";
  linkId: string;
  project: { name: string; path: string };
  sameProject: boolean;
  branches: string[];
  summary?: string;
};

export type ChatReloadContext = { kind: "reload" };

/**
 * What starts a Routine: the clock, a change in a Linear workspace, or a POST to its webhook URL. A webhook's `hookId` is
 * the hex sha256 of the secret in the URL, so the Routine never holds the secret itself; `signed` says an HMAC is checked.
 */
export type RoutineTrigger =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "linear"; workspace: string; event: "assigned" | "label-added" | "state" | "comment"; team?: string; label?: string; state?: string }
  | { kind: "webhook"; hookId: string; signed: boolean };

export type RoutineTarget = { kind: "chat"; chatId: string } | { kind: "new-chat"; projectPath: string; workspace: "worktree" | "project" };

export interface LinearIssueSnapshot {
  id: string;
  key: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  state: string;
  /** The state's type and color, for the issue card; absent on a snapshot taken before they were kept. */
  stateType?: string;
  stateColor?: string;
  team: string;
  assignee?: string;
  workspace: string;
}

export interface LinearCommentSnapshot {
  id: string;
  body: string;
  author: string;
  createdAt: number;
}

/** What made a Routine run, kept on its Run. `key` identifies the event so one change never starts two Runs. */
export type RoutineEvent =
  | { kind: "schedule" }
  | { kind: "linear"; key: string; change: "assigned" | "label-added" | "state" | "comment"; issue: LinearIssueSnapshot; comment?: LinearCommentSnapshot }
  | { kind: "webhook"; key: string; deliveryId: string };

/**
 * How a Run ended or stands. `ended` is a flow Run that stopped without failing: an approval rejected or expired, or ended
 * by hand. It never counts toward the failed streak.
 */
export type RoutineRunStatus = "running" | "acted" | "quiet" | "failed" | "skipped-busy" | "missed" | "ended";

/**
 * A field a flow step gives the steps after it. `choice` takes one of `choices`; `yes-no` is a boolean; `link` an http(s)
 * URL. Later steps read it as `{{<stepId>.<name>}}`.
 */
export interface FlowField {
  name: string;
  type: "text" | "choice" | "yes-no" | "number" | "link";
  choices?: string[];
  description?: string;
}

export type FlowStep = FlowAgentStep | FlowIfStep | FlowAskStep | FlowWaitStep | FlowPullRequestStep | FlowCommentStep;
export type FlowStepKind = FlowStep["kind"];

/**
 * A turn in a Chat. `chat: "run"` uses the Run's Chat (made by the first agent step, in the Run's Worktree); `own` starts a
 * Chat of its own in the same Worktree. The agent hands `output` back through the flow_step_output tool. `retries` is how
 * many more turns it gets after a failed one; `onInvalid: "ask-once"` sends one follow-up when a turn ended without a valid
 * output.
 */
export interface FlowAgentStep {
  id: string;
  name: string;
  kind: "agent";
  prompt: string;
  provider?: ModelProvider;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  chat: "run" | "own";
  output: FlowField[];
  retries: number;
  onInvalid: "ask-once" | "stop";
}

export interface FlowIfStep {
  id: string;
  name: string;
  kind: "if";
  /** `<stepId>.<field>` or `trigger.<path>`. */
  field: string;
  test: "is" | "is-not" | "contains" | "is-set";
  value?: string;
  yes: FlowStep[];
  otherwise: FlowStep[];
}

export interface FlowAskStep {
  id: string;
  name: string;
  kind: "ask";
  message: string;
  expiresInHours: number;
}

export interface FlowWaitStep {
  id: string;
  name: string;
  kind: "wait";
  until: { kind: "time"; minutes: number } | { kind: "linear-state"; state: string } | { kind: "pr-review" };
  /** For a Linear state or a review: how long to wait before the step fails. */
  timeoutHours: number;
}

export interface FlowPullRequestStep {
  id: string;
  name: string;
  kind: "pull-request";
  title: string;
  body: string;
  base?: string;
  draft: boolean;
  askFirst: boolean;
}

export interface FlowCommentStep {
  id: string;
  name: string;
  kind: "linear-comment";
  body: string;
}

/**
 * A Routine's flow: the published steps every new Run uses (`revision` counts publishes) and the draft being edited. A Run
 * keeps a copy of the steps it started with, so publishing never changes a Run in progress.
 */
export interface RoutineFlow {
  revision: number;
  steps: FlowStep[];
  publishedAt: number;
  draft?: { steps: FlowStep[]; updatedAt: number };
}

export type FlowStepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped" | "not-run";

/** A step's part of a Run. `tries` are the turns that failed before this one; `taken` is the path an If took. */
export interface FlowStepRun {
  status: FlowStepStatus;
  startedAt?: number;
  endedAt?: number;
  chatId?: string;
  output?: Record<string, string | number | boolean>;
  error?: string;
  /** What the step says it did, in a few words: "complexity large, area relay", "Opened draft #861". */
  summary?: string;
  tries?: Array<{ startedAt: number; endedAt: number; error: string; chatId?: string }>;
  taken?: "yes" | "otherwise";
  note?: string;
  askedForOutput?: boolean;
  turnEnded?: boolean;
  approval?: FlowApproval;
  receipt?: FlowReceipt;
  intentAt?: number;
  intentPreview?: FlowPullRequestPreview;
  waitUntil?: number;
  checkedAt?: number;
}

/**
 * A flow Run's progress, on its RoutineRun. `steps` is the revision it started on. `status` is `waiting` while a step waits
 * for approval or a wait; `paused` once the owner paused it (the step under way finishes, the next one doesn't start).
 */
export interface FlowRun {
  revision: number;
  steps: FlowStep[];
  state: Record<string, FlowStepRun>;
  status: "running" | "waiting" | "paused" | "done" | "failed" | "ended";
  /** A simulation: agents use sample or saved fields; actions and waits are skipped and approvals pass. */
  dryRun?: boolean;
  /** Set while paused and asked to pause. */
  pauseRequested?: boolean;
}

/**
 * The model a Run in a Chat of its own retries on, once, when its attempt fails for a provider-side reason (the model at
 * capacity, a rate or usage limit, the agent exiting unexpectedly). A Routine without one retries on another installed
 * provider's recommended model.
 */
export interface RoutineFallback {
  provider: ModelProvider;
  model: string;
  effort?: EffortLevel;
}

export interface RoutineRunAttempt {
  chatId?: string;
  worktreeId?: string;
  provider?: ModelProvider;
  model?: string;
  effort?: EffortLevel;
  startedAt: number;
  endedAt: number;
  error: string;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  trigger: RoutineTrigger;
  target: RoutineTarget;
  provider?: ModelProvider;
  model?: string;
  permissionMode?: string;
  /** What a Run retries on after a provider-side failure; unset, another installed provider's recommended model. */
  fallback?: RoutineFallback;
  enabled: boolean;
  createdBy: { kind: "agent"; chatId: string } | { kind: "user" };
  maxRuns?: number;
  expiresAt?: number;
  nextRunAt?: number | null;
  lastRunAt?: number;
  runCount: number;
  /** Counted Runs in a row that failed; three end a heartbeat and pause a trigger. Re-enabling a paused trigger clears it. */
  failedStreak?: number;
  /** Why a trigger was switched off by itself, e.g. "3 failed runs in a row: <last error>". Cleared when it is switched on again. */
  pausedReason?: string;
  /** The latest system error about the Routine itself, apart from its Runs (e.g. "Linear sign-in needed"); cleared when it is fixed. */
  lastError?: string;
  /** A signed webhook's signature header, lowercased; "sentry-hook-signature" when absent. The signing secret never leaves the Mac. */
  signingHeader?: string;
  flow?: RoutineFlow;
  completedAt?: number;
  /** Why it ended, when whatever ended it said: a babysit stop reason, "expired", "max runs", "chat gone"… */
  completedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  scheduledFor?: number;
  startedAt: number;
  endedAt?: number;
  status: RoutineRunStatus;
  chatId?: string;
  worktreeId?: string;
  event?: RoutineEvent;
  summary?: string;
  title?: string;
  error?: string;
  rejected?: boolean;
  /** Earlier attempts that failed for a provider-side reason; `chatId` and `status` are the last attempt's. */
  attempts?: RoutineRunAttempt[];
  fallback?: RoutineFallback;
  flow?: FlowRun;
}

/**
 * The divider a Routine's run leaves in its Chat. `quiet` and `summary` are set once the reply is known to be a "(pass)".
 * `label` is what an acted divider says before the time, "Heartbeat" when it is left out: "Routine · <name>" on a new Chat's
 * first message, "Linear comment · <author>" on a comment sent into a linked Chat.
 */
export type RoutineRunContext = {
  kind: "routine-run";
  routineId: string;
  runId: string;
  name: string;
  at: number;
  label?: string;
  /**
   * A Babysit PRs Run: the level it went at (1 when the Worktree is on another branch, which `offBranch` says) and whether it
   * may resolve threads (the setting, at a level that replies).
   */
  babysit?: { level: number; resolveThreads: boolean; offBranch?: boolean };
  quiet?: boolean;
  summary?: string;
};

export type BabysitStopReason = "merged" | "closed" | "green" | "failures" | "expired" | "own-rule" | "deleted";

/**
 * The line Milagre writes in a Chat when the Heartbeat babysitting its PR ended (babysitStoppedText in babysit.mjs says it).
 * `times` is the failures rule's count, `days` how long the Heartbeat watched.
 */
export type BabysitStoppedContext = {
  kind: "babysit-stopped";
  routineId: string;
  pr: number;
  reason: BabysitStopReason;
  times?: number;
  days?: number;
};

export type ChatContext =
  | { kind: "chat-fork"; from: string; title: string; messageId?: number }
  | MessageEditContext
  | AdvisorResultContext
  | WorktreeLinkedContext
  | LinkedContext
  | { kind: "orchestrator-answer"; summary: string; summaries?: string[] }
  | HandoffContext
  | CompactionContext
  | PullRequestActionContext
  | LinearIssueContext
  | GithubIssueContext
  | UsageLimitContext
  | AccountSwitchContext
  | { kind: "limit-reset" | "git-action" }
  | ChatReloadContext
  | RoutineRunContext
  | BabysitStoppedContext
  | CheckpointRestoreContext
  | ValidationContext
  | SubchatWaitingContext
  | SubchatEscalationContext
  | SubchatSuggestionContext
  | SubchatSuggestionOutcomeContext
  | SubchatAnsweredByContext
  | SubchatWakeContext
  | "handover"
  | null;

/**
 * What a message no person typed is (`ChatMessage.context`): a Delegation from another Chat, a Delegation
 * report coming back, a message another Chat sent, a Negotiation's agreement, or a notice about one. `from` is the other Chat's key.
 */
export type LinkedContext =
  /** `from` is null for a Delegation another computer sent: its Chat isn't on this one. */
  | { kind: "delegation"; delegationId: string; from: string | null; fromLabel: string; negotiation?: { id: string; round: number } }
  | {
      kind: "delegation-report";
      delegationId: string;
      from: string | null;
      fromLabel: string;
      status: "done" | "cancelled" | "failed";
      negotiation?: { id: string; round: number };
    }
  | { kind: "negotiation-agreement"; negotiationId: string; with: string; by?: string }
  | { kind: "chat-message"; from: string | null; fromLabel: string }
  | { kind: "linked-notice"; negotiationId?: string; delegationId?: string; with?: string };

export interface OpenDelegation {
  id: string;
  link_id: string | null;
  /** Null on the computer that runs another computer's Delegation. */
  from_chat: string | null;
  to_chat: string | null;
  from_label: string;
  to_label: string;
  status: "queued" | "running";
  negotiation_id?: string;
  round?: number;
  message: string;
  computer?: { id: string; name: string };
}

export interface RunningNegotiation {
  id: string;
  link_id: string | null;
  chats: [string, string | null];
  labels: [string, string];
  round: number;
}

/** The open work across Links (linked:snapshot, linked:changed). `receiveOnly` lists Codex Chats that can't use the linked tools. */
export interface LinkedWork {
  delegations: OpenDelegation[];
  negotiations: RunningNegotiation[];
  receiveOnly: string[];
}

export type StepKind = "shell" | "edit" | "read" | "search" | "other" | "thinking" | "setup" | "image" | "artifact";

export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
  /** Older transcript entries have no format; resolve them through the host's catalog. */
  format?: "design" | "html";
  /** An immutable HTML reply displayed in the transcript, independent of the live Artifact page. */
  inline?: boolean;
  height?: number;
  /** The part of the app a design belongs to; the canvas lays out one row per group. */
  group?: string;
}

/**
 * One tool call in an agent's reply, or a stretch of its thinking. A `setup` step is the worktree's setup command,
 * which Milagre ran.
 */
export interface ChatStep {
  /** Identifies one step across start, output and completion. A viewed snapshot needs a distinct ID from its source Read step. */
  id: string;
  kind: StepKind;
  /** Host time when this step first started. Older hosts omit it; clients show no duration for the running step. */
  startedAt?: number;
  endedAt?: number;
  source?: { name: string; server?: string };
  /** Bounded, redacted arguments for the detail panel. Large documents are not retained here. */
  input?: string;
  summary?: string;
  error?: string;
  /** What it did, e.g. "Ran `npm test`"; text between backticks is code. */
  title: string;
  /** Saved steps are done or failed; only a reply still streaming has running ones. */
  status: "running" | "done" | "failed";
  description?: string;
  /** The command and its output, a unified diff, or the thinking summary, capped at 20,000 characters. */
  detail?: string;
  /**
   * The detail is left out and kept elsewhere. A saved message keeps a long detail in a sidecar on the host (desktop:
   * the chat:message command; phone: GET /message). The phone also leaves out what the host still has inline, and for a
   * turn still streaming it keeps only the tail of the last few steps and of running ones, with no full message to
   * fetch until the turn ends.
   */
  hasDetail?: boolean;
  /** The file a read or edit worked on, as the tool named it; the title shows only its name. For an image step, its generated image or snapshot. */
  file?: string;
  /** The files of a change that edited several (a Codex patch), which has no single `file`; a reply's file links match them too. */
  files?: string[];
  imageOrigin?: "viewed";
  sourceFile?: string;
  note?: string;
  durationMs?: number;
  /** Where the step sits in the reply: the length of the reply's text when it started. */
  offset?: number;
  artifact?: ArtifactRef;
  tool?: "design_show" | "design_apply" | "artifact_show" | "html_render";
  agent?: string;
  routine?: { id: string; name: string };
}

export interface ImageAttachment {
  path?: string;
  id: string;
  name: string;
  /** Draft and legacy images use dataUrl; persisted images use path. */
  dataUrl?: string;
  /** Original file attachment when path points at the durable image copy. */
  sourcePath?: string;
}

export interface PermissionRequest {
  requestId: string;
  kind: "command" | "edit" | "other" | "delegation" | "setup";
  setup?: { projectPath: string; source: string; computer: string };
  tool: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  /** A unified diff (or the new content), capped at 20,000 characters. */
  diff?: string;
  files?: string[];
  detail?: string;
  reason?: string;
  allowForChat: boolean;
  stepId?: string;
  /** On a Delegation's card: where it goes ("Project / branch / Chat"), what it says, and whether it opens a Negotiation. */
  /** `computer`: the paired computer it goes to, for a Delegation to another computer (Always allow covers that computer). */
  delegation?: { target: string; message: string; negotiation: boolean; computer?: string };
}

export type PermissionDecision = "allow" | "allow-for-chat" | "deny";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  /** Unique within its request; answers are keyed by it. */
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  secret: boolean;
}

export interface QuestionRequest {
  requestId: string;
  /** `saveAs`: the agent named the secret, so the card can also save it under that name, to this Project or all of them. */
  secretRequest?: { description: string; expiresAt?: number; saveAs?: { name: string; project: boolean; replaces: boolean } };
  /**
   * Host-owned Milagre bug report (bug-reports.cjs): the exact redacted text to approve. The answer is `{ title, body }`
   * (edited or not), or null to cancel; text that needs more redacted comes back as a new request with `recheck`.
   */
  bugReport?: { repo: string; title: string; body: string; expiresAt?: number; redactions?: number; recheck?: boolean };
  questions: AgentQuestion[];
}

export type QuestionAnswers = Record<string, string[]>;

/** Images attached to the answers, per question id: the agent gets their paths with that question's answer. */
export type QuestionImages = Record<string, ImageAttachment[]>;

export type QuestionOutcome = "answered" | "dismissed" | "cancelled";

export interface Subagent {
  id: string;
  source?: "milagre-advisor";
  mode?: "analysis" | "execution";
  provider?: ModelProvider;
  model?: string;
  retryable?: boolean;
  archived?: boolean;
  parentId?: string;
  background?: boolean;
  agentType?: string;
  title: string;
  prompt?: string;
  status: "initializing" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  latestActivity?: string;
  tasks?: AgentTask[];
  progress?: SubagentProgress;
  transcript: SubagentTranscriptEntry[];
  /**
   * How many entries the transcript has, when `transcript` holds only its last ones (a client that reads transcripts on
   * demand, see subagent-transcript.mjs); absent when it holds them all.
   */
  transcriptLength?: number;
  /**
   * Set on an archived subagent sent as a summary, without its prompt, latest activity or transcript (a
   * client that reads archived subagents on demand, see subagent-transcript.mjs); chat:subagent reads the rest.
   */
  detailsOnDemand?: true;
}
export type SubagentTranscriptEntry = { id: string; kind: "tool" | "message"; text: string; tool?: StepKind };
export type ToolCategory = "commands" | "images" | "reads" | "searches" | "edits" | "other";
export type SubagentProgress = { steps: number; said?: string; tools: Partial<Record<ToolCategory, number>> };

export interface AgentTask {
  id: string;
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

export type ChatTaskStatus = "pending" | "in_progress" | "completed";

/** One item of a Chat's task list, at most three levels deep. Ids are Milagre's: "1", "1.2", "1.2.1". */
export interface ChatTask {
  id: string;
  title: string;
  activeForm?: string;
  status: ChatTaskStatus;
  children?: ChatTask[];
}

/** Where a Chat's work is, set by the agent with phase_set. In graph row order, bottom to top. */
export type ChatPhase = "start" | "plan" | "build" | "test" | "review" | "merge" | "release" | "done";

export interface ChatPhaseEntry {
  phase: ChatPhase;
  at: number;
}

export interface ChatPlan {
  /** "milagre" once tasks_set or task_update wrote it; "native" while it mirrors the provider's own todo list. */
  source: "milagre" | "native";
  tasks: ChatTask[];
  /** Oldest first, at most 200; the last is the current phase. */
  phases: ChatPhaseEntry[];
  updatedAt: number;
}

export interface AgentPort {
  port: number;
  pid: number;
  command: string;
  address: string;
  /** Set by a desktop window on a port that listens on another computer, which `localhost` doesn't reach. */
  computerId?: string;
  taskId?: string;
}

export type AgentPorts = Record<string, AgentPort[]>;

export type AgentEvent =
  | { type: "message-sent"; model: string; permissionMode?: PermissionMode }
  | { type: "answers-sent" }
  | { type: "subagent-update"; agent: Subagent }
  | { type: "background-tasks"; tasks: BackgroundTask[] }
  | { type: "subagents-waiting"; waiting: boolean }
  | { type: "tasks-updated"; tasks: AgentTask[] }
  | { type: "plan-updated"; plan: ChatPlan | null }
  | ({ type: "context-usage" } & ContextUsage)
  | { type: "prompt-suggestion"; text: string; turnId: string }
  | { type: "context-compacting" }
  | { type: "context-compacted"; trigger: "manual" | "auto"; before?: number; after?: number }
  | { type: "session-started"; nativeId: string }
  | { type: "session-reset" }
  /** `continues`: the turn whose steering message arrived as it ended, which this turn the agent started by itself takes. */
  | { type: "turn-started"; turnId: string | null; continues?: string }
  /** `startsMessage`: a provider message boundary, distinct from a streamed paragraph break. */
  | { type: "text-delta"; messageId: string | null; text: string; startsMessage?: boolean }
  | {
      type: "step-started";
      step: Pick<ChatStep, "id" | "kind" | "title" | "detail" | "file" | "files" | "imageOrigin" | "sourceFile" | "tool" | "agent" | "startedAt">;
    }
  | { type: "step-output"; id: string; text: string }
  /**
   * Claude's input to a Milagre design tool while the model writes it (design-drafts.cjs), for the Designs canvas to
   * build the design live: `text` continues the input at `offset`, `done` once it is whole. `id` is the step's; `agent`
   * the subagent writing it, if one is. Not saved.
   */
  | { type: "step-draft"; id: string; tool: "design_show" | "design_apply"; offset: number; text: string; done?: boolean; agent?: string }
  | {
      type: "step-completed";
      id: string;
      status: "done" | "failed";
      title?: string;
      note?: string;
      detail?: string;
      durationMs?: number;
      endedAt?: number;
      summary?: string;
      error?: string;
      file?: string;
      artifact?: ArtifactRef;
      routine?: { id: string; name: string };
    }
  | ({ type: "permission-request" } & PermissionRequest)
  | { type: "permission-resolved"; requestId: string; decision: PermissionDecision | "cancelled" }
  | ({ type: "question-request" } & QuestionRequest)
  | { type: "question-resolved"; requestId: string; outcome: QuestionOutcome }
  | { type: "turn-completed"; quiet?: boolean; credits?: number; metrics?: TurnMetrics }
  | { type: "turn-cancelled"; quit?: boolean }
  | { type: "turn-failed"; message: string; notice?: boolean; login?: boolean; limit?: UsageLimit };

/**
 * The plan's usage limit stopped a turn. `accountId` is the Account the turn ran on (added by the session manager);
 * `window` is the CLI's name for the full window (Claude: five_hour, seven_day…) and `resetsAt` an ISO date, when known.
 */
export interface UsageLimit {
  provider: ModelProvider;
  accountId?: string;
  window?: string;
  resetsAt?: string;
}

export type UsageLimitContext = { kind: "limit" } & UsageLimit;

export type AccountSwitchContext = { kind: "account-switch"; provider: ModelProvider; label: string };

export interface LimitResume {
  at: string;
  provider: ModelProvider;
  accountId: string;
  sourceMessageId: number;
  sendId: string;
  mode: "automatic" | "manual";
  stoppedAt: number;
  expiresAt: number;
}

export interface ChatSendRequest {
  projectPath: string;
  /** While busy: wait for the current turn, or steer it (stop and send when steering isn't supported). Omitted preserves legacy/provider behavior. */
  delivery?: "queue" | "now";
  clientMessageId?: string;
  /** The chat to send to, or null for a new chat in the worktree. */
  sessionId: number | null;
  worktreeId: number;
  /** The message as the chat shows it. */
  body: string;
  images: ImageAttachment[];
  /** Paths of the files attached to the message. */
  files: string[];
  /** What the agent is sent: the body with the attached files listed. */
  prompt: string;
  provider: ModelProvider;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  ultracode?: boolean;
  /** Claude only: faster Opus output at premium usage rates. */
  fastMode?: boolean;
  /** How long Claude's replies run; Claude only, Codex ignores it. */
  replies?: "concise" | "normal";
  /** Apply bundled TLDR writing rules to both providers. Defaults to true. */
  tldrEnabled?: boolean;
  /** A PR-blocker pill's action. Milagre checks it and writes the body, prompt and context itself, ignoring the ones sent. */
  prAction?: { action: PullRequestBlocker; pr: number; url: string; projectId?: string };
  /** The first message of a Chat started from an issue. Milagre reads the issue and writes the body, prompt and context itself. */
  linearIssue?: { key: string; workspace?: string; note?: string };
  /** The first message of a Chat started from a GitHub issue. The host reads it with its own `gh` and writes the body, prompt and context itself. */
  githubIssue?: { repo: string; number: number; note?: string };
  /** Compact the Chat's context now (Claude only). Milagre writes the body, prompt and context itself, ignoring the ones sent. */
  compact?: boolean;
  /** Where the user typed it, when not in the Chat's own computer's window. The agent is told (packages/core/src/sent-from.cjs). */
  sentFrom?: SentFrom;
}

export type SentFrom = "phone" | "tablet" | "computer";

export interface EditorInfo {
  id: string;
  name: string;
}

export interface WorktreeRequest {
  projectPath: string;
  baseBranch?: string;
  /** A configured Project base wins over a remembered or fallback client selection. */
  useProjectBase?: boolean;
  /** Names the branch and folder only. The new Chat starts empty: send its first message with `chat send`. */
  prompt: string;
  issueKey?: string;
  /** The Linear workspace the issue was picked from. */
  issueWorkspace?: string;
  /** A GitHub issue to name the branch after; the host reads it with its own `gh`. */
  githubIssue?: { repo: string; number: number };
}

export interface CoordinatorState {
  persistence?: PersistenceFailure;
  /** From a host that keeps messages by Chat (chat-pages-v1): `messages` is empty, and the Chats on screen read their own. */
  messagesInChats?: boolean;
  next_id: number;
  projects: Record<string, Project>;
  worktrees: Record<string, Worktree>;
  sessions: Record<string, AgentSession>;
  messages: ChatMessage[];
  tasks: Record<string, { id: number; worktree_id: number; title: string; status: string }>;
}

export interface RestoredChats {
  worktree: string;
  count: number;
}

export interface OpenProject {
  path: string;
  name: string;
  /** False for a folder outside Git: its one Worktree is the folder itself, and its Chats work there. */
  git?: boolean;
  /** "chats" for the Chats home, the internal repository project-less Chats run in. Absent for every other Project. */
  kind?: ProjectKind;
  state: CoordinatorState;
  restoredChats?: RestoredChats[];
}

export interface AgentFolder {
  path: string;
  name: string;
  provider: ModelProvider;
  lastUsed: string;
  git: boolean;
}

export interface LinkIssueResult {
  project: OpenProject;
  mode: "renamed" | "stored";
  branch: string;
}

export function sortedWorktrees(state: CoordinatorState) {
  return Object.values(state.worktrees).sort((a, b) => a.id - b.id);
}

export function sessionForWorktree(state: CoordinatorState, worktreeId: number) {
  return Object.values(state.sessions).find((session) => session.worktree_id === worktreeId);
}

export interface SkillOption {
  name: string;
  description: string;
  path: string;
  scope: "workspace" | "user" | "bundled";
  provider: string;
}

export interface ShadowedSkill extends SkillOption {
  shadowedBy: string;
}

export interface SkillCatalog {
  skills: SkillOption[];
  shadowed?: ShadowedSkill[];
  warnings: string[];
}

export interface UsageWindow {
  id: string;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  detail?: string;
}

export interface ProviderUsage {
  /** The host Account whose limits are shown, captured with the usage read. */
  account?: Pick<ProviderAccount, "id" | "label" | "email"> & { state?: ProviderAccount["state"]; default?: true };
  provider: ModelProvider;
  status: "ok" | "unavailable" | "error";
  windows: UsageWindow[];
  updatedAt: string;
  /** Latest completed provider check, including unsuccessful checks. Quota timestamps stay in updatedAt. */
  checkedAt?: string;
  message?: string;
  /** Rate-limit resets the account has banked; absent when there are none. */
  bankedResets?: number;
}

export interface UsageSnapshot {
  accountKey?: string;
  /** Host clock at the snapshot read, so cache freshness is independent of phone clock skew. */
  generatedAt?: string;
  providers: ProviderUsage[];
}

export interface TranscriptState {
  next_id: number;
  sessions: Record<string, AgentSession | LinkChatSession>;
  messages: ChatMessage[];
}
export type LinkSendRequest = Omit<ChatSendRequest, "projectPath" | "worktreeId"> & { linkId: string; operationId: string };

export type { AccountsSnapshot, ProjectAccountScope, ProjectAccountsSnapshot, ProviderAccount } from "./account-model.js";

export type { BtwState, BtwRequest } from "./btw.js";

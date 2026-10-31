import type { GateMeta } from "./bots.mjs";
import type { ProjectKind } from "./chats-home.mjs";

export type SessionStatus = "Created" | "Running" | "Stopped";
export type ModelProvider = "codex" | "claude" | "antigravity" | "kiro";
export type PermissionMode = "ask" | "auto" | "full" | "bot";
/** Where a new chat runs: the selected checkout, or a fresh git worktree. */
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

export interface ModelOption {
  id: string;
  name: string;
  provider: ModelProvider;
  description: string;
  recommended?: boolean;
  /** Kiro only: the model's credit multiplier, relative to Auto (2 means a turn costs twice what Auto would). */
  credits?: number;
}

/** A model as its agent's CLI reports it (agent:models), with what it accepts. */
export interface ReportedModel extends ModelCapability {
  id: string;
  name: string;
  description: string;
  recommended: boolean;
  /** Kiro only: the model's credit multiplier, relative to Auto. */
  credits?: number;
}

/** Each agent's reported models; null when its CLI is missing, too old, or couldn't be asked. */
export type AgentModels = Record<ModelProvider, ReportedModel[] | null>;

/** How an agent's CLI stands, for the model picker (agent:cli-status). `message` is what a turn would fail with. */
export type CliState = "ready" | "missing" | "outdated" | "logged-out" | "broken";
export interface CliStatus {
  state: CliState;
  message?: string;
}
export interface ProviderUpdate {
  provider: ModelProvider;
  installedVersion: string;
  version: string;
}

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
  /** CI on the open PR: still running, or failed. Unset once every check passed or when it has none. */
  checks?: "running" | "failed";
}

/** A Project's PRs as the host's poll last found them: each Worktree's branch PR, and each Chat-named PR by folder and ref. */
export interface PullRequestSnapshot {
  worktrees: Record<string, PullRequest | null>;
  chats: Record<string, Record<string, PullRequest | null>>;
  /** Some were never read yet; they come with the next `pull-requests:changed`. */
  pending: boolean;
}

export interface Worktree {
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

/** What the chat lists need from a Chat's messages, kept on the Chat by the host (chat-summary.mjs). */
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
  /** How the last reply ended (the commit dialog's notes aren't replies). */
  lastOutcome?: "completed" | "failed" | "cancelled";
  /** The PRs the Chat's commands created or merged. */
  pullRequests?: string[];
  /** The model of the last message the user sent. */
  lastModel?: string;
  /** A handoff divider still preparing, by message id. */
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
  /** Kept by the host from the Chat's messages; absent from an older host. */
  summary?: ChatSummary;
  /** The agent this chat runs on now. A send on the other provider hands the chat off in place (see handoff.mjs). */
  provider?: ModelProvider;
  /** Claude session id or Codex thread id of the current `provider`, used to resume the agent's memory. */
  native_session_id?: string;
  /** Session ids of the providers this chat is not on right now, so switching back resumes them. */
  native_sessions?: Partial<Record<ModelProvider, string>>;
  subagents?: Subagent[];
  /**
   * The background work the Chat's agent process reports besides its subagents (a command run in the background, an MCP
   * task, a workflow), live while that process runs; absent when there is none (chat-activity.mjs).
   */
  backgroundTasks?: BackgroundTask[];
  /** The Chat's task list and phase history (chat-plan.mjs); absent until an agent writes one. */
  plan?: ChatPlan;
  /** Automatic title from the first message; a manual title takes precedence. */
  generatedTitle?: string;
  /** Persisted until background naming finishes, including across restarts. */
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
  /** How full the agent's context window was when its last turn ended. */
  contextUsage?: ContextUsage;
  /** Claude's predicted follow-up, accepted into the draft without sending. */
  suggestion?: { text: string; turnId: string };
  /** The completed turn eligible to supply a suggestion; cleared before any new input. */
  suggestionTurnId?: string;
  /**
   * The Routine and Run that started this Chat; set only on a Chat a Run created. `hidden` keeps it out of every Chat list
   * until it waits on an approval or question; it is absent on a Chat made before Run Chats were hidden.
   */
  routine?: { routineId: string; runId: string; hidden?: boolean };
  /** The permission mode the Chat's composer last set (a pick, or a person's message); a heartbeat's beat runs in it. */
  permissionMode?: PermissionMode;
  /**
   * Messages sent while a turn ran on a provider that can't steer (provider-capabilities `steer`), oldest first. Each
   * starts a turn of its own when the one before it completes; Send now and Remove act on one (chat-host.cjs).
   */
  queued?: QueuedMessage[];
  /** Stop, or a turn that failed, ended the turn the queue waited on: the queue waits for Send now instead of starting. */
  queueHeld?: boolean;
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
  /** The model and provider picked when it was sent; its turn hands off like any send if the chat is on another. */
  model: string;
  provider: ModelProvider;
  queuedAt: number;
  clientMessageId?: string;
}

/**
 * A piece of background work the agent's process runs that isn't a subagent: Claude Code's background tasks (a Bash
 * command run in the background, an MCP task, a workflow). `kind` is the provider's own name for it (local_bash…).
 */
export interface BackgroundTask {
  id: string;
  kind: string;
  title: string;
  /** When Milagre first saw it run (ms since epoch). */
  startedAt: number;
}

/** The end of a background command's output (chat:task-output): the last 8 KiB it wrote, escape sequences included. */
export interface BackgroundTaskOutput {
  output: string;
  /** The size of the whole output in bytes. */
  totalBytes: number;
  /** Whether `output` holds only the end of a longer output. */
  truncated: boolean;
}

/** Tokens in the agent's context window, out of the model's window size. */
export interface ContextUsage {
  used: number;
  size: number;
}

/** A named Link owns one conversation across an isolated Worktree in each member Project. */
export type ChatScope = { kind: "project"; projectPath: string } | { kind: "link"; linkId: string };
export interface NamedProjectLink {
  id: string;
  name: string;
  projectIds: string[];
  createdAt: string;
  hidden?: boolean;
}
export interface WorktreeBinding {
  projectId: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  base: string;
  /** The folder name the shared Chat's workspace links this Worktree under. */
  alias?: string;
}
export interface LinkChatSession extends Omit<AgentSession, "worktree_id"> {
  workspacePath: string;
  /** Only the Projects the Chat has changed: each gets its Worktree when the agent is about to edit it. */
  worktrees: WorktreeBinding[];
}
export interface LinkPreparation {
  operationId: string;
  chatId: number;
  /** "ready" once the workspace folder exists. The others come from preparations saved before Worktrees were made on demand. */
  status: "reserved" | "creating" | "setup" | "ready" | "failed";
  /** The Worktrees made or being made for the Chat. A failed one that kept changes is `retained`, with its `error`. */
  members: Array<WorktreeBinding & { created?: boolean; setupDone?: boolean; setupDeferred?: boolean; retained?: boolean; error?: string }>;
  workspacePath: string;
  error?: string;
  retainedPaths?: string[];
}
/** A failed save retained by the Computer, until every pending edit has reached disk. Never persisted itself. */
export interface PersistenceFailure {
  error: string;
  code?: string;
  saving: boolean;
}

export interface LinkState {
  persistence?: PersistenceFailure;
  /** From a host that keeps messages by Chat (chat-pages-v1): `messages` is empty, and the Chats on screen read their own. */
  messagesInChats?: boolean;
  next_id: number;
  sessions: Record<string, LinkChatSession>;
  messages: ChatMessage[];
  preparations: Record<string, LinkPreparation>;
}
export interface OpenLink {
  link: NamedProjectLink;
  state: LinkState;
  projects: Array<{ id: string; path: string; name: string }>;
}

export interface ChatMessage {
  id: number;
  /** Matches a local send preview to the saved input across snapshots and the send response. */
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
  /** How the agent turn that produced this reply ended. */
  outcome?: "completed" | "failed" | "cancelled";
  /** The tool calls the agent made in this reply, and its thinking, in the order they started. */
  steps?: ChatStep[];
  /** Kiro only: what the turn cost, in credits, as the agent reported it. */
  credits?: number;
  /** The host's sidecar with the long details of these steps (each marked `hasDetail`); read with the chat:message command. */
  detailFile?: string;
  operationId?: string;
  /** On the user's answers to an agent's questions: each question with what they answered, shown as a card. */
  answered?: AnsweredQuestion[];
}

/** One question the user answered, as their message keeps it. A typed answer to a secret question is masked. */
export interface AnsweredQuestion {
  header: string;
  question: string;
  answers: string[];
}

/** A provider switch inside a chat, shown as a divider before the message that caused it. `brief` is what the new provider was sent. */
export type HandoffContext = {
  kind: "handoff";
  from: { provider: ModelProvider; model?: string };
  to: { provider: ModelProvider; model?: string };
  status: "preparing" | "done" | "failed";
  brief?: string;
  transcriptPath?: string;
};

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

/** What wrote a message nobody typed in this chat: a Link (see LinkedContext), the commit dialog, a handoff, or a legacy handover note. */
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

/** Something on GitHub that stops an open PR from merging and that the agent can fix. */
export type PullRequestBlocker = "conflicts" | "changes-requested" | "checks-failed" | "behind";

/** A PR-blocker pill the user clicked. Milagre wrote the message and the skill prompt the agent got. */
export type PullRequestActionContext = { kind: "pr-action"; action: PullRequestBlocker; pr: number; url: string };

/**
 * A Chat started from a Linear issue. Milagre read the issue and wrote the message and prompt; `note` is what the user typed.
 * A Linear Routine's Run starts the same way, and its first message also carries `routine`: the divider (see
 * RoutineRunContext, which `routineRunOf` in routines.mjs makes of it) shown with the issue card.
 */
export type LinearIssueContext = {
  kind: "linear-issue";
  key: string;
  title: string;
  url: string;
  state: { name: string; type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"; color: string };
  workspace?: string;
  note?: string;
  routine?: { routineId: string; runId: string; name: string; at: number; quiet?: boolean; summary?: string; label?: string };
};

/**
 * A Link made on the canvas that reached this Chat's Worktree, as a line in the Chat. Milagre writes it when the Link is
 * made; `summary` is the linked summary the Chat's next turn gets, as of then.
 */
export type WorktreeLinkedContext = {
  kind: "worktree-linked";
  linkId: string;
  /** The Project the Link reached: another one, or the Chat's own when it links two of its Worktrees. */
  project: { name: string; path: string };
  sameProject: boolean;
  /** The branches of the Worktrees the Link reached, more than one for a whole-Project Link. */
  branches: string[];
  summary?: string;
};

/** Where the user reloaded the Chat's agent: its process ended, and the next turn resumes the session in a new one. */
export type ChatReloadContext = { kind: "reload" };

/**
 * What Milagre writes into a bot's thread (packages/core/src/bots): a sign-off that expired, a Chat the bot opened that
 * finished a turn or that the user took over. `bot-message` marks a prompt a bot sent into a Chat it opened.
 */
export type BotContext =
  | { kind: "bot-gate-expired"; requestId: string; chatKey: string }
  | { kind: "bot-chat-finished"; chatKey: string; status: "done" | "failed" }
  | { kind: "bot-chat-taken-over"; chatKey: string }
  | { kind: "bot-message"; botId: string; botName: string };

/**
 * What starts a Routine: the clock, a change in a Linear workspace, or a POST to its webhook URL. A webhook's `hookId` is
 * the hex sha256 of the secret in the URL, so the Routine never holds the secret itself; `signed` says an HMAC is checked.
 */
export type RoutineTrigger =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "linear"; workspace: string; event: "assigned" | "label-added" | "state" | "comment"; team?: string; label?: string; state?: string }
  | { kind: "webhook"; hookId: string; signed: boolean };

/** Where a Routine's Run lands: an existing Chat (a heartbeat), or a new Chat for each Run. */
export type RoutineTarget = { kind: "chat"; chatId: string } | { kind: "new-chat"; projectPath: string; workspace: "worktree" | "project" };

/** The Linear issue a Run was started for, as it was when the change was seen. */
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

/** The Linear comment a Run was started for. `createdAt` is epoch milliseconds. */
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

export type RoutineRunStatus = "running" | "acted" | "quiet" | "failed" | "skipped-busy" | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  trigger: RoutineTrigger;
  target: RoutineTarget;
  provider?: ModelProvider;
  model?: string;
  permissionMode?: string;
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
  /** The Worktree this Run's Chat was started in. */
  worktreeId?: string;
  /** What started this Run. */
  event?: RoutineEvent;
  summary?: string;
  /** What the Run did, set when it ends; the Runs list shows it as the row's name. */
  title?: string;
  error?: string;
  /** An event refused before it ran (a webhook whose signature didn't match); only the newest are kept. */
  rejected?: boolean;
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

/** Why a babysit Heartbeat ended: the PR merged or closed, a stop rule held, it ran out of time, or it was deleted. */
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

/**
 * Undo changes wrote files: `restored` of them went back to how they were before the task (`checkpointId`), `kept` stayed
 * as they were. `recoveryId` is the checkpoint saved just before, which the line's Redo previews. `redo` marks restoring
 * such a recovery checkpoint, which puts the files back again.
 */
export type CheckpointRestoreContext = {
  kind: "checkpoint-restore";
  checkpointId: string;
  recoveryId: string;
  restored: number;
  kept: number;
  redo: boolean;
};

export type ChatContext =
  | AdvisorResultContext
  | WorktreeLinkedContext
  | LinkedContext
  | { kind: "git-action" }
  | HandoffContext
  | CompactionContext
  | PullRequestActionContext
  | LinearIssueContext
  | UsageLimitContext
  | AccountSwitchContext
  | ChatReloadContext
  | BotContext
  | RoutineRunContext
  | BabysitStoppedContext
  | CheckpointRestoreContext
  | "handover"
  | null;

/**
 * What a message no person typed is (`ChatMessage.context`): a Delegation from another Chat, a Delegation
 * report coming back, a Negotiation's agreement, or a notice about one. `from` is the other Chat's key.
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
  | { kind: "linked-notice"; negotiationId?: string; delegationId?: string; with?: string };

/** A Delegation still queued or running (see delegations.cjs in @milagre/core). */
export interface OpenDelegation {
  id: string;
  /** The Link it travels along; null for a Delegation inside its Chat's own Project. */
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
  /** The paired computer that runs it, for a Delegation to another computer; `to_chat` is then that computer's key. */
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

/** A design an agent showed or revised: which artifact and the version this step made. */
export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
  /** Older transcript entries have no format; resolve them through the host's catalog. */
  format?: "design" | "html";
  /** The part of the app a design belongs to; the canvas lays out one row per group. */
  group?: string;
}

/** One tool call in an agent's reply (a `setup` step is the worktree's setup command, which Milagre ran, not the agent) (a command, an edit, a read, a search or another tool), or a stretch of its thinking. */
export interface ChatStep {
  /** Identifies one step across start, output and completion. A viewed snapshot needs a distinct ID from its source Read step. */
  id: string;
  kind: StepKind;
  /** Host time when this step first started. Older hosts omit it; clients show no duration for the running step. */
  startedAt?: number;
  /** Host completion time; together with startedAt gives wall time without adding parallel calls. */
  endedAt?: number;
  /** MCP identity, independent of the human title and artifact tool field. */
  source?: { name: string; server?: string };
  /** Bounded, redacted arguments for the detail panel. Large documents are not retained here. */
  input?: string;
  /** Small facts retained even when detail is fetched lazily. */
  summary?: string;
  error?: string;
  /** What it did, e.g. "Ran `npm test`"; text between backticks is code. */
  title: string;
  /** Saved steps are done or failed; only a reply still streaming has running ones. */
  status: "running" | "done" | "failed";
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
  /** An image snapshot of a file the agent viewed, rather than an image it generated. */
  imageOrigin?: "viewed";
  /** Provenance of a viewed snapshot only; never grants access to this file. */
  sourceFile?: string;
  /** Muted text after the title, e.g. "3s" or "exited with code 1 after 4s". */
  note?: string;
  /** How long the step took, measured by the host or reported by the provider. */
  durationMs?: number;
  /** Where the step sits in the reply: the length of the reply's text when it started. */
  offset?: number;
  /** For an artifact step, the design it showed. */
  artifact?: ArtifactRef;
  /** For an artifact step, the Milagre tool it called: the Designs canvas opens when a design tool starts. */
  tool?: "design_show" | "design_apply" | "artifact_show";
  /** For an artifact step a subagent made, the subagent: the id of the Agent call that started it (Subagent.id). */
  agent?: string;
  /** For a heartbeat_create step, the Routine it set (the tool result's first line names it), so the card can stop it. */
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

/** What an agent asks to do, as shown on the approval card. */
export interface PermissionRequest {
  requestId: string;
  kind: "command" | "edit" | "other" | "delegation" | "setup";
  /** Setup command review context. */
  setup?: { projectPath: string; source: string; computer: string };
  /** Short name of the tool, e.g. "Bash", "Shell" or "Edit files". */
  tool: string;
  /** The agent's own name for the tool, when `tool` shows another (Claude's MCP tools: "Send Message"). */
  toolName?: string;
  title: string;
  description?: string;
  command?: string;
  cwd?: string;
  /** A unified diff (or the new content), capped at 20,000 characters. */
  diff?: string;
  files?: string[];
  /** The tool's raw input, for tools that are neither commands nor edits. */
  detail?: string;
  reason?: string;
  /** Whether "Always allow in this chat" can be offered. */
  allowForChat: boolean;
  /** The tool step this request is about. */
  stepId?: string;
  /** On a Delegation's card: where it goes ("Project / branch / Chat"), what it says, and whether it opens a Negotiation. */
  /** `computer`: the paired computer it goes to, for a Delegation to another computer (Always allow covers that computer). */
  delegation?: { target: string; message: string; negotiation: boolean; computer?: string };
  /** On a bot's sign-off card: the gated action and the bot that wants it. */
  gate?: GateMeta;
}

export type PermissionDecision = "allow" | "allow-for-chat" | "deny";

/** One option on a question card. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question an agent asks, as shown on the question card. */
export interface AgentQuestion {
  /** Unique within its request; answers are keyed by it. */
  id: string;
  /** A short tag such as "Library"; may be empty. */
  header: string;
  question: string;
  options: QuestionOption[];
  /** The user may pick several options. */
  multiSelect: boolean;
  /** The user may type an answer of their own. */
  allowOther: boolean;
  /** The typed answer is a secret, so the field hides it. */
  secret: boolean;
}

/** Questions a turn waits on, asked together. */
export interface QuestionRequest {
  requestId: string;
  /** Host-owned request: values go to a private file, never a provider question response. */
  secretRequest?: { description: string; expiresAt?: number };
  questions: AgentQuestion[];
}

/** The labels picked and any typed answer, per question id. */
export type QuestionAnswers = Record<string, string[]>;

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
  /** Launched by the chat to run in the background: its result wakes the chat with a turn of its own. */
  background?: boolean;
  /** The agent type it was launched as (Claude's subagent_type), such as a QA persona ("qa-mobile", qa-personas.ts). */
  agentType?: string;
  title: string;
  prompt?: string;
  status: "initializing" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  latestActivity?: string;
  /** The subagent's own to-do list (its TodoWrite, task tools or Codex plan), when it keeps one. */
  tasks?: AgentTask[];
  /** Running totals over its whole transcript, kept by the host (subagent-glance.mjs). */
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
/** `tool` is a tool call's step kind, when the host knew it. */
export type SubagentTranscriptEntry = { id: string; kind: "tool" | "message"; text: string; tool?: StepKind };
/** What a subagent's tool calls count under in its panel (subagent-glance.mjs). */
export type ToolCategory = "commands" | "images" | "reads" | "searches" | "edits" | "other";
/** How many steps a subagent has taken (things it said), the first sentence of the last, and its tool calls per category. */
export type SubagentProgress = { steps: number; said?: string; tools: Partial<Record<ToolCategory, number>> };

/** One item of the agent's to-do list. */
export interface AgentTask {
  id: string;
  content: string;
  /** Present-continuous wording for while the task is in progress ("Running tests"). */
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

/** A Chat task's state. A parent's is derived from its subtasks (chat-plan.mjs). */
export type ChatTaskStatus = "pending" | "in_progress" | "completed";

/** One item of a Chat's task list, at most three levels deep. Ids are Milagre's: "1", "1.2", "1.2.1". */
export interface ChatTask {
  id: string;
  title: string;
  /** Present-continuous wording shown while in progress ("Saving wishlist changes"). */
  activeForm?: string;
  status: ChatTaskStatus;
  children?: ChatTask[];
}

/** Where a Chat's work is, set by the agent with phase_set. In graph row order, bottom to top. */
export type ChatPhase = "start" | "plan" | "build" | "test" | "review" | "merge" | "release" | "done";

export interface ChatPhaseEntry {
  phase: ChatPhase;
  /** When the agent moved to this phase, in milliseconds since epoch. */
  at: number;
}

/** A Chat's task list and phase history. Lives on the session, so it outlasts turns and restarts. */
export interface ChatPlan {
  /** "milagre" once tasks_set or task_update wrote it; "native" while it mirrors the provider's own todo list. */
  source: "milagre" | "native";
  tasks: ChatTask[];
  /** Oldest first, at most 200; the last is the current phase. */
  phases: ChatPhaseEntry[];
  updatedAt: number;
}

/** A TCP port a chat's commands listen on, such as a dev server. */
export interface AgentPort {
  port: number;
  pid: number;
  /** The listening process's name, as lsof reports it ("node"). */
  command: string;
  /** The address it listens on: "*", "127.0.0.1", "::1". */
  address: string;
  /** Set by a desktop window on a port that listens on another computer, which `localhost` doesn't reach. */
  computerId?: string;
  /** The agent's background command that serves it, which the port then stands for instead of the background line. */
  taskId?: string;
}

/** Every chat's listening ports, by chat key; a chat with none is absent. */
export type AgentPorts = Record<string, AgentPort[]>;

export type AgentEvent =
  /** Milagre's own event: the user's message was saved, so a turn starts, or a running one is steered and its reply split. */
  | { type: "message-sent"; model: string; permissionMode?: PermissionMode }
  /** Milagre's own event: the user's answers to a question were saved as their message, after the reply so far. */
  | { type: "answers-sent" }
  | { type: "subagent-update"; agent: Subagent }
  /** Every piece of background work the agent's process runs besides its subagents, now: it replaces the last set. */
  | { type: "background-tasks"; tasks: BackgroundTask[] }
  | { type: "subagents-waiting"; waiting: boolean }
  | { type: "tasks-updated"; tasks: AgentTask[] }
  /** Milagre's own event: a task tool changed the Chat's plan; null clears it. */
  | { type: "plan-updated"; plan: ChatPlan | null }
  | ({ type: "context-usage" } & ContextUsage)
  | { type: "prompt-suggestion"; text: string; turnId: string }
  | { type: "context-compacting" }
  /** The provider compacted the conversation: token counts when reported; `manual` when `/compact` asked for it. */
  | { type: "context-compacted"; trigger: "manual" | "auto"; before?: number; after?: number }
  | { type: "session-started"; nativeId: string }
  | { type: "session-reset" }
  /** `continues`: the turn whose steering message arrived as it ended, which this turn the agent started by itself takes. */
  | { type: "turn-started"; turnId: string | null; continues?: string }
  /** `startsMessage`: a provider message boundary, distinct from a streamed paragraph break. */
  | { type: "text-delta"; messageId: string | null; text: string; startsMessage?: boolean }
  | { type: "step-started"; step: Pick<ChatStep, "id" | "kind" | "title" | "detail" | "file" | "imageOrigin" | "sourceFile" | "tool" | "agent" | "startedAt"> }
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
  | { type: "turn-completed"; quiet?: boolean; credits?: number }
  | { type: "turn-cancelled"; quit?: boolean }
  /** `notice`: a message Milagre wrote (it names the CLI and the fix), shown as it is; otherwise it is the agent's own error. */
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

/** A reply the plan's usage limit stopped: the Chat offers the Project's other Accounts for the provider. */
export type UsageLimitContext = { kind: "limit" } & UsageLimit;

/** The message that continued a Chat on another account after the usage limit, shown as a line like a handoff. `label` names the account. */
export type AccountSwitchContext = { kind: "account-switch"; provider: ModelProvider; label: string };

/** A message for a chat. The main process saves it, then starts or steers the chat's turn. */
export interface ChatSendRequest {
  projectPath: string;
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
  prAction?: { action: PullRequestBlocker; pr: number; url: string };
  /** The first message of a Chat started from an issue. Milagre reads the issue and writes the body, prompt and context itself. */
  linearIssue?: { key: string; workspace?: string; note?: string };
  /** Compact the Chat's context now (Claude only). Milagre writes the body, prompt and context itself, ignoring the ones sent. */
  compact?: boolean;
  /** Where the user typed it, when not in the Chat's own computer's window. The agent is told (packages/core/src/sent-from.cjs). */
  sentFrom?: SentFrom;
}

/** The device a message came from: a phone, an iPad, or another computer's Milagre. */
export type SentFrom = "phone" | "tablet" | "computer";

/** A code editor found on this Mac. */
export interface EditorInfo {
  id: string;
  name: string;
}

export interface WorktreeRequest {
  projectPath: string;
  baseBranch: string;
  prompt: string;
  issueKey?: string;
  /** The Linear workspace the issue was picked from. */
  issueWorkspace?: string;
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

/** Chats a linked worktree's old project file held, brought into the repository's project. */
export interface RestoredChats {
  /** The worktree's name, as the sidebar shows it. */
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
  /** Only on the first open after chats came back from linked worktrees' old files. */
  restoredChats?: RestoredChats[];
}

/** A folder an agent session on this computer worked in, for onboarding. */
export interface AgentFolder {
  path: string;
  name: string;
  provider: ModelProvider;
  /** ISO time of the newest session there. */
  lastUsed: string;
  git: boolean;
}

/** worktree:link-issue's answer: `renamed` when the branch took the issue's name, `stored` when only the key was kept. */
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

/** A skill discovery skipped because an earlier one has the same name; `shadowedBy` is the winner's path. */
export interface ShadowedSkill extends SkillOption {
  shadowedBy: string;
}

export interface SkillCatalog {
  skills: SkillOption[];
  /** Absent from an older host. */
  shadowed?: ShadowedSkill[];
  warnings: string[];
}

export interface UsageWindow {
  id: string;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  /** The amounts behind the percent, when the provider gives them: "453 of 10,000 credits". */
  detail?: string;
}

export interface ProviderUsage {
  /** The host Account whose limits are shown, captured with the usage read. */
  account?: Pick<ProviderAccount, "id" | "label" | "email">;
  provider: ModelProvider;
  status: "ok" | "unavailable" | "error";
  windows: UsageWindow[];
  updatedAt: string;
  message?: string;
  /** Rate-limit resets the account has banked; absent when there are none. */
  bankedResets?: number;
}

export interface UsageSnapshot {
  accountKey?: string;
  providers: ProviderUsage[];
}

/** Provider identities only. Credentials stay with the CLI on the connected computer. */
export type ProviderAccount = {
  /** An explicit assignment whose saved profile was removed. */
  missing?: boolean;
  id: string;
  provider: ModelProvider;
  label: string;
  state: "unknown" | "ready" | "signed-out" | "signing-in" | "error";
  email?: string;
  plan?: string;
  message?: string;
  /** When the account hit its plan's usage limit in a Chat: the time it can be used again (ISO). Project accounts only. */
  limitedUntil?: string;
};
export type AccountsSnapshot = { providers: { provider: ModelProvider; installed?: boolean; selectedId: string; accounts: ProviderAccount[] }[] };
export interface TranscriptState {
  next_id: number;
  sessions: Record<string, AgentSession | LinkChatSession>;
  messages: ChatMessage[];
}
export type LinkSendRequest = Omit<ChatSendRequest, "projectPath" | "worktreeId"> & { linkId: string; operationId: string };

/** Host-local account assignments; null follows the computer selection. */
export type ProjectAccountScope = {
  key: string;
  name: string;
  kind: "project" | "link";
  projects: { id: string; path: string; name: string }[];
  /** The computer's Chats home: a Project scope for every Chat without a Project, shown with the Chats mark, not a repository's. */
  chatsHome?: true;
};
export type ProjectAccountsSnapshot = {
  scopeKey: string;
  providers: { provider: ModelProvider; accountId: string | null; effectiveId: string; defaultId: string; accounts: ProviderAccount[] }[];
};

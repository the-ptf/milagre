export type SessionStatus = "Created" | "Running" | "Stopped";
export type ModelProvider = "codex" | "claude" | "antigravity";
export type PermissionMode = "ask" | "auto" | "full";
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
}

/** A model as its agent's CLI reports it (agent:models), with what it accepts. */
export interface ReportedModel extends ModelCapability {
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
  state: "OPEN" | "MERGED";
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

export interface Worktree {
  id: number;
  project_id: number;
  path: string;
  /** The checked-out branch, or the folder name when HEAD is detached. */
  name: string;
  /** The ref a worktree Milagre created started from; its changes are measured against it. */
  base?: string;
  /** The Linear issue this Worktree was started from (its key); the branch may also name one. */
  linearIssue?: string;
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
  /** The first line of the first thing the user wrote, which names a Chat that has no title. */
  titleLine?: string;
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
  worktrees: WorktreeBinding[];
}
export interface LinkPreparation {
  operationId: string;
  chatId: number;
  status: "reserved" | "creating" | "setup" | "ready" | "failed";
  members: Array<WorktreeBinding & { created?: boolean; setupDone?: boolean }>;
  workspacePath: string;
  error?: string;
  retainedPaths?: string[];
}
export interface LinkState {
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
};

/** Something on GitHub that stops an open PR from merging and that the agent can fix. */
export type PullRequestBlocker = "conflicts" | "changes-requested" | "checks-failed" | "behind";

/** A PR-blocker pill the user clicked. Milagre wrote the message and the skill prompt the agent got. */
export type PullRequestActionContext = { kind: "pr-action"; action: PullRequestBlocker; pr: number; url: string };

/** A Chat started from a Linear issue. Milagre read the issue and wrote the message and prompt; `note` is what the user typed. */
export type LinearIssueContext = {
  kind: "linear-issue";
  key: string;
  title: string;
  url: string;
  state: { name: string; type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"; color: string };
  workspace?: string;
  note?: string;
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
  | "handover"
  | null;

/**
 * What a message no person typed is (`ChatMessage.context`): a Delegation from another Chat, a Delegation
 * report coming back, a Negotiation's agreement, or a notice about one. `from` is the other Chat's key.
 */
export type LinkedContext =
  | { kind: "delegation"; delegationId: string; from: string; fromLabel: string; negotiation?: { id: string; round: number } }
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
  link_id: string;
  from_chat: string;
  to_chat: string | null;
  from_label: string;
  to_label: string;
  status: "queued" | "running";
  negotiation_id?: string;
  round?: number;
  message: string;
}

export interface RunningNegotiation {
  id: string;
  link_id: string;
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

/** A design an agent showed with artifact_show: which artifact and the version this step made. */
export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
}

/** One tool call in an agent's reply (a `setup` step is the worktree's setup command, which Milagre ran, not the agent) (a command, an edit, a read, a search or another tool), or a stretch of its thinking. */
export interface ChatStep {
  id: string;
  kind: StepKind;
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
  /** The file a read or edit worked on, as the tool named it; the title shows only its name. For an image step, the generated image. */
  file?: string;
  /** Muted text after the title, e.g. "3s" or "exited with code 1 after 4s". */
  note?: string;
  /** How long a thinking step took. */
  durationMs?: number;
  /** Where the step sits in the reply: the length of the reply's text when it started. */
  offset?: number;
  /** For an artifact step, the design it showed. */
  artifact?: ArtifactRef;
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
  kind: "command" | "edit" | "other" | "delegation";
  /** Short name of the tool, e.g. "Bash", "Shell" or "Edit files". */
  tool: string;
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
  delegation?: { target: string; message: string; negotiation: boolean };
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
  questions: AgentQuestion[];
}

/** The labels picked and any typed answer, per question id. */
export type QuestionAnswers = Record<string, string[]>;

export type QuestionOutcome = "answered" | "dismissed" | "cancelled";

/** An observed message between agents. A null endpoint is the main agent. */
export interface SubagentCommunication {
  id: string;
  fromId: string | null;
  toId: string | null;
  text: string;
  at: number;
}

export interface Subagent {
  id: string;
  source?: "milagre-advisor";
  provider?: ModelProvider;
  model?: string;
  retryable?: boolean;
  archived?: boolean;
  parentId?: string;
  /** Launched by the chat to run in the background: its result wakes the chat with a turn of its own. */
  background?: boolean;
  title: string;
  prompt?: string;
  status: "initializing" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  latestActivity?: string;
  communications?: SubagentCommunication[];
  transcript: SubagentTranscriptEntry[];
  /**
   * How many entries the transcript has, when `transcript` holds only its last ones (a client that reads transcripts on
   * demand, see subagent-transcript.mjs); absent when it holds them all.
   */
  transcriptLength?: number;
  /**
   * Set on an archived subagent sent as a summary, without its prompt, latest activity, communications or transcript (a
   * client that reads archived subagents on demand, see subagent-transcript.mjs); chat:subagent reads the rest.
   */
  detailsOnDemand?: true;
}
export type SubagentTranscriptEntry = { id: string; kind: "tool" | "message"; text: string };

/** One item of the agent's to-do list. */
export interface AgentTask {
  id: string;
  content: string;
  /** Present-continuous wording for while the task is in progress ("Running tests"). */
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
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
}

/** Every chat's listening ports, by chat key; a chat with none is absent. */
export type AgentPorts = Record<string, AgentPort[]>;

export type AgentEvent =
  /** Milagre's own event: the user's message was saved, so a turn starts, or a running one is steered and its reply split. */
  | { type: "message-sent"; model: string }
  /** Milagre's own event: the user's answers to a question were saved as their message, after the reply so far. */
  | { type: "answers-sent" }
  | { type: "subagent-update"; agent: Subagent }
  | { type: "subagents-waiting"; waiting: boolean }
  | { type: "tasks-updated"; tasks: AgentTask[] }
  | ({ type: "context-usage" } & ContextUsage)
  | { type: "context-compacting" }
  /** The provider compacted the conversation: token counts when reported; `manual` when `/compact` asked for it. */
  | { type: "context-compacted"; trigger: "manual" | "auto"; before?: number; after?: number }
  | { type: "session-started"; nativeId: string }
  | { type: "session-reset" }
  /** `continues`: the turn whose steering message arrived as it ended, which this turn the agent started by itself takes. */
  | { type: "turn-started"; turnId: string | null; continues?: string }
  /** `startsMessage`: a provider message boundary, distinct from a streamed paragraph break. */
  | { type: "text-delta"; messageId: string | null; text: string; startsMessage?: boolean }
  | { type: "step-started"; step: Pick<ChatStep, "id" | "kind" | "title" | "detail" | "file"> }
  | { type: "step-output"; id: string; text: string }
  | { type: "step-completed"; id: string; status: "done" | "failed"; title?: string; note?: string; detail?: string; durationMs?: number; file?: string }
  | ({ type: "permission-request" } & PermissionRequest)
  | { type: "permission-resolved"; requestId: string; decision: PermissionDecision | "cancelled" }
  | ({ type: "question-request" } & QuestionRequest)
  | { type: "question-resolved"; requestId: string; outcome: QuestionOutcome }
  | { type: "turn-completed" }
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
}

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
  state: CoordinatorState;
  /** Only on the first open after chats came back from linked worktrees' old files. */
  restoredChats?: RestoredChats[];
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
export type AccountsSnapshot = { providers: { provider: ModelProvider; selectedId: string; accounts: ProviderAccount[] }[] };
export interface TranscriptState {
  next_id: number;
  sessions: Record<string, AgentSession | LinkChatSession>;
  messages: ChatMessage[];
}
export type LinkSendRequest = Omit<ChatSendRequest, "projectPath" | "worktreeId"> & { linkId: string; operationId: string };

/** Host-local account assignments; null follows the computer selection. */
export type ProjectAccountScope = { key: string; name: string; kind: "project" | "link"; projects: { id: string; path: string; name: string }[] };
export type ProjectAccountsSnapshot = {
  scopeKey: string;
  providers: { provider: ModelProvider; accountId: string | null; effectiveId: string; defaultId: string; accounts: ProviderAccount[] }[];
};

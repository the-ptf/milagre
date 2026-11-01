import type { ContextSettings } from "@milagre/shared/context-settings";
import type { AppUpdateState, HostUpdate } from "@milagre/shared/app-update";
import type { BabysitSettings } from "@milagre/shared/babysit";
import type { DoneSettings } from "@milagre/shared/done";
import type { CheckpointApi } from "@milagre/shared/checkpoints";
import type { KeybindingCommandId, KeybindingRule, KeybindingsState } from "@milagre/shared/keybindings";
import type { MainSyncSettings, MainSyncStatus } from "@milagre/shared/main-sync";
import type { McpAccount, McpAccountCheck, McpChangedEvent, McpProvider, McpServerDefinition, McpTarget } from "@milagre/shared/mcp";
import type { LocalMcpApi } from "@milagre/shared/local-mcp";
import type { LinearIssue, LinearIssuesResult, LinearStatus } from "@milagre/shared/linear";
import type {
  BackgroundTaskOutput,
  ProjectAccountScope,
  ProjectAccountsSnapshot,
  NamedProjectLink,
  OpenLink,
  LinkState,
  LinkSendRequest,
  TranscriptState,
  ChatMessage,
  Routine,
  RoutineFallback,
  RoutineRun,
  RoutineTarget,
  RoutineTrigger,
} from "@milagre/shared/model";
import type { Result } from "@milagre/shared/result";
import type { ChatsHome } from "@milagre/shared/chats-home";
import type { ComputerResources } from "@milagre/shared/computer-resources";
import type { BotRecord, BotsSnapshot, GateRecord } from "@milagre/shared/bots";
import type { StatePatch } from "@milagre/shared/state-patch";
export type FloatingDragOverlay = {
  targets: Array<{ edge: "left" | "right" | "bottom"; x: number; y: number; width: number; height: number; active: boolean }>;
};

/** On a state event from a host that sends patches: what changed since the state numbered `base`, or `resync`. */
type StateNumbering = { patch?: StatePatch; base?: number; version?: number; epoch?: string; resync?: boolean; messages?: MessageChanges };
/**
 * On an open reply (a Project's open, switch or read, a Link's open or read) from a host that numbers states: the
 * number of the state it carries, or holds, and the host's run. A host from before them sends neither.
 */
export type StateStamp = { version?: number; epoch?: string };
/** A Project read with `{ state: false }`: its path, name and number without the state, which a host from before the option still sends. */
export type ProjectRead = Omit<OpenProject, "state"> & { state?: CoordinatorState } & StateStamp;
/** A starter bot and the setup card it asks for. */
export type BotTemplate = {
  id: string;
  name: string;
  role: string;
  color: string;
  body: BotRecord["body"];
  fields: Array<{ id: string; label: string; kind: "projects" | "text"; required: boolean; options?: Array<{ value: string; label: string }> }>;
};
export type BotCreateInput = {
  templateId: string;
  name: string;
  answers: { projects: string[]; ci?: string; linearTeam?: string };
  provider: string;
  model: string;
};
export type BotPatch = { name?: string; role?: string; brief?: string; paused?: boolean; projects?: string[] };
/** To a client that reads messages by Chat: the messages a change added, changed (each after the one before it in its Chat) or removed. */
export type MessageChanges = { changed: Array<{ message: ChatMessage; after: number | null }>; removed: number[] };
/** Where a search match is and what matched. */
export type ChatSearchMatch = { message: { id: number; session_id: number }; score: number; snippet: string; highlight: [number, number]; term: string };
import type { SimulatorApi } from "@milagre/shared/simulator";
import type { BrowserApi } from "@milagre/shared/browser";
import type { TerminalApi } from "@milagre/shared/terminal";
import type { ArtifactApi } from "@milagre/shared/artifact";

import type { AgentRuns } from "./lib/agent-runs";
import type { SessionPatch, WorktreeRename } from "@milagre/shared/project-edits";
import type { GitChanges, GitChatContext, GitCommitResult, GitPrResult, GitPushResult, GitTextResult } from "./lib/git-dialog";
import type { ModelProvider } from "./model";
import type { RecentProject } from "./lib/project-list";
import type {
  AgentCliStatus,
  AgentModels,
  AgentPorts,
  Subagent,
  EditorInfo,
  AgentEvent,
  ChatSendRequest,
  CoordinatorState,
  LinkedWork,
  OpenProject,
  PermissionDecision,
  PermissionMode,
  QuestionAnswers,
  SkillCatalog,
  UsageSnapshot,
  LinkIssueResult,
  WorktreeRequest,
} from "./model";

import type { WorktreeStatus } from "./lib/archive";
import type { PullRequest, PullRequestSnapshot } from "./model";

/**
 * What `updateRoutine` may change. `null` drops `maxRuns` or `expiresAt` (a heartbeat keeps at least one), and the provider,
 * model or permission mode. A `trigger` or `target` replaces the stored one whole and keeps its kind.
 */
export type RoutineUpdate = Partial<Pick<Routine, "name" | "prompt" | "enabled">> & {
  cron?: string;
  timezone?: string;
  maxRuns?: number | null;
  expiresAt?: number | null;
  provider?: ModelProvider | null;
  model?: string | null;
  permissionMode?: string | null;
  /** The model a Run retries on after a provider-side failure; null goes back to the automatic pick. */
  fallback?: RoutineFallback | null;
  trigger?: RoutineTrigger;
  target?: RoutineTarget;
  /** Webhook Routines: a new HMAC secret (write-only, never read back) and the header the signature comes in (null or blank: the default). */
  signingSecret?: string;
  signingHeader?: string | null;
};

/** A Routine the user makes in the Routines form. It is always theirs (`createdBy` is set by the Mac). */
export type RoutineCreate = Pick<Routine, "name" | "prompt" | "trigger" | "target"> &
  Partial<Pick<Routine, "provider" | "model" | "permissionMode" | "fallback" | "maxRuns" | "expiresAt">> & {
    /** Webhook Routines: the HMAC secret, write-only (signs the Routine), and the header the signature comes in. */
    signingSecret?: string;
    signingHeader?: string;
  };

/** The Routines form's Linear choices. `error` says why a read failed. */
export type RoutineLinearOptions = {
  workspaces: Array<{ id: string; name: string }>;
  teams: Array<{ key: string; name: string }>;
  labels: string[];
  states: Array<{ name: string; type: string }>;
  error?: string;
};
/** Where a Routine can run: each Project Milagre lists, with up to 50 of its unarchived Chats, newest first. */
export type RoutineTargets = { projects: Array<{ path: string; name: string; chats: Array<{ chatId: string; title: string; lastAt: number }> }> };

/** Which patterns apply to new worktrees, and the files they match in the main checkout. */
export type FilesToCopy = { source: "worktreeinclude" | "setting" | "default"; worktreeInclude: string | null; matches: string[] };

/** Where the setup command new worktrees run comes from: the repo's .milagre/worktree.json, the project's setting, or nowhere. */
export type WorktreeSetupSource = "repo" | "setting" | "none";

/** The project's saved setup command, and the one that applies. `note` says why a repo file was ignored. */
export type WorktreeSetupSettings = { setupCommand: string; source: WorktreeSetupSource; command: string | null; note?: string };

export type ReleaseChannel = "stable" | "beta";
export type UpdateState = AppUpdateState;

/** The Phone setting as the host runs it. The link and QR (an SVG) are there only while it is on; both carry the access token. */
export type PhoneStatus = {
  enabled: boolean;
  state: "off" | "starting" | "on" | "error";
  error?: string;
  /** "cloudflare": reachable from any network at `publicUrl`. "relay": reachable from any network through relay.milagre.cloud. "none": only this Mac, at `localUrl`. */
  remote: "cloudflare" | "relay" | "none";
  /** With `remote: "relay"` or `"cloudflare"` (the relay runs behind a tunnel too): whether this Mac is connected to the relay. */
  relay?: "connecting" | "online" | "offline";
  /** Same as `relay`: when (ms since the epoch) the window in which new devices may pair through the relay ends. */
  pairingUntil?: number;
  /** Same as `relay`: how many phones have paired since the last reset. */
  pairedPhones?: number;
  localUrl?: string;
  publicUrl?: string;
  /** What the QR encodes: the tunnel's link behind a Cloudflare tunnel, otherwise the relay's. */
  pairingLink?: string;
  /** The encrypted device link, with private routes preferred before the remote fallback. */
  computerLink?: string;
  pairingOptions?: { id: string; label: string; link: string; qrSvg?: string }[];
  qrSvg?: string;
  /** Phone access on this Mac's local network: on or off, and the addresses a phone on the same network dials. */
  lan?: { enabled: boolean; addresses: string[]; error?: string };
};

/** A phone or computer paired to this Mac, as Settings › Devices lists it. `route`: how it is connected now, or null. */
export type PairedDevice = {
  key: string;
  kind: "phone" | "computer";
  /** What the device called itself in its hello; null for phones paired before names. */
  name: string | null;
  pairedAt: number | null;
  lastSeen: number | null;
  /** A phone that paired since the owner last looked at Settings › Devices. Missing from hosts before it. */
  isNew?: boolean;
  route: "lan" | "relay" | null;
};

/** A computer pairing with this Mac for the first time, waiting for Allow in its window (devices:pending). */
export type PendingComputer = { key: string; name: string | null; at: number };

/** How a paired computer stands: "off" while Settings › Devices › Other computers is off. */
export type ComputerState = "off" | "connecting" | "online" | "reconnecting" | "offline" | "refused";
/** A computer this Mac drives, as computers.cjs reports it. `route`: how it is reached while online. */
export type ComputerView = {
  id: string;
  /** This Mac's label for it ("Show it as"); never sent to it. */
  name: string;
  hostId: string;
  relayHost: string;
  state: ComputerState;
  route: "lan" | "relay" | null;
  /** The LAN or tailnet IP its LAN route dialed, where its dev servers answer too; null over the relay or offline. */
  address?: string | null;
  lastSeen: number | null;
  addedAt: number | null;
  /** Why it isn't connected, in words, while that can be said. */
  message: string | null;
  lan: boolean;
  /** The LAN addresses it gave (ws://host:port), at most four. */
  lanRoutes: string[];
};
/** This Mac's name and every computer it drives. */
export type ComputersSnapshot = { thisMac: string; computers: ComputerView[]; enabled?: boolean };
/** What a pasted link names, read before any socket opens. */
export type ComputerPreview = { name: string; hostId: string; relayHost: string };
export type AddComputerResult = { ok: true; computer: ComputerView } | { ok: false; code: string; message: string };
/** An event from a computer's runtime: its channel and payload, tagged with the computer. */
export type ComputerEvent = { computerId: string; channel: string; payload: any };
export type ComputersApi = {
  list: () => Promise<ComputersSnapshot>;
  preview: (link: string) => Promise<ComputerPreview>;
  /** Pairs with the link's computer, waiting through its owner's Allow (onComputerAddPending says when). */
  add: (link: string, options: { name?: string }) => Promise<AddComputerResult>;
  cancelAdd: () => Promise<void>;
  /** A label on this Mac only. */
  rename: (id: string, name: string) => Promise<ComputersSnapshot>;
  remove: (id: string) => Promise<ComputersSnapshot>;
  setEnabled: (on: boolean) => Promise<void>;
  /** One daemon call on the computer. */
  invoke: (id: string, method: string, args?: unknown[]) => Promise<any>;
  /** Keeps a remote scope's state or a chat's window as its offline copy. */
  remember: (
    id: string,
    entry:
      | { kind: "state"; scope: string; state: unknown }
      | { kind: "chat"; scope: string; chatId: number; window: { messages: unknown[]; hasMore: boolean; total: number } },
  ) => Promise<void>;
  /** A chat's offline copy, read to paint it while the computer's own answer is on its way; null without one. */
  recall?: (id: string, entry: { kind: "chat"; scope: string; chatId: number }) => Promise<{ messages: unknown[]; hasMore: boolean; total: number } | null>;
  /** A line about the computer's scopes for daemon.log, which the window has no log of its own for. */
  note?: (id: string, line: string) => Promise<void>;
};

import type { DiffMode, DiffFilesResult, DiffFileResult } from "@milagre/shared/git-diff";
import type {
  MergeMethod,
  PullRequestDetailResult,
  PullRequestWriteResult,
  RepoLabelsResult,
  ReviewerCandidatesResult,
  ReviewEvent,
} from "@milagre/shared/pull-request-review";
export type { DiffMode, DiffFileEntry, DiffFilesResult, DiffFileResult } from "@milagre/shared/git-diff";

/** `hostOutdated`: connected to a host from before result pages, which can't load very large Projects.
 * `notice`: shown once, e.g. the host went away and was started again. `failed`: it couldn't be started again (`message` says why). */
export type RuntimeConnection = { connected: boolean; message?: string; hostOutdated?: boolean; notice?: string; failed?: boolean };
export type RuntimeSnapshot = {
  projects: OpenProject[];
  links?: Array<{ linkId: string; state: LinkState }>;
  runs: { runs: AgentRuns; seq: number };
  ports: AgentPorts;
  eventSeq: number;
};
export type LinkEndpoint = { project_id: string; worktree_path?: string };
export type ProjectLink = { id: string; a: LinkEndpoint; b: LinkEndpoint; created_at: string };
export type CanvasSnapshot = {
  projects: { id: string; path: string; name: string; position: { x: number; y: number } | null; openedAt: string }[];
  links: ProjectLink[];
  projectGroups?: NamedProjectLink[];
  worktreePositions: Record<string, Record<string, { x: number; y: number }>>;
  states: { path: string; state: CoordinatorState }[];
};

export type CliProgress =
  | { provider: ModelProvider; phase: "download"; received: number; total: number }
  | { provider: ModelProvider; phase: "extract" | "validate" | "done" };

export type MilagreBridge = {
  /** `source` is the page's Chat and files, which its `assets/<name>` references load from that Chat's computer. */
  createArtifactPreview: (
    html: string,
    source?: { chatId?: string; assets?: import("@milagre/shared/artifact").ArtifactAsset[]; inline?: true },
  ) => Promise<string>;
  releaseArtifactPreview: (url: string) => Promise<void>;
  simulators: SimulatorApi;
  /** Experimental: agents operate desktop apps on this computer (Settings › Experimental). */
  computerUse: import("@milagre/shared/computer-use").ComputerUseApi;
  /** Experimental: devices leased from a Simlock pool (Settings › Experimental). */
  simlock: import("@milagre/shared/simulator").SimlockApi;
  browsers: BrowserApi;
  pageComments: import("@milagre/shared/page-comments").PageCommentsApi;
  terminals: TerminalApi;
  /** A Chat's Terminals opened, closed or changed what they run. */
  onTerminalsChanged: (callback: (payload: { chatId: string }) => void) => () => void;
  setTerminalFocused: (focused: boolean) => void;
  /** ⌘W pressed while a Terminal has focus. */
  onCloseFocusedTerminal: (callback: () => void) => () => void;
  artifacts: ArtifactApi;
  getRuntimeConnection: () => Promise<RuntimeConnection>;
  /** Stops the running host (it saves and suspends turns) and starts this desktop's own. */
  restartHost: () => Promise<void>;
  onRuntimeConnection: (callback: (state: RuntimeConnection) => void) => () => void;
  onRuntimeSnapshot: (callback: (snapshot: RuntimeSnapshot) => void) => () => void;
  uploadAttachment: (request: {
    projectPath: string;
    name?: string;
    base64?: string;
    reuse?: string;
    transferId?: string;
    offset?: number;
    totalBytes?: number;
  }) => Promise<{ file?: { id: string; path: string } | null; error?: { status: number; message: string } }>;
  getPathForFile: (file: File) => string;
  readAttachment: (file: string) => Promise<{ text: string; binary: boolean; truncated: boolean }>;
  readAttachmentChunk: (file: string, offset: number, version?: string) => Promise<import("@milagre/shared/attachment-download").AttachmentChunk>;
  searchProjectFiles: (root: string, query: string) => Promise<string[]>;
  listSkills: (projectPath: string) => Promise<SkillCatalog>;
  /** The text of a SKILL.md the catalog listed (a shadowed one included), up to 256 KiB. */
  readSkill: (projectPath: string, file: string) => Promise<string>;
  /** The words a dictated message about this folder likely holds, for the recognizer. */
  /** `scope` and `chatId` name the Chat dictated into: the names its last turns used join the words. */
  dictationContext: (request: { cwd: string; chatTitle?: string; scope?: string; chatId?: number }) => Promise<{ terms: string[] }>;
  /** A dictated message with misheard names fixed by a small model of the Chat's agent; as dictated when none answers. */
  polishDictation: (request: { cwd: string; text: string; chatTitle?: string; provider?: string }) => Promise<{ text: string; polished: boolean }>;
  /** Opens a listed SKILL.md in an editor, wherever it lives (user skills are outside any checkout). */
  openSkill: (request: { projectPath: string; file: string; editor?: string }) => Promise<Result<null>>;
  /** Shows a listed SKILL.md in the file manager. */
  revealSkill: (projectPath: string, file: string) => Promise<void>;
  listBranches: (projectPath: string) => Promise<string[]>;
  getProjectImage: (projectPath: string) => Promise<string | null>;
  /** Saves a chosen icon (an image data URL), or null to go back to the repository's own; returns the icon now shown. */
  setProjectIcon: (projectPath: string, icon: string | null) => Promise<string | null>;
  getAppVersion: () => Promise<string>;
  /** Writes a triage session beside this Mac's host profile; `prompt` is the new Chat's draft. */
  prepareTriage: (client: string) => Promise<{ prompt: string }>;
  /** `setupNote`: why the repo's setup file was ignored. */
  createWorktree: (request: WorktreeRequest) => Promise<{ project: OpenProject & { state: CoordinatorState }; worktreeId: number; setupNote?: string }>;
  /** Links an existing worktree to a Linear issue: a Milagre-named branch with no open PR takes the issue's branch name. */
  linkWorktreeIssue: (request: { projectPath: string; worktreeId: number; key: string; workspace?: string }) => Promise<LinkIssueResult>;
  /** Removes the stored issue link; the branch keeps its name. */
  unlinkWorktreeIssue: (request: { projectPath: string; worktreeId: number }) => Promise<{ project: OpenProject & { state: CoordinatorState } }>;
  /** The folders Milagre keeps its worktrees in (the configured one and its real path). */
  getWorktreeRoots: () => Promise<string[]>;
  /** What archiving would lose from a worktree. Rejects when git can't tell. */
  getWorktreeStatus: (worktreePath: string, base: string) => Promise<WorktreeStatus>;
  /**
   * Removes a worktree Milagre made and its branch; `force` discards what it holds. Main closes the chat's agent
   * and checks again against `seen`, the status the user saw. Rejects with git's message, or a message that
   * says the worktree changed after it was checked.
   */
  removeWorktree: (
    worktreePath: string,
    options: { force: boolean; base: string; projectPath: string; chatId: string; seen: WorktreeStatus },
  ) => Promise<{ removed: boolean; alreadyRemoved?: boolean; branch: string | null; branchDeleted: boolean }>;
  /** The project's saved "Files to copy" patterns, with what the effective patterns match now. */
  readFilesToCopy: (projectPath: string) => Promise<FilesToCopy & { filesToCopy: string[] }>;
  /** What patterns would match, without saving them. `.worktreeinclude` still wins. */
  previewFilesToCopy: (projectPath: string, patterns: string[]) => Promise<FilesToCopy>;
  saveFilesToCopy: (projectPath: string, patterns: string[]) => Promise<FilesToCopy & { filesToCopy: string[] }>;
  readWorktreeSetup: (projectPath: string) => Promise<WorktreeSetupSettings>;
  /** Saves the project's setup command; an empty one removes it. `.milagre/worktree.json` still wins. */
  saveWorktreeSetup: (projectPath: string, command: string) => Promise<WorktreeSetupSettings>;
  /** Whether new Worktrees sync their source branch first, and the last sync's result. */
  readMainSync: (projectPath: string) => Promise<MainSyncSettings>;
  /** null brings the global default back. */
  saveMainSync: (projectPath: string, override: boolean | null) => Promise<MainSyncSettings>;
  readMainSyncDefault: () => Promise<{ syncMain: boolean }>;
  saveMainSyncDefault: (value: boolean) => Promise<{ syncMain: boolean }>;
  /** A main branch sync finished, before a new Worktree. */
  onMainSyncStatus: (callback: (status: MainSyncStatus) => void) => () => void;
  /** Whether the host has Designs. Always on now; a paired computer on an older Milagre may still report it off. */
  readDesignsEnabled: () => Promise<{ enabled: boolean }>;
  onDesignsEnabledChanged: (callback: (value: { enabled: boolean }) => void) => () => void;
  /** This Mac's default-off Experimental Bots switch. Bots stay on this Mac: a paired computer's bridge refuses them. */
  readBotsEnabled: () => Promise<{ enabled: boolean }>;
  saveBotsEnabled: (value: boolean) => Promise<{ enabled: boolean }>;
  onBotsEnabledChanged: (callback: (value: { enabled: boolean }) => void) => () => void;
  listBots: () => Promise<BotsSnapshot>;
  onBotsChanged: (callback: (snapshot: BotsSnapshot) => void) => () => void;
  botTemplates: () => Promise<BotTemplate[]>;
  createBot: (input: BotCreateInput) => Promise<BotRecord>;
  updateBot: (id: string, patch: BotPatch) => Promise<BotRecord>;
  /** The bot's Chats stay in Milagre as the user's; its pending sign-offs are denied. */
  removeBot: (id: string) => Promise<void>;
  sendToBot: (id: string, text: string) => Promise<void>;
  /** A sign-off is the card `requestId` in Chat `chatKey`: request ids repeat across Chats. */
  answerBotGate: (chatKey: string, requestId: string, choice: "once" | "always" | "deny") => Promise<GateRecord>;
  revokeBotGrant: (id: string) => Promise<void>;
  readBotBrief: (id: string) => Promise<{ text: string }>;
  readBotMemory: (id: string) => Promise<{ text: string; lines: number; bytes: number }>;
  /** `base`: the text read when the profile opened MEMORY.md; the save is refused when the file changed since. */
  saveBotMemory: (id: string, text: string, base?: string) => Promise<unknown>;
  readLinearStatus: () => Promise<LinearStatus>;
  /** Opens Linear in the browser and resolves once the Mac is connected. A second call replaces a waiting one. */
  /** `window`: sign in from a window of its own with an empty session (Add workspace), not the browser. */
  connectLinear: (options?: { window?: boolean }) => Promise<LinearStatus>;
  disconnectLinear: (workspace: string) => Promise<LinearStatus>;
  /** `moveToStarted`: a Chat started from an issue moves it to In Progress. A Mac that predates it sends none (on). */
  readLinearEnabled: () => Promise<{ enabled: boolean; moveToStarted?: boolean }>;
  saveLinearMoveToStarted: (value: boolean) => Promise<{ moveToStarted: boolean }>;
  /** Settings › Accounts: after a usage limit, move the Chat's Project to the next ready account and continue by itself. */
  readLimitAutoSwitch: () => Promise<{ autoSwitch: boolean }>;
  saveLimitAutoSwitch: (value: boolean) => Promise<{ autoSwitch: boolean }>;
  readLimitResumeAtReset: () => Promise<{ resumeAtReset: boolean }>;
  saveLimitResumeAtReset: (value: boolean) => Promise<{ resumeAtReset: boolean }>;
  scheduleLimitResume: (projectPath: string, sessionId: number, sourceMessageId: number) => Promise<boolean>;
  cancelLimitResume: (projectPath: string, sessionId: number, sendId: string) => Promise<boolean>;
  /** Settings › About: install a downloaded update by itself once no Chat or Routine runs and the Mac sits unused for 5 minutes. Kept by the host, so a paired desktop or the phone flips it too. */
  readAutoUpdate: () => Promise<{ autoUpdate: boolean }>;
  saveAutoUpdate: (value: boolean) => Promise<{ autoUpdate: boolean }>;
  /** The switch changed, here or from another device. */
  onAutoUpdate: (callback: (value: { autoUpdate: boolean }) => void) => () => void;
  /**
   * A paired computer's Computer page (and the phone): the update of the desktop app open on that computer and the
   * version it runs, through its host; null while no desktop app is open there. This Mac's own window uses getUpdateState.
   */
  readHostUpdate: () => Promise<HostUpdate>;
  /** Starts a check there and answers at once with the check begun; readHostUpdate follows it. */
  checkHostUpdate: () => Promise<HostUpdate>;
  /** Restarts Milagre there to install a downloaded update; rejects when none is ready. Running Chats resume after the restart. */
  installHostUpdate: () => Promise<HostUpdate>;
  /** Settings › Devices: this computer's memory and disk and how much Milagre takes (a paired computer's bridge reads that computer's). */
  readComputerResources: () => Promise<ComputerResources>;
  /** Settings › Keybindings: the rules of keybindings.json on this computer (a paired computer's bridge reads that computer's). A missing file is created with the defaults. */
  readKeybindings: () => Promise<KeybindingsState>;
  /** Replaces one command's rules (none unbinds it). Rejects an unknown command, a key or `when` Milagre can't read, or a file with errors. */
  setKeybindingCommand: (command: KeybindingCommandId, rules: Array<Pick<KeybindingRule, "key" | "when">>) => Promise<KeybindingsState>;
  resetKeybindingCommand: (command: KeybindingCommandId) => Promise<KeybindingsState>;
  /** Writes the defaults over the whole file, which also fixes a file with errors. */
  resetKeybindings: () => Promise<KeybindingsState>;
  /** The file changed, from Settings on any device or by hand; the callback gets the full state. */
  onKeybindings: (callback: (state: KeybindingsState) => void) => () => void;
  /** Opens this Mac's keybindings.json in the default editor. Only on this Mac's own bridge: a paired computer's refuses. */
  openKeybindingsFile: () => Promise<void>;
  /** Settings › Babysit PRs: the one global configuration every Chat's babysitting follows. Kept by the host, so a paired desktop or the phone edits it too. */
  readContextSettings: () => Promise<ContextSettings>;
  saveContextSettings: (patch: Partial<ContextSettings>) => Promise<ContextSettings>;
  onContextSettings: (callback: (value: ContextSettings) => void) => () => void;
  readBabysitSettings: () => Promise<BabysitSettings>;
  /** Merges the patch over the stored settings and returns the normalized result. */
  saveBabysitSettings: (patch: Partial<BabysitSettings>) => Promise<BabysitSettings>;
  /** The settings changed, here or from another device. */
  onBabysitSettings: (callback: (value: BabysitSettings) => void) => () => void;
  /** Settings › Chats: how long a Chat stays in the Done list before the host archives it. Kept by the host. */
  readDoneSettings: () => Promise<DoneSettings>;
  /** Merges the patch over the stored settings and returns the normalized result. */
  saveDoneSettings: (patch: Partial<DoneSettings>) => Promise<DoneSettings>;
  /** The settings changed, here or from another device. */
  onDoneSettings: (callback: (value: DoneSettings) => void) => () => void;
  /** Whether this Mac runs Routines: always `true` now; an older paired computer may still say `false`. */
  readRoutinesEnabled: () => Promise<{ enabled: boolean }>;
  /** This Mac's routines that haven't ended, newest first, each with its latest Runs first. */
  listRoutines: () => Promise<{ routines: Array<Routine & { runs: RoutineRun[] }> }>;
  updateRoutine: (id: string, patch: RoutineUpdate) => Promise<Routine>;
  deleteRoutine: (id: string) => Promise<{ removed: boolean }>;
  runRoutineNow: (id: string) => Promise<RoutineRun | undefined>;
  /** `hookUrl` comes with a webhook Routine (a later update). */
  createRoutine: (input: RoutineCreate) => Promise<{ routine: Routine; hookUrl?: string }>;
  routineTargets: () => Promise<RoutineTargets>;
  /** The Routines form's Linear choices: labels and states are the named team's. `error` says why a read failed. */
  routineLinearOptions: (args?: { workspace?: string; team?: string }) => Promise<RoutineLinearOptions>;
  /** A webhook Routine's URL (on the relay), whether it checks an HMAC, and the header that carries it. */
  routineHook: (id: string) => Promise<{ url: string; signed: boolean; signingHeader: string }>;
  /** A new URL for a webhook Routine; the old one stops at once. Signing stays as it was. */
  rotateRoutineHook: (id: string) => Promise<{ url: string }>;
  onRoutinesChanged: (callback: () => void) => () => void;
  saveLinearEnabled: (value: boolean) => Promise<{ enabled: boolean }>;
  onLinearStatusChanged: (callback: (status: LinearStatus) => void) => () => void;
  mcp: {
    accounts: () => Promise<McpAccount[]>;
    check: (provider: McpProvider, accountId: string) => Promise<McpAccountCheck>;
    definition: (name: string, target: McpTarget) => Promise<McpServerDefinition | null>;
    save: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => Promise<void>;
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => Promise<void>;
    remove: (name: string, target: McpTarget) => Promise<void>;
    toggle: (provider: McpProvider, accountId: string, name: string, on: boolean) => Promise<void>;
    signIn: (name: string, accounts: { provider: McpProvider; accountId: string }[]) => Promise<{ started: true }>;
    cancelSignIn: (name: string) => Promise<void>;
    onChanged: (callback: (event: McpChangedEvent) => void) => () => void;
  };
  localMcp: LocalMcpApi;
  /** The Linear switch (Settings › Connections › Linear) changed, on this Mac or from a phone. */
  onLinearEnabledChanged: (callback: (value: { enabled: boolean }) => void) => () => void;
  /** Assigned issues when query is empty, otherwise workspace matches (a key also finds that issue first). Never rejects. */
  listLinearIssues: (query?: string, options?: { fresh?: boolean; workspace?: string }) => Promise<LinearIssuesResult>;
  /** Each Worktree's Linear issue by worktree path, for the chips. {} when off, disconnected or on error. */
  readWorktreeLinearIssues: (projectPath: string) => Promise<Record<string, LinearIssue>>;
  /** A new worktree's branch got the name picked for its chat, a few seconds after it was created. */
  onWorktreeRenamed: (callback: (rename: WorktreeRename) => void) => () => void;
  /** Re-reads the given worktrees' diff stats in the main process, e.g. after a commit from the "Commit and open PR" dialog. */
  refreshDiffs: (projectPath: string, worktreeIds: number[]) => Promise<void>;
  /** The current branch's open or merged PR, or null when none is available. */
  readPullRequest: (worktreePath: string) => Promise<PullRequest | null>;
  /** PRs a chat created or merged, by URL or number, looked up from its folder; null where one can't be read. */
  readPullRequests: (worktreePath: string, refs: string[]) => Promise<Array<PullRequest | null>>;
  /**
   * Every PR of a Project's Worktrees (by folder) and Chats (by folder, then ref) from the host's last poll, without
   * waiting on GitHub. `pending` when some were never read: they arrive with `onPullRequestsChanged`.
   */
  readPullRequestSnapshot: (projectPath: string) => Promise<PullRequestSnapshot>;
  /** A Project's PRs changed on the host's poll; read the snapshot again. */
  onPullRequestsChanged: (callback: (change: { projectPath: string }) => void) => () => void;
  /** Opens a project or worktree folder in the file manager; rejects for any other folder. */
  revealInFolder: (folder: string) => Promise<void>;
  /** Puts a chat image on the clipboard; `file` is its absolute path, or a pasted image's data URL. */
  copyImage: (file: string) => Promise<void>;
  /** Saves a copy of a chat image where the user picks, named after `name` when it is a data URL; the saved path, or null when cancelled. */
  saveImage: (file: string, name?: string) => Promise<string | null>;
  /** The image's right-click menu: Copy Image and Save Image…. */
  showImageMenu: (file: string, name?: string) => Promise<void>;
  /** The "Commit and open PR" dialog: git and gh run in the chat's folder (`cwd`). */
  git: {
    history: (request: {
      cwd: string;
      base?: string;
      recordedBase?: string;
      branchesVersion?: string;
      limit?: number;
    }) => Promise<import("@milagre/shared/git-diff").GitHistory>;
    changes: (request: { cwd: string; base?: string }) => Promise<GitChanges>;
    /** Files changed against HEAD or the comparison branch. With `commit`, compares that immutable SHA with its first parent (or the empty tree). */
    diffFiles: (request: { cwd: string; base?: string; commit?: string | null; mode: DiffMode }) => Promise<DiffFilesResult>;
    /** One file's unified patch. Rejects for a path that is absolute or climbs out of the folder. */
    diffFile: (request: {
      cwd: string;
      base?: string;
      commit?: string | null;
      mode: DiffMode;
      path: string;
      oldPath?: string;
      untracked?: boolean;
    }) => Promise<DiffFileResult>;
    /** Never rejects for a model failure: `ok: false` carries the note the dialog shows. */
    generate: (request: { cwd: string; base?: string; provider?: ModelProvider; chat: GitChatContext }) => Promise<GitTextResult>;
    commit: (request: { cwd: string; message: string }) => Promise<GitCommitResult>;
    push: (request: { cwd: string }) => Promise<GitPushResult>;
    openPr: (request: { cwd: string; base?: string; title: string; body: string }) => Promise<GitPrResult>;
  };
  /** The PR a Chat's branch opened, read and reviewed through gh in the Chat's folder (`cwd`). Writes never reject: `ok: false` carries GitHub's reason. */
  pr: {
    detail: (request: { cwd: string; number: number }) => Promise<PullRequestDetailResult>;
    /** The PR's files as GitHub diffs them, merge-base(base, head)..head; both are commit ids from the detail. */
    diffFiles: (request: { cwd: string; base: string; head: string }) => Promise<DiffFilesResult | { ok: false; message: string }>;
    diffFile: (request: {
      cwd: string;
      base: string;
      head: string;
      path: string;
      oldPath?: string;
    }) => Promise<DiffFileResult | { ok: false; message: string }>;
    /** A draft comment on `line` (or `startLine`..`line`), added to the viewer's pending review. */
    comment: (request: {
      cwd: string;
      number: number;
      path: string;
      line: number;
      startLine?: number;
      side?: "LEFT" | "RIGHT";
      body: string;
    }) => Promise<PullRequestWriteResult>;
    /** A draft reply in a thread, added to the viewer's pending review. */
    reply: (request: { cwd: string; number: number; threadId: string; body: string }) => Promise<PullRequestWriteResult>;
    deleteComment: (request: { cwd: string; commentId: string }) => Promise<PullRequestWriteResult>;
    submitReview: (request: { cwd: string; number: number; event: ReviewEvent; body: string }) => Promise<PullRequestWriteResult>;
    resolveThread: (request: { cwd: string; threadId: string; resolved: boolean }) => Promise<PullRequestWriteResult>;
    /** Merges now, turns auto-merge on (`auto`) or off (`disableAuto`); `admin` bypasses unmet requirements where allowed. */
    merge: (request: {
      cwd: string;
      number: number;
      method: MergeMethod;
      auto?: boolean;
      admin?: boolean;
      disableAuto?: boolean;
    }) => Promise<PullRequestWriteResult>;
    /** Marks a draft ready for review, or turns it back into a draft (`draft`). */
    ready: (request: { cwd: string; number: number; draft?: boolean }) => Promise<PullRequestWriteResult>;
    /** A GitHub attachment of the PR's description or comments, read with gh's token, as a data URL. */
    image: (request: { cwd: string; url: string }) => Promise<{ ok: true; dataUrl: string } | { ok: false; message: string }>;
    /** The repository's labels, for the labels picker. */
    labels: (request: { cwd: string }) => Promise<RepoLabelsResult>;
    setLabels: (request: { cwd: string; number: number; add: string[]; remove: string[] }) => Promise<PullRequestWriteResult>;
    /** Who can be asked to review: the repository's assignable users. */
    reviewerCandidates: (request: { cwd: string }) => Promise<ReviewerCandidatesResult>;
    requestReviewers: (request: { cwd: string; number: number; add: string[]; remove: string[] }) => Promise<PullRequestWriteResult>;
  };
  /** Code editors found on this Mac, in the order the first becomes the default. */
  listEditors: () => Promise<EditorInfo[]>;
  /** Opens a file (or, with no path, the folder) in an editor. `path` is relative to `root`. Returns a Result with a failure code and message. */
  openInEditor: (request: { root: string; path?: string; line?: number; editor?: string }) => Promise<Result<null>>;
  getCurrentProject: () => Promise<(OpenProject & StateStamp) | null>;
  openProject: () => Promise<(OpenProject & StateStamp) | null>;
  /** Opens a folder of this computer as a Project, without the dialog. */
  openProjectAt: (folder: string) => Promise<OpenProject>;
  listDirs: (request: { path?: string }) => Promise<DirListing>;
  readMedia: (request: { scope: string; path: string }) => Promise<MediaBytes>;
  /** Projects opened lately, most recent first; folders that are gone are left out. */
  listRecentProjects: () => Promise<RecentProject[]>;
  /** Every Project the computer knows, newest opened first, for the new-chat picker. Rejects on a computer that predates it. */
  listKnownProjects: () => Promise<RecentProject[]>;
  /** Onboarding: folders Claude Code and Codex sessions on this Mac worked in, newest first. */
  listAgentFolders: () => Promise<import("@milagre/shared/model").AgentFolder[]>;
  /** Onboarding: a new folder in ~/Code with Git, opened as a Project. */
  createProject: (name: string) => Promise<OpenProject>;
  /** Onboarding: clones a repository into ~/Code and opens it. */
  cloneProject: (url: string) => Promise<OpenProject>;
  /** Sets up Git in a Project folder that has none (git init, first commit when Git knows who you are), then opens it. */
  setUpGit: (folder: string) => Promise<OpenProject>;
  /** Keeps a recent project out of the all-Projects sidebar and the phone's list, or shows it again; resolves to the list. */
  setProjectHidden: (projectPath: string, hidden: boolean) => Promise<RecentProject[]>;
  /** Loads a recent project's chats without opening it; later changes arrive through onProjectState. */
  retrySave: (scope: string) => Promise<void>;
  readProject: {
    /** No options: the sidebar's read of a Project it lists. With options: a window opening it (on another computer). */
    (projectPath: string, options?: { state: true }): Promise<OpenProject & StateStamp>;
    /** `state: false`: only the Project's path, name and state number, for a window that holds its state already. */
    (projectPath: string, options: { state: false }): Promise<ProjectRead>;
  };
  /** Where this computer's Chats home is, the repository Chats without a Project run in, and whether it exists yet. */
  chatsHome: () => Promise<ChatsHome>;
  /** Makes the Chats home when it is missing and reads it, leaving the shown Project alone; never added to the recent list. */
  ensureChatsHome: () => Promise<OpenProject & StateStamp & { kind: "chats" }>;
  /** Every opened Project, seeded once from existing coordination files. */
  listNamedLinks: () => Promise<NamedProjectLink[]>;
  createNamedLink: (request: { name: string; projectIds: string[]; hidden?: boolean }) => Promise<NamedProjectLink>;
  updateNamedLink: (request: { id: string; name: string; projectIds: string[]; hidden?: boolean }) => Promise<NamedProjectLink>;
  openNamedLink: (id: string) => Promise<OpenLink & StateStamp>;
  /** A Link's chats as saved, without opening it or preparing its worktrees. */
  readLink: (id: string) => Promise<{ link: NamedProjectLink; state: LinkState } & StateStamp>;
  sendLinkMessage: (request: LinkSendRequest) => Promise<{ sessionId: number }>;
  /** Raw from the host: a whole state, or a patch (see StateNumbering). Listen through state-events.ts instead. */
  onLinkState: (callback: (update: { linkId: string; state?: LinkState } & StateNumbering) => void) => () => void;
  listProjects: () => Promise<{ id: string; path: string; name: string; position: { x: number; y: number } | null; openedAt: string }[]>;
  setProjectPosition: (
    id: string,
    position: { x: number; y: number },
  ) => Promise<{ id: string; path: string; name: string; position: { x: number; y: number } | null; openedAt: string }[]>;
  getCanvas: () => Promise<CanvasSnapshot>;
  addLink: (a: LinkEndpoint, b: LinkEndpoint) => Promise<ProjectLink[]>;
  removeLink: (id: string) => Promise<ProjectLink[]>;
  /** Undo of a removal: the same Link with its id, so what was saved against it holds again. */
  restoreLink?: (link: ProjectLink) => Promise<ProjectLink[]>;
  /** The canvas Links alone, without every Project's state; a Mac that predates it rejects. */
  getLinks?: () => Promise<ProjectLink[]>;
  /** Every Link change, from the canvas, the sidebar or the phone. */
  onLinksChanged?: (callback: (links: ProjectLink[]) => void) => () => void;
  /** "Always allow for this Link in this chat", set before the Chat's agent asks for a Delegation. */
  grantDelegations?: (chatId: string, linkId: string) => Promise<void>;
  /** Delegations and Negotiations still open across Links, and the Codex Chats that only receive. */
  getLinkedWork: () => Promise<LinkedWork>;
  /** Settings > Experimental: whether this Mac's Chats may delegate to another paired computer's Projects. */
  readRemoteDelegationEnabled: () => Promise<{ enabled: boolean }>;
  saveRemoteDelegationEnabled: (value: boolean) => Promise<{ enabled: boolean }>;
  onRemoteDelegationEnabledChanged: (callback: (value: { enabled: boolean }) => void) => () => void;
  readDeviceNotesEnabled: () => Promise<{ enabled: boolean }>;
  saveDeviceNotesEnabled: (value: boolean) => Promise<{ enabled: boolean }>;
  onDeviceNotesEnabledChanged: (callback: (value: { enabled: boolean }) => void) => () => void;
  onLinkedWork: (callback: (work: LinkedWork) => void) => () => void;
  /** An app shortcut (⌘⇧ plus a letter, or ⌘,) pressed in any frame, forwarded by the main process. */
  onAppShortcut: (callback: (shortcut: { key: string; code?: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }) => void) => () => void;
  /** The canvas's Stop on a Link: the Negotiation stops, turns already running finish. */
  stopNegotiation: (id: string) => Promise<void>;
  setWorktreePosition: (id: string, worktreePath: string, position: { x: number; y: number }) => Promise<unknown>;
  openCanvasProject: (projectPath: string) => Promise<OpenProject & StateStamp>;
  /** Opens a project from the recent list. Rejects for a path that isn't listed or isn't a checkout's top folder. */
  switchProject: (projectPath: string) => Promise<OpenProject & StateStamp>;
  /** Takes a project off the recent list (its folder is untouched) and resolves to the list. */
  forgetProject: (projectPath: string) => Promise<RecentProject[]>;
  /** A project's state changed in the main process, its only writer. Changes made by agent events come with the event instead. */
  retryQuit: () => Promise<void>;
  onQuitFailed: (callback: (message: string) => void) => () => void;
  /** Raw from the host: a whole state, or a patch (see StateNumbering). Listen through state-events.ts instead. */
  onProjectState: (callback: (update: { path: string; state?: CoordinatorState } & StateNumbering) => void) => () => void;
  /** Saves a message in its chat (a new one when `sessionId` is null), then starts or steers the chat's turn. */
  checkpoints: CheckpointApi;
  sendStatus: (owner: string, id: string) => Promise<{ sessionId: number } | null>;
  sendMessage: (request: ChatSendRequest) => Promise<{ sessionId: number }>;
  /** Continues a chat a quit stopped mid-turn, on its saved options. Resolves false when it has nothing to continue. */
  resumeChat: (projectPath: string, sessionId: number) => Promise<boolean>;
  /** Stops a running turn and ends the chat's agent process; the next message resumes its session in a new one. */
  reloadChat: (chatId: string) => Promise<void>;
  /** Starts a message queued behind a turn that can't be steered, stopping that turn first if it still runs. */
  sendQueuedNow: (chatId: string, id: string) => Promise<void>;
  /** Drops a queued message unsent; false when it was already gone. */
  removeQueued: (chatId: string, id: string) => Promise<boolean>;
  /** The limit card: moves the Chat's Project to `accountId`, then continues the Chat there (`continued` false: send again). */
  switchAccountAfterLimit: (
    projectPath: string,
    sessionId: number,
    provider: ModelProvider,
    accountId: string,
  ) => Promise<{ continued: boolean; label: string }>;
  patchChat: (projectPath: string, sessionId: number, patch: SessionPatch) => Promise<void>;
  deleteChat: (projectPath: string, sessionId: number) => Promise<void>;
  /** Archives one of a chat's subagents, or brings it back; the provider carries on either way. */
  archiveSubagent: (projectPath: string, sessionId: number, id: string, archived: boolean) => Promise<void>;
  archiveFinishedSubagents: (projectPath: string, sessionId: number) => Promise<void>;
  /** Records in a chat what the "Commit and open PR" dialog did; while the chat's turn runs, the line waits for it to end. */
  addGitNote: (chatId: string, body: string) => Promise<void>;
  /** The chat on screen, by chat key, which opening reads; a turn that ends in any other chat leaves it unread. */
  setOpenChat: (chatId: string | null) => Promise<void>;
  /** The turns streaming now, in every project, and the number of the last agent event they hold. */
  getRuns: () => Promise<{ runs: AgentRuns; seq: number }>;
  /** One saved message of a Project or Link (scope key), with the long step details the state leaves out. */
  getMessage: (scope: string, id: number) => Promise<ChatMessage>;
  respondToPermission: (chatId: string, requestId: string, decision: PermissionDecision) => Promise<boolean>;
  /** Sends the answers to a question card, or dismisses it (null). False when the question is gone. */
  answerQuestion: (chatId: string, requestId: string, answers: QuestionAnswers | null, summary?: string) => Promise<boolean>;
  setAgentPermissionMode: (chatId: string, mode: PermissionMode) => Promise<void>;
  /** Each agent's model list as its CLI reports it, asked once per app run; null for an agent that couldn't be asked. */
  listAccountScopes: () => Promise<ProjectAccountScope[]>;
  getProjectAccounts: (scopeKey: string, refresh?: boolean) => Promise<ProjectAccountsSnapshot>;
  assignProjectAccount: (scopeKey: string, provider: ModelProvider, accountId: string | null) => Promise<ProjectAccountsSnapshot>;
  getModels: (scopeKey?: string) => Promise<AgentModels>;
  /** How each agent's CLI stands (missing, outdated, broken, logged out, or ready); checked again on every call while it has a problem. */
  getCliStatus: (scopeKey?: string) => Promise<AgentCliStatus>;
  /** Runs update for the specified CLI agent and refreshes status. */
  getProviderUpdates: () => Promise<import("@milagre/shared/model").ProviderUpdate[]>;
  updateCli: (provider: ModelProvider, targetVersion?: string) => Promise<{ ok: boolean; version?: string; error?: string; status?: CliStatus }>;
  stopAdvisor: (chatId: string, id: string) => Promise<Subagent>;
  retryAdvisor: (chatId: string, id: string) => Promise<Subagent>;
  /** Where Antigravity's install stands while `updateCli("antigravity")` runs: download bytes, then extract, validate, done. */
  onCliProgress: (callback: (progress: CliProgress) => void) => () => void;
  interruptAgent: (chatId: string) => Promise<void>;
  /** An agent event, with its project's new state when the event changed it, and its number once it's folded into the main process's runs (see getRuns). */
  /** Raw from the host; an event's state can come as a patch (see StateNumbering). For the state, listen through state-events.ts. */
  onAgentEvent: (
    callback: (payload: { chatId: string; event: AgentEvent; state?: CoordinatorState | LinkState; seq?: number } & StateNumbering) => void,
  ) => () => void;
  /** A Project's or Link's (scope key) state and its number, for applying the host's state patches. */
  readState: (scope: string) => Promise<{ state: CoordinatorState | LinkState; version: number; epoch: string }>;
  /** A page of one Chat's messages: its latest turns, or those before the message `before` (chat-pages-v1). */
  readChatMessages: (
    scope: string,
    chatId: number,
    options?: { before?: number; turns?: number; limit?: number },
  ) => Promise<{ messages: ChatMessage[]; hasMore: boolean; total: number }>;
  /** Matches across the Chats of a Project or Link, best first (chat-pages-v1). */
  searchChats: (scope: string, query: string, options?: { limit?: number }) => Promise<ChatSearchMatch[]>;
  /** One subagent of Chat `chatId` with its whole transcript (subagent-tails-v1). */
  readSubagent: (scope: string, chatId: number, agentId: string) => Promise<Subagent>;
  /** The end of a background command's output in Chat `chatId` (a chat key), read from its live agent process. */
  readTaskOutput: (chatId: string, taskId: string) => Promise<BackgroundTaskOutput>;
  /** Every chat's listening ports now, by chat key. */
  getAgentPorts: () => Promise<AgentPorts>;
  /** Stops the command listening on one of a chat's ports; false when the chat's list doesn't show that pid. */
  stopAgentPort: (chatId: string, pid: number) => Promise<boolean>;
  /** Every chat's listening ports, each time any of them change. */
  onAgentPorts: (callback: (ports: AgentPorts) => void) => () => void;
  getUpdateState: () => Promise<UpdateState>;
  getUpdateReleaseNotes: (version: string) => Promise<string>;
  checkForUpdates: () => Promise<UpdateState>;
  getReleaseChannel: () => Promise<ReleaseChannel>;
  setReleaseChannel: (channel: ReleaseChannel) => Promise<ReleaseChannel>;
  installUpdate: () => Promise<void>;
  onUpdateState: (callback: (state: UpdateState) => void) => () => void;
  getPhoneStatus: () => Promise<PhoneStatus>;
  /** Turns phone access on or off. Resolves as it starts; progress and the result arrive through onPhoneStatus. */
  setPhoneEnabled: (enabled: boolean) => Promise<PhoneStatus>;
  /** Turns phone access over the local network on or off. Resolves with the new status. */
  setPhoneLan(enabled: boolean): Promise<PhoneStatus>;
  /** A new access token: phones paired before scan again. */
  resetPhoneAccess: () => Promise<PhoneStatus>;
  /** Lets phones that have not paired yet do so for another ten minutes. */
  openPhonePairing: () => Promise<PhoneStatus>;
  /** Every phone and computer paired to this Mac. */
  listDevices: () => Promise<PairedDevice[]>;
  /** Forgets one and closes its connections; resolves with the devices left. */
  removeDevice: (key: string) => Promise<PairedDevice[]>;
  /** The owner saw these devices in Settings › Devices, so they are no longer New; resolves with every device. */
  acknowledgeDevices: (keys: string[]) => Promise<PairedDevice[]>;
  /** Computers waiting for Allow, oldest first. */
  listPendingDevices: () => Promise<PendingComputer[]>;
  /** Lets a waiting computer pair; resolves with the ones still waiting. */
  allowDevice: (key: string) => Promise<PendingComputer[]>;
  /** Turns a waiting computer away; resolves with the ones still waiting. */
  denyDevice: (key: string) => Promise<PendingComputer[]>;
  onDevicesPending: (callback: (payload: { requests: PendingComputer[] }) => void) => () => void;
  onPhoneStatus: (callback: (status: PhoneStatus) => void) => () => void;
  listAccounts: (refresh?: boolean) => Promise<import("@milagre/shared/model").AccountsSnapshot>;
  accountAction: (
    action: "add" | "select" | "login" | "cancel" | "remove",
    provider: ModelProvider,
    value: string,
  ) => Promise<import("@milagre/shared/model").AccountsSnapshot>;
  onAccountsChanged: (callback: () => void) => () => void;
  onUsageChanged: (callback: (payload: { scopeKey?: string }) => void) => () => void;
  readUsage: (scopeKey?: string) => Promise<UsageSnapshot>;
  /** Whether the Mac stays awake while Milagre runs (the screen can still sleep; plugged in, also with the lid closed). */
  setKeepAwake: (enabled: boolean) => Promise<void>;
  getCachedUsage: (scopeKey?: string) => Promise<UsageSnapshot>;
  /** The Usage page: tokens and estimated cost from this computer's Claude Code and Codex transcripts. */
  readTokenUsage: (request: import("@milagre/shared/token-usage").TokenUsageRequest) => Promise<import("@milagre/shared/token-usage").TokenUsageReport>;
  /** A transcript scan or a price refresh changed what readTokenUsage returns. */
  onTokenUsageChanged: (callback: () => void) => () => void;
  /** Whether a chat that waits on the user while Milagre is in the background gets a system notification. */
  setNotifyWhenWaiting: (on: boolean) => Promise<void>;
  /** The notification chime (Settings › Notifications): a chat's notification goes silent and the window plays it (onPlayChime). */
  setNotificationChime: (chime: import("@milagre/shared/notification-chimes").NotificationChime) => Promise<void>;
  setNotificationSchedule: (schedule: import("@milagre/shared/notification-schedule").NotificationSchedule | null) => Promise<void>;
  onPlayChime: (callback: (chime: string) => void) => () => void;
  /** Whether the window lets the blurred desktop show through (macOS). `theme` picks the blur material. */
  setWindowBackground: (background: string) => Promise<void>;
  /** The open project's unread chats and the notification settings, for completion alerts and the Dock badge. */
  syncNotifications: (state: {
    projectPath: string;
    activeChatId: string | null;
    unread: string[];
    notifyOnCompletion: boolean;
    showDockBadge: boolean;
  }) => Promise<void>;
  notifyCompletion: (notice: { chatId: string; title: string }) => Promise<boolean>;
  getInbox: () => Promise<import("@milagre/shared/attention").InboxSnapshot>;
  setFloatingInbox: (on: boolean) => Promise<void>;
  toggleFloatingInbox: () => Promise<void>;
  selectInboxItem: (key: string) => Promise<void>;
  getSelectedInboxItem: () => Promise<string | null>;
  onSelectedInboxItem: (callback: (key: string) => void) => () => void;
  getFloatingInboxOpen: () => Promise<boolean>;
  onFloatingInboxOpen: (callback: (open: boolean) => void) => () => void;
  expandFloatingBar: (on: boolean, reducedMotion?: boolean) => Promise<void>;
  closeFloatingInbox: () => Promise<void>;
  resizeFloatingBar: (count: number) => Promise<void>;
  resizeFloatingInbox: (height: number, reducedMotion?: boolean) => Promise<void>;
  showInboxPreview: (key: string | null, y?: number) => Promise<void>;
  getInboxPreviewKey: () => Promise<string | null>;
  onInboxPreview: (callback: (key: string | null) => void) => () => void;
  getFloatingPlacement: () => Promise<"left" | "right" | "bottom">;
  onFloatingPlacement: (callback: (edge: "left" | "right" | "bottom") => void) => () => void;
  beginFloatingDrag: (reducedMotion: boolean) => Promise<void>;
  moveFloatingDrag: () => Promise<void>;
  endFloatingDrag: (cancel?: boolean) => Promise<void>;
  getFloatingDragOverlay: () => Promise<FloatingDragOverlay | null>;
  onFloatingDragOverlay: (callback: (state: FloatingDragOverlay | null) => void) => () => void;
  openInboxChat: (key: string) => Promise<void>;
  openInboxSettings: () => Promise<void>;
  onOpenExperimental: (callback: () => void) => () => void;
  /** A notification was clicked: the window is back, and the chat it was about should open. */
  onOpenChat: (callback: (chatId: string) => void) => () => void;
  /** The "phone paired" notification was clicked: the window is back, and Settings → Devices should open. */
  onOpenPhoneSettings: (callback: () => void) => () => void;
};

declare global {
  interface Window {
    milagrePreferences?: import("./lib/preference-storage").PreferenceBridge;
    milagreWindowChrome?: { controls: "leading" | "overlay" | "external" };
    /** The Browser panel's pages, which live in this window (electron/browser-guests.cjs). Absent outside Electron. */
    milagreBrowserPanel?: {
      partition: string;
      /** A page asked for a new window; `from` is its webContents id. */
      onOpenTab: (callback: (request: { from: number; url: string }) => void) => () => void;
      /** ⌘L, ⌘R or ⌘W pressed inside the page with webContents id `from`. */
      onKey: (callback: (request: { from: number; key: "l" | "r" | "w" }) => void) => () => void;
      /** The agent opened a page in a Chat's Browser panel (browser_open). */
      onOpenUrl?: (callback: (request: { chatKey: string; url: string }) => void) => () => void;
      /**
       * A page with webContents id `from` started or stopped being viewed from the phone or another computer, or its
       * viewer's size changed: `viewport` is the size it lays out at while parked, null for its own.
       */
      onViewed?: (callback: (request: { from: number; viewed: boolean; viewport?: { width: number; height: number } | null }) => void) => () => void;
      /** The panel's pages in this window, each webview's webContents id and its Chat, for the host's browser service. */
      setPages: (pages: { contentsId: number; chatKey: string }[]) => Promise<void>;
      /** A PNG data URL of part of the page with webContents id `contentsId`, in its CSS pixels; null if it is gone. */
      capture: (contentsId: number, rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>;
      /**
       * The session a Chat on another computer opens its pages in, with that computer as its proxy: the page draws here
       * and reaches localhost and the web from there. Rejects while the computer can't be reached.
       */
      remotePartition?: (chatKey: string) => Promise<string>;
      /** Signs the pages of this Mac's Chats ("local") or of one computer's out of every site; open ones reload. */
      clearSignIns?: (computerId: string) => Promise<{ cleared: true }>;
    };
    milagre: MilagreBridge & {
      /** The same calls on a paired computer, carried there by main; this Mac's own actions refuse with "Not available on a remote computer". */
      on: (computerId: string) => MilagreBridge;
      computers: ComputersApi;
      onComputersChanged: (callback: (snapshot: ComputersSnapshot) => void) => () => void;
      /** The computer being added is waiting for its owner's Allow. */
      onComputerAddPending: (callback: () => void) => () => void;
      /** Every computer's runtime events. */
      onComputerEvent: (callback: (event: ComputerEvent) => void) => () => void;
      /**
       * Whisper on this computer: `audio` is 16 kHz mono 16-bit PCM. Each model (ids from WHISPER_MODELS.desktop)
       * downloads once; `onModel` reports every change to one, its download progress included, to every window.
       */
      dictation: {
        status: () => Promise<DictationModelState[]>;
        download: (id: string) => Promise<void>;
        cancel: (id: string) => Promise<void>;
        remove: (id: string) => Promise<void>;
        prepare: (id: string) => Promise<void>;
        transcribe: (request: { audio: ArrayBuffer; language: string; prompt: string; model: string }) => Promise<{ text: string }>;
        onModel: (callback: (state: DictationModelState) => void) => () => void;
        /** The system's microphone privacy settings, where a refused microphone is allowed again. */
        openSettings: () => Promise<void>;
      };
    };
  }
}

/** A speech model on this computer: downloaded, and how many bytes of its download in flight have arrived (null when none is). */
export type DictationModelState = { id: string; ready: boolean; size: number; received: number | null };

/** One folder of a computer's home folder, for the remote folder picker (fs:list-dirs). */
export type DirListing = {
  path: string;
  home: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; git: boolean; branch: string | null; project: boolean }>;
  /** The folder holds more subfolders than are listed (the first 500 by name). */
  truncated?: boolean;
};
/** An image a chat shows, read from its computer (media:read). */
export type MediaBytes = { type: string; size: number; base64: string };

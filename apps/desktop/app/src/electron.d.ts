import type { MainSyncSettings, MainSyncStatus } from "@milagre/shared/main-sync";
import type { McpAccount, McpAccountCheck } from "@milagre/shared/mcp";
import type { LinearIssue, LinearIssuesResult, LinearStatus } from "@milagre/shared/linear";
import type {
  ProjectAccountScope,
  ProjectAccountsSnapshot,
  NamedProjectLink,
  OpenLink,
  LinkState,
  LinkSendRequest,
  TranscriptState,
  ChatMessage,
} from "@milagre/shared/model";
import type { Result } from "@milagre/shared/result";
import type { StatePatch } from "@milagre/shared/state-patch";
export type FloatingDragOverlay = {
  targets: Array<{ edge: "left" | "right" | "bottom"; x: number; y: number; width: number; height: number; active: boolean }>;
};

/** On a state event from a host that sends patches: what changed since the state numbered `base`, or `resync`. */
type StateNumbering = { patch?: StatePatch; base?: number; version?: number; epoch?: string; resync?: boolean; messages?: MessageChanges };
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
import type { PullRequest } from "./model";

/** Which patterns apply to new worktrees, and the files they match in the main checkout. */
export type FilesToCopy = { source: "worktreeinclude" | "setting" | "default"; worktreeInclude: string | null; matches: string[] };

/** Where the setup command new worktrees run comes from: the repo's .milagre/worktree.json, the project's setting, or nowhere. */
export type WorktreeSetupSource = "repo" | "setting" | "none";

/** The project's saved setup command, and the one that applies. `note` says why a repo file was ignored. */
export type WorktreeSetupSettings = { setupCommand: string; source: WorktreeSetupSource; command: string | null; note?: string };

export type ReleaseChannel = "stable" | "beta";
export type UpdateState = {
  status: "idle" | "checking" | "up-to-date" | "downloading" | "downloaded" | "installing" | "error" | "unavailable";
  version: string | null;
  progress: number;
  error?: string;
};

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
  /** The relay's link, the only kind another Mac can pair with. Copy link copies it. */
  computerLink?: string;
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

/** How a paired computer stands: "off" while Settings › Experimental › Other computers is off. */
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
  lastSeen: number | null;
  addedAt: number | null;
  /** Why it isn't connected, in words, while that can be said. */
  message: string | null;
  lan: boolean;
  /** The LAN addresses it gave (ws://host:port), at most four. */
  lanRoutes: string[];
};
/** This Mac's name and every computer it drives. */
export type ComputersSnapshot = { thisMac: string; computers: ComputerView[] };
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
};

import type { DiffMode, DiffFilesResult, DiffFileResult } from "@milagre/shared/git-diff";
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
  simulators: SimulatorApi;
  browsers: BrowserApi;
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
  getPathForFile: (file: File) => string;
  readAttachment: (file: string) => Promise<{ text: string; binary: boolean; truncated: boolean }>;
  searchProjectFiles: (root: string, query: string) => Promise<string[]>;
  listSkills: (projectPath: string) => Promise<SkillCatalog>;
  /** The text of a SKILL.md the catalog listed (a shadowed one included), up to 256 KiB. */
  readSkill: (projectPath: string, file: string) => Promise<string>;
  /** Opens a listed SKILL.md in an editor, wherever it lives (user skills are outside any checkout). */
  openSkill: (request: { projectPath: string; file: string; editor?: string }) => Promise<Result<null>>;
  /** Shows a listed SKILL.md in the file manager. */
  revealSkill: (projectPath: string, file: string) => Promise<void>;
  listBranches: (projectPath: string) => Promise<string[]>;
  getProjectImage: (projectPath: string) => Promise<string | null>;
  /** Saves a chosen icon (an image data URL), or null to go back to the repository's own; returns the icon now shown. */
  setProjectIcon: (projectPath: string, icon: string | null) => Promise<string | null>;
  getAppVersion: () => Promise<string>;
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
  /** Whether new Worktrees sync the main branch first, and the last sync's result. */
  readMainSync: (projectPath: string) => Promise<MainSyncSettings>;
  /** null brings the global default back. */
  saveMainSync: (projectPath: string, override: boolean | null) => Promise<MainSyncSettings>;
  readMainSyncDefault: () => Promise<{ syncMain: boolean }>;
  saveMainSyncDefault: (value: boolean) => Promise<{ syncMain: boolean }>;
  /** A main branch sync finished, before a new Worktree. */
  onMainSyncStatus: (callback: (status: MainSyncStatus) => void) => () => void;
  readLinearStatus: () => Promise<LinearStatus>;
  /** Opens Linear in the browser and resolves once the Mac is connected. A second call replaces a waiting one. */
  /** `window`: sign in from a window of its own with an empty session (Add workspace), not the browser. */
  connectLinear: (options?: { window?: boolean }) => Promise<LinearStatus>;
  cancelLinearSignIn: () => Promise<void>;
  disconnectLinear: (workspace: string) => Promise<LinearStatus>;
  /** `moveToStarted`: a Chat started from an issue moves it to In Progress. A Mac that predates it sends none (on). */
  readLinearEnabled: () => Promise<{ enabled: boolean; moveToStarted?: boolean }>;
  saveLinearMoveToStarted: (value: boolean) => Promise<{ moveToStarted: boolean }>;
  saveLinearEnabled: (value: boolean) => Promise<{ enabled: boolean }>;
  onLinearStatusChanged: (callback: (status: LinearStatus) => void) => () => void;
  mcp: {
    accounts: () => Promise<McpAccount[]>;
    check: (provider: McpAccount["provider"], accountId: string) => Promise<McpAccountCheck>;
  };
  /** The Experimental Linear switch changed, on this Mac or from a phone. */
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
    changes: (request: { cwd: string; base?: string }) => Promise<GitChanges>;
    /** Files a chat's folder changed: `uncommitted` against HEAD (untracked included), `committed` since the merge-base with the base branch. */
    diffFiles: (request: { cwd: string; base?: string; mode: DiffMode }) => Promise<DiffFilesResult>;
    /** One file's unified patch. Rejects for a path that is absolute or climbs out of the folder. */
    diffFile: (request: { cwd: string; base?: string; mode: DiffMode; path: string; oldPath?: string; untracked?: boolean }) => Promise<DiffFileResult>;
    /** Never rejects for a model failure: `ok: false` carries the note the dialog shows. */
    generate: (request: { cwd: string; base?: string; provider?: ModelProvider; chat: GitChatContext }) => Promise<GitTextResult>;
    commit: (request: { cwd: string; message: string }) => Promise<GitCommitResult>;
    push: (request: { cwd: string }) => Promise<GitPushResult>;
    openPr: (request: { cwd: string; base?: string; title: string; body: string }) => Promise<GitPrResult>;
  };
  /** Code editors found on this Mac, in the order the first becomes the default. */
  listEditors: () => Promise<EditorInfo[]>;
  /** Opens a file (or, with no path, the folder) in an editor. `path` is relative to `root`. Returns a Result with a failure code and message. */
  openInEditor: (request: { root: string; path?: string; line?: number; editor?: string }) => Promise<Result<null>>;
  getCurrentProject: () => Promise<OpenProject>;
  openProject: () => Promise<OpenProject | null>;
  /** Opens a folder of this computer as a Project, without the dialog. */
  openProjectAt: (folder: string) => Promise<OpenProject>;
  listDirs: (request: { path?: string }) => Promise<DirListing>;
  readMedia: (request: { scope: string; path: string }) => Promise<MediaBytes>;
  /** Projects opened lately, most recent first; folders that are gone are left out. */
  listRecentProjects: () => Promise<RecentProject[]>;
  /** Keeps a recent project out of the all-Projects sidebar and the phone's list, or shows it again; resolves to the list. */
  setProjectHidden: (projectPath: string, hidden: boolean) => Promise<RecentProject[]>;
  /** Loads a recent project's chats without opening it; later changes arrive through onProjectState. */
  readProject: (projectPath: string) => Promise<OpenProject>;
  /** Every opened Project, seeded once from existing coordination files. */
  listNamedLinks: () => Promise<NamedProjectLink[]>;
  createNamedLink: (request: { name: string; projectIds: string[]; hidden?: boolean }) => Promise<NamedProjectLink>;
  updateNamedLink: (request: { id: string; name: string; projectIds: string[]; hidden?: boolean }) => Promise<NamedProjectLink>;
  openNamedLink: (id: string) => Promise<OpenLink>;
  /** A Link's chats as saved, without opening it or preparing its worktrees. */
  readLink: (id: string) => Promise<{ link: NamedProjectLink; state: LinkState }>;
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
  onLinkedWork: (callback: (work: LinkedWork) => void) => () => void;
  /** An app ⌘⇧ shortcut pressed while an embedded frame had focus, forwarded by the main process (its letter). */
  onAppShortcut: (callback: (key: string) => void) => () => void;
  /** The canvas's Stop on a Link: the Negotiation stops, turns already running finish. */
  stopNegotiation: (id: string) => Promise<void>;
  setWorktreePosition: (id: string, worktreePath: string, position: { x: number; y: number }) => Promise<unknown>;
  openCanvasProject: (projectPath: string) => Promise<OpenProject>;
  /** Opens a project from the recent list. Rejects for a path that isn't listed or isn't a checkout's top folder. */
  switchProject: (projectPath: string) => Promise<OpenProject>;
  /** Takes a project off the recent list (its folder is untouched) and resolves to the list. */
  forgetProject: (projectPath: string) => Promise<RecentProject[]>;
  /** A project's state changed in the main process, its only writer. Changes made by agent events come with the event instead. */
  retryQuit: () => Promise<void>;
  onQuitFailed: (callback: (message: string) => void) => () => void;
  /** Raw from the host: a whole state, or a patch (see StateNumbering). Listen through state-events.ts instead. */
  onProjectState: (callback: (update: { path: string; state?: CoordinatorState } & StateNumbering) => void) => () => void;
  /** Saves a message in its chat (a new one when `sessionId` is null), then starts or steers the chat's turn. */
  sendMessage: (request: ChatSendRequest) => Promise<{ sessionId: number }>;
  /** Continues a chat a quit stopped mid-turn, on its saved options. Resolves false when it has nothing to continue. */
  resumeChat: (projectPath: string, sessionId: number) => Promise<boolean>;
  patchChat: (projectPath: string, sessionId: number, patch: SessionPatch) => Promise<void>;
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
  updateCli: (provider: ModelProvider) => Promise<{ ok: boolean; version?: string; error?: string; status?: CliStatus }>;
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
  /** Every chat's listening ports now, by chat key. */
  getAgentPorts: () => Promise<AgentPorts>;
  /** Stops the command listening on one of a chat's ports; false when the chat's list doesn't show that pid. */
  stopAgentPort: (chatId: string, pid: number) => Promise<boolean>;
  /** Every chat's listening ports, each time any of them change. */
  onAgentPorts: (callback: (ports: AgentPorts) => void) => () => void;
  getUpdateState: () => Promise<UpdateState>;
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
  readUsage: (scopeKey?: string) => Promise<UsageSnapshot>;
  /** Whether the Mac stays awake while an agent works (the screen can still sleep). */
  setKeepAwake: (enabled: boolean) => Promise<void>;
  getCachedUsage: (scopeKey?: string) => Promise<UsageSnapshot>;
  /** Whether a chat that waits on the user while Milagre is in the background gets a system notification. */
  setNotifyWhenWaiting: (on: boolean) => Promise<void>;
  /** Whether the window lets the blurred desktop show through (macOS). `theme` picks the blur material. */
  setWindowTranslucent: (on: boolean, theme: "light" | "dark", background: string) => Promise<void>;
  /** The open project's unread chats and the notification settings, for completion alerts and the Dock badge. */
  syncNotifications: (state: {
    projectPath: string;
    activeChatId: string | null;
    unread: string[];
    notifyOnCompletion: boolean;
    showDockBadge: boolean;
  }) => Promise<void>;
  notifyCompletion: (notice: { chatId: string; title: string; subtitle?: string }) => Promise<boolean>;
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
    milagre: MilagreBridge & {
      /** The same calls on a paired computer, carried there by main; this Mac's own actions refuse with "Not available on a remote computer". */
      on: (computerId: string) => MilagreBridge;
      computers: ComputersApi;
      onComputersChanged: (callback: (snapshot: ComputersSnapshot) => void) => () => void;
      /** The computer being added is waiting for its owner's Allow. */
      onComputerAddPending: (callback: () => void) => () => void;
      /** Every computer's runtime events. */
      onComputerEvent: (callback: (event: ComputerEvent) => void) => () => void;
    };
  }
}

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

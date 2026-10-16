import type { AgentEvent, OpenProject } from "@milagre/shared/model";
import type { AttentionNotice } from "@milagre/shared/attention";
import type { KeepAwake } from "./keep-awake.cjs";
import type { Simulators } from "./simulators.cjs";
import type { Browsers } from "./browsers.cjs";
/** Host-facing runtime boundary. Provider adapters remain internal to core. */
export interface RuntimeOptions {
  dataDir: string;
  version: string;
  cwd?: string;
  worktreeRoot?: string;
  environmentReady?: Promise<unknown>;
  keepAwake?: KeepAwake;
  simulators?: Simulators;
  browsers?: Browsers;
  /** Injectable public snapshot endpoint for an isolated sharing fixture. */
  designSharing?: { origin?: string; fetch?: typeof fetch };
  isFocused?: () => boolean;
  emit?: (channel: string, payload: unknown) => void;
  observeAgentEvent?: (chatId: string, event: AgentEvent) => void;
  notifyWaiting?: (notice: AttentionNotice & { chatId: string; requestId: string }) => void;
  /** Replace the real readers, for a host that runs no real agent (the review demo). */
  readUsage?: () => Promise<{ providers: unknown[] }>;
  usageReaders?: { claude?: () => Promise<unknown>; codex?: () => Promise<unknown>; antigravity?: (options: { env: NodeJS.ProcessEnv }) => Promise<unknown> };
  agentModels?: () => Promise<unknown>;
  agentCliStatus?: (() => Promise<unknown>) & { invalidate(provider: string): void };
  /** false: `/skill` in a prompt is sent as typed, without the skill's text. */
  expandSkills?: boolean;
  /** worktree:pull-request; the default asks `gh`. */
  readPullRequest?: (worktreePath: string) => Promise<unknown>;
  /** worktree:link-issue's PR lookup: `known: false` when it couldn't ask; the default asks `gh`. */
  readPullRequestState?: (worktreePath: string) => Promise<{ known: boolean; pr: unknown }>;
  /**
   * Which Chats' messages stay in memory (see project-states.cjs): a Chat not touched for `idleMs` (10 minutes) whose
   * turn isn't busy is unloaded by a sweep every `sweepMs` (a minute; 0 for none). false keeps every message in memory.
   */
  lazyMessages?: false | { idleMs?: number; sweepMs?: number };
  /** Whose bots these are, as their instructions and copy name the owner. Default "Victor". */
  botOwner?: string;
  /** The Linear connection; tests point it at a fake Linear and a fake browser. */
  linear?: {
    clientId?: string;
    apiBase?: string;
    port?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    openBrowser?: (url: string) => void;
  };
}
export interface Runtime {
  readonly methods: readonly string[];
  invoke(method: string, args?: unknown[], context?: { clientId: string } | null): Promise<unknown>;
  /** Drop simulator and browser viewer capabilities owned by a disconnected authenticated client. */
  disconnect(clientId: string): Promise<void>;
  /** `takeNotice` (default true): a desktop window's open, which takes the restored-chats notice. */
  openProject(projectPath: string, options?: { takeNotice?: boolean }): Promise<OpenProject>;
  resumeRecentProjects(): Promise<void>;
  /** A bot's thread, or a Chat a bot opened and still runs: no completion notification or push. */
  isQuietChat(chatKey: string): boolean;
  environmentReady: Promise<unknown>;
  focused(): Promise<void>;
  /** Unloads the idle Chats of every open Project and Link now, as the sweep does. */
  unloadIdle(): Promise<void>;
  /** True once close() has begun, including after a failed close that has not been retried yet. */
  isClosing(): boolean;
  close(): Promise<void>;
}
export function createRuntime(options: RuntimeOptions): Runtime;

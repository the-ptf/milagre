export type GateKind = "merge" | "publish" | "post" | "delete" | "spend";

/** What a sign-off card shows about the gated action. */
export interface GateMeta {
  kind: GateKind;
  title: string;
  command: string;
  /**
   * The repo the command names (`--repo`/`-R`, a PR URL, a `gh api` endpoint), else the Chat's Project path. Null when
   * Milagre can't be sure what the command acts on: no grant covers it, and "Always" on its card allows once.
   */
  target: string | null;
  botId: string;
  botName: string;
  expiresAt: number;
}

export interface BotRecord {
  id: string;
  name: string;
  role: string;
  color: string;
  body: "circle" | "squircle" | "capsule";
  provider: string;
  model: string;
  projects: string[];
  paused: boolean;
  homePath: string;
  homeWorktreeId: number;
  threadSessionId: number;
  createdAt: number;
}

export interface BotSummary extends BotRecord {
  preview: string;
  lastAt: number | null;
  unread: boolean;
  pendingGates: number;
}

export interface GateRecord {
  requestId: string;
  botId: string;
  chatKey: string;
  meta: GateMeta;
  status: "pending" | "allowed" | "denied" | "expired";
  createdAt: number;
}

/** A standing "Always for <Bot name>" answer for one gate and target. */
export interface GrantRecord {
  id: string;
  botId: string;
  gate: GateKind;
  target: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface BotChatRecord {
  chatKey: string;
  botId: string;
  title: string;
  projectPath: string;
  status: "running" | "done" | "failed" | "taken-over";
  createdAt: number;
}

export interface BotsSnapshot {
  enabled: boolean;
  bots: BotSummary[];
  gates: GateRecord[];
  grants: GrantRecord[];
  chats: BotChatRecord[];
}

export const GATE_KINDS: readonly GateKind[];
export const GATE_EXPIRY_MS: number;
export const BOT_RUNNING_CHAT_CAP: number;
export const MEMORY_LINE_CAP: number;
export const MEMORY_BYTE_CAP: number;
/** A bot's id from its name: lowercase, runs of anything else than letters and digits become one dash. */
export function botIdFromName(name: string): string;
/** True for a bot's thread and for a Chat a bot opened and still runs: neither tells the user when it finishes. */
export function isQuietChat(snapshot: BotsSnapshot | null | undefined, chatKey: string): boolean;

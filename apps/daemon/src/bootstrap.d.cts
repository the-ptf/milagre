import { EventEmitter } from "node:events";
export interface DaemonClient extends EventEmitter {
  call(method: "daemon:status", args?: unknown[]): Promise<{ methods: string[]; capabilities: string[] }>;
  call(method: "daemon:snapshot", args: [{ paged: true }]): Promise<{ snapshotId: number; pageCount: number; eventSeq: number }>;
  call(method: "daemon:snapshot-page", args: [number, number]): Promise<string>;
  call(method: string, args?: unknown[]): Promise<unknown>;
  close(): void;
  /** What daemon:status reported when the connection was checked. */
  status?: { methods: string[]; capabilities: string[] };
}
export interface DaemonOptions {
  dataDir: string;
  version: string;
  cwd?: string;
  worktreeRoot?: string;
  /** Where the host keeps this computer's Chats home instead of ~/.milagre/chats (a dev or test profile). */
  chatsHome?: string;
  executable?: string;
  entry?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}
export function ensureDaemon(options: DaemonOptions): Promise<DaemonClient>;
export function compatibleClient(dataDir: string, timeoutMs?: number): Promise<DaemonClient>;
/** Error codes of a connection with no host behind it. */
export const HOST_GONE: readonly string[];

import type { ChatSendRequest, WorktreeRequest } from "./model.ts";
export type OutboxAttachment = { name: string; base64?: string; path?: string; imageId?: string };
export type OutboxInput = {
  id: string;
  computerId: string;
  computerName: string;
  owner: string;
  conversation: string;
  request: ChatSendRequest;
  link?: { linkId: string; operationId: string };
  createWorktree?: WorktreeRequest;
  attachments: OutboxAttachment[];
};
export type OutboxItem = OutboxInput & {
  status: "queued" | "sending" | "sent" | "failed";
  phase: "ready" | "creating" | "dispatching" | "done";
  createdAt: number;
  sentAt?: number;
  sessionId?: number;
  error: string;
};
export type OutboxData = { version: 1; revision: number; items: OutboxItem[] };
export type OutboxSnapshot = { loaded: boolean; items: OutboxItem[]; error: string };
export type OutboxStorage = { read(): Promise<OutboxData | null>; write(data: OutboxData, previousRevision: number): Promise<void> };
export function outboxStatus(item: OutboxItem): string;
export function canCancelOutbox(item: OutboxItem): boolean;
export function createOutbox(options: {
  storage: OutboxStorage;
  available(item: OutboxItem): boolean;
  deliver(item: OutboxItem, update: (patch: Partial<OutboxItem>) => Promise<OutboxItem>): Promise<{ sessionId: number; worktreeId?: number }>;
  now?: () => number;
}): {
  ready: Promise<void>;
  getSnapshot(): OutboxSnapshot;
  subscribe(listener: () => void): () => void;
  enqueue(item: OutboxInput): Promise<OutboxItem>;
  remove(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  recover(id: string, target: { sessionId: number; worktreeId: number }): Promise<void>;
  retryStorage(): Promise<void>;
  flush(): Promise<void>;
};
export type Outbox = ReturnType<typeof createOutbox>;

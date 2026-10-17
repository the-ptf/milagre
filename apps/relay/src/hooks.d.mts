export const MAX_HOOK_BODY: number;
export const MAX_HOOK_HEADERS: number;
export const MAX_STORED: number;
export const MAX_STORED_BYTES: number;
export const MAX_STORED_PER_HOOK: number;
export const MAX_STORED_BYTES_PER_HOOK: number;
export const HOLD_MS: number;
export const MAX_HOOKS: number;
export interface HookAnswer {
  status: number;
  json: Record<string, unknown>;
}
export const NOT_FOUND: HookAnswer;
export const NOT_FOUND_BODY: string;

export interface HookRequest {
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Uint8Array;
}
export interface HookDelivery extends HookRequest {
  id: string;
  hook: string;
  receivedAt: number;
  size: number;
}
export interface HookDeliveryEntry {
  id: string;
  hook: string;
  receivedAt: number;
  size: number;
}
export interface HookStorage {
  hooks: { has(id: string): boolean; add(id: string): unknown; delete(id: string): unknown; [Symbol.iterator](): Iterator<string> };
  deliveries: {
    put(delivery: HookDelivery): void;
    get(id: string): HookDelivery | null;
    delete(id: string): void;
    /** Oldest first. */
    list(): HookDeliveryEntry[];
    size(): number;
    bytes(): number;
  };
}
export interface HookDirectoryClient {
  /** `secret`: the hook's URL secret, proving the claiming room's Mac made it; moves a hook another room holds. */
  claim(hookId: string, roomId: string, secret?: string): boolean | Promise<boolean>;
  release(hookId: string, roomId: string): void | Promise<void>;
}
export type HookSend = (bytes: Uint8Array) => boolean;
export interface HookRoom {
  receive(hookId: string, request: HookRequest): HookAnswer;
  onHostReady(send?: HookSend): void;
  /** HOOK_SET returns its settle; HOOK_ACK and anything else return undefined. After each set the room sends HOOK_RESULT `{ refused, failed }`: held by another room, or the directory couldn't be asked. */
  onFrame(type: number, payload: Uint8Array, send?: HookSend): Promise<void> | undefined;
  expire(at: number): number | null;
}
export function createHookRoom(options: {
  storage: HookStorage;
  directory: HookDirectoryClient;
  roomId: string | (() => string);
  now?: () => number;
  randomId?: () => string;
  send?: HookSend;
}): HookRoom;
export function createHookDirectory(options: { storage: { get(key: string): unknown; put(key: string, value: string): void; delete(key: string): unknown } }): {
  claim(roomId: string, proof?: { hookId: string; secret: string }): Promise<boolean>;
  release(roomId: string): void;
  room(): string | null;
};
export function memoryHookStorage(): HookStorage;
export function memoryHookDirectory(): HookDirectoryClient & { owner(hookId: string): string | null };
export function hookSecretOf(pathname: string): string | null;
export function hookIdOf(secret: string): Promise<string>;
export function readHookBody(request: Request, max?: number): Promise<Uint8Array | null>;
export function pickHookHeaders(entries: Iterable<[string, string]>, max?: number): Record<string, string>;
export function pickHookQuery(search: string): Record<string, string>;
export function splitHookFrame(payload: Uint8Array): { header: Record<string, unknown>; body: Uint8Array };
export function packHookRequest(request: HookRequest): Uint8Array;
export function unpackHookRequest(bytes: Uint8Array): HookRequest;
export function hookResponse(answer: HookAnswer): Response;
export function handleHookRequest(
  request: Request,
  hops: {
    lookupRoom(hookId: string): Promise<string | null> | string | null;
    forwardToRoom(roomId: string, hookId: string, packed: Uint8Array): Promise<Response> | Response;
  },
): Promise<Response>;
export interface HookSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, any>[]; one(): Record<string, any> };
}
export function sqlHookStorage(sql: HookSql): HookStorage;

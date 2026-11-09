export const MAX_PHONES: number;
export const HOOK: 4;
export const HOOK_SET: 5;
export const HOOK_ACK: 6;
export const HOOK_RESULT: 7;
export type Payload = string | ArrayBuffer | ArrayBufferView;
export interface RoomSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
export function frame(type: number, conn: bigint, payload?: Uint8Array): Uint8Array;
export function unframe(bytes: ArrayBuffer | Uint8Array): { type: number; conn: bigint; payload: Uint8Array };
/** What the room marks on a socket so a fresh room can rebuild after eviction; null once the room is done with it. */
export type RoomSocketState = { role: "pending"; challenge: string } | { role: "host"; next: string } | { role: "phone"; conn: string };
export interface Room {
  hostOpened(socket: RoomSocket): void;
  /** Returns the hook frame handler's promise when the frame was HOOK_SET or HOOK_ACK. */
  hostMessage(socket: RoomSocket, data: Payload): void | Promise<void>;
  hostClosed(socket: RoomSocket): void;
  /** Why a new phone would be turned away right now, or null. Changes nothing. */
  phoneRefusal(): { code: number; reason: string } | null;
  /** Sends a whole frame to the proven Mac; false when there is none or the send failed. */
  sendHost(bytes: Uint8Array): boolean;
  phoneOpened(socket: RoomSocket): bigint | null;
  phoneMessage(socket: RoomSocket, data: Payload): void;
  phoneClosed(socket: RoomSocket): void;
  /** Rebuilds a fresh room from surviving sockets and their last marks, in the runtime's listing order. */
  restore(entries: { socket: RoomSocket; state: unknown }[]): void;
}
export function createRoom(options: {
  id: string;
  nonce?: () => Uint8Array;
  /** Called whenever a socket's role or state changes. */
  mark?: (socket: RoomSocket, state: RoomSocketState | null) => void;
  /** The Mac proved its key and heard ready. */
  onHostReady?: () => void;
  /** A HOOK_SET or HOOK_ACK frame from the Mac on conn 0. */
  onHostFrame?: (type: number, payload: Uint8Array) => void | Promise<void>;
}): Room;

export type RelayRequest = {
  t: "req";
  id: number;
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  /** Base64 of this slice of the request body; '' when there is none. Every part repeats id, method, path and headers. */
  chunk: string;
  more: boolean;
};
export type RelayResponsePart = {
  t: "res";
  id: number;
  status: number;
  headers: Record<string, string>;
  /** Base64 of this slice of the body. */
  chunk: string;
  more: boolean;
};
export type RelayLiveOpen = { t: "live-open"; id: number; path: string };
export type RelayLive = { t: "live"; id: number; data: string };
export type RelayLiveClose = { t: "live-close"; id: number; code?: number };
export type RelayPing = { t: "ping" };
export type RelayPong = { t: "pong" };
/** The messages of one window, in order, as one frame: a Mac sends these only to a device whose hello asked for "batch". */
export type RelayBatch = { t: "batch"; items: RelayMessage[] };
export type RelayMessage = RelayRequest | RelayResponsePart | RelayLiveOpen | RelayLive | RelayLiveClose | RelayPing | RelayPong | RelayBatch;

export type AssembledResponse = { done: false } | { done: true; status: number; headers: Record<string, string>; body: Uint8Array };
export type ResponseAssembler = {
  add(part: RelayResponsePart): AssembledResponse;
  drop(id: number): void;
};

export const CHUNK: number;
export const MAX_RESPONSE: number;
export function toBase64(bytes: Uint8Array): string;
export function fromBase64(text: string): Uint8Array;
export function splitBody(bytes: Uint8Array, size?: number): string[];
export function createAssembler(): ResponseAssembler;

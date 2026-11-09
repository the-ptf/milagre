import type { ChatScope } from "./model.ts";
export function validLinkId(id: unknown): id is string;
export function isLinkScopeKey(key: unknown): key is string;
export function scopeKey(scope: ChatScope): string;
export function scopeFromKey(key: string): ChatScope;
export function chatKeyForScope(scope: ChatScope, sessionId: number): string;
export function scopeFromChatKey(key: string): ChatScope;
export const LOCAL_COMPUTER: "local";
/** A computer's status dot on both apps (8px, round), as a palette key: green online, orange while it connects or is
 * being checked, red when it refused the pairing, ink4 offline or unknown. */
export function presenceTone(state: string | null | undefined): "green" | "orange" | "red" | "ink4";
export function computerOfKey(key: unknown): string;
export function unqualifyKey<T>(key: T): T;
export function qualifyKey<T>(computerId: string | null | undefined, key: T): T;

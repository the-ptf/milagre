import type { AccountSwitchContext, ChatMessage, ProjectAccountsSnapshot, UsageLimitContext, LimitResume } from "./model.ts";

export type LimitChoice = { id: string; label: string; detail: string | null; disabled: boolean };

export function usageLimitOf(message: Pick<ChatMessage, "context"> | null | undefined): UsageLimitContext | null;
export function resetTime(iso: string | undefined, now?: Date): string | null;
export function limitHeadline(limit: UsageLimitContext, now?: Date): { title: string; detail: string };
export function limitChoices(snapshot: ProjectAccountsSnapshot | null | undefined, limit: UsageLimitContext, now?: Date): LimitChoice[];
export function switchedText(result: { continued: boolean; label: string }): string;
export function isAccountSwitch(message: ChatMessage | null | undefined): message is ChatMessage & { context: AccountSwitchContext };
export function accountSwitchText(context: AccountSwitchContext): string;
export function isLimitReset(message: ChatMessage | null | undefined): boolean;
export function limitResetText(): string;
export function limitResumeLabel(pending: Pick<LimitResume, "at"> | null | undefined, limit: UsageLimitContext, now?: Date): string | null;

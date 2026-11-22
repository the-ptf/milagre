import type { AgentCliStatus, ModelProvider } from "./model.ts";
export const PROVIDERS: readonly ModelProvider[];
export function providerName(provider: ModelProvider): string;
export function cliName(provider: ModelProvider): string;
export function pickerProviders(status: AgentCliStatus | null | undefined, ...keep: ModelProvider[]): ModelProvider[];
export function accountType(plan?: string | null): "Business" | "Team" | "Personal" | null;
export function currentProvider<T>(provider: T): T | "pi";
export function withCurrentProviders<T>(record: T): T;
export function currentModelId<T>(model: T): T;

export type SecretKind = "text" | "file";
export type SecretDelivery = "on-demand" | "ambient";

/** A secret without its value: what agents, peers and the phone may see. */
export interface SecretSummary {
  name: string;
  kind: SecretKind;
  fileName: string | null;
  hint: string | null;
  projects: "all" | string[];
  delivery: SecretDelivery;
  unattended: boolean;
  note: string | null;
  version: number;
  changedOn: string;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface SecretScopeTarget {
  name: string;
  kind?: SecretKind;
  value?: string;
  projects: "all" | string[];
  unattended?: boolean;
}

export declare const SECRET_LIMITS: Readonly<{ count: number; valueBytes: number; noteChars: number; fileNameChars: number; projects: number }>;
export declare const SECRET_KINDS: readonly SecretKind[];
export declare const SECRET_DELIVERIES: readonly SecretDelivery[];
export declare const REDACT_MIN_CHARS: number;
export function secretNameProblem(name: unknown): string | null;
export function secretHint(value: unknown): string | null;
export function secretReaches(secret: SecretScopeTarget, target: { origin: string | null; unattended?: boolean }): boolean;
export function parseDotenv(text: string): { name: string; value: string }[];
export function secretRedactor(
  secrets: { name: string; kind?: SecretKind; value: string }[],
): ((text: string) => string) & { pending: (text: string) => number };

export const AI_CONSENT_VERSION: string;
export const PRIVACY_URL: string;
export const SUPPORT_URL: string;
export const AI_CONSENT_TITLE: string;
export const AI_CONSENT_DESCRIPTION: string;
export const AI_CONSENT_DETAIL: string;
export const AI_RESET_DETAIL: string;
export const AI_PROVIDER_POLICIES: ReadonlyArray<{ name: string; url: string }>;
export function createAiConsent(options: { read(): Promise<string | null>; write(value: string | null): Promise<void>; ask(): Promise<boolean> }): {
  allowed(): Promise<boolean>;
  require(interactive?: boolean): Promise<void>;
  reset(): Promise<void>;
};
export function requiresAiConsent(method: string, args?: unknown[]): boolean;
export function protectAiBridge<T extends object>(bridge: T, requireConsent: (interactive?: boolean) => Promise<void>): T;

export const MILAGRE_REPO: string;
export const REPORT_BUG_PROMPT: string;
export function withReportPrompt(draft: string): string;
export const BUG_REPORT_FEATURES: Readonly<Record<string, string>>;
export const BUG_REPORT_KINDS: readonly string[];
export const CODE_REMOVED: string;
export function reportSegments(text: string): { text: string; placeholder?: true }[];
export function placeholderCount(text: string): number;

export function prosePrompt(prompt: string): string;
export type PromptSkillPart = { text: string; skill: boolean };
export type PromptSkillToken = { name: string; start: number; end: number };
export function promptSkillTokens(prompt: string): PromptSkillToken[];
export function promptSkillParts(prompt: string, names: readonly string[]): PromptSkillPart[];
export function promptSkillAtSelection(parts: readonly PromptSkillPart[], selection: { start: number; end: number }): string | null;
export function promptSkillQuery(
  prompt: string,
  selection: { start: number; end: number },
  names?: readonly string[],
): { start: number; end: number; query: string } | null;

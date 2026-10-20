import { skillLabel, type PromptPart } from "@milagre/shared/prompt-parts";

/**
 * What VoiceOver reads for a sent prompt. The chips are inline Views, which the native text reads as U+FFFC, so the
 * bubble carries this label instead: a skill reads as "skill Tldr", a file as "file App.tsx". Undefined when the
 * prompt has no chips, so plain text keeps reading as itself.
 */
export function promptAccessibilityLabel(parts: readonly PromptPart[]): string | undefined {
  if (parts.every((part) => part.kind === "text")) return undefined;
  const label = parts
    .map((part) => {
      if (part.kind === "skill") return `skill ${skillLabel(part.name)}`;
      if (part.kind === "file") return `file ${part.path.split("/").filter(Boolean).at(-1) ?? part.path}`;
      return part.text;
    })
    .join("");
  return label.replace(/\s+/g, " ").trim();
}

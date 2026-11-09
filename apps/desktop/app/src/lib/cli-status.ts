import type { CliState, CliStatus, ModelProvider } from "../model";

const TAB_LABELS: Record<Exclude<CliState, "ready">, string> = {
  missing: "Not installed",
  outdated: "Update",
  "logged-out": "Log in",
  broken: "Not working",
};

/** The short label that replaces a provider tab's model count, or null when the CLI is fine (or not known yet). */
export function cliTabLabel(status: CliStatus | null | undefined): string | null {
  return status && status.state !== "ready" ? TAB_LABELS[status.state] : null;
}

/** The CLI's message as a turn fails with it (the tab's tooltip), or null when there is nothing to flag. */
export function cliMessage(status: CliStatus | null | undefined): string | null {
  return status && status.state !== "ready" && status.message ? status.message : null;
}

/**
 * The notice above the model rows: the message up to the command. "then send your message again" belongs to the
 * chat, where a message just failed; the picker isn't waiting for one.
 */
export function cliNotice(status: CliStatus | null | undefined): string | null {
  return cliMessage(status)?.replace(/, then send your message again\.$/, ".") ?? null;
}

/** The minimum version named by an outdated CLI's status, when the host can upgrade to a specific release. */
export function requiredCliVersion(status: CliStatus | null | undefined): string | undefined {
  if (status?.state !== "outdated") return undefined;
  return status.message?.match(/\bneeds (?:Claude Code|Codex) (\d+\.\d+\.\d+) or later\b/i)?.[1];
}

/** A message split at its `backtick` spans, so commands can be set as code. */
export function messageParts(message: string): Array<{ text: string; code: boolean }> {
  return message.split(/`([^`]*)`/).flatMap((text, index) => (text ? [{ text, code: index % 2 === 1 }] : []));
}

/** Detects if a message text is an outdated CLI error and returns which provider it refers to. */
export function extractOutdatedProvider(message: string): ModelProvider | null {
  if (/(?:Claude Code|claude update)/i.test(message) && /(?:needs Claude Code|Run `?claude update`?)/i.test(message)) {
    return "claude";
  }
  if (/(?:Codex|codex update)/i.test(message) && /(?:needs Codex|Run `?codex update`?)/i.test(message)) {
    return "codex";
  }
  if (/Antigravity/i.test(message) && /needs Antigravity/i.test(message) && /Update it from/i.test(message)) {
    return "antigravity";
  }
  return null;
}

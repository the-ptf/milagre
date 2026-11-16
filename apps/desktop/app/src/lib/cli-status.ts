import type { CliState, CliStatus, ModelProvider } from "../model";

const TAB_LABELS: Record<Exclude<CliState, "ready">, string> = {
  missing: "Not installed",
  outdated: "Update",
  "logged-out": "Log in",
  broken: "Not working",
};

export function cliTabLabel(status: CliStatus | null | undefined): string | null {
  return status && status.state !== "ready" ? TAB_LABELS[status.state] : null;
}

export function cliMessage(status: CliStatus | null | undefined): string | null {
  return status && status.state !== "ready" && status.message ? status.message : null;
}

export function cliNotice(status: CliStatus | null | undefined): string | null {
  return cliMessage(status)?.replace(/, then send your message again\.$/, ".") ?? null;
}

export function requiredCliVersion(status: CliStatus | null | undefined): string | undefined {
  if (status?.state !== "outdated") return undefined;
  return status.message?.match(/\bneeds (?:Claude Code|Codex) (\d+\.\d+\.\d+) or later\b/i)?.[1];
}

export function messageParts(message: string): Array<{ text: string; code: boolean }> {
  return message.split(/`([^`]*)`/).flatMap((text, index) => (text ? [{ text, code: index % 2 === 1 }] : []));
}

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

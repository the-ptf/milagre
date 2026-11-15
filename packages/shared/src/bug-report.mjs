import { owner, repo } from "./repository.mjs";

export const MILAGRE_REPO = `${owner}/${repo}`;

export const REPORT_BUG_PROMPT = "Report a Milagre bug: ";

export function withReportPrompt(draft) {
  const text = String(draft ?? "");
  if (text.startsWith(REPORT_BUG_PROMPT)) return text;
  return text.trim() ? `${REPORT_BUG_PROMPT}${text.trimStart()}` : REPORT_BUG_PROMPT;
}

export const BUG_REPORT_FEATURES = {
  chat: "Chat and composer",
  agents: "Agent turns and providers",
  approvals: "Approvals and questions",
  delegation: "Delegation and Links",
  routines: "Routines and Heartbeats",
  babysit: "Babysit",
  worktrees: "Worktrees and Git",
  "pull-requests": "Pull requests",
  simulators: "Simulators",
  browser: "Browser panel",
  designs: "Designs and Artifacts",
  phone: "Phone app",
  computers: "Computers and pairing",
  linear: "Linear",
  dictation: "Dictation",
  settings: "Settings",
  install: "Install and updates",
  other: "Other",
};

export const BUG_REPORT_KINDS = [
  "project",
  "org",
  "repo",
  "worktree",
  "branch",
  "chat",
  "home",
  "path",
  "file",
  "url",
  "pr",
  "issue",
  "email",
  "person",
  "computer",
  "host",
  "ip",
  "token",
  "commit",
  "id",
];

export const CODE_REMOVED = "<code removed>";

const PLACEHOLDER = new RegExp(`<(?:${BUG_REPORT_KINDS.join("|")})(?:-[a-z]{1,2})?>|${CODE_REMOVED}`, "g");

export function reportSegments(text) {
  const segments = [];
  let last = 0;
  for (const match of String(text).matchAll(PLACEHOLDER)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    segments.push({ text: match[0], placeholder: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

export function placeholderCount(text) {
  return new Set(String(text).match(PLACEHOLDER) ?? []).size;
}

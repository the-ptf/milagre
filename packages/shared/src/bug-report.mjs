// A Milagre bug report filed from a Chat (issue #938): the words both the host's redaction and the clients' preview
// share. The host replaces what identifies the user's work with these placeholders; desktop and phone mark them in the
// text the user approves.

/** Where reports go (renamed from the-ptf/milagre-ade, which still redirects). */
export const MILAGRE_REPO = "the-ptf/milagre";

/** What the Chat menu's "Report a Milagre bug" puts in the composer: the user says what went wrong, the agent files it. */
export const REPORT_BUG_PROMPT = "Report a Milagre bug: ";

/** The composer's text with the report request in front, once. */
export function withReportPrompt(draft) {
  const text = String(draft ?? "");
  if (text.startsWith(REPORT_BUG_PROMPT)) return text;
  return text.trim() ? `${REPORT_BUG_PROMPT}${text.trimStart()}` : REPORT_BUG_PROMPT;
}

/** The part of Milagre a report is about, as the agent names it; the label is what the issue shows. */
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

/** Every kind of value the host replaces, each shown as `<kind>` or, when a report has several, `<kind-a>`, `<kind-b>`. */
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

/** What a fenced code block becomes: the report says what Milagre did, never what the user's code is. */
export const CODE_REMOVED = "<code removed>";

const PLACEHOLDER = new RegExp(`<(?:${BUG_REPORT_KINDS.join("|")})(?:-[a-z]{1,2})?>|${CODE_REMOVED}`, "g");

/** The report's text split around its placeholders, so a preview can mark each replacement. */
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

/** How many distinct values a report replaced. */
export function placeholderCount(text) {
  return new Set(String(text).match(PLACEHOLDER) ?? []).size;
}

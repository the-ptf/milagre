// Milagre wraps text that other Chats, issues, tools and earlier Chats wrote in tagged blocks and tells the agent the
// block is data. Text inside a block must not be able to close it or open one of Milagre's own, so these tags are
// neutralized in whatever is put inside.

const MILAGRE_TAGS = ["linked_worktrees", "delegation_reports", "handoff_brief", "advisor_result", "linear_issue", "milagre_note"];
const TAG = new RegExp(`<(\\s*/?\\s*(?:${MILAGRE_TAGS.join("|")})\\b)`, "gi");

/** The text with every opening or closing Milagre block tag written as `&lt;tag`, so it can't end or start a block. */
export function neutralizeTags(text) {
  return String(text ?? "").replace(TAG, "&lt;$1");
}

/** The text cut to `length` characters with an ellipsis, keeping its line breaks (unlike a one-line clip). */
export function truncateText(text, length) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1).trimEnd()}…` : trimmed;
}

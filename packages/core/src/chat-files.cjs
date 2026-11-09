const MarkdownIt = require("markdown-it");
const { localFileLink } = require("@milagre/shared/file-link");
const markdown = new MarkdownIt({ html: false });

/** Only file links actually shared in an assistant reply grant access outside the open Worktrees. */
function sharedFilePaths(message, cwd) {
  const files = new Set();
  if (message.role !== "assistant") return files;
  const visit = (tokens) => {
    for (const token of tokens) {
      if (token.type === "link_open") {
        const file = localFileLink(token.attrGet("href") || "", cwd);
        if (file) files.add(file.path);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(message.body || message.text || "", {}));
  return files;
}

function chatFolder(state, message, projectPath) {
  const session = state.sessions?.[message.session_id];
  return session?.workspacePath || state.worktrees?.[session?.worktree_id]?.path || projectPath;
}

module.exports = { sharedFilePaths, chatFolder };

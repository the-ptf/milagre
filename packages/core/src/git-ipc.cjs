const fs = require("node:fs/promises");
const path = require("node:path");
const { PROVIDERS } = require("@milagre/shared/providers");
const { createGitActions } = require("./git-actions.cjs");
const { createGitDiff } = require("./git-diff.cjs");
const { GENERATION_FAILED, claudeModel, codexModel, generateGitText, antigravityModel, kiroModel } = require("./git-text.cjs");
const { createPullRequestReview } = require("./pull-request-review.cjs");

const NOT_A_CHAT_FOLDER = "This folder isn't one of the open project's chats.";

const text = (value, limit = 20_000) => (typeof value === "string" ? value.slice(0, limit) : "");

/** The chat context the renderer sends for the dialog's text, kept to the fields the prompt uses. */
function chatContext(chat = {}) {
  return {
    chatTitle: text(chat.chatTitle, 500),
    firstMessage: text(chat.firstMessage),
    recentMessages: Array.isArray(chat.recentMessages) ? chat.recentMessages.slice(-10).map((message) => text(message)) : [],
    testCommands: Array.isArray(chat.testCommands)
      ? chat.testCommands.slice(-20).map((item) => ({ command: text(item?.command, 500), status: item?.status === "failed" ? "failed" : "done" }))
      : [],
  };
}

/**
 * Handlers for the "Commit and open PR" dialog: git:changes, git:generate, git:commit, git:push and
 * git:open-pr, plus git:diff-files and git:diff-file for the Changes panel's diff view. They only act in a chat's folder: one of `knownFolders()` (the open projects'
 * checkouts), and the top of its checkout (git-actions checks that). Every call waits for `ready()`
 * (the login shell's environment), so git and gh are found from a Finder launch; commands run in the
 * folder with that environment. `cli(name)` is main's CLI check: `{ command, problem }`, the path the
 * SDK and Codex start directly, without a shell.
 */
function registerGitHandlers(
  ipcMain,
  {
    cli,
    ready = () => undefined,
    clientVersion,
    env = process.env,
    actions = createGitActions({ env }),
    diff = createGitDiff({ env }),
    models,
    knownFolders,
    review = createPullRequestReview({ env }),
    pullRequestChanged = () => {},
  } = {},
) {
  const command = (name, cwd) => async () => {
    const status = await cli(name, cwd);
    return status?.problem ? null : (status ?? null);
  };
  const textModels = (cwd) =>
    models ?? {
      claude: claudeModel({ getCommand: command("claude", cwd) }),
      codex: codexModel({ getCommand: command("codex", cwd), clientVersion }),
      antigravity: antigravityModel({ getCommand: command("antigravity", cwd), clientVersion }),
      kiro: kiroModel({ getCommand: command("kiro", cwd), clientVersion }),
    };

  async function folder(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("The chat's folder must be an absolute path.");
    await ready();
    if (knownFolders) {
      const real = await fs.realpath(cwd).catch(() => null);
      const known = await Promise.all((await knownFolders()).map((item) => fs.realpath(item).catch(() => null)));
      if (!real || !known.includes(real)) throw new Error(NOT_A_CHAT_FOLDER);
    }
    return cwd;
  }

  // A write that changes what a PR's summary shows (state, review decision, checks): its folder's PRs are read again.
  const changing =
    (run) =>
    async (_event, request = {}) => {
      const cwd = await folder(request?.cwd);
      try {
        return await run(cwd, request);
      } finally {
        pullRequestChanged(cwd);
      }
    };

  ipcMain.handle("git:changes", async (_event, { cwd, base } = {}) => actions.readChanges({ cwd: await folder(cwd), base }));
  ipcMain.handle("git:history", async (_event, { cwd, base, recordedBase, branchesVersion, limit } = {}) =>
    diff.history({ cwd: await folder(cwd), base, recordedBase, branchesVersion, limit }),
  );
  ipcMain.handle("git:diff-files", async (_event, { cwd, base, mode } = {}) => diff.listDiffFiles({ cwd: await folder(cwd), base, mode }));
  ipcMain.handle("git:diff-file", async (_event, { cwd, base, mode, path: file, oldPath, untracked } = {}) =>
    diff.readDiffFile({ cwd: await folder(cwd), base, mode, path: file, oldPath, untracked }),
  );
  // The PR a Chat's branch opened: its detail, its diff, and every review write, all through gh in the Chat's folder.
  ipcMain.handle("pr:detail", async (_event, { cwd, number } = {}) => review.detail({ cwd: await folder(cwd), number }));
  ipcMain.handle("pr:diff-files", async (_event, { cwd, base, head } = {}) => review.diffFiles({ cwd: await folder(cwd), base, head }));
  ipcMain.handle("pr:diff-file", async (_event, { cwd, base, head, path: file, oldPath } = {}) =>
    review.diffFile({ cwd: await folder(cwd), base, head, path: file, oldPath }),
  );
  ipcMain.handle("pr:comment", async (_event, { cwd, number, path: file, line, startLine, side, body } = {}) =>
    review.comment({ cwd: await folder(cwd), number, path: file, line, startLine, side, body }),
  );
  ipcMain.handle("pr:reply", async (_event, { cwd, number, threadId, body } = {}) => review.reply({ cwd: await folder(cwd), number, threadId, body }));
  ipcMain.handle("pr:delete-comment", async (_event, { cwd, commentId } = {}) => review.deleteComment({ cwd: await folder(cwd), commentId }));
  ipcMain.handle(
    "pr:submit-review",
    changing((cwd, { number, event, body }) => review.submit({ cwd, number, event, body })),
  );
  ipcMain.handle("pr:resolve-thread", async (_event, { cwd, threadId, resolved } = {}) => review.resolve({ cwd: await folder(cwd), threadId, resolved }));
  ipcMain.handle(
    "pr:merge",
    changing((cwd, { number, method, auto, admin, disableAuto }) => review.merge({ cwd, number, method, auto, admin, disableAuto })),
  );
  ipcMain.handle(
    "pr:ready",
    changing((cwd, { number, draft }) => review.ready({ cwd, number, draft })),
  );
  ipcMain.handle("pr:image", async (_event, { cwd, url } = {}) => review.image({ cwd: await folder(cwd), url }));
  ipcMain.handle("pr:labels", async (_event, { cwd } = {}) => review.labels({ cwd: await folder(cwd) }));
  ipcMain.handle("pr:set-labels", async (_event, { cwd, number, add, remove } = {}) => review.setLabels({ cwd: await folder(cwd), number, add, remove }));
  ipcMain.handle("pr:reviewer-candidates", async (_event, { cwd } = {}) => review.reviewerCandidates({ cwd: await folder(cwd) }));
  ipcMain.handle("pr:request-reviewers", async (_event, { cwd, number, add, remove } = {}) =>
    review.requestReviewers({ cwd: await folder(cwd), number, add, remove }),
  );
  ipcMain.handle("git:generate", async (_event, { cwd, base, provider, chat } = {}) => {
    const checked = await folder(cwd);
    try {
      const context = await actions.readTextContext({ cwd: checked, base });
      return await generateGitText(
        { ...chatContext(chat), ...context },
        { provider: PROVIDERS.includes(provider) ? provider : "claude", models: textModels(checked) },
      );
    } catch {
      return { ok: false, message: GENERATION_FAILED };
    }
  });
  ipcMain.handle("git:commit", async (_event, { cwd, message } = {}) => actions.commit({ cwd: await folder(cwd), message }));
  ipcMain.handle(
    "git:push",
    changing((cwd) => actions.push({ cwd })),
  );
  ipcMain.handle(
    "git:open-pr",
    changing((cwd, { base, title, body }) => actions.openPr({ cwd, base, title, body })),
  );
}

module.exports = { NOT_A_CHAT_FOLDER, registerGitHandlers };

const { createHash } = require("node:crypto");
const { githubIssueBody } = require("@milagre/shared/github-issue");

/** Reuse Worktree creation and user sends; no GitHub writes or separate agent orchestration. */
function createGitHubImporter({ issues, readProject, createWorktree, send, sendStatus = async () => null, validateBase = async () => {}, store }) {
  const pending = new Map();
  const memory = new Map();
  const receipts = store ?? { load: async (key) => memory.get(key), save: async (key, value) => memory.set(key, value) };
  const fingerprint = (value) => {
    const stable = (item) =>
      Array.isArray(item)
        ? item.map(stable)
        : item && typeof item === "object"
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, stable(item[key])]),
            )
          : item;
    return createHash("sha256")
      .update(JSON.stringify(stable(value)))
      .digest("hex");
  };
  return function importIssue(request) {
    const id = request?.options?.clientMessageId;
    if (typeof id !== "string" || !/^[\w-]{16,80}$/.test(id)) throw new Error("An import needs a unique message id.");
    const key = `${request.projectPath}#${id}`;
    const signature = fingerprint(request);
    const prior = pending.get(key);
    if (prior) {
      if (prior.signature !== signature) throw new Error("This import id was already used for another request.");
      return prior.result;
    }
    const result = (async () => {
      const { projectPath, target, note, options } = request;
      if (typeof request.account !== "string" || !request.account || (note !== undefined && typeof note !== "string"))
        throw new Error("Preview the GitHub issue before importing.");
      const project = await readProject(projectPath);
      const previous = await receipts.load(key);
      if (previous && previous.signature !== signature) throw new Error("This import id was already used for another request.");
      if (previous) {
        const delivered = await sendStatus(projectPath, id);
        const accepted = delivered?.sessionId ?? (previous.phase === "sent" ? previous.sessionId : null);
        if (accepted !== null && accepted !== undefined) {
          const chat = project.state.sessions[accepted];
          if (!chat) throw new Error("The imported Chat is no longer available. Check the Project before starting another import.");
          return { project, sessionId: accepted, worktreeId: chat.worktree_id };
        }
        if (previous.phase === "creating")
          throw new Error("Worktree creation was interrupted. Check the Project for the created Worktree and choose it before starting another import.");
        if (previous.phase !== "ready") throw new Error("The import receipt is unavailable. Check the Project before starting another import.");
      }
      let worktreeId,
        sessionId = null;
      if (previous?.phase === "ready") {
        worktreeId = previous.worktreeId;
        sessionId = previous.sessionId;
        if (!Number.isSafeInteger(worktreeId) || (sessionId !== null && !project.state.sessions[sessionId]))
          throw new Error("The import target is no longer available. Check the Project before starting another import.");
      } else if (target?.kind === "existing") {
        const chat = project.state.sessions[target.sessionId];
        if (!chat || chat.archived || chat.formerWorktree) throw new Error("That Chat is unavailable. Choose another target.");
        sessionId = chat.id;
        worktreeId = chat.worktree_id;
      } else if (target?.kind === "chat") {
        worktreeId = target.worktreeId;
      } else if (target?.kind !== "worktree" || typeof target.baseBranch !== "string" || !target.baseBranch.trim()) {
        throw new Error("Choose a Chat, Worktree or base branch before importing.");
      }
      if (worktreeId !== undefined && !project.state.worktrees[worktreeId]) throw new Error("That Worktree is unavailable. Choose another target.");
      if (worktreeId !== undefined && project.state.worktrees[worktreeId]?.sharedChat)
        throw new Error("This Worktree belongs to a shared Chat. Choose a Project Chat or a new Worktree.");
      if (target.kind === "worktree" && !previous) await validateBase(projectPath, target.baseBranch);
      const issue = await issues.read(projectPath, request.url, request.account);
      const body = githubIssueBody(issue, note);
      if (target.kind === "worktree" && !previous) {
        await receipts.save(key, { signature, phase: "creating" });
        const made = await createWorktree({ projectPath, baseBranch: target.baseBranch, prompt: body });
        worktreeId = made.worktreeId;
        sessionId = Object.values(made.project.state.sessions).find((chat) => chat.worktree_id === worktreeId)?.id ?? null;
      }
      await receipts.save(key, { signature, phase: "ready", worktreeId, sessionId });
      const { clientMessageId, provider, model, permissionMode, effort, ultracode, fastMode, replies, tldrEnabled } = options;
      const sent = await send({
        projectPath,
        sessionId,
        worktreeId,
        clientMessageId,
        provider,
        model,
        permissionMode,
        effort,
        ultracode,
        fastMode,
        replies,
        tldrEnabled,
        body,
        prompt: body,
        images: [],
        files: [],
        githubIssue: { url: issue.url, account: issue.account, note },
      });
      await receipts.save(key, { signature, phase: "sent", worktreeId, sessionId: sent.sessionId });
      return { project: await readProject(projectPath), sessionId: sent.sessionId, worktreeId };
    })();
    const settled = result.finally(() => {
      pending.delete(key);
    });
    pending.set(key, { signature, result: settled });
    return settled;
  };
}

module.exports = { createGitHubImporter };

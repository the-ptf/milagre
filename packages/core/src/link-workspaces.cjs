const fs = require("node:fs/promises");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { createWorktree: create, slugify, DEFAULT_WORKTREE_ROOT } = require("./worktrees.cjs");
const { resolveSetupCommand, runSetupCommand } = require("./worktree-setup.cjs");
const { validLinkId } = require("@milagre/shared/chat-scopes");

function createLinkWorkspaces({
  store,
  registry,
  ownProject,
  root = DEFAULT_WORKTREE_ROOT,
  getSettings = async () => ({}),
  createWorktree = create,
  runSetup = runSetupCommand,
  deferSetup,
  git = createGit(),
}) {
  const queues = new Map();
  async function save(id, preparation) {
    await store.update(
      id,
      (state) => ({
        ...state,
        next_id: Math.max(state.next_id, preparation.chatId + 1),
        preparations: { ...state.preparations, [preparation.operationId]: preparation },
      }),
      { chats: [] },
    );
    await store.flush(id);
  }
  async function membersAvailable(link) {
    const projects = await registry.list();
    const members = link.projectIds.map((id) => projects.find((project) => project.id === id));
    for (let i = 0; i < members.length; i++)
      if (!members[i]) throw new Error(`Link Project ${path.basename(path.dirname(link.projectIds[i]))} is unavailable. Restore its folder before sending.`);
    return members;
  }
  async function prepare({ link, chatId, prompt = "", operationId }) {
    if (!validLinkId(operationId) || !Number.isSafeInteger(chatId) || chatId < 1) throw new Error("Invalid Link preparation request");
    const state = await store.get(link.id);
    let prep = state.preparations[operationId] ?? Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (prep?.chatId !== undefined && prep.chatId !== chatId) throw new Error("Preparation belongs to another Chat");
    if (prep?.status === "ready") return { workspacePath: prep.workspacePath, worktrees: prep.members };
    if (prep?.status === "failed") {
      if (prep.retainedPaths?.length) throw new Error(prep.error);
      prep = undefined;
    }
    const projects = await membersAvailable(link);
    // Acquire every repository before reserving or mutating any member.
    for (const project of projects) await ownProject(project.path);
    if (!prep) {
      const members = [];
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        const settings = await getSettings(project.path);
        const base = (await git.read.resolveBase(project.path)).ref ?? "HEAD";
        const suffix = `${operationId.slice(0, 8)}${i}`;
        const name = `${slugify(prompt) || "chat"}-${suffix}`;
        const worktreePath = path.join(root, path.basename(project.path), name);
        if (await git.read.refExists(project.path, `refs/heads/milagre/${name}`)) throw new Error(`Project ${project.name}: branch already exists`);
        try {
          await fs.lstat(worktreePath);
          throw new Error(`Project ${project.name}: Worktree folder already exists`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const resolved = await resolveSetupCommand(project.path, settings.setupCommand);
        members.push({
          projectId: project.id,
          projectPath: project.path,
          projectName: project.name,
          worktreePath,
          branch: `milagre/${name}`,
          base,
          initialCommit: await git.read.commitOf(project.path, base),
          suffix,
          alias: `${slugify(project.name) || "project"}-${i + 1}`,
          ...(settings.filesToCopy !== undefined ? { copyPatterns: settings.filesToCopy } : {}),
          setupCommand: resolved.command,
          setupSource: resolved.source,
        });
      }
      prep = { operationId, chatId, prompt, status: "reserved", workspacePath: path.join(store.directory(link.id), "workspaces", String(chatId)), members };
      await save(link.id, prep);
    }
    let current;
    try {
      for (const member of prep.members) {
        current = member;
        const discovered = (await git.read.worktreeList(member.projectPath)).find((item) => item.path === member.worktreePath);
        if (discovered) {
          if (discovered.name !== member.branch || ((await git.read.commitOf(member.worktreePath, "HEAD")) !== member.initialCommit && !member.created))
            throw new Error("Existing Worktree cannot be verified after restart");
          member.created = true;
        } else {
          if (member.created) throw new Error("Previously created Worktree is missing");
          prep.status = "creating";
          await save(link.id, prep);
          const created = await createWorktree({
            projectPath: member.projectPath,
            baseBranch: member.base,
            root,
            suffix: member.suffix,
            prompt: prep.prompt,
            copyPatterns: member.copyPatterns,
          });
          member.base = created.base;
          member.worktreePath = await fs.realpath(created.path);
          member.initialCommit = await git.read.commitOf(member.worktreePath, "HEAD");
          member.created = true;
          await save(link.id, prep);
        }
        if (member.setupCommand && !member.setupDone && !member.setupDeferred) {
          if (member.setupStarted) throw new Error("Setup was interrupted. Its Worktree has been retained for inspection");
          if (deferSetup) {
            // The shared Chat must exist before the review can appear on either client. Persist the pending setup
            // outside the Project first, then its first turn uses the same review as ordinary Worktrees.
            await deferSetup({
              worktreePath: member.worktreePath,
              projectPath: member.projectPath,
              resolved: { command: member.setupCommand, source: member.setupSource ?? "repo" },
              strict: true,
            });
            member.setupDeferred = true;
          } else {
            prep.status = "setup";
            member.setupStarted = true;
            await save(link.id, prep);
            const result = await runSetup({ cwd: member.worktreePath, command: member.setupCommand });
            if (result.status !== "done") throw new Error(`Setup ${result.status}: ${result.output || result.error || "command did not complete"}`);
          }
        }
        if (!member.setupDeferred) member.setupDone = true;
        await save(link.id, prep);
      }
      await fs.mkdir(prep.workspacePath, { recursive: true });
      for (const member of prep.members) {
        const alias = path.join(prep.workspacePath, member.alias);
        try {
          await fs.symlink(member.worktreePath, alias, process.platform === "win32" ? "junction" : "dir");
        } catch (error) {
          if (error.code !== "EEXIST" || (await fs.realpath(alias)) !== member.worktreePath) throw error;
        }
      }
      await fs.writeFile(path.join(prep.workspacePath, "milagre-workspace.json"), JSON.stringify({ linkId: link.id, chatId, projects: prep.members }, null, 2));
      prep.status = "ready";
      await save(link.id, prep);
      return { workspacePath: prep.workspacePath, worktrees: prep.members };
    } catch (error) {
      const retainedPaths = [];
      for (const member of prep.members) {
        const exists = await fs.lstat(member.worktreePath).then(
          () => true,
          () => false,
        );
        if (!exists) continue;
        try {
          if (
            (member.setupStarted && !member.setupDone) ||
            !member.created ||
            (await git.read.commitOf(member.worktreePath, "HEAD")) !== member.initialCommit ||
            (await git.read.text(member.worktreePath, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).trim()
          )
            throw new Error("Modified or unverified");
          await git.write.checked(member.projectPath, ["worktree", "remove", "--", member.worktreePath]);
          await git.write.checked(member.projectPath, ["branch", "-d", "--", member.branch]);
          member.created = false;
        } catch {
          retainedPaths.push(member.worktreePath);
        }
      }
      prep.status = "failed";
      prep.retainedPaths = retainedPaths;
      prep.error = `Project ${current?.projectName ?? link.name}: ${error.message}${retainedPaths.length ? `\nRetained Worktrees: ${retainedPaths.join(", ")}` : ""}`;
      await save(link.id, prep);
      throw new Error(prep.error);
    }
  }
  return {
    membersAvailable,
    prepareLinkChat(request) {
      const key = request.link.id;
      const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => prepare(request));
      queues.set(key, run);
      run
        .finally(() => {
          if (queues.get(key) === run) queues.delete(key);
        })
        .catch(() => {});
      return run;
    },
    async recoverLinkPreparations(linkId) {
      const link = (await registry.listProjectGroups()).find((item) => item.id === linkId);
      if (!link) throw new Error("Link no longer exists");
      for (const prep of Object.values((await store.get(linkId)).preparations))
        if (!["ready", "failed"].includes(prep.status)) await this.prepareLinkChat({ link, chatId: prep.chatId, operationId: prep.operationId });
    },
  };
}
module.exports = { createLinkWorkspaces };

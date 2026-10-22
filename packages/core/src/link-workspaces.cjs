const fs = require("node:fs/promises");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { createWorktree: create, slugify, DEFAULT_WORKTREE_ROOT } = require("./worktrees.cjs");
const { resolveSetupCommand, runSetupCommand } = require("./worktree-setup.cjs");
const { validLinkId } = require("@milagre/shared/chat-scopes");

/**
 * A shared Link Chat's workspace: a folder of aliases, one per Project the Chat edits. A new Chat starts with none, and
 * each Project gets its Worktree (branch, folder and setup command) only when the Chat's agent is about to edit it
 * (`addMember`, the link_worktree_create tool), so a Chat that touches one Project leaves the others alone.
 */
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
  // A member is the Chat's once its Worktree exists and its setup ran, or waits for its review (deferSetup).
  const isReady = (member) => Boolean(member.setupDone || member.setupDeferred);
  // One preparation at a time per Link, so a new Chat and a new member never race on the same state.
  function queued(key, task) {
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(key, run);
    run
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key);
      })
      .catch(() => {});
    return run;
  }
  // The Chat's Worktrees follow its preparation: a member reaches the session once its setup is done.
  async function save(id, preparation) {
    const ready = preparation.members.filter(isReady);
    await store.update(
      id,
      (state) => ({
        ...state,
        next_id: Math.max(state.next_id, preparation.chatId + 1),
        preparations: { ...state.preparations, [preparation.operationId]: preparation },
        ...(state.sessions?.[preparation.chatId]
          ? { sessions: { ...state.sessions, [preparation.chatId]: { ...state.sessions[preparation.chatId], worktrees: ready } } }
          : {}),
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
  const result = (prep) => ({ workspacePath: prep.workspacePath, worktrees: prep.members.filter(isReady) });
  async function writeManifest(link, prep) {
    await fs.mkdir(prep.workspacePath, { recursive: true });
    for (const member of prep.members.filter(isReady)) {
      const alias = path.join(prep.workspacePath, member.alias);
      try {
        await fs.symlink(member.worktreePath, alias, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error.code !== "EEXIST" || (await fs.realpath(alias)) !== member.worktreePath) throw error;
      }
    }
    await fs.writeFile(
      path.join(prep.workspacePath, "milagre-workspace.json"),
      JSON.stringify({ linkId: link.id, chatId: prep.chatId, projects: prep.members.filter(isReady) }, null, 2),
    );
  }
  // The branch, folder and setup a member will get, checked free before anything is made. `index` is the Project's
  // place in the Link, so its alias and branch suffix stay the same whichever Project the Chat edits first.
  async function reserve(prep, project, index) {
    const settings = await getSettings(project.path);
    const base = (await git.read.resolveBase(project.path)).ref ?? "HEAD";
    const suffix = `${prep.operationId.slice(0, 8)}${index}`;
    const name = `${slugify(prep.prompt) || "chat"}-${suffix}`;
    const worktreePath = path.join(root, path.basename(project.path), name);
    if (await git.read.refExists(project.path, `refs/heads/milagre/${name}`)) throw new Error(`Project ${project.name}: branch already exists`);
    try {
      await fs.lstat(worktreePath);
      throw new Error(`Project ${project.name}: Worktree folder already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const resolved = await resolveSetupCommand(project.path, settings.setupCommand);
    return {
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      worktreePath,
      branch: `milagre/${name}`,
      base,
      initialCommit: await git.read.commitOf(project.path, base),
      suffix,
      alias: `${slugify(project.name) || "project"}-${index + 1}`,
      ...(settings.filesToCopy !== undefined ? { copyPatterns: settings.filesToCopy } : {}),
      setupCommand: resolved.command,
      setupSource: resolved.source,
    };
  }
  // Creates (or, after a restart, verifies) one member's Worktree and runs its setup. On failure an untouched Worktree
  // is removed with its branch and the member forgotten, so asking again starts over; a changed one is retained.
  async function materialize(link, prep, member) {
    try {
      const discovered = (await git.read.worktreeList(member.projectPath)).find((item) => item.path === member.worktreePath);
      if (discovered) {
        if (discovered.name !== member.branch || ((await git.read.commitOf(member.worktreePath, "HEAD")) !== member.initialCommit && !member.created))
          throw new Error("Existing Worktree cannot be verified after restart");
        member.created = true;
      } else {
        if (member.created) throw new Error("Previously created Worktree is missing");
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
          // The setup waits for the same review as an ordinary Worktree's, before the agent works in this one.
          await deferSetup({
            worktreePath: member.worktreePath,
            projectPath: member.projectPath,
            resolved: { command: member.setupCommand, source: member.setupSource ?? "repo" },
            strict: true,
          });
          member.setupDeferred = true;
        } else {
          member.setupStarted = true;
          await save(link.id, prep);
          const result = await runSetup({ cwd: member.worktreePath, command: member.setupCommand });
          if (result.status !== "done") throw new Error(`Setup ${result.status}: ${result.output || result.error || "command did not complete"}`);
        }
      }
      if (!member.setupDeferred) member.setupDone = true;
      await writeManifest(link, prep);
      await save(link.id, prep);
      return member;
    } catch (error) {
      let retained = false;
      const exists = await fs.lstat(member.worktreePath).then(
        () => true,
        () => false,
      );
      if (exists) {
        try {
          if (
            (member.setupStarted && !member.setupDone) ||
            !member.created ||
            (await git.read.commitOf(member.worktreePath, "HEAD")) !== member.initialCommit ||
            (await git.read.text(member.worktreePath, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).trim()
          )
            throw new Error("Modified or unverified", { cause: error });
          await git.write.checked(member.projectPath, ["worktree", "remove", "--", member.worktreePath]);
          await git.write.checked(member.projectPath, ["branch", "-d", "--", member.branch]);
        } catch {
          retained = true;
        }
      }
      const message = `Project ${member.projectName}: ${error.message}${retained ? `\nRetained Worktree: ${member.worktreePath}` : ""}`;
      if (retained) Object.assign(member, { setupDone: false, setupDeferred: false, retained: true, error: message });
      else prep.members = prep.members.filter((item) => item !== member);
      await save(link.id, prep);
      throw new Error(message, { cause: error });
    }
  }
  // Members reserved but not finished: a quit interrupted them, or the preparation was saved before Worktrees were made
  // on demand. A retained member stays as it is, for inspection.
  const unfinished = (prep) => prep.status !== "ready" || prep.members.some((member) => !isReady(member) && !member.retained);
  async function finishMembers(link, prep) {
    for (const member of prep.members) {
      if (isReady(member) || member.retained) continue;
      await ownProject(member.projectPath);
      await materialize(link, prep, member);
    }
  }
  // A new Chat's workspace folder, with no Worktree yet; an unfinished preparation finishes first.
  async function prepare({ link, chatId, prompt = "", operationId }) {
    if (!validLinkId(operationId) || !Number.isSafeInteger(chatId) || chatId < 1) throw new Error("Invalid Link preparation request");
    const state = await store.get(link.id);
    let prep = state.preparations[operationId] ?? Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (prep?.chatId !== undefined && prep.chatId !== chatId) throw new Error("Preparation belongs to another Chat");
    if (prep && !unfinished(prep)) return result(prep);
    if (prep?.status === "failed") {
      if (prep.retainedPaths?.length) throw new Error(prep.error);
      prep = undefined;
    }
    await membersAvailable(link);
    prep ??= { operationId, chatId, prompt, workspacePath: path.join(store.directory(link.id), "workspaces", String(chatId)), members: [] };
    await finishMembers(link, prep);
    await writeManifest(link, prep);
    prep.status = "ready";
    await save(link.id, prep);
    return result(prep);
  }
  // Which Link Project the agent means: its name, alias, folder name or path, in any case.
  function find(projects, prep, wanted) {
    const value = String(wanted ?? "").trim();
    const lower = value.toLowerCase();
    const index = projects.findIndex(
      (project, i) =>
        project.id === value ||
        project.path === value ||
        project.name.toLowerCase() === lower ||
        path.basename(project.path).toLowerCase() === lower ||
        `${slugify(project.name) || "project"}-${i + 1}` === lower ||
        prep.members.some((member) => member.projectId === project.id && member.worktreePath === value),
    );
    if (index === -1) throw new Error(`No Project "${value}" in this Link. Its Projects: ${projects.map((project) => project.name).join(", ")}.`);
    return index;
  }
  async function addMember({ link, chatId, project: wanted }) {
    const state = await store.get(link.id);
    const prep = Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (prep?.status !== "ready") throw new Error("This Chat's workspace is not ready.");
    const projects = await membersAvailable(link);
    const index = find(projects, prep, wanted);
    const project = projects[index];
    let member = prep.members.find((item) => item.projectId === project.id);
    if (member && isReady(member)) return { member, created: false };
    if (member?.retained) throw new Error(member.error);
    await ownProject(project.path);
    if (!member) {
      member = await reserve(prep, project, index);
      prep.members.push(member);
      await save(link.id, prep);
    }
    return { member: await materialize(link, prep, member), created: true };
  }
  return {
    membersAvailable,
    prepareLinkChat: (request) => queued(request.link.id, () => prepare(request)),
    /** Gives a Link Chat its Worktree in one Project, or the one it has. Resolves to `{ member, created }`. */
    addLinkWorktree: (request) => queued(request.link.id, () => addMember(request)),
    async recoverLinkPreparations(linkId) {
      const link = (await registry.listProjectGroups()).find((item) => item.id === linkId);
      if (!link) throw new Error("Link no longer exists");
      for (const prep of Object.values((await store.get(linkId)).preparations))
        if (prep.status !== "failed" && unfinished(prep)) await queued(link.id, () => prepare({ link, chatId: prep.chatId, operationId: prep.operationId }));
    },
  };
}
module.exports = { createLinkWorkspaces };

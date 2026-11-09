const fs = require("node:fs/promises");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");
const { createWorktree: create, issueBranch, slugify, DEFAULT_WORKTREE_ROOT } = require("./worktrees.cjs");
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
  /** The Chat's member Projects. A preparation from before Worktrees were made on demand made every member at once. */
  function normalized(prep) {
    if (prep.projects) return prep;
    const ready = prep.status === "ready";
    prep.projects = prep.members.map((member) => ({
      projectId: member.projectId,
      projectPath: member.projectPath,
      projectName: member.projectName,
      alias: member.alias,
    }));
    for (const member of prep.members) member.status ??= ready ? "ready" : "reserved";
    return prep;
  }
  const readyMembers = (prep) => prep.members.filter((member) => member.status === "ready");
  const prepared = (prep) => ({ workspacePath: prep.workspacePath, projects: prep.projects, worktrees: readyMembers(prep) });
  async function writeManifest(linkId, prep) {
    await fs.mkdir(prep.workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(prep.workspacePath, "milagre-workspace.json"),
      JSON.stringify({ linkId, chatId: prep.chatId, projects: prep.projects, worktrees: readyMembers(prep) }, null, 2),
    );
  }
  // A Chat reserves its folder and its member Projects. No Worktree is made until the agent edits a Project
  // (prepareMember). `issue` (a Chat started from a Linear issue) names each member's branch after it when it's made.
  async function prepare({ link, chatId, prompt = "", operationId, issue }) {
    if (!validLinkId(operationId) || !Number.isSafeInteger(chatId) || chatId < 1) throw new Error("Invalid Link preparation request");
    const state = await store.get(link.id);
    let prep = state.preparations[operationId] ?? Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (prep?.chatId !== undefined && prep.chatId !== chatId) throw new Error("Preparation belongs to another Chat");
    if (prep?.status === "failed") {
      if (prep.retainedPaths?.length) throw new Error(prep.error);
      prep = undefined;
    }
    if (prep) normalized(prep);
    if (prep?.status === "ready") return prepared(prep);
    if (!prep) {
      const projects = await membersAvailable(link);
      prep = {
        operationId,
        chatId,
        prompt,
        status: "reserved",
        workspacePath: path.join(store.directory(link.id), "workspaces", String(chatId)),
        projects: projects.map((project, index) => ({
          projectId: project.id,
          projectPath: project.path,
          projectName: project.name,
          alias: `${slugify(project.name) || "project"}-${index + 1}`,
        })),
        members: [],
        ...(issue ? { issue: { key: issue.key, title: issue.title, branchName: issue.branchName } } : {}),
      };
      await save(link.id, prep);
    }
    // A member a crash interrupted is checked and finished, as it would have been then.
    for (const member of prep.members)
      if (member.status === "reserved") {
        await ownProject(member.projectPath);
        await makeMember(link.id, prep, member);
      }
    await writeManifest(link.id, prep);
    prep.status = "ready";
    await save(link.id, prep);
    return prepared(prep);
  }

  /** The member Project `name` names: its id, path, name or alias. */
  function memberProject(prep, name) {
    const wanted = String(name ?? "").trim();
    const lower = wanted.toLowerCase();
    return prep.projects.find(
      (project) =>
        project.projectId === wanted ||
        project.projectPath === wanted ||
        project.alias.toLowerCase() === lower ||
        String(project.projectName ?? "").toLowerCase() === lower,
    );
  }

  // The Chat's Worktree in one member Project, made the first time the agent asks for it.
  async function prepareMember({ linkId, chatId, project: name }) {
    const state = await store.get(linkId);
    const prep = Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (!prep || prep.status !== "ready") throw new Error("This Chat's Link workspace isn't ready.");
    normalized(prep);
    const project = memberProject(prep, name);
    if (!project)
      throw new Error(
        `No Project ${JSON.stringify(String(name ?? ""))} in this Chat. Choose one of: ${prep.projects.map((item) => item.projectName).join(", ")}.`,
      );
    let member = prep.members.find((item) => item.projectId === project.projectId);
    if (member?.status === "ready") return { member, created: false, ...prepared(prep) };
    if (member?.status === "failed") {
      if (member.retainedPaths?.length) throw new Error(member.error);
      prep.members = prep.members.filter((item) => item !== member);
      member = undefined;
    }
    await ownProject(project.projectPath);
    if (!member) {
      member = await reserveMember(prep, project);
      prep.members.push(member);
      await save(linkId, prep);
    }
    await makeMember(linkId, prep, member);
    await writeManifest(linkId, prep);
    return { member, created: true, ...prepared(prep) };
  }

  async function reserveMember(prep, project) {
    const index = prep.projects.indexOf(project);
    const settings = await getSettings(project.projectPath);
    const base = (await git.read.resolveBase(project.projectPath)).ref ?? "HEAD";
    const suffix = `${prep.operationId.slice(0, 8)}${index}`;
    const named = prep.issue ? await issueBranch({ projectPath: project.projectPath, issue: prep.issue, suffix, git }) : undefined;
    const name = named ? `${slugify(named.split("/").pop()) || "chat"}-${suffix}` : `${slugify(prep.prompt) || "chat"}-${suffix}`;
    const branch = named ?? `milagre/${name}`;
    const worktreePath = path.join(root, path.basename(project.projectPath), name);
    if (await git.read.refExists(project.projectPath, `refs/heads/${branch}`)) throw new Error(`Project ${project.projectName}: branch already exists`);
    try {
      await fs.lstat(worktreePath);
      throw new Error(`Project ${project.projectName}: Worktree folder already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const resolved = await resolveSetupCommand(project.projectPath, settings.setupCommand);
    return {
      ...project,
      status: "reserved",
      worktreePath,
      branch,
      ...(named ? { named: true } : {}),
      base,
      initialCommit: await git.read.commitOf(project.projectPath, base),
      suffix,
      ...(settings.filesToCopy !== undefined ? { copyPatterns: settings.filesToCopy } : {}),
      setupCommand: resolved.command,
    };
  }

  // Creates (or, after a crash, verifies) one member's Worktree, runs its setup and links it into the Chat's folder.
  // A failure removes a Worktree nothing changed yet and keeps any other for inspection.
  async function makeMember(linkId, prep, member) {
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
          ...(member.named ? { branch: member.branch } : {}),
          copyPatterns: member.copyPatterns,
        });
        member.base = created.base;
        member.worktreePath = await fs.realpath(created.path);
        member.initialCommit = await git.read.commitOf(member.worktreePath, "HEAD");
        member.created = true;
        await save(linkId, prep);
      }
      if (member.setupCommand && !member.setupDone) {
        if (member.setupStarted) throw new Error("Setup was interrupted. Its Worktree has been retained for inspection");
        member.setupStarted = true;
        await save(linkId, prep);
        const result = await runSetup({ cwd: member.worktreePath, command: member.setupCommand });
        if (result.status !== "done") throw new Error(`Setup ${result.status}: ${result.output || result.error || "command did not complete"}`);
      }
      member.setupDone = true;
      await fs.mkdir(prep.workspacePath, { recursive: true });
      const alias = path.join(prep.workspacePath, member.alias);
      try {
        await fs.symlink(member.worktreePath, alias, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (error.code !== "EEXIST" || (await fs.realpath(alias)) !== member.worktreePath) throw error;
      }
      member.status = "ready";
      await save(linkId, prep);
    } catch (error) {
      const retainedPaths = [];
      const exists = await fs.lstat(member.worktreePath).then(
        () => true,
        () => false,
      );
      if (exists)
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
      member.status = "failed";
      member.retainedPaths = retainedPaths;
      member.error = `Project ${member.projectName}: ${error.message}${retainedPaths.length ? `\nRetained Worktree: ${retainedPaths.join(", ")}` : ""}`;
      await save(linkId, prep);
      throw new Error(member.error, { cause: error });
    }
  }
  function queued(key, work) {
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, run);
    run
      .finally(() => {
        if (queues.get(key) === run) queues.delete(key);
      })
      .catch(() => {});
    return run;
  }
  return {
    membersAvailable,
    prepareLinkChat: (request) => queued(request.link.id, () => prepare(request)),
    /** `{ member, created, workspacePath, projects, worktrees }`: the member's Worktree and the Chat's made ones. */
    prepareLinkMember: (request) => queued(request.linkId, () => prepareMember(request)),
    /** The Chat's Projects and the Worktrees made in them so far, from its preparation. */
    async chatMembers(linkId, chatId) {
      const prep = Object.values((await store.get(linkId)).preparations).find((item) => item.chatId === chatId);
      return prep ? prepared(normalized(prep)) : null;
    },
    async recoverLinkPreparations(linkId) {
      const link = (await registry.listProjectGroups()).find((item) => item.id === linkId);
      if (!link) throw new Error("Link no longer exists");
      const failures = [];
      for (const prep of Object.values((await store.get(linkId)).preparations)) {
        normalized(prep);
        if (!["ready", "failed"].includes(prep.status)) await this.prepareLinkChat({ link, chatId: prep.chatId, operationId: prep.operationId });
        else if (prep.status === "ready")
          for (const member of prep.members.filter((item) => item.status === "reserved"))
            await queued(linkId, async () => {
              await ownProject(member.projectPath);
              await makeMember(linkId, prep, member);
            }).catch((error) => failures.push(error));
      }
      if (failures.length) throw failures[0];
    },
  };
}
module.exports = { createLinkWorkspaces };

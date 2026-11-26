const fs = require("node:fs/promises");
const path = require("node:path");
const { branchTicket } = require("@milagre/shared/branch-policy");
const { resolveBranchPolicy, availablePolicyBranch } = require("./branch-policy.cjs");
const { createGit } = require("./git/client.cjs");
const { createWorktree: create, slugify, DEFAULT_WORKTREE_ROOT } = require("./worktrees.cjs");
const { resolveSetupCommand, runSetupCommand } = require("./worktree-setup.cjs");
const { removeWorktree: removeChecked } = require("./worktree-cleanup.cjs");
const { changedCopiedFiles } = require("./worktree-files.cjs");
const { validLinkId } = require("@milagre/shared/chat-scopes");

const projectSlug = (project) => slugify(project.name) || "project";
function memberAlias(projects, index) {
  const slug = projectSlug(projects[index]);
  return projects.some((project, i) => i !== index && projectSlug(project) === slug) ? `${slug}-${index + 1}` : slug;
}

async function reserve({ getSettings, git, root }, prep, projects, index) {
  const project = projects[index];
  const settings = await getSettings(project.path);
  const policy = settings.git ?? (await resolveBranchPolicy(project.path)).effective;
  const base = policy.baseBranch || (await git.read.resolveBase(project.path)).ref || "HEAD";
  const branchSuffix = prep.operationId.slice(0, 8);
  const suffix = `${branchSuffix}${index}`;
  const name = `${slugify(prep.prompt) || "chat"}-${suffix}`;
  const worktreePath = path.join(root, path.basename(project.path), name);
  const issue = prep.issue;
  const branch = await availablePolicyBranch(
    project.path,
    policy,
    { slug: issue?.title || prep.prompt || "chat", ticket: issue?.key || branchTicket(prep.prompt), suffix: branchSuffix },
    { issueBranch: issue ? issue.branchName || "" : undefined },
  );
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
    branch,
    trackBase: policy.trackBase,
    base,
    initialCommit: await git.read.commitOf(project.path, base),
    suffix,
    alias: memberAlias(projects, index),
    ...(settings.filesToCopy !== undefined ? { copyPatterns: settings.filesToCopy } : {}),
    setupCommand: resolved.command,
    setupSource: resolved.source,
  };
}

function groupMembersByProject(members) {
  const groups = new Map();
  members.forEach((member, index) => {
    const key = member.projectPath || "";
    const list = groups.get(key);
    if (list) list.push([index, member]);
    else groups.set(key, [[index, member]]);
  });
  return [...groups.values()];
}

async function releaseMember(member, { isReady, root, removeWorktree, changedCopied }) {
  if (member.adopted) return { kind: "kept", member };
  const exists = await fs.lstat(member.worktreePath).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  const checkedBase = member.base && member.base !== "HEAD" ? member.base : member.initialCommit;
  try {
    if ((!member.created && !isReady(member)) || (member.setupStarted && !member.setupDone)) throw new Error("Unverified Worktree");
    if ((await changedCopied({ projectPath: member.projectPath, worktreePath: member.worktreePath, setting: member.copyPatterns })).length)
      throw new Error("Copied files changed");
    await removeWorktree({ path: member.worktreePath, root, projectPath: member.projectPath, base: checkedBase });
    return { kind: "removed", member };
  } catch {
    return { kind: "kept", member: { ...member, checkedBase } };
  }
}

function createLinkWorkspaces({
  store,
  registry,
  ownProject,
  root = DEFAULT_WORKTREE_ROOT,
  getSettings = async () => ({}),
  createWorktree = create,
  runSetup = runSetupCommand,
  deferSetup,
  removeWorktree = removeChecked,
  changedCopied = changedCopiedFiles,
  git = createGit(),
}) {
  const queues = new Map();
  const released = new Set();
  const refuseReleased = (id, state) => {
    if (released.has(id) || state.deletedAt) throw new Error("This Link is being deleted.");
  };
  const isReady = (member) => Boolean(member.setupDone || member.setupDeferred);
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
          branch: member.branch,
          folderSlug: slugify(prep.prompt) || "chat",
          trackBase: member.trackBase === true,
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
  const unfinished = (prep) => prep.status !== "ready" || prep.members.some((member) => !isReady(member) && !member.retained);
  async function finishMembers(link, prep) {
    for (const member of prep.members) {
      if (isReady(member) || member.retained) continue;
      await ownProject(member.projectPath);
      await materialize(link, prep, member);
    }
  }
  async function prepare({ link, chatId, prompt = "", operationId, issue }) {
    if (!validLinkId(operationId) || !Number.isSafeInteger(chatId) || chatId < 1) throw new Error("Invalid Link preparation request");
    const state = await store.get(link.id);
    refuseReleased(link.id, state);
    if (link.canvasLinkId) throw new Error("This shared Chat uses the existing Worktrees selected on the canvas.");
    let prep = state.preparations[operationId] ?? Object.values(state.preparations).find((item) => item.chatId === chatId);
    if (prep?.chatId !== undefined && prep.chatId !== chatId) throw new Error("Preparation belongs to another Chat");
    if (prep && !unfinished(prep)) return result(prep);
    if (prep?.status === "failed") {
      if (prep.retainedPaths?.length) throw new Error(prep.error);
      prep = undefined;
    }
    await membersAvailable(link);
    prep ??= {
      operationId,
      chatId,
      prompt,
      workspacePath: path.join(store.directory(link.id), "workspaces", String(chatId)),
      members: [],
      ...(issue ? { issue: { key: issue.key, title: issue.title, branchName: issue.branchName } } : {}),
    };
    await finishMembers(link, prep);
    await writeManifest(link, prep);
    prep.status = "ready";
    await save(link.id, prep);
    return result(prep);
  }
  function find(projects, prep, wanted) {
    const value = String(wanted ?? "").trim();
    const lower = value.toLowerCase();
    const index = projects.findIndex(
      (project, i) =>
        project.id === value ||
        project.path === value ||
        project.name.toLowerCase() === lower ||
        path.basename(project.path).toLowerCase() === lower ||
        memberAlias(projects, i) === lower ||
        `${projectSlug(project)}-${i + 1}` === lower ||
        prep.members.some((member) => member.projectId === project.id && member.worktreePath === value),
    );
    if (index === -1) throw new Error(`No Project "${value}" in this Link. Its Projects: ${projects.map((project) => project.name).join(", ")}.`);
    return index;
  }
  async function addMember({ link, chatId, project: wanted }) {
    if (link.canvasLinkId) throw new Error("This Chat owns only the existing Worktrees selected on the canvas.");
    const state = await store.get(link.id);
    refuseReleased(link.id, state);
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
      member = await reserve({ getSettings, git, root }, prep, projects, index);
      prep.members.push(member);
      await save(link.id, prep);
    }
    return { member: await materialize(link, prep, member), created: true };
  }
  async function release(linkId) {
    const state = await store.get(linkId);
    const members = new Map();
    for (const prep of Object.values(state.preparations)) for (const member of prep.members) members.set(member.worktreePath, member);
    for (const session of Object.values(state.sessions)) for (const member of session.worktrees ?? []) members.set(member.worktreePath, member);
    released.add(linkId);
    const groups = groupMembersByProject([...members.values()]);
    const outcomes = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, groups.length) }, async () => {
        while (next < groups.length) {
          for (const [index, member] of groups[next++]) outcomes[index] = await releaseMember(member, { isReady, root, removeWorktree, changedCopied });
        }
      }),
    );
    const removed = [],
      kept = [];
    for (const outcome of outcomes) {
      if (!outcome) continue;
      if (outcome.kind === "removed") removed.push(outcome.member);
      else kept.push(outcome.member);
    }
    return { removed, kept };
  }
  return {
    membersAvailable,
    releaseLinkWorktrees: (linkId) => queued(linkId, () => release(linkId)),
    prepareLinkChat: (request) => queued(request.link.id, () => prepare(request)),
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

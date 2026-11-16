const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeOrchestratorSettings, roleById, pickAccount, titleFromPrompt, recordTrust } = require("@milagre/shared/orchestrator");
const { routeTask } = require("./router.cjs");

const HINT_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];
const HINT_CHARS = 400;

function readHints(projectPath) {
  for (const name of HINT_FILES) {
    try {
      const text = fs.readFileSync(path.join(projectPath, name), "utf8");
      const body = text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#>*_`|[\]()!-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (body) return body.slice(0, HINT_CHARS);
    } catch {}
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
    if (typeof pkg.description === "string" && pkg.description.trim()) return pkg.description.trim().slice(0, HINT_CHARS);
  } catch {}
  return null;
}

function withRole(prompt, role) {
  if (!role?.instructions) return prompt;
  return `${prompt}\n\n<role_instructions role="${role.name}">\n${role.instructions}\n</role_instructions>`;
}

function createOrchestrator({ store, ports, now = () => Date.now() }) {
  const hints = new Map();
  const starting = new Set();

  function settings() {
    return store.read().settings;
  }

  async function projectList() {
    const config = settings();
    const listed = await ports.projects();
    return listed
      .filter((project) => config.projects[project.path]?.included !== false)
      .map((project) => {
        if (!hints.has(project.path)) hints.set(project.path, readHints(project.path));
        return { path: project.path, name: project.name, hints: config.projects[project.path]?.hints ?? hints.get(project.path) };
      });
  }

  function addTask(prompt) {
    const task = { id: randomUUID(), prompt, title: titleFromPrompt(prompt), state: "routing", createdAt: now(), answered: [] };
    store.update((current) => ({ ...current, tasks: [...current.tasks, task] }));
    return task.id;
  }

  async function chooseAccount(provider, projectPath) {
    const projectAccountId = ports.selectedAccount(provider, projectPath);
    const usage = await ports.accountUsage().catch(() => []);
    const accounts = usage
      .filter((entry) => entry.provider === provider)
      .map((entry) => ({ id: entry.accountId, usedPercent: entry.usedPercent, limited: entry.usedPercent >= 100 }));
    return pickAccount({ mode: settings().account, accounts, projectAccountId });
  }

  async function start(taskId, route) {
    const config = settings();
    const role = roleById(config.roles, route.role);
    if (!role) throw new Error("No role has a model. Pick one in Settings › Church › Orchestrator.");
    const account = await chooseAccount(role.provider, route.projectPath);
    let worktreeId = null;
    try {
      worktreeId = await ports.createWorktree(route.projectPath, route.title);
    } catch (error) {
      console.warn("[orchestrator] couldn't make a Worktree, using the Project folder:", error.message);
      worktreeId = await ports.projectWorktree(route.projectPath);
    }
    if (worktreeId === undefined || worktreeId === null) throw new Error("The Project folder is no longer in the Project.");
    const sessionId = await ports.emptyChat(route.projectPath, worktreeId, {
      title: route.title,
      orchestrator: { taskId, hidden: config.hideTaskChats, ...(account.accountId ? { accounts: { [role.provider]: account.accountId } } : {}) },
    });
    store.updateTask(taskId, () => ({
      state: "started",
      title: route.title,
      projectPath: route.projectPath,
      worktreeId: String(worktreeId),
      sessionId,
      role: role.id,
      provider: role.provider,
      model: role.model,
      effort: role.effort,
      accountId: account.accountId,
      computer: null,
      reason: { project: route.reason ?? null, role: route.roleReason ?? null, account: account.reason, computer: null },
      error: null,
    }));
    const task = store.task(taskId);
    await ports.send({
      projectPath: route.projectPath,
      sessionId,
      worktreeId: String(worktreeId),
      provider: role.provider,
      model: role.model,
      ...(role.effort ? { effort: role.effort } : {}),
      permissionMode: "auto",
      body: task.prompt,
      prompt: withRole(task.prompt, role),
      images: [],
      files: [],
    });
    return store.task(taskId);
  }

  async function routeAndStart(taskId) {
    const task = store.task(taskId);
    if (!task) return null;
    starting.add(taskId);
    try {
      const config = settings();
      const projects = await projectList();
      const notes = store
        .read()
        .memory.notes.filter((note) => note.enabled)
        .map((note) => note.text);
      const route = await routeTask({ prompt: task.prompt, projects, roles: config.roles, notes, call: ports.routerCall(config.router) });
      if (!route.projectPath && !(config.whenUnsure === "guess" && projects.length === 1)) {
        store.updateTask(taskId, () => ({ state: "needs-project", title: route.title, role: route.role, reason: { ...task.reason, project: route.reason } }));
        return store.task(taskId);
      }
      return await start(taskId, { ...route, projectPath: route.projectPath ?? projects[0].path });
    } catch (error) {
      store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) }));
      return store.task(taskId);
    } finally {
      starting.delete(taskId);
    }
  }

  function chatKeyOf(task) {
    return task?.projectPath && task.sessionId !== null ? ports.chatKey(task.projectPath, task.sessionId) : null;
  }

  async function dropChat(task) {
    const chatKey = chatKeyOf(task);
    if (!chatKey) return;
    await ports.stop(chatKey).catch(() => {});
    await ports.archive(task.projectPath, task.sessionId).catch(() => {});
  }

  function learn(kind) {
    store.update((current) => ({ ...current, memory: { ...current.memory, trust: recordTrust(current.memory.trust, kind, "corrected"), updatedAt: now() } }));
  }

  return {
    snapshot: () => store.read(),
    saveSettings(patch) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Orchestrator settings must be an object");
      store.update((current) => ({ ...current, settings: normalizeOrchestratorSettings({ ...current.settings, ...patch }) }));
      return store.read().settings;
    },
    async send(prompt) {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Type what you need first.");
      if (!settings().enabled) throw new Error("Turn the Orchestrator on in Settings › Church first.");
      const taskId = addTask(prompt.trim());
      void routeAndStart(taskId);
      return store.task(taskId);
    },
    async pickProject(taskId, projectPath) {
      const task = store.task(taskId);
      if (!task || task.state === "started") return task;
      const projects = await projectList();
      if (!projects.some((project) => project.path === projectPath)) throw new Error("That Project isn't one the Orchestrator can use.");
      learn("project");
      return start(taskId, { projectPath, role: task.role, title: task.title, reason: "You picked it" }).catch((error) => {
        store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) }));
        return store.task(taskId);
      });
    },
    async showInSidebar(taskId, shown) {
      const task = store.task(taskId);
      if (!task?.projectPath || task.sessionId === null) return task;
      await ports.setHidden(task.projectPath, task.sessionId, !shown);
      return task;
    },
    async undo(taskId) {
      const task = store.task(taskId);
      if (!task) return null;
      await dropChat(task);
      store.update((current) => ({ ...current, tasks: current.tasks.filter((entry) => entry.id !== taskId) }));
      return null;
    },
    async reroute(taskId, change = {}) {
      const task = store.task(taskId);
      if (!task) return null;
      await dropChat(task);
      learn(change.projectPath && change.projectPath !== task.projectPath ? "project" : "role");
      store.updateTask(taskId, () => ({ state: "routing", sessionId: null, worktreeId: null, error: null }));
      if (!change.projectPath && !change.role) return routeAndStart(taskId);
      return start(taskId, {
        projectPath: change.projectPath ?? task.projectPath,
        role: change.role ?? task.role,
        title: task.title,
        reason: change.projectPath ? "You picked it" : task.reason.project,
      }).catch((error) => {
        store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) }));
        return store.task(taskId);
      });
    },
    dismiss(taskId) {
      store.update((current) => ({ ...current, tasks: current.tasks.filter((entry) => entry.id !== taskId) }));
      return null;
    },
    isStarting: (taskId) => starting.has(taskId),
    taskForChat(projectPath, sessionId) {
      return store.read().tasks.find((task) => task.projectPath === projectPath && task.sessionId === sessionId) ?? null;
    },
  };
}

module.exports = { createOrchestrator, readHints };

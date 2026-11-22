const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  normalizeOrchestratorSettings,
  roleById,
  titleFromPrompt,
  recordTrust,
  normalizeTaskOutcome,
  taskOutcomePrompt,
  BOARD_COLUMNS,
} = require("@milagre/shared/orchestrator");
const { createAccounts, createLimitWatch } = require("./limits.cjs");
const { routeTask } = require("./router.cjs");
const { importMemory } = require("./memory-import.cjs");
const { createPlacement } = require("./placement.cjs");
const { checkedImages, savedImages } = require("./images.cjs");

const HINT_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];
const HINT_CHARS = 400;
const IMAGES_ONLY_PROMPT = "Look at the attached images.";

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

async function readMemoryInto({ store, ports, settings, now }) {
  const at = now();
  store.update((current) => ({ ...current, memory: { ...current.memory, sources: [], importStartedAt: at, updatedAt: at } }));
  const result = await importMemory({
    call: ports.memoryCall?.(settings().router) ?? null,
    onSource: (source) => store.update((current) => ({ ...current, memory: { ...current.memory, sources: [...current.memory.sources, source] } })),
    ...(ports.home ? { home: ports.home } : {}),
    now,
  }).catch((error) => {
    console.warn("[orchestrator] couldn't read the agents' memory:", error.message);
    return { sources: store.read().memory.sources, notes: [] };
  });
  store.update((current) => ({
    ...current,
    memory: {
      ...current.memory,
      sources: result.sources,
      notes: [...current.memory.notes.filter((note) => note.source === "Milagre"), ...result.notes],
      importedAt: now(),
      updatedAt: now(),
    },
  }));
}

/** What the owner does to a task by hand: show it in the sidebar, move it on the board, delete, undo or dismiss it. */
function taskActions({ store, ports, chatKeyOf, dropChat, forget }) {
  const drop = (taskId) => {
    store.update((current) => ({ ...current, tasks: current.tasks.filter((entry) => entry.id !== taskId) }));
    ports.images.drop(taskId);
  };
  return {
    async showInSidebar(taskId, shown) {
      const task = store.task(taskId);
      if (task?.remoteTaskId) return ports.remote.invoke(task.remoteComputerId, "orchestrator:task:sidebar", [task.remoteTaskId, shown]);
      if (!task?.projectPath || task.sessionId === null) return task;
      await ports.setHidden(task.projectPath, task.sessionId, !shown);
      return task;
    },
    async move(taskId, column) {
      if (!BOARD_COLUMNS.includes(column)) throw new Error("Move it to Running, Needs you, In review or Done.");
      const task = store.task(taskId);
      if (task?.remoteTaskId) return ports.remote.invoke(task.remoteComputerId, "orchestrator:task:move", [task.remoteTaskId, column]);
      if (!task?.projectPath || task.sessionId === null) throw new Error("This task has no Chat to move yet.");
      await ports.placeChat(task.projectPath, task.sessionId, column);
      return task;
    },
    async remove(taskId) {
      const task = store.task(taskId);
      if (!task) return null;
      if (task.remoteTaskId) await ports.remote.invoke(task.remoteComputerId, "orchestrator:task:delete", [task.remoteTaskId]);
      else if (chatKeyOf(task))
        await ports.deleteChat(task.projectPath, task.sessionId).catch(async (error) => {
          console.warn("[orchestrator] couldn't delete a task's Chat, archiving it:", error.message);
          await dropChat(task);
        });
      forget(taskId);
      drop(taskId);
      return null;
    },
    async undo(taskId) {
      const task = store.task(taskId);
      if (!task) return null;
      if (task.remoteTaskId) await ports.remote.invoke(task.remoteComputerId, "orchestrator:task:undo", [task.remoteTaskId]).catch(() => {});
      else await dropChat(task);
      drop(taskId);
      return null;
    },
    dismiss(taskId) {
      drop(taskId);
      return null;
    },
  };
}

function createOrchestrator({ store, ports, now = () => Date.now() }) {
  const hints = new Map();
  const starting = new Set();
  function settings() {
    return store.read().settings;
  }

  const accounts = createAccounts({ ports, settings, now });
  const { roleWithRoom } = accounts;

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

  function addTask(prompt, permissionMode, images = [], outcome = settings().outcome) {
    const task = {
      id: randomUUID(),
      prompt,
      outcome: normalizeTaskOutcome(outcome),
      title: titleFromPrompt(prompt),
      state: "routing",
      permissionMode,
      createdAt: now(),
      answered: [],
      images: images.length,
    };
    if (images.length) ports.images.save(task.id, images);
    store.update((current) => ({ ...current, tasks: [...current.tasks, task] }));
    ports.images.prune(store.read().tasks.map((entry) => entry.id));
    return task.id;
  }

  const imagesOf = (task) => savedImages(ports.images, task);

  async function start(taskId, route) {
    const config = settings();
    const wanted = roleById(config.roles, route.role);
    if (!wanted) throw new Error("No role has a model. Pick one in Settings › Church › Orchestrator.");
    const images = imagesOf(store.task(taskId));
    const roomy = await roleWithRoom(wanted, route.projectPath);
    const role = roomy.role;
    const account = roomy.account;
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
      limit: null,
      reason: { project: route.reason ?? null, role: roomy.reason ?? route.roleReason ?? null, account: account.reason, computer: null },
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
      permissionMode: task.permissionMode,
      body: task.prompt,
      prompt: `${withRole(task.prompt, role)}\n\n<task_outcome>\n${taskOutcomePrompt(task.outcome)}\n</task_outcome>`,
      images,
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
      if (!route.projectPath && projects.length !== 1 && config.whenUnsure === "ask") {
        store.updateTask(taskId, () => ({ state: "needs-project", title: route.title, role: route.role, reason: { ...task.reason, project: route.reason } }));
        return store.task(taskId);
      }
      const placed = { ...route, projectPath: route.projectPath ?? projects[0].path };
      return (await placement.placeElsewhere(taskId, placed).catch(() => null)) ?? (await start(taskId, placed));
    } catch (error) {
      store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) }));
      return store.task(taskId);
    } finally {
      starting.delete(taskId);
    }
  }

  const placement = createPlacement({ store, ports, settings, projectList, addTask, imagesOf, start: (taskId, route) => start(taskId, route) });

  const limitWatch = createLimitWatch({
    store,
    accounts,
    settings,
    taskFor: (chatKey) => store.read().tasks.find((entry) => chatKeyOf(entry) === chatKey),
    isStarting: (taskId) => starting.has(taskId),
    restart: async (task, route) => {
      await dropChat(task);
      startInBackground(task.id, route);
    },
  });

  let importing = null;

  const readMemory = () => readMemoryInto({ store, ports, settings, now });

  function startInBackground(taskId, route) {
    store.updateTask(taskId, () => ({ state: "routing", error: null }));
    void start(taskId, route).catch((error) => store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) })));
    return store.task(taskId);
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
    async projects() {
      const config = settings();
      return (await ports.projects()).map((project) => {
        if (!hints.has(project.path)) hints.set(project.path, readHints(project.path));
        const own = config.projects[project.path];
        return { path: project.path, name: project.name, included: own?.included !== false, hints: own?.hints ?? null, defaultHints: hints.get(project.path) };
      });
    },
    computers: () => placement.computers(),
    saveSettings(patch) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Orchestrator settings must be an object");
      store.update((current) => ({ ...current, settings: normalizeOrchestratorSettings({ ...current.settings, ...patch }) }));
      return store.read().settings;
    },
    async send(prompt, options = {}) {
      const images = checkedImages(options?.images);
      if (typeof prompt !== "string" || (!prompt.trim() && !images.length)) throw new Error("Type what you need first.");
      if (!settings().enabled) throw new Error("Turn the Orchestrator on in Settings › Church first.");
      const taskId = addTask(prompt.trim() || IMAGES_ONLY_PROMPT, options?.permissionMode, images);
      void routeAndStart(taskId);
      return store.task(taskId);
    },
    async pickProject(taskId, projectPath) {
      const task = store.task(taskId);
      if (!task || task.state === "started") return task;
      const projects = await projectList();
      if (!projects.some((project) => project.path === projectPath)) throw new Error("That Project isn't one the Orchestrator can use.");
      learn("project");
      return startInBackground(taskId, { projectPath, role: task.role, title: task.title, reason: "You picked it" });
    },
    ...taskActions({ store, ports, chatKeyOf, dropChat, forget: (taskId) => limitWatch.forget(taskId) }),
    async reroute(taskId, change = {}) {
      const task = store.task(taskId);
      if (!task) return null;
      await dropChat(task);
      limitWatch.forget(taskId);
      learn(change.projectPath && change.projectPath !== task.projectPath ? "project" : "role");
      store.updateTask(taskId, () => ({ state: "routing", sessionId: null, worktreeId: null, error: null }));
      if (!change.projectPath && !change.role) {
        void routeAndStart(taskId);
        return store.task(taskId);
      }
      return startInBackground(taskId, {
        projectPath: change.projectPath ?? task.projectPath,
        role: change.role ?? task.role,
        title: task.title,
        reason: change.projectPath ? "You picked it" : task.reason.project,
      });
    },
    importMemory() {
      if (!importing) importing = readMemory().finally(() => (importing = null));
      return store.read().memory;
    },
    whenImported: () => importing ?? Promise.resolve(),
    saveMemoryNotes(notes) {
      if (!Array.isArray(notes)) throw new Error("Memory notes must be a list");
      store.update((current) => ({ ...current, memory: { ...current.memory, notes, updatedAt: now() } }));
      return store.read().memory;
    },
    forgetMemory() {
      store.update((current) => ({ ...current, memory: { notes: [], trust: {}, sources: [], importedAt: null, updatedAt: now() } }));
      return store.read().memory;
    },
    capacity: () => placement.capacity(),
    startHere: (request) => placement.startHere(request),
    isStarting: (taskId) => starting.has(taskId),
    observe: (chatKey, event) => limitWatch.observe(chatKey, event),
    taskForChat(projectPath, sessionId) {
      return store.read().tasks.find((task) => task.projectPath === projectPath && task.sessionId === sessionId) ?? null;
    },
  };
}

module.exports = { createOrchestrator, readHints };

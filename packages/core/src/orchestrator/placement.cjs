const { pickComputer } = require("@milagre/shared/orchestrator");
const { checkedImages } = require("./images.cjs");

function createPlacement({ store, ports, settings, projectList, addTask, imagesOf, start }) {
  async function placeElsewhere(taskId, route) {
    const config = settings();
    const remote = ports.remote;
    if (!config.useOtherComputers || !remote?.enabled?.()) return null;
    const origin = await ports.originOf(route.projectPath).catch(() => null);
    if (!origin) return null;
    const here = await ports.capacity();
    const required = (await ports.requiredSecrets?.(origin).catch(() => [])) ?? [];
    const holdsSecrets = (capacity) => required.every((name) => capacity?.secrets?.includes(name));
    const answers = await Promise.all(
      remote.list().map(async (computer) => {
        const capacity = await ports.withTimeout(remote.invoke(computer.id, "orchestrator:capacity", []), 4000).catch(() => null);
        const project = capacity?.projects?.find((entry) => entry.origin === origin);
        return project && holdsSecrets(capacity)
          ? { ...capacity, id: computer.id, name: computer.name, local: false, online: true, projectPath: project.path }
          : null;
      }),
    );
    const candidates = [{ ...here, id: "local", name: null, local: true, online: true }, ...answers.filter(Boolean)];
    if (candidates.length < 2) return null;
    const pick = pickComputer({ candidates, preferences: config.computerPreferences });
    if (!pick || pick.local) {
      store.updateTask(taskId, (task) => ({ reason: { ...task.reason, computer: "This computer has the most room" } }));
      return null;
    }
    const task = store.task(taskId);
    const started = await remote.invoke(pick.id, "orchestrator:start-here", [
      {
        prompt: task.prompt,
        title: route.title,
        origin,
        role: route.role,
        reason: route.reason ?? null,
        permissionMode: task.permissionMode,
        outcome: task.outcome,
        images: imagesOf(task),
      },
    ]);
    const computerReason = `${pick.name} has the most room (${Math.round((1 - (pick.cpu ?? 0)) * 100)}% CPU free)`;
    store.updateTask(taskId, () => ({
      title: route.title,
      projectPath: pick.projectPath,
      computer: pick.name,
      remoteComputerId: pick.id,
      remoteTaskId: started.id,
      state: "routing",
    }));
    void follow(taskId, pick.id, started.id, computerReason);
    return store.task(taskId);
  }

  async function follow(taskId, computerId, remoteTaskId, computerReason) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const remoteTask = (await ports.remote.invoke(computerId, "orchestrator:read", []).catch(() => null))?.tasks?.find((entry) => entry.id === remoteTaskId);
      if (remoteTask && remoteTask.state !== "routing") {
        const {
          id: _id,
          prompt: _prompt,
          createdAt: _createdAt,
          computer: _computer,
          remoteComputerId: _from,
          remoteTaskId: _task,
          images: _images,
          outcome: _outcome,
          ...fields
        } = remoteTask;
        store.updateTask(taskId, () => ({ ...fields, reason: { ...fields.reason, computer: computerReason } }));
        return;
      }
      await ports.wait(3000);
    }
  }

  async function capacity() {
    const projects = await projectList();
    const origins = await Promise.all(projects.map((project) => ports.originOf(project.path).catch(() => null)));
    return {
      ...(await ports.capacity()),
      projects: projects.map((project, index) => ({ path: project.path, name: project.name, origin: origins[index] })).filter((entry) => entry.origin),
    };
  }
  async function startHere({ prompt, title, origin, role, reason, permissionMode, images, outcome }) {
    const checked = checkedImages(images);
    const projects = await projectList();
    const origins = await Promise.all(projects.map((project) => ports.originOf(project.path).catch(() => null)));
    const project = projects.find((_, index) => origins[index] === origin);
    if (!project) throw new Error("That Project isn't on this computer.");
    const taskId = addTask(String(prompt), permissionMode, checked, outcome);
    void start(taskId, { projectPath: project.path, role, title, reason }).catch((error) =>
      store.updateTask(taskId, () => ({ state: "failed", error: String(error?.message ?? error).slice(0, 300) })),
    );
    return store.task(taskId);
  }

  async function computers() {
    const remote = ports.remote;
    if (!remote?.enabled?.()) return [];
    return Promise.all(
      remote.list().map(async (computer) => {
        const ask = (method, args) => ports.withTimeout(remote.invoke(computer.id, method, args), 4000).catch(() => null);
        const capacity = await ask("orchestrator:capacity", []);
        const memory = capacity || computer.online === false ? null : (await ask("computer:resources:read", [{}]))?.memory;
        return {
          id: computer.id,
          name: computer.name,
          online: Boolean(capacity) || computer.online === true,
          cpu: capacity?.cpu ?? null,
          memoryFree: capacity?.memoryFree ?? (memory?.total ? memory.available / memory.total : null),
          agents: capacity?.agents ?? null,
          takesTasks: Boolean(capacity),
        };
      }),
    );
  }

  return { placeElsewhere, capacity, startHere, computers };
}

module.exports = { createPlacement };

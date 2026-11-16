const { pickComputer } = require("@milagre/shared/orchestrator");

function createPlacement({ store, ports, settings, projectList, addTask, start }) {
  async function placeElsewhere(taskId, route) {
    const config = settings();
    const remote = ports.remote;
    if (!config.useOtherComputers || !remote?.enabled?.()) return null;
    const origin = await ports.originOf(route.projectPath).catch(() => null);
    if (!origin) return null;
    const here = await ports.capacity();
    const answers = await Promise.all(
      remote.list().map(async (computer) => {
        const capacity = await ports.withTimeout(remote.invoke(computer.id, "orchestrator:capacity", []), 4000).catch(() => null);
        const project = capacity?.projects?.find((entry) => entry.origin === origin);
        return project ? { ...capacity, id: computer.id, name: computer.name, local: false, online: true, projectPath: project.path } : null;
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
      { prompt: task.prompt, title: route.title, origin, role: route.role, reason: route.reason ?? null },
    ]);
    store.updateTask(taskId, () => ({
      ...started,
      id: taskId,
      prompt: task.prompt,
      createdAt: task.createdAt,
      computer: pick.name,
      remoteComputerId: pick.id,
      remoteTaskId: started.id,
      reason: { ...started.reason, computer: `${pick.name} has the most room (${Math.round((1 - (pick.cpu ?? 0)) * 100)}% CPU free)` },
    }));
    return store.task(taskId);
  }

  async function capacity() {
    const projects = await projectList();
    const origins = await Promise.all(projects.map((project) => ports.originOf(project.path).catch(() => null)));
    return {
      ...(await ports.capacity()),
      projects: projects.map((project, index) => ({ path: project.path, name: project.name, origin: origins[index] })).filter((entry) => entry.origin),
    };
  }
  async function startHere({ prompt, title, origin, role, reason }) {
    const projects = await projectList();
    const origins = await Promise.all(projects.map((project) => ports.originOf(project.path).catch(() => null)));
    const project = projects.find((_, index) => origins[index] === origin);
    if (!project) throw new Error("That Project isn't on this computer.");
    const taskId = addTask(String(prompt));
    return start(taskId, { projectPath: project.path, role, title, reason });
  }

  return { placeElsewhere, capacity, startHere };
}

module.exports = { createPlacement };

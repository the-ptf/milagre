const { z } = require("zod");

function orchestratorMcpMethods({ send, read }) {
  return {
    orchestratorSend: ({ prompt }, assertActive) => {
      assertActive();
      return send(prompt);
    },
    async orchestratorTasks() {
      const { settings, tasks } = await read();
      return settings.enabled ? tasks : [];
    },
  };
}

function orchestratorTools({ read, act, host, assertActive }) {
  return [
    read(
      "orchestrator_tasks",
      "List the Orchestrator's tasks with each one's prompt, Project, role, model, account, computer and state. Empty while the Orchestrator is off in Settings › Church.",
      {},
      () => host.orchestratorTasks(),
    ),
    act(
      "orchestrator_send",
      "Hand a request to the Orchestrator: it picks the Project, role, model, account and computer, then starts it as a task Chat that stays off the sidebar until the user moves it there. Use it when work belongs to another Project or the right one is unclear. Fails while the Orchestrator is off in Settings › Church.",
      "create",
      { prompt: z.string().min(1).max(20000) },
      (args) => host.orchestratorSend(args, assertActive),
    ),
  ];
}

module.exports = { orchestratorMcpMethods, orchestratorTools };

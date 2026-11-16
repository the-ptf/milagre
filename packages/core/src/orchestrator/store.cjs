const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeOrchestratorSettings, normalizeOrchestratorTasks, normalizeOrchestratorMemory } = require("@milagre/shared/orchestrator");

function fresh() {
  return { settings: normalizeOrchestratorSettings(null), tasks: [], memory: normalizeOrchestratorMemory(null) };
}

function createOrchestratorStore({ file, emit = () => {} }) {
  let cache = null;
  function read() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      cache = {
        settings: normalizeOrchestratorSettings(raw?.settings),
        tasks: normalizeOrchestratorTasks(raw?.tasks),
        memory: normalizeOrchestratorMemory(raw?.memory),
      };
    } catch {
      cache = fresh();
    }
    return cache;
  }
  function write(next) {
    const value = {
      settings: normalizeOrchestratorSettings(next.settings),
      tasks: normalizeOrchestratorTasks(next.tasks),
      memory: normalizeOrchestratorMemory(next.memory),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    cache = value;
    emit("orchestrator:changed", value);
    return value;
  }
  return {
    read,
    update: (change) => write(change(read())),
    task: (taskId) => read().tasks.find((task) => task.id === taskId) ?? null,
    updateTask: (taskId, change) => write({ ...read(), tasks: read().tasks.map((task) => (task.id === taskId ? { ...task, ...change(task) } : task)) }),
  };
}

module.exports = { createOrchestratorStore };

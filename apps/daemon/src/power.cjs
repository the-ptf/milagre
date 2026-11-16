const childProcess = require("node:child_process");

function createPowerBlocker({
  platform = process.platform,
  spawn = childProcess.spawn,
  onError = (error) => console.warn("Keep awake unavailable:", error.message),
} = {}) {
  let nextId = 0;
  const children = new Map();
  return {
    start() {
      const id = ++nextId;
      if (platform !== "darwin") return id;
      const child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
      children.set(id, child);
      child.once("error", (error) => {
        children.delete(id);
        onError(error);
      });
      child.once("exit", () => children.delete(id));
      child.unref();
      return id;
    },
    isStarted: (id) => children.has(id),
    stop(id) {
      children.get(id)?.kill("SIGTERM");
      children.delete(id);
    },
  };
}
module.exports = { createPowerBlocker };

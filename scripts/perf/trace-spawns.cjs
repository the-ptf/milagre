// Loaded with NODE_OPTIONS=--require by launch.cjs --trace into the Electron main process and the host. Every child
// process they start runs under a bash wrapper that records its CPU, and its command line, caller and timing go to
// PERF_TRACE_DIR. Children don't inherit NODE_OPTIONS, except the host started by the main process.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const dir = process.env.PERF_TRACE_DIR;
const wrapper = process.env.PERF_TRACE_WRAPPER;
const isElectron = /Electron|Milagre/.test(path.basename(process.execPath));

if (dir && wrapper && isElectron) {
  const role = process.env.ELECTRON_RUN_AS_NODE ? "host" : "main";
  const spawnLog = path.join(dir, `spawns-${role}-${process.pid}.jsonl`);
  const cpuLog = path.join(dir, "cpu.log");
  const root = path.resolve(__dirname, "../..");
  const caller = () =>
    String(new Error().stack)
      .split("\n")
      .slice(2)
      .map((line) => line.trim().replace(/^at /, ""))
      .filter((line) => !line.includes(__filename) && !line.includes("node:"))
      .slice(0, 14)
      .map((line) => line.replaceAll(root, "").replace(/^.*\/(packages|apps)\//, "$1/"));
  const write = (entry) => fs.appendFileSync(spawnLog, `${JSON.stringify(entry)}\n`);
  const isHost = (args) => args.some((arg) => arg.endsWith("cli.cjs")) && args.includes("serve");
  const original = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function spawn(options) {
    const file = options.file;
    const args = options.args.slice(1);
    const host = role === "main" && isHost(args);
    if (!host) {
      options.envPairs = options.envPairs?.filter((pair) => !pair.startsWith("NODE_OPTIONS="));
      options.args = [wrapper, cpuLog, file, ...args];
      options.file = wrapper;
    }
    const started = Date.now();
    const result = original.call(this, options);
    write({ role, parent: process.pid, pid: this.pid, file, args, started, wrapped: !host, caller: caller() });
    this.once("exit", () => write({ pid: this.pid, ended: Date.now() }));
    return result;
  };
}

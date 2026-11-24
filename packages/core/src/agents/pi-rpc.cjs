const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { spawnCommand } = require("./command.cjs");
const { killTree } = require("./process-tree.cjs");

// Client for Pi's RPC mode (`pi --mode rpc`): one JSON record per line on stdin and stdout. Commands carry an id
// and get one `response` back; everything else on stdout is a session event or an extension UI request. Records
// are split on LF only: readline would also split on U+2028 and U+2029, which are valid inside JSON strings.
class PiRpc extends EventEmitter {
  constructor({ command, args = [], cwd, env = process.env, spawnImpl = spawn, name = "Pi" } = {}) {
    super();
    Object.assign(this, { command, args, cwd, env, spawnImpl, name });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = null;
    this.exited = false;
  }

  start() {
    const child = spawnCommand(
      this.command,
      this.args,
      { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true },
      this.spawnImpl,
    );
    this.child = child;
    lines(child.stdout, (line) => this.handleLine(line));
    lines(child.stderr, (line) => {
      this.stderr = `${this.stderr}${line}\n`.slice(-8000);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.handleExit({ code: null, signal: null, error }));
    child.on("close", (code, signal) => this.handleExit({ code, signal }));
  }

  handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object") return;
    if (record.type === "response") {
      const waiter = this.pending.get(record.id);
      if (!waiter) return;
      this.pending.delete(record.id);
      clearTimeout(waiter.timer);
      if (record.success === false) waiter.reject(Object.assign(new Error(record.error || `${this.name} couldn't run ${waiter.type}.`), { rpcError: true }));
      else waiter.resolve(record.data ?? {});
      return;
    }
    if (record.type === "extension_ui_request") {
      this.emit("ui", record);
      return;
    }
    this.emit("event", record);
  }

  handleExit({ code, signal, error }) {
    if (this.exited) return;
    this.exited = true;
    const detail =
      error?.code === "ENOENT"
        ? `${path.basename(String(this.command))} isn't installed or isn't on your PATH.`
        : error?.message || this.stderr.trim() || `${this.name} exited with code ${code}${signal ? ` (${signal})` : ""}.`;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error(detail), { exited: true }));
    }
    this.pending.clear();
    this.emit("exit", { code, signal, detail, error });
  }

  write(record) {
    if (!this.child || this.exited) throw new Error(`${this.name} is not running.`);
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  request(type, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = `m${this.nextId++}`;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(Object.assign(new Error(`${this.name} did not answer ${type} within ${Math.round(timeoutMs / 1000)} s.`), { timedOut: true }));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        this.write({ ...params, id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respondUi(id, answer) {
    this.write({ type: "extension_ui_response", id, ...answer });
  }

  close({ descendants = false } = {}) {
    return killTree(this.child, { descendants });
  }
}

function lines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
    buffer = "";
  });
}

module.exports = { PiRpc };

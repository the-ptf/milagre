const { spawnCommand } = require("./command.cjs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { killTree } = require("./process-tree.cjs");

// Client for an Agent Client Protocol agent: JSON-RPC 2.0, one message per line over stdio, with
// Agents log to stderr, and some print plain lines on stdout too (Antigravity's sign-in URL). Lines that
// aren't JSON-RPC are passed to `onLine` and emitted as "line" so a sign-in flow can read them.
class AcpRpc extends EventEmitter {
  constructor({ command, args = [], cwd, env = process.env, spawnImpl = spawn, name = "The agent", onLine = null } = {}) {
    super();
    Object.assign(this, { command, args, cwd, env, spawnImpl, name, onLine });
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
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr = `${this.stderr}${line}\n`.slice(-8000);
      this.passLine("stderr", line);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.handleExit({ code: null, signal: null, error }));
    child.on("close", (code, signal) => this.handleExit({ code, signal }));
  }

  passLine(stream, line) {
    if (!line.trim()) return;
    try {
      this.onLine?.(line, stream);
    } catch {}
    this.emit("line", { stream, line });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.passLine("stdout", line);
      return;
    }
    if (!message || typeof message !== "object") {
      this.passLine("stdout", line);
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      this.emit("request", { id: message.id, method: message.method, params: message.params ?? {} });
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", { method: message.method, params: message.params ?? {} });
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error)
      waiter.reject(Object.assign(new Error(message.error.message || `${this.name} couldn't answer ${waiter.method}.`), { rpcError: message.error }));
    else waiter.resolve(message.result ?? {});
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

  write(message) {
    if (!this.child || this.exited) throw new Error(`${this.name} is not running.`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(Object.assign(new Error(`${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`), { timedOut: true }));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.write({ id, result: result ?? null });
  }

  respondError(id, message, code = -32601) {
    this.write({ id, error: { code, message } });
  }

  close({ descendants = false } = {}) {
    return killTree(this.child, { descendants });
  }
}

module.exports = { AcpRpc };

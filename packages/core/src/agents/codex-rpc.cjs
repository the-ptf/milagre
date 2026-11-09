const { spawnCommand } = require("./command.cjs");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { killTree } = require("./process-tree.cjs");

// Client for `codex app-server`: newline-delimited JSON over stdio, shaped like JSON-RPC
// without the "jsonrpc" field (verified against codex-cli 0.158.0):
//   request       { id, method, params }    sent by either side
//   response      { id, result } | { id, error: { code, message } }
//   notification  { method, params }
// Milagre uses initialize, initialized, thread/start, thread/resume, thread/unarchive,
// turn/start and turn/interrupt, plus the item/agentMessage/delta and turn/completed
// notifications. The protocol is marked experimental, so callers read fields defensively.
class CodexRpc extends EventEmitter {
  constructor({ command, args = ["app-server"], cwd, env = process.env, spawnImpl = spawn } = {}) {
    super();
    Object.assign(this, { command, args, cwd, env, spawnImpl });
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
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.handleExit({ code: null, signal: null, error }));
    child.on("close", (code, signal) => this.handleExit({ code, signal }));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit("request", { id: message.id, method: message.method, params: message.params ?? {} });
      return;
    }
    if (message.method) {
      this.emit("notification", { method: message.method, params: message.params ?? {} });
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message || `Codex ${waiter.method} failed.`), { rpcError: message.error }));
    else waiter.resolve(message.result ?? {});
  }

  handleExit({ code, signal, error }) {
    if (this.exited) return;
    this.exited = true;
    const detail =
      error?.code === "ENOENT"
        ? `${path.basename(String(this.command))} isn't installed or isn't on your PATH.`
        : error?.message || this.stderr.trim() || `Codex exited with code ${code}${signal ? ` (${signal})` : ""}.`;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(detail));
    }
    this.pending.clear();
    this.emit("exit", { code, signal, detail });
  }

  write(message) {
    if (!this.child || this.exited) throw new Error("Codex is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // A null timeoutMs waits for the answer however long it takes; the request still fails when Codex exits.
  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`));
            }, timeoutMs);
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
    this.write({ id, result });
  }

  respondError(id, message) {
    this.write({ id, error: { code: -32601, message } });
  }

  close() {
    return killTree(this.child);
  }
}

module.exports = { CodexRpc };

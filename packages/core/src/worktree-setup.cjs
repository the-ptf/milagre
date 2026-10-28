const { spawnCommand } = require("./agents/command.cjs");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { realpathSync } = require("node:fs");
const path = require("node:path");
const { killTree } = require("./agents/process-tree.cjs");
const { capOutput, code, formatDuration } = require("./agents/steps.cjs");

// A command a new worktree runs once, before its chat's first turn (`npm ci`, `uv sync`): the project's
// setting, or `setup` in .milagre/worktree.json at the repo root, which wins like .worktreeinclude does
// for the files to copy. The command runs in every new worktree, whichever of the two it comes from.

const SETUP_FILE = ".milagre/worktree.json";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const NOTE_LINES = 40;
const BATCH_MS = 50;
// Shells that take `-l -c`; any other $SHELL runs the command in zsh, the macOS default.
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh"]);
// Once the shell exits, output still in the pipes gets this long; a background process it left holding them doesn't hold the turn.
const DRAIN_MS = 500;

/**
 * The command new worktrees run: { source: "repo" | "setting" | "none", command, note? }. A repo file that
 * sets `setup` is in charge even when it sets it empty (the repo runs nothing). A file that isn't valid
 * JSON, or whose `setup` isn't a string, is ignored with a note, and the setting applies.
 */
async function resolveSetupCommand(projectPath, setting) {
  const fallback = (note) => {
    const command = typeof setting === "string" ? setting.trim() : "";
    return { source: command ? "setting" : "none", command: command || null, ...(note ? { note } : {}) };
  };
  let text;
  try {
    text = await fs.readFile(path.join(projectPath, SETUP_FILE), "utf8");
  } catch {
    return fallback();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback(`${SETUP_FILE} isn't valid JSON, so Milagre ignored it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.setup === undefined) return fallback();
  if (typeof parsed.setup !== "string") return fallback(`"setup" in ${SETUP_FILE} must be a string, so Milagre ignored it.`);
  return { source: "repo", command: parsed.setup.trim() || null };
}

function loginShell(env, platform = process.platform) {
  if (platform === "win32") return env.ComSpec || path.win32.join(env.SystemRoot || "C:\\Windows", "System32/cmd.exe");
  return env.SHELL && SHELLS.has(path.basename(env.SHELL)) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/**
 * Runs the command in `cwd` through the login shell, so npm, pnpm or uv resolve as in the user's terminal.
 * Resolves (never rejects) to { status: "done" | "failed" | "timed-out" | "cancelled", exitCode, signal,
 * error?, output, durationMs }. A timeout or an aborted `signal` stops the shell and everything it started.
 */
function runSetupCommand({
  command,
  cwd,
  env = process.env,
  shell = loginShell(env),
  timeoutMs = SETUP_TIMEOUT_MS,
  signal,
  onOutput = () => {},
  now = Date.now,
}) {
  const started = now();
  return new Promise((resolve) => {
    let output = "";
    let stopped = null;
    let killing = null;
    let settled = false;
    let child;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (killing) await killing;
      resolve({ exitCode: null, signal: null, ...result, ...(stopped ? { status: stopped } : {}), output, durationMs: now() - started });
    };
    const stop = (why) => {
      if (settled || stopped) return;
      stopped = why;
      killing = killTree(child);
    };
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed-out"), timeoutMs);
    try {
      child = spawnCommand(shell, process.platform === "win32" ? ["/d", "/s", "/c", `"${command}"`] : ["-l", "-c", command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsVerbatimArguments: process.platform === "win32",
      });
    } catch (error) {
      void finish({ status: "failed", error: error.message });
      return;
    }
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      output = capOutput(output + text);
      onOutput(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => void finish({ status: "failed", error: error.message }));
    child.on("exit", (exitCode, exitSignal) => {
      const result = { status: exitCode === 0 ? "done" : "failed", exitCode, signal: exitSignal };
      const drained = () => void finish(result);
      if (child.stdout.readableEnded && child.stderr.readableEnded) return drained();
      child.on("close", drained);
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        drained();
      }, DRAIN_MS).unref?.();
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// oxlint-disable-next-line no-control-regex -- matches ANSI escape sequences in setup output
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The last `lines` lines of command output, without colour codes or trailing blank lines. */
function outputTail(text, lines = NOTE_LINES) {
  const trimmed = String(text ?? "")
    .replace(ANSI, "")
    .replace(/\s+$/, "");
  return trimmed ? trimmed.split(/\r?\n/).slice(-lines).join("\n") : "";
}

function failureReason(result, timeoutMs) {
  if (result.status === "timed-out") return `timed out after ${formatDuration(timeoutMs)}`;
  if (result.error) return `couldn't start (${result.error})`;
  if (result.exitCode !== null && result.exitCode !== undefined) return `failed with exit code ${result.exitCode}`;
  return `was stopped by ${result.signal ?? "a signal"}`;
}

/** What the agent's first prompt gets after a setup that failed or timed out; nothing after one that worked or was stopped. */
function setupNote(command, result, timeoutMs = SETUP_TIMEOUT_MS) {
  if (result.status !== "failed" && result.status !== "timed-out") return "";
  const tail = outputTail(result.output);
  return `Note: the worktree setup command \`${command}\` ${failureReason(result, timeoutMs)}.${tail ? ` Last output:\n${tail}` : ""}`;
}

// The setup is its own kind of step: the chat shows it as a row of its own, not as one of the agent's tool calls.
function setupStarted(id, command) {
  return { type: "step-started", step: { id, kind: "setup", title: `Running setup ${code(command)}`, detail: `$ ${command}\n` } };
}

function setupCompleted(id, command, result, timeoutMs = SETUP_TIMEOUT_MS) {
  const took = formatDuration(result.durationMs);
  const failed = result.exitCode !== null && result.exitCode !== undefined ? `exited with code ${result.exitCode} after ${took}` : `failed after ${took}`;
  const note = { done: took, cancelled: `stopped after ${took}`, "timed-out": `timed out after ${formatDuration(timeoutMs)}` }[result.status] ?? failed;
  const why =
    result.status === "failed" ? `\n${result.error ?? (result.exitCode !== null ? `Exited with code ${result.exitCode}` : `Stopped by ${result.signal}`)}` : "";
  const ok = result.status === "done";
  return {
    type: "step-completed",
    id,
    status: ok ? "done" : "failed",
    title: `${ok ? "Ran setup" : "Setup failed"} ${code(command)}`,
    note,
    detail: capOutput(`$ ${command}\n${result.output}${why}`),
    durationMs: result.durationMs,
  };
}

// Worktrees are keyed by their real path: git lists them resolved (/private/tmp, not /tmp), so the folder
// createWorktree made and the chat's cwd only match once symlinks are followed.
function worktreeKey(worktreePath) {
  try {
    return realpathSync(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

/**
 * The setup commands waiting for their worktree's first turn, and the ones running. `send(chatId, event)`
 * shows a run as a shell step at the start of the chat's reply, its output streamed in batches.
 */
class WorktreeSetups {
  constructor({ send, run = runSetupCommand, timeoutMs = SETUP_TIMEOUT_MS, batchMs = BATCH_MS, file, review }) {
    Object.assign(this, { send, run, timeoutMs, batchMs, file, review });
    this.pending = new Map();
    this.running = new Map();
    this.worktreeRuns = new Map();
    this.saving = Promise.resolve();
  }

  load() {
    return (this.loading ??= fs
      .readFile(this.file, "utf8")
      .then((text) => {
        const entries = JSON.parse(text);
        if (
          !Array.isArray(entries) ||
          entries.some(([key, entry]) => typeof key !== "string" || !entry || typeof entry.projectPath !== "string" || typeof entry.command !== "string")
        )
          throw new Error("Worktree setup state is invalid. Restore the Computer's setup state before continuing.");
        this.pending = new Map(entries);
      })
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
      }));
  }

  save() {
    if (!this.file) return Promise.resolve();
    const text = JSON.stringify([...this.pending]);
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, text, { mode: 0o600 });
        await fs.rename(temporary, this.file);
      });
    return this.saving;
  }

  /** Records what a new worktree runs before its first turn. Resolves to { command, source }, or null when there is none. */
  async prepare({ worktreePath, projectPath, resolved, strict = false }) {
    if (this.file) await this.load();
    if (!resolved.command) return null;
    const key = worktreeKey(worktreePath);
    // A recovered Named Link never overwrites a setup that already started or failed.
    if (!this.pending.has(key)) this.pending.set(key, { projectPath, command: resolved.command, source: resolved.source, strict });
    await this.save();
    return { command: resolved.command, source: resolved.source };
  }

  async forget(worktreePath) {
    if (this.file) await this.load();
    this.pending.delete(worktreeKey(worktreePath));
    await this.save();
  }

  /**
   * Runs the worktree's setup before the chat's first turn and resolves to { cancelled, note }.
   * A message sent while it runs waits for the same run.
   */
  async beforeTurn(chatId, cwd) {
    if (this.file) await this.load();
    if (this.closed) return { cancelled: true, note: "" };
    const key = worktreeKey(cwd);
    const active = this.running.get(chatId);
    if (active) return { ...(await active.done), note: "" };
    const shared = this.worktreeRuns.get(key);
    if (shared) {
      // Another Chat owns the review. Stop must cancel this waiter without answering or cancelling that review.
      const controller = new AbortController();
      const cancelled = new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve({ cancelled: true, note: "" }), { once: true });
      });
      const done = Promise.race([shared.done, cancelled]).finally(() => this.running.delete(chatId));
      this.running.set(chatId, { controller, done });
      return done;
    }
    const entry = this.pending.get(key);
    if (!entry) return { cancelled: false, note: "" };
    const controller = new AbortController();
    const done = this.runPending(chatId, cwd, key, entry, controller).finally(() => {
      this.running.delete(chatId);
      this.worktreeRuns.delete(key);
    });
    const running = { controller, done };
    this.running.set(chatId, running);
    this.worktreeRuns.set(key, running);
    return done;
  }

  async runPending(chatId, cwd, key, entry, controller) {
    const reviewed = this.review ? await this.review({ chatId, cwd, entry, signal: controller.signal }) : entry;
    if (reviewed.cancelled || controller.signal.aborted) return { cancelled: true, note: "" };
    if (reviewed.skipped || !reviewed.command) {
      this.pending.delete(key);
      await this.save();
      return { cancelled: false, note: reviewed.command ? "The user skipped the Worktree setup command. Do not run it without asking." : "" };
    }
    entry = { ...entry, command: reviewed.command, source: reviewed.source, status: "started" };
    this.pending.set(key, entry);
    // A crash after this write requires a fresh review; it never silently repeats a partly run command.
    if (this.file) await this.save();
    if (controller.signal.aborted) return { cancelled: true, note: "" };
    const result = await this.start(chatId, cwd, entry.command, controller);
    const failed = entry.strict && result.status !== "done";
    if (failed) this.pending.set(key, { ...entry, status: "failed" });
    else this.pending.delete(key);
    await this.save();
    return { cancelled: result.status === "cancelled", note: setupNote(entry.command, result, this.timeoutMs), ...(failed ? { failed: true } : {}) };
  }

  start(chatId, cwd, command, controller) {
    const id = `setup-${randomUUID()}`;
    let buffered = "";
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (buffered) this.send(chatId, { type: "step-output", id, text: buffered });
      buffered = "";
    };
    this.send(chatId, setupStarted(id, command));
    const done = this.run({
      command,
      cwd,
      timeoutMs: this.timeoutMs,
      signal: controller.signal,
      onOutput: (text) => {
        buffered = capOutput(buffered + text);
        timer ??= setTimeout(flush, this.batchMs);
      },
    }).then((result) => {
      flush();
      this.send(chatId, setupCompleted(id, command, result, this.timeoutMs));
      return result;
    });
    return done;
  }

  /** Stops a chat's running setup (Escape, archive) and waits until it and what it started are gone. */
  async cancel(chatId) {
    const active = this.running.get(chatId);
    if (!active) return;
    active.controller.abort();
    await active.done.catch(() => {});
  }

  cancelAll() {
    this.closed = true;
    return Promise.all([...this.running.keys()].map((chatId) => this.cancel(chatId)));
  }
}

module.exports = {
  loginShell,
  SETUP_FILE,
  SETUP_TIMEOUT_MS,
  WorktreeSetups,
  outputTail,
  resolveSetupCommand,
  runSetupCommand,
  setupCompleted,
  setupNote,
  setupStarted,
};

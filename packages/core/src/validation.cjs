const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { VALIDATION_LIMITS, validationAgentNote, validationStatus, validationText } = require("@milagre/shared/validation");
const { runSetupCommand, outputTail } = require("./worktree-setup.cjs");
const { changedFiles, codeState, codeSummary, createValidationStore, updateChatNote } = require("./validation-state.cjs");

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG = 2 * 1024 * 1024;
const RECHECK_MS = 3000;
const HOST_STOPPED = "Milagre stopped while it ran";

function resultOf(command, outcome, timeoutMs) {
  const base = { ...command, durationMs: outcome.durationMs, exitCode: outcome.exitCode ?? null, signal: outcome.signal ?? null };
  const tail = outputTail(outcome.output, VALIDATION_LIMITS.tailLines).slice(-VALIDATION_LIMITS.tailChars);
  const withTail = tail ? { ...base, tail } : base;
  if (outcome.status === "done") return { ...withTail, status: "passed" };
  if (outcome.status === "timed-out") return { ...withTail, status: "interrupted", reason: `timed out after ${Math.round(timeoutMs / 60000)} min` };
  if (outcome.status === "cancelled") return { ...withTail, status: "interrupted", reason: "stopped" };
  return { ...withTail, status: "failed", ...(outcome.error ? { reason: `couldn't start: ${outcome.error}` } : {}) };
}

/** Streams a command's output to its log file, up to 2 MB. */
async function openLog(file) {
  const handle = await fs.open(file, "w", 0o600);
  let size = 0;
  let writes = Promise.resolve();
  return {
    write(text) {
      if (size >= MAX_LOG) return;
      const chunk = Buffer.from(text).subarray(0, MAX_LOG - size);
      size += chunk.length;
      const full = size >= MAX_LOG ? Buffer.concat([chunk, Buffer.from("\n… log truncated at 2 MB\n")]) : chunk;
      writes = writes.then(() => handle.write(full));
    },
    async close() {
      await writes.catch(() => {});
      await handle.close();
      return size;
    },
  };
}

const matches = (runId) => (message) => message.context?.kind === "validation" && message.context.runId === runId;

/**
 * Runs a Project's validation commands in a Chat's Worktree and records each result as a note in the Chat
 * (`context.kind: "validation"`). Results come only from the exit codes of commands Milagre ran. A run's code state stays
 * recorded until the Worktree changes, when its note is marked out of date.
 */
function createValidations({
  directory,
  settings,
  states,
  chats,
  git,
  tell = () => {},
  run = runSetupCommand,
  timeoutMs = COMMAND_TIMEOUT_MS,
  now = Date.now,
}) {
  const store = createValidationStore(directory);
  const active = new Map();
  const lastCheck = new Map();
  const updateNote = (chatId, match, change) => updateChatNote(chats, chatId, match, change);

  async function worktreeOf(chatId) {
    const scope = typeof chatId === "string" ? projectOfKey(chatId) : null;
    if (!scope || isLinkScopeKey(scope)) throw new Error("Validation runs in a Project Chat's Worktree; a Named Link's shared Chats don't have it yet.");
    const context = await states.executionContext(scope, sessionIdFromKey(chatId), { readOnly: true });
    if (!context.cwd) throw new Error("This Chat has no Worktree to validate.");
    return { projectPath: scope, cwd: context.cwd };
  }

  async function publish(chatId, context) {
    const body = validationText(context);
    if (!(await updateNote(chatId, matches(context.runId), () => ({ body, context })))) await chats.addNote(chatId, { body, context });
  }

  async function commandsFor(projectPath) {
    const { commands } = await settings().getValidation(projectPath);
    if (!commands.length) throw new Error("This Project has no validation commands. Add them in Settings › Project › Validation.");
    return commands;
  }

  /** Records a run that didn't start, such as an automatic run in Ask mode. */
  async function notRun(chatId, { trigger, reason }) {
    const { projectPath, cwd } = await worktreeOf(chatId);
    const commands = await commandsFor(projectPath);
    const results = commands.map((command) => ({ ...command, status: "not-run" }));
    const context = { kind: "validation", runId: randomUUID(), status: "not-run", trigger, startedAt: now(), worktreePath: cwd, reason, results };
    await publish(chatId, context);
    return context;
  }

  async function execute(chatId, cwd, context, commands, signal) {
    const results = commands.map((command) => ({ ...command, status: "queued" }));
    const update = () => publish(chatId, { ...context, results: results.map((result) => ({ ...result })) });
    await update();
    for (const [index, command] of commands.entries()) {
      if (signal.aborted) {
        results[index] = { ...command, status: "not-run" };
        continue;
      }
      results[index] = { ...command, status: "running" };
      await update();
      const log = await openLog(store.logFile(context.runId, index));
      const outcome = await run({ command: command.command, cwd: command.cwd ? path.join(cwd, command.cwd) : cwd, timeoutMs, signal, onOutput: log.write });
      results[index] = { ...resultOf(command, outcome, timeoutMs), hasLog: (await log.close()) > 0 };
      await update();
    }
    return results;
  }

  async function remember(chatId, runId, cwd, before) {
    const list = (await store.fresh()).filter((item) => !(item.chatId === chatId && item.worktree === cwd));
    await store.setFresh([...list, { chatId, runId, worktree: cwd, state: before }]);
  }

  async function perform(entry, { chatId, cwd, commands, trigger }) {
    const { runId, controller } = entry;
    const before = await codeState(git, cwd).catch(() => null);
    const context = {
      kind: "validation",
      runId,
      status: "running",
      trigger,
      startedAt: now(),
      worktreePath: cwd,
      ...(before ? { code: codeSummary(before) } : {}),
      results: [],
    };
    await store.writeRun(runId, { chatId, status: "running", startedAt: context.startedAt });
    const results = await execute(chatId, cwd, context, commands, controller.signal);
    const stopped = controller.signal.aborted;
    const final = {
      ...context,
      results,
      status: validationStatus(results, { interrupted: stopped }),
      endedAt: now(),
      ...(stopped ? { reason: entry.reason ?? "Stopped" } : {}),
    };
    const after = before ? await codeState(git, cwd).catch(() => null) : null;
    if (before && after && after.digest !== before.digest) final.stale = { at: now(), files: await changedFiles(git, cwd, before, after) };
    await publish(chatId, final);
    await store.writeRun(runId, { chatId, status: final.status, startedAt: final.startedAt, endedAt: final.endedAt });
    if (before && !final.stale) await remember(chatId, runId, cwd, before);
    if (trigger !== "agent") tell(chatId, validationAgentNote(final));
    return final;
  }

  /** Starts a run, or joins the one already running in that Worktree. `done` resolves with the final record. */
  async function start(chatId, { trigger }) {
    const { projectPath, cwd } = await worktreeOf(chatId);
    const existing = active.get(cwd);
    if (existing) return { runId: existing.runId, chatId: existing.chatId, done: existing.done };
    const commands = await commandsFor(projectPath);
    const entry = { runId: randomUUID(), chatId, controller: new AbortController() };
    active.set(cwd, entry);
    entry.done = perform(entry, { chatId, cwd, commands, trigger }).finally(() => {
      active.delete(cwd);
      void store.prune(new Set([...active.values()].map((item) => item.runId))).catch(() => {});
    });
    return { runId: entry.runId, chatId, done: entry.done };
  }

  async function stop(chatId, runId, reason = "Stopped") {
    const entry = [...active.values()].find((item) => item.runId === runId && item.chatId === chatId);
    if (!entry) return false;
    entry.reason = reason;
    entry.controller.abort();
    await entry.done.catch(() => {});
    return true;
  }

  async function cancelChat(chatId, reason = "The Chat was closed") {
    await Promise.all([...active.values()].filter((entry) => entry.chatId === chatId).map((entry) => stop(chatId, entry.runId, reason)));
    const list = await store.fresh();
    if (list.some((item) => item.chatId === chatId)) await store.setFresh(list.filter((item) => item.chatId !== chatId));
  }

  /** Marks this Worktree's recorded runs out of date when its code changed since they ran. */
  async function recheck(worktreePath, { force = false } = {}) {
    if (!worktreePath || active.has(worktreePath)) return 0;
    if (!force && now() - (lastCheck.get(worktreePath) ?? -Infinity) < RECHECK_MS) return 0;
    lastCheck.set(worktreePath, now());
    const watched = (await store.fresh()).filter((item) => item.worktree === worktreePath);
    if (!watched.length) return 0;
    const current = await codeState(git, worktreePath).catch(() => null);
    const changed = current ? watched.filter((item) => item.state.digest !== current.digest) : [];
    for (const item of changed) {
      const stale = { at: now(), files: await changedFiles(git, worktreePath, item.state, current) };
      await updateNote(item.chatId, matches(item.runId), (message) => ({ context: { ...message.context, stale } })).catch(() => false);
    }
    if (changed.length) await store.setFresh((await store.fresh()).filter((item) => !changed.includes(item)));
    return changed.length;
  }

  async function recheckChat(chatId, options) {
    const found = await worktreeOf(chatId).catch(() => null);
    return found ? recheck(found.cwd, options) : 0;
  }

  async function readLog(chatId, runId, index) {
    if (!store.validId(runId) || !Number.isSafeInteger(index) || index < 0) throw new Error("Choose a validation run.");
    const record = await store.readRun(runId);
    if (!record || record.chatId !== chatId) throw new Error("That validation log is gone.");
    return { text: await fs.readFile(store.logFile(runId, index), "utf8").catch(() => "") };
  }

  /** Runs a host left running when it stopped are recorded as interrupted, never passed. */
  async function recover() {
    for (const runId of await store.runIds()) {
      const record = await store.readRun(runId);
      if (record?.status !== "running") continue;
      await updateNote(record.chatId, matches(runId), (message) => {
        const results = (message.context.results ?? []).map((result) => {
          if (result.status === "running") return { ...result, status: "interrupted", reason: HOST_STOPPED };
          return result.status === "queued" ? { ...result, status: "not-run" } : result;
        });
        const context = { ...message.context, results, status: "interrupted", reason: HOST_STOPPED };
        return { body: validationText(context), context };
      }).catch(() => false);
      await store.writeRun(runId, { ...record, status: "interrupted" });
    }
  }

  async function latest(chatId) {
    const messages = await states.chatMessages(projectOfKey(chatId), [sessionIdFromKey(chatId)]);
    return (Array.isArray(messages) ? messages : []).findLast((message) => message.context?.kind === "validation")?.context ?? null;
  }

  return {
    start,
    notRun,
    stop,
    cancelChat,
    recheck,
    recheckChat,
    log: readLog,
    recover,
    latest,
    worktreeOf,
    stopAll: () => Promise.all([...active.values()].map((entry) => stop(entry.chatId, entry.runId, HOST_STOPPED))),
  };
}

module.exports = { createValidations, COMMAND_TIMEOUT_MS };

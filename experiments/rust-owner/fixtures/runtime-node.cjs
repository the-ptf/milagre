#!/usr/bin/env node
// The Node side of tests/runtime.rs: a trace of changes, time and reads run through the real ProjectStates
// (project-states.cjs with message-store.cjs lazy Chats, project-store.cjs saves) under mocked timers.
//
//   node runtime-node.cjs seed <traces.json> <name> <project-dir>   # write the trace's starting state (saveProjectState)
//   node runtime-node.cjs run <traces.json> <name> <project-dir>    # one JSON line per step: { op, result }
//
// The clock starts at the trace's `start` and moves only with `advance` steps, ticked 10 ms at a time with every
// pending save and queued change settled between ticks, so each timer runs at a 10 ms boundary of the start.

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolve.call(this, request, ...rest);
};
const source = (name) => path.join(repo, "packages/core/src", name);
const MODULES = ["project-states.cjs", "project-store.cjs", "message-store.cjs", "chat-db.cjs", "project-content.cjs", "chat-pages.cjs"].map(source);
const { snapshot, placeholders } = require("./writer-node.cjs");

/** The runtime's modules, fresh: a crash forgets every per-process cache. */
function modules() {
  for (const file of MODULES) delete require.cache[require.resolve(file)];
  return {
    ProjectStates: require(source("project-states.cjs")).ProjectStates,
    store: require(source("project-store.cjs")),
    messages: require(source("message-store.cjs")),
    pages: require(source("chat-pages.cjs")),
    content: require(source("project-content.cjs")),
  };
}

// apps/daemon/src/server.cjs messageChanges, verbatim (server.cjs starts a daemon when required). The check below
// fails if the daemon's copy changes.
function messageChanges(previousState, nextState, isFromDisk, unloadedChats) {
  const previous = previousState?.messages ?? [];
  const next = nextState?.messages ?? [];
  if (previous === next) return { changed: [], removed: [] };
  const before = new Set(previous);
  const changed = next.filter((message) => !before.has(message) && !isFromDisk(message));
  const ids = new Set(next.map((message) => message.id));
  const unloaded = unloadedChats(nextState);
  // A Chat removed while unloaded is removed: its messages are announced as before.
  const kept = (message) => unloaded.has(Number(message.session_id)) && Object.hasOwn(nextState?.sessions ?? {}, String(message.session_id));
  const removed = previous.filter((message) => !ids.has(message.id) && !kept(message)).map((message) => message.id);
  if (!changed.length) return { changed: [], removed };
  const chats = new Map();
  for (const message of next) {
    const list = chats.get(message.session_id);
    if (list) list.push(message);
    else chats.set(message.session_id, [message]);
  }
  return {
    changed: changed.map((message) => {
      const chat = chats.get(message.session_id);
      return { message, after: chat[chat.indexOf(message) - 1]?.id ?? null };
    }),
    removed,
  };
}
const daemon = fs.readFileSync(path.join(repo, "apps/daemon/src/server.cjs"), "utf8");
for (const line of [
  "const changed = next.filter((message) => !before.has(message) && !isFromDisk(message));",
  "return { message, after: chat[chat.indexOf(message) - 1]?.id ?? null };",
])
  if (!daemon.includes(line)) throw new Error(`server.cjs messageChanges changed: ${line}`);

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A state change of the trace (the same kinds tests/runtime.rs applies). */
function change(state, step) {
  const spec = step.change;
  switch (spec.kind) {
    case "none":
      return state;
    case "append":
      return { ...state, messages: [...state.messages, ...structuredClone(spec.messages)] };
    case "edit":
      return { ...state, messages: state.messages.map((message) => (message.id === spec.id ? { ...message, ...structuredClone(spec.patch) } : message)) };
    case "remove":
      return { ...state, messages: state.messages.filter((message) => !spec.ids.includes(message.id)) };
    case "session": {
      const sessions = { ...state.sessions };
      if (spec.value === null) delete sessions[spec.id];
      else sessions[spec.id] = structuredClone(spec.value);
      return { ...state, sessions };
    }
    case "field":
      return { ...state, [spec.key]: structuredClone(spec.value) };
    default:
      throw new Error(`unknown change ${spec.kind}`);
  }
}

async function run(tracesFile, name, dir) {
  const trace = JSON.parse(fs.readFileSync(tracesFile, "utf8")).find((item) => item.name === name);
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: trace.start });
  const clean = placeholders(dir);
  // Save errors name the folder: compare them with it replaced.
  const cleanValue = (value) => (value === null ? null : JSON.parse(clean(JSON.stringify(value))));
  console.warn = () => {};
  let events = [];
  const busy = new Set();
  let m;
  let states;
  const make = () => {
    m = modules();
    states = new m.ProjectStates({
      read: m.store.readProjectState,
      save: async (projectPath, state) => {
        try {
          const report = await m.store.saveProjectState(projectPath, state);
          events.push({ saved: report });
          return report;
        } catch (error) {
          events.push({ failed: clean(error.message) });
          throw error;
        }
      },
      compact: m.store.compactProjectDetails,
      persistenceChanged: (_key, state) => events.push({ persistence: cleanValue(state?.persistence ?? null) }),
      messages: {
        directory: (key) => key,
        now: () => Date.now(),
        active: (_key, chat) => busy.has(Number(chat)),
        unloaded: () => events.push({ unloaded: true }),
      },
    });
  };
  make();
  const settle = async () => {
    for (let round = 0; round < 1000; round++) {
      const pending = [...states.queues.values(), ...states.writes.values()];
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await new Promise((done) => setImmediate(done));
  };
  const view = (state) => ({
    ids: (state?.messages ?? []).map((message) => message.id),
    unloaded: [...m.messages.unloadedChats(state)].sort((a, b) => a - b),
    persistence: cleanValue(state?.persistence ?? null),
    hash: sha(clean(JSON.stringify(state))),
  });
  const attempt = async (work) => {
    try {
      return await work();
    } catch (error) {
      return { error: clean(error.message) };
    }
  };
  for (const step of trace.steps) {
    let result = null;
    switch (step.op) {
      case "open":
        result = view(await states.get(dir));
        break;
      case "load":
        result = view(await states.load(dir, step.chats));
        break;
      case "update": {
        const previous = states.states.get(dir);
        const options = { persist: step.persist ?? true, ...(step.chats ? { chats: step.chats } : {}) };
        const out = await attempt(() => states.update(dir, (state) => change(state, step), options));
        if (out.error) result = out;
        else {
          const patch = messageChanges(previous, out.state, m.messages.isFromDisk, m.messages.unloadedChats);
          result = {
            changed: out.changed,
            ...view(out.state),
            patch: {
              changed: patch.changed.map(({ message, after }) => ({ id: message.id, after, hash: sha(JSON.stringify(message)) })),
              removed: patch.removed,
            },
          };
        }
        break;
      }
      case "advance":
        for (let elapsed = 0; elapsed < step.ms; elapsed += 10) {
          mock.timers.tick(10);
          await settle();
        }
        result = { events, ...view(states.states.get(dir)) };
        events = [];
        break;
      case "flush":
        result = await attempt(async () => {
          await states.flush(dir);
          return null;
        });
        await settle();
        result = { result, events };
        events = [];
        break;
      case "retry":
        result = await attempt(async () => {
          await states.retry(dir);
          return null;
        });
        await settle();
        result = { result, events, ...view(states.states.get(dir)) };
        events = [];
        break;
      case "busy":
        if (step.value) busy.add(step.chat);
        else busy.delete(step.chat);
        break;
      case "block": {
        const file = path.join(dir, ".milagre", "coordination.json");
        fs.renameSync(file, `${file}.blocked`);
        fs.mkdirSync(file);
        break;
      }
      case "unblock": {
        const file = path.join(dir, ".milagre", "coordination.json");
        fs.rmdirSync(file);
        fs.renameSync(`${file}.blocked`, file);
        break;
      }
      case "crash":
        // The process dies: timers stop, nothing more is saved, every per-process cache is gone.
        for (const timer of states.timers.values()) clearTimeout(timer);
        clearInterval(states.sweep);
        states.closed = true;
        await settle();
        events = [];
        // A restarted runtime has no turn running.
        busy.clear();
        make();
        break;
      case "close":
        result = await attempt(async () => {
          await states.close();
          return null;
        });
        await settle();
        result = { result, events };
        events = [];
        make();
        break;
      case "chatMessages":
        result = await attempt(async () => m.pages.chatPage((await states.load(dir, [step.chat])).messages, step.chat, step.options ?? {}));
        break;
      case "chatMessage":
        result = await attempt(async () => {
          const message = await states.findMessage(dir, "id", step.id);
          if (!message) throw new Error("That message is no longer in this Project.");
          return m.content.withDetails(dir, message);
        });
        break;
      case "allMessages":
        result = await attempt(async () => {
          const read = { withState: step.withState === true };
          const out = step.marks ? await states.messageMarks(dir, read) : await states.allMessages(dir, read);
          return step.withState ? { state: sha(clean(JSON.stringify(out.state))), messages: out.messages } : out;
        });
        break;
      case "search":
        result = await attempt(async () => {
          const state = await states.get(dir);
          const open = Object.values(state.sessions ?? {})
            .filter((session) => !session.archived)
            .map((session) => session.id);
          return m.pages.chatSearch(state, step.query, { limit: step.limit ?? 200 }, await states.searchableMessages(dir, open));
        });
        break;
      case "subagent":
        result = await attempt(async () => {
          const agent = (await states.get(dir)).sessions?.[step.chat]?.subagents?.find((item) => item.id === step.agent);
          if (!agent) throw new Error("That subagent is no longer in this Chat.");
          return agent;
        });
        break;
      case "sendStatus":
        result = await attempt(async () => {
          const message = await states.findMessage(dir, "clientMessageId", step.id);
          if (message) return { sessionId: message.session_id };
          const state = await states.get(dir);
          const queued = Object.values(state.sessions).find((session) => session.queued?.some((entry) => entry.clientMessageId === step.id));
          return queued ? { sessionId: queued.id } : null;
        });
        break;
      case "inbox":
        result = await attempt(async () => sha(clean(JSON.stringify(await states.inboxState(dir)))));
        break;
      case "inboxValue":
        result = await attempt(async () => await states.inboxState(dir));
        break;
      case "whole":
        result = await attempt(async () => {
          const state = await states.get(dir);
          const whole = m.messages.wholeState(state);
          return { ids: whole.messages.map((message) => message.id), hash: sha(clean(JSON.stringify(whole))) };
        });
        break;
      case "snapshot":
        result = await snapshot(dir);
        break;
      default:
        throw new Error(`unknown step ${step.op}`);
    }
    process.stdout.write(`${JSON.stringify({ op: step.op, result: JSON.stringify(result) })}\n`);
  }
  await settle();
}

async function seed(tracesFile, name, dir) {
  const trace = JSON.parse(fs.readFileSync(tracesFile, "utf8")).find((item) => item.name === name);
  const { store } = modules();
  fs.mkdirSync(dir, { recursive: true });
  await store.saveProjectState(dir, trace.seed);
}

const [command, ...args] = process.argv.slice(2);
(command === "seed" ? seed : run)(...args).catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

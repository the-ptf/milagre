#!/usr/bin/env node
// The Node side of tests/chat.rs: a trace of sends, provider events, cancels and time run through the real ChatHost
// (agents/chat-host.cjs) over the real ProjectStates, with the provider mocked where SessionManager.startTurn sits.
//
//   node chat-node.cjs seed <traces.json> <name> <project-dir>
//   node chat-node.cjs run <traces.json> <name> <project-dir>     # one JSON line per step
//
// Queued-message ids come from a counter (crypto.randomUUID is patched while chat-host.cjs loads), the clock is
// node:test's mock, ticked 10 ms at a time. Packages this Worktree lacks (chat-host.cjs needs markdown-it) are read
// from the main checkout's node_modules, or MILAGRE_NODE_MODULES.

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../../..");
const installed =
  process.env.MILAGRE_NODE_MODULES ??
  path.resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim(), "..", "node_modules");
// oxlint-disable-next-line no-underscore-dangle -- the one hook that maps a workspace package without node_modules
const resolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  try {
    return resolve.call(this, request, parent, ...rest);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || request.startsWith(".") || path.isAbsolute(request)) throw error;
    return resolve.call(this, request, { ...parent, paths: [installed] }, ...rest);
  }
};
const source = (name) => path.join(repo, "packages/core/src", name);
const MODULES = ["project-states.cjs", "project-store.cjs", "message-store.cjs", "chat-db.cjs", "project-content.cjs"].map(source);
const { snapshot, placeholders } = require("./writer-node.cjs");
const { USER_DECISIONS } = require(source("agents/permissions.cjs"));
const { validAnswers } = require(source("agents/questions.cjs"));

const sha = (text) => createHash("sha256").update(text).digest("hex");
let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;

function modules() {
  for (const file of [...MODULES, source("agents/chat-host.cjs")]) delete require.cache[require.resolve(file)];
  const loaded = {
    ProjectStates: require(source("project-states.cjs")).ProjectStates,
    store: require(source("project-store.cjs")),
    messages: require(source("message-store.cjs")),
  };
  // Only chat-host.cjs takes the counter: it reads randomUUID once, as it loads.
  const crypto = require("node:crypto");
  const real = crypto.randomUUID;
  crypto.randomUUID = uuid;
  try {
    loaded.ChatHost = require(source("agents/chat-host.cjs")).ChatHost;
  } finally {
    crypto.randomUUID = real;
  }
  return loaded;
}

async function run(tracesFile, name, dir) {
  const trace = JSON.parse(fs.readFileSync(tracesFile, "utf8")).find((item) => item.name === name);
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: trace.start });
  let clean = placeholders(dir);
  const cleanValue = (value) => (value === null || value === undefined ? null : JSON.parse(clean(JSON.stringify(value))));
  console.warn = () => {};
  let notices = [];
  let turns = [];
  let interrupts = [];
  let failNextStart = null;
  // SessionManager's side of answers: the Chats with a session (a turn started this run), what was handed over.
  let answers = [];
  let refuseAnswers = false;
  const sessions = new Set();
  // A send into a running turn steers it: SessionManager resolves `{ steered: true }` for it.
  let steerNext = false;
  // Turn ids count successful starts over the whole trace, as the Rust mock provider does.
  let startedTurns = 0;
  // Handoffs: transcripts go where the Rust owner puts them (beside the Project, `.owner/handovers`), written at once
  // so the trace stays deterministic; the brief is handover.cjs's own generateBrief over a scripted model.
  const handover = require(source("agents/handover.cjs"));
  const handovers = path.join(path.dirname(dir), ".owner", "handovers");
  const handoversFolder = path.join(handovers, createHash("sha1").update(dir).digest("hex").slice(0, 12));
  const cleanText = clean;
  clean = (text) => cleanText(String(text).split(handoversFolder).join("<handovers>"));
  // What the brief's model does for the next handoff: { reply }, { fail: true }, { none: true } or { hang: true }.
  let briefMode = { none: true };
  let m;
  let states;
  let host;
  const chat = (session) => `${dir}#${session}`;
  const make = () => {
    m = modules();
    states = new m.ProjectStates({
      read: m.store.readProjectState,
      save: m.store.saveProjectState,
      compact: m.store.compactProjectDetails,
      messages: { directory: (key) => key, now: () => Date.now(), active: (_key, id) => Boolean(host?.isBusy(`${dir}#${id}`)) },
    });
    host = new m.ChatHost({
      states,
      startTurn: async (request) => {
        turns.push(cleanValue(request));
        sessions.add(request.chatId);
        if (failNextStart) {
          const message = failNextStart;
          failNextStart = null;
          throw new Error(message);
        }
        const steered = steerNext;
        steerNext = false;
        return { turnId: `turn-${++startedTurns}`, steered };
      },
      interrupt: async (id) => interrupts.push(clean(id)),
      publish: (_chatId, event, state, seq) => notices.push({ event: event.type, seq: seq ?? null, state: Boolean(state), payload: cleanValue(event) }),
      broadcast: () => notices.push({ broadcast: true }),
      nameChat: async (_path, sessionId) => notices.push({ nameChat: sessionId }),
      onQueuedStart: (_chatId, entry) => notices.push({ queueStartedWithoutSender: entry.id }),
      onQueuedRemoved: (_chatId, entry) => notices.push({ queueRemovedWithoutSender: entry.id }),
      handoverTools: {
        writeTranscript: async ({ projectPath, sessionId, markdown }) => {
          const file = handover.transcriptPath(handovers, projectPath, sessionId);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, markdown);
          return file;
        },
        brief: ({ cwd: _cwd, worktrees: _worktrees, projectPath: _projectPath, ...input }) => {
          const mode = briefMode;
          const models = mode.none
            ? {}
            : {
                [input.provider]: () => {
                  if (mode.fail) return Promise.reject(new Error("model failed"));
                  if (mode.hang) return new Promise(() => {});
                  return Promise.resolve(mode.reply);
                },
              };
          return handover.generateBrief({ ...input, changedFiles: async () => [] }, { models });
        },
      },
    });
  };
  make();
  // Waits until nothing the host started is still going: ChatHost moves its queue on in detached promises (afterTurn),
  // so the host counts as settled only after 20 rounds of the event loop with no change queued and no save in flight.
  const settle = async () => {
    let idle = 0;
    for (let round = 0; round < 5000 && idle < 20; round++) {
      const pending = [...states.queues.values(), ...states.writes.values()];
      if (pending.length) {
        idle = 0;
        await Promise.allSettled(pending);
      } else {
        idle++;
        await new Promise((done) => setImmediate(done));
      }
    }
  };
  const view = () => {
    const state = states.states.get(dir);
    return {
      ids: (state?.messages ?? []).map((message) => message.id),
      hash: sha(clean(JSON.stringify(state ?? null))),
      runs: cleanValue(host.runs),
    };
  };
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
        await states.get(dir);
        break;
      case "send":
        if (step.brief) briefMode = step.brief;
        result = await attempt(async () => {
          steerNext = step.request.sessionId != null && Boolean(host.runs[chat(step.request.sessionId)]);
          const sent = await host.send({ ...step.request, projectPath: dir });
          // A handoff whose brief waits on a deadline or a Stop: its start is told when it settles.
          if (step.brief?.hang) {
            void sent.started.then((value) => notices.push({ handoffStarted: cleanValue(value) }));
            return { sessionId: sent.sessionId, duplicate: false, queued: false, started: "preparing" };
          }
          // A queued or duplicate send calls no startTurn: the flag must not reach a later start.
          if (sent.queued || sent.duplicate) steerNext = false;
          if (sent.queued) void sent.started.then((value) => notices.push({ queuedStarted: cleanValue(value) }));
          const started = sent.duplicate ? null : sent.queued ? "waiting" : cleanValue(await sent.started);
          return { sessionId: sent.sessionId, duplicate: Boolean(sent.duplicate), queued: Boolean(sent.queued), started };
        });
        break;
      case "failNextStart":
        failNextStart = step.message;
        break;
      case "event":
        result = await attempt(async () => {
          await host.receive(chat(step.session), structuredClone(step.event));
          return null;
        });
        break;
      case "interrupt":
        // agent:interrupt: a handoff being prepared is cancelled (runtime.cjs, cancelHandoff); otherwise it reaches the
        // provider's session (SessionManager.interrupt) and its turn-cancelled follows.
        if (!(await host.cancelHandoff(chat(step.session)))) interrupts.push(clean(chat(step.session)));
        break;
      case "recover":
        result = await attempt(async () => {
          await host.recoverHandoffs(dir);
          return null;
        });
        break;
      case "queueSend":
        result = await attempt(async () => {
          const { interrupt } = await host.sendQueuedNow(chat(step.session), step.id);
          if (interrupt) interrupts.push(clean(chat(step.session)));
          return null;
        });
        break;
      case "queueRemove":
        result = await attempt(async () => host.removeQueued(chat(step.session), step.id));
        break;
      case "refuseAnswers":
        refuseAnswers = step.refuse;
        break;
      case "respondPermission":
        // runtime.cjs respondPermission -> SessionManager.respondToPermission.
        result = await attempt(async () => {
          if (!USER_DECISIONS.has(step.decision)) throw new Error(`Unknown permission decision: ${step.decision}`);
          const chatId = chat(step.session);
          if (!sessions.has(chatId)) return false;
          answers.push({ chat: clean(chatId), requestId: step.requestId, decision: step.decision });
          return !refuseAnswers;
        });
        break;
      case "answerQuestion":
        // runtime.cjs answerQuestion without images, secrets, bug reports or Subchat cards, over the real ChatHost.
        result = await attempt(async () => {
          const chatId = chat(step.session);
          const given = step.answers;
          const recorded =
            given && typeof step.summary === "string" && step.summary && states.states.has(dir)
              ? host.recordAnswers(chatId, step.summary, { requestId: step.requestId, answers: { ...given }, images: [] }).catch(() => null)
              : Promise.resolve(null);
          const handOver = async () => {
            const sent = given && { ...given };
            if (!validAnswers(sent)) throw new Error("Invalid answers to an agent question.");
            if (!sessions.has(chatId)) return false;
            answers.push({ chat: clean(chatId), requestId: step.requestId, answers: sent ?? null });
            return !refuseAnswers;
          };
          let accepted;
          try {
            accepted = await handOver();
          } catch (error) {
            const messageId = await recorded;
            if (messageId !== null) await host.takeBack(chatId, messageId);
            throw error;
          }
          const messageId = await recorded;
          if (!accepted && messageId !== null) await host.takeBack(chatId, messageId);
          return accepted;
        });
        break;
      case "sendStatus":
        result = await attempt(async () => host.sendStatus(dir, step.id));
        break;
      case "advance":
        for (let elapsed = 0; elapsed < step.ms; elapsed += 10) {
          mock.timers.tick(10);
          await settle();
        }
        break;
      case "flush":
        result = await attempt(async () => {
          await states.flush(dir);
          return null;
        });
        break;
      case "crash":
        sessions.clear();
        for (const timer of states.timers.values()) clearTimeout(timer);
        clearInterval(states.sweep);
        states.closed = true;
        await settle();
        make();
        break;
      case "snapshot":
        result = await snapshot(dir, [[handoversFolder, "<handovers>"]]);
        break;
      default:
        throw new Error(`unknown step ${step.op}`);
    }
    await settle();
    const line = { op: step.op, result, notices, turns, interrupts, answers, ...view() };
    notices = [];
    turns = [];
    interrupts = [];
    answers = [];
    process.stdout.write(`${JSON.stringify({ op: step.op, line: JSON.stringify(line) })}\n`);
  }
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

#!/usr/bin/env node
// Node oracle for the Rust owner's permission-mode seam. Real ChatHost, ProjectStates and SessionManager methods;
// only the session callback and the states' read/save I/O are scripted. No provider process or project is opened.
//
//   node experiments/rust-owner/fixtures/permission-mode-node.cjs
//
// Every await has a deterministic producer in this fixture. The delayed callback is released explicitly, never by
// sleeping or polling. Save callbacks keep data in memory and every ProjectStates instance is closed in finally.

const Module = require("node:module");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../../..");
const installed =
  process.env.MILAGRE_NODE_MODULES ??
  path.resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8", timeout: 5000 }).trim(), "..", "node_modules");
// Resolve workspace packages and read-only dependencies as the other owner Node oracles do.
// oxlint-disable-next-line no-underscore-dangle
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

const { ChatHost } = require(path.join(repo, "packages/core/src/agents/chat-host.cjs"));
const { SessionManager } = require(path.join(repo, "packages/core/src/agents/session-manager.cjs"));
const { ProjectStates } = require(path.join(repo, "packages/core/src/project-states.cjs"));

// A key only, never opened on disk: ProjectStates uses the in-memory callbacks below.
const project = "/permission-mode-oracle";
const chat = `${project}#1`;

function deferred() {
  let finish;
  const promise = new Promise((done) => {
    finish = done;
  });
  return { promise, resolve: finish };
}

async function harness(run, { hold = null, liveError = null } = {}) {
  const initial = {
    sessions: { 1: { id: 1, permissionMode: "ask", queued: [{ id: "queued-1", turn: { permissionMode: "auto" } }] } },
    messages: [],
  };
  let saved = structuredClone(initial);
  let broadcasts = 0;
  const calls = [];
  const states = new ProjectStates({
    read: async () => structuredClone(initial),
    save: async (_project, state) => {
      saved = structuredClone(state);
    },
  });
  const manager = new SessionManager({
    createSession: () => {
      throw new Error("The mode oracle must not create a provider session.");
    },
    send: () => {},
  });
  const liveSession = {
    permissions: { mode: "ask" },
    turnActive: true,
    async setPermissionMode(mode) {
      calls.push(mode);
      if (hold) await hold.promise;
      if (liveError) throw new Error(liveError);
      this.permissions.mode = mode;
    },
  };
  manager.sessions.set(chat, { session: liveSession });
  const host = new ChatHost({
    states,
    startTurn: () => {
      throw new Error("The mode oracle must not start a turn.");
    },
    publish: () => {},
    broadcast: () => {
      broadcasts++;
    },
  });
  host.turns.set(chat, { provider: "claude", permissionMode: "ask", prompt: "kept", effort: "high" });
  const live = manager.setPermissionMode.bind(manager);
  const snapshot = () => ({
    saved: saved.sessions[1]?.permissionMode ?? null,
    turn: host.turnSettings(chat)?.permissionMode ?? null,
    queued: saved.sessions[1]?.queued?.[0]?.turn.permissionMode ?? null,
    live: liveSession.permissions.mode,
    broadcasts,
  });
  const attempt = async (key, mode) => {
    try {
      await host.setPermissionMode(key, mode, live);
      return null;
    } catch (error) {
      return error.message;
    }
  };
  await states.get(project);
  try {
    return await run({ host, manager, states, liveSession, calls, snapshot, attempt, live });
  } finally {
    // No SessionManager timers or provider processes were started. Remove the structural test entry explicitly.
    manager.sessions.clear();
    await states.close();
  }
}

async function main() {
  const accepted = [];
  for (const mode of ["ask", "auto", "full"]) {
    accepted.push(
      await harness(async ({ attempt, states, snapshot }) => {
        const error = await attempt(chat, mode);
        if (error) throw new Error(error);
        await states.flush();
        return { mode, ...snapshot() };
      }),
    );
  }

  const hold = deferred();
  const delayed = await harness(
    async ({ attempt, states, snapshot }) => {
      let settled = false;
      const change = attempt(chat, "full").then((error) => {
        settled = true;
        return error;
      });
      const before = { ...snapshot(), settled };
      hold.resolve();
      const error = await change;
      if (error) throw new Error(error);
      await states.flush();
      return { before, after: { ...snapshot(), settled } };
    },
    { hold },
  );

  const liveFailure = await harness(
    async ({ attempt, states, snapshot }) => {
      const error = await attempt(chat, "full");
      await states.flush();
      return { error, ...snapshot() };
    },
    { liveError: "agent refused" },
  );

  const missing = await harness(async ({ attempt, states, calls }) => {
    const result = await attempt(`${project}#999`, "full");
    return { result, exists: Boolean((await states.get(project)).sessions[999]), liveCalls: calls.length };
  });

  const noLive = await harness(async ({ attempt, states, snapshot, manager, calls }) => {
    manager.sessions.delete(chat);
    const error = await attempt(chat, "full");
    await states.flush();
    return { error, ...snapshot(), liveCalls: calls.length };
  });

  const idle = await harness(async ({ attempt, states, snapshot, liveSession, calls }) => {
    liveSession.turnActive = false;
    const error = await attempt(chat, "full");
    await states.flush();
    return { error, ...snapshot(), liveCalls: calls.length };
  });

  const invalid = await harness(async ({ attempt, states, snapshot, calls }) => {
    const error = await attempt(chat, "yolo");
    await states.flush();
    return { error, ...snapshot(), liveCalls: calls.length };
  });

  async function noteFails(liveError) {
    return harness(
      async ({ attempt, states, snapshot }) => {
        const update = states.update;
        states.update = async () => {
          throw new Error("save failed");
        };
        let error;
        try {
          error = await attempt(chat, "full");
        } finally {
          states.update = update;
        }
        return { error, ...snapshot() };
      },
      { liveError },
    );
  }

  const noteFailure = await noteFails(null);
  const bothFail = await noteFails("agent refused");
  process.stdout.write(`${JSON.stringify({ accepted, delayed, liveFailure, missing, noLive, idle, invalid, noteFailure, bothFail })}\n`);
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});

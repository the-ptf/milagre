#!/usr/bin/env node
// Actual SessionManager retention decisions, with explicit synthetic native sessions and event snapshots.
// No provider, profile, credentials, host discovery, filesystem workspace, or native execution is used.
// NODE_PATH must explicitly name installed dependencies when this checkout has no node_modules.
//   NODE_PATH=<checkout>/node_modules node experiments/rust-runtime/fixtures/session-retention-node.cjs [--check]
// --check recomputes all decisions and source hashes, compares JSON, and writes nothing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle -- resolve this repository's workspace packages only
const originalResolve = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return originalResolve.call(this, request, ...rest);
};
const { SessionManager } = require(path.join(repo, "packages/core/src/agents/session-manager.cjs"));
const { subagentActive } = require(path.join(repo, "packages/shared/src/agent-runs.mjs"));
const { providerCapabilities } = require(path.join(repo, "packages/shared/src/provider-capabilities.mjs"));

const chat = "/fixture/retention#1";
const base = {
  chatId: chat,
  provider: "claude",
  cwd: "/fixture/worktree",
  workspaceRoots: ["/fixture/linked"],
  workspaceInstructions: "Fixture workspace instructions.",
  tldrEnabled: true,
  model: "fixture-model",
  permissionMode: "ask",
  prompt: "Synthetic turn",
};
const terminal = new Set(["turn-completed", "turn-failed", "turn-cancelled"]);
const event = (value, session) => ({ action: "event", event: value, ...(session ? { session } : {}) });
const child = (status, extra = {}) => event({ type: "subagent-update", agent: { id: "child", status, background: true, ...extra } });
const tasks = (ids) => event({ type: "background-tasks", tasks: ids.map((id) => ({ id, kind: "local_bash", title: `Synthetic ${id}`, startedAt: 1 })) });
const end = () => event({ type: "turn-completed" });
const start = (request = {}) => ({ action: "start", request });

async function run(spec) {
  const created = [];
  const forwarded = [];
  const closedChats = [];
  const manager = new SessionManager({
    createSession(provider, options) {
      const session = {
        id: created.length + 1,
        provider,
        options,
        nativeId: options.resumeId ?? `native-${created.length + 1}`,
        closed: false,
        turnActive: false,
        starts: 0,
        closes: 0,
        async startTurn() {
          if (this.closed) throw new Error("Synthetic session is closed.");
          const steered = this.turnActive;
          this.starts++;
          this.emit({ type: "turn-started", turnId: `s${this.id}-t${this.starts}` });
          return { turnId: `s${this.id}-t${this.starts}`, steered };
        },
        emit(value) {
          // These explicit native-double state changes precede the real manager's forward callback.
          if (value.type === "turn-started") this.turnActive = true;
          if (terminal.has(value.type)) this.turnActive = false;
          options.emit(structuredClone(value));
        },
        async close() {
          this.closes++;
          this.closed = true;
          this.turnActive = false;
        },
      };
      created.push(session);
      return session;
    },
    send: (_chat, value) => forwarded.push(structuredClone(value)),
    onSessionClosed: (closed) => closedChats.push(closed),
    // Real unref timers are never advanced: all decisions use explicit events and close calls, no sleeps.
    idleMs: 60 * 60 * 1000,
  });
  const snapshot = () => {
    const entry = manager.sessions.get(chat);
    const current = entry?.session;
    return {
      session: current?.id ?? null,
      created: created.length,
      closed: created.filter((session) => session.closed).map((session) => session.id),
      provider: entry?.provider ?? null,
      tldrEnabled: entry?.tldrEnabled ?? null,
      resumeId: current?.options.resumeId ?? null,
      starts: created.map((session) => session.starts),
      activeChildren: [...(entry?.activeChildren ?? [])].sort(),
      backgroundChildren: [...(entry?.backgroundChildren ?? [])].sort(),
      backgroundTasks: [...(entry?.backgroundTasks ?? [])].sort(),
      backgroundWork: manager.backgroundWork(chat),
      forwarded: forwarded.length,
      closeNotifications: closedChats.length,
    };
  };
  const steps = [];
  let record;
  try {
    for (const step of spec.steps) {
      let result = null;
      try {
        if (step.action === "start") result = await manager.startTurn({ ...base, ...spec.initial, ...step.request });
        else if (step.action === "event") {
          const session = step.session ? created[step.session - 1] : manager.sessions.get(chat)?.session;
          if (!session) throw new Error("No synthetic session for this event.");
          session.emit(step.event);
        } else if (step.action === "close") await manager.closeChat(chat);
        else throw new Error(`Unknown oracle action: ${step.action}`);
      } catch (error) {
        result = { error: error.message };
      }
      steps.push({ ...step, result, snapshot: snapshot() });
    }
    record = {
      name: spec.name,
      ...(spec.boundaryNote ? { boundaryNote: spec.boundaryNote } : {}),
      initial: { ...base, ...spec.initial },
      steps,
      creations: created.map((session) => ({
        id: session.id,
        provider: session.provider,
        cwd: session.options.cwd,
        workspaceRoots: session.options.workspaceRoots,
        workspaceInstructions: session.options.workspaceInstructions,
        tldrEnabled: session.options.tldrEnabled,
        resumeId: session.options.resumeId ?? null,
      })),
      forwarded,
    };
  } finally {
    await manager.closeAll();
  }
  if (manager.sessions.size || manager.buffers.size) throw new Error("Synthetic sessions or buffers survived oracle cleanup.");
  return record;
}

const cases = [
  {
    name: "background-retention",
    steps: [
      start(),
      child("running"),
      tasks(["task"]),
      end(),
      start({ tldrEnabled: false }),
      child("completed"),
      end(),
      start({ tldrEnabled: false }),
      tasks([]),
      child("waiting"),
      end(),
      start({ tldrEnabled: false }),
      child("completed"),
      end(),
      start({ tldrEnabled: false }),
      child("initializing"),
      tasks(["new-task"]),
      end(),
      { action: "close" },
    ],
  },
  {
    name: "foreground-retains-tldr-on",
    initial: { tldrEnabled: false },
    steps: [
      start(),
      child("running", { background: false }),
      end(),
      start({ tldrEnabled: true }),
      child("completed", { background: false }),
      end(),
      start({ tldrEnabled: true }),
    ],
  },
  {
    name: "background-retention-tldr-on",
    initial: { tldrEnabled: false },
    steps: [
      start(),
      child("running"),
      tasks(["task"]),
      end(),
      start({ tldrEnabled: true }),
      child("completed"),
      end(),
      start({ tldrEnabled: true }),
      tasks([]),
      end(),
      start({ tldrEnabled: true, resumeId: "stale-request-native" }),
    ],
  },
  { name: "running-turn-retains-tldr", steps: [start(), start({ tldrEnabled: false }), end(), start({ tldrEnabled: false })] },
  {
    name: "duplicates-and-snapshot-replacement",
    steps: [
      start(),
      child("initializing"),
      child("initializing"),
      child("waiting"),
      child("running", { id: "nested", parentId: "child", background: false }),
      tasks(["a", "a", "b"]),
      tasks(["b", "c"]),
      end(),
      end(),
      child("completed"),
      child("completed"),
      child("failed", { id: "nested", parentId: "child", background: false }),
      tasks([]),
      tasks([]),
      start({ tldrEnabled: false }),
    ],
  },
  {
    name: "partial-child-snapshot-boundary",
    boundaryNote:
      "SessionManager.forward consumes supplied snapshots, not patches. A terminal event omitting background does not clear backgroundChildren. Native child mappers normally emit merged snapshots; this case makes no native-mapper claim.",
    steps: [
      start(),
      child("running"),
      end(),
      event({ type: "subagent-update", agent: { id: "child", status: "completed" } }),
      start({ provider: "codex" }),
      child("completed"),
      start({ provider: "codex", resumeId: "request-native" }),
    ],
  },
  {
    name: "stale-entry-events-ignored",
    steps: [
      start(),
      end(),
      start({ tldrEnabled: false }),
      event({ type: "subagent-update", agent: { id: "old-child", status: "running", background: true } }, 1),
      event({ type: "background-tasks", tasks: [{ id: "old-task" }] }, 1),
      event({ type: "turn-completed" }, 1),
      end(),
      { action: "close" },
      { action: "close" },
      event({ type: "subagent-update", agent: { id: "closed-child", status: "waiting", background: true } }, 2),
    ],
  },
  {
    name: "provider-without-background-capability",
    initial: { provider: "codex" },
    steps: [
      start(),
      child("running"),
      tasks(["ignored-task"]),
      end(),
      start({ tldrEnabled: false }),
      end(),
      start({ provider: "claude", resumeId: "request-native" }),
    ],
  },
  ...[true, false].flatMap((background) =>
    [
      { name: `${background ? "background" : "foreground"}-provider-switch`, request: { provider: "codex", resumeId: "request-native" } },
      { name: `${background ? "background" : "foreground"}-folder-switch`, request: { cwd: "/fixture/other", resumeId: "request-native" } },
      {
        name: `${background ? "background" : "foreground"}-workspace-switch`,
        request: { workspaceRoots: ["/fixture/new-link"], workspaceInstructions: "Changed fixture instructions.", resumeId: "request-native" },
      },
    ].map(({ name, request }) => ({
      name,
      steps: [start(), child("running", { background }), end(), start(request), ...(background ? [child("completed"), end(), start(request)] : [])],
    })),
  ),
  {
    name: "workspace-root-order-is-not-a-switch",
    initial: { workspaceRoots: ["/fixture/z", "/fixture/a"] },
    steps: [start(), end(), start({ workspaceRoots: ["/fixture/a", "/fixture/z", "/fixture/a"] })],
  },
];

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Only --check is accepted.");
  const files = [
    "packages/core/src/agents/session-manager.cjs",
    "packages/core/src/agents/subagents.cjs",
    "packages/core/src/agents/events.cjs",
    "packages/core/src/agents/permissions.cjs",
    "packages/shared/src/agent-runs.mjs",
    "packages/shared/src/provider-capabilities.mjs",
    "packages/shared/src/chat-activity.mjs",
    "packages/shared/src/providers.mjs",
    "experiments/rust-runtime/fixtures/session-retention-node.cjs",
  ];
  const output = {
    schema: 1,
    generatedBy: "fixtures/session-retention-node.cjs",
    scope: "Actual Node SessionManager with explicit synthetic native-session double; no native execution or provider-lifecycle equivalence claim.",
    sources: Object.fromEntries(
      files.map((file) => [
        file,
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(repo, file)))
          .digest("hex"),
      ]),
    ),
    predicate: [null, "initializing", "running", "waiting", "completed", "failed", "cancelled", "unknown", "stopped"].map((status) => ({
      status,
      active: subagentActive(status === null ? undefined : { status }),
    })),
    capabilities: Object.fromEntries(
      ["claude", "codex", "kiro", "antigravity", "unknown"].map((provider) => [
        provider,
        { backgroundSubagents: providerCapabilities(provider).backgroundSubagents },
      ]),
    ),
    cases: [],
  };
  for (const spec of cases) output.cases.push(await run(spec));
  const file = path.join(__dirname, "session-retention-node.json");
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(output))
      throw new Error("Session retention oracle drifted from fresh Node output or source hashes.");
    console.log(`matched ${output.cases.length} SessionManager retention cases; check wrote nothing`);
  } else {
    fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`wrote ${output.cases.length} SessionManager retention cases`);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, CoordinatorState } from "@milagre/shared/model";
import type { WorktreeStatus } from "@milagre/shared/archive";
import { archiveActivity, archiveFromPhone as archiveNow, checkArchive, type ArchiveClient, type ArchiveRequest } from "./archive.ts";
import { archiveChoices, undoDelete } from "@milagre/shared/archive";

const clean: WorktreeStatus = { uncommitted: 0, unpushed: 0, branch: "milagre/x-1", head: "abc", removable: true };
const dirty: WorktreeStatus = { uncommitted: 2, unpushed: 1, branch: "milagre/x-1", head: "abc", removable: false };
const session = (id: number, worktree_id: number, extra: Partial<AgentSession> = {}) =>
  ({ id, worktree_id, agent_name: "x", status: "Created", ...extra }) as AgentSession;
const state = (): CoordinatorState =>
  ({
    next_id: 10,
    projects: {},
    worktrees: {
      1: { id: 1, project_id: 1, path: "/work/shop", name: "main" },
      2: { id: 2, project_id: 1, path: "/wt/shop/x-1", name: "milagre/x-1", base: "main" },
    },
    sessions: { 1: session(1, 1), 2: session(2, 2) },
    connections: {},
    events: [],
    messages: [],
    approvals: [],
    tasks: {},
    artifacts: {},
    outputs: [],
    conflicts: [],
  }) as unknown as CoordinatorState;

// The deletions here don't wait out a toast's Undo; the tests that undo pass their own window.
const archiveFromPhone = (request: ArchiveRequest) => archiveNow({ undoMs: 0, ...request });

const refusedByOldDaemon = () => Promise.reject(new Error("Command is not available from mobile"));

function fakeClient(answers: Record<string, (args: unknown[]) => unknown> = {}, current = state(), runs: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client: ArchiveClient = {
    async call<T>(method: string, args: unknown[] = []) {
      calls.push({ method, args });
      const answer = answers[method];
      if (answer) return (await answer(args)) as T;
      if (method === "worktree:roots") return ["/wt"] as T;
      if (method === "worktree:status") return clean as T;
      return null as T;
    },
    async snapshot() {
      calls.push({ method: "snapshot", args: [] });
      if (answers.snapshot) return (await answers.snapshot([])) as Awaited<ReturnType<ArchiveClient["snapshot"]>>;
      return { project: { state: current }, runs: { runs } };
    },
  };
  return { client, calls };
}

test("checkArchive works out the plan as desktop does", async () => {
  assert.deepEqual(await checkArchive(fakeClient().client, state(), 2), { milagreOwned: true, shared: false, status: clean });
  // The project's own checkout is not Milagre's, so nothing about it is checked.
  const main = fakeClient();
  assert.deepEqual(await checkArchive(main.client, state(), 1), { milagreOwned: false, shared: false, status: null });
  assert.equal(
    main.calls.some((call) => call.method === "worktree:status"),
    false,
  );
  const shared = state();
  shared.sessions[3] = session(3, 2);
  assert.deepEqual(await checkArchive(fakeClient().client, shared, 2), { milagreOwned: true, shared: true, status: null });
  // A check that fails only hides.
  assert.deepEqual(await checkArchive(fakeClient({ "worktree:status": () => Promise.reject(new Error("git hung")) }).client, state(), 2), {
    milagreOwned: false,
    shared: false,
    status: null,
  });
});

test("an older daemon that refuses the check falls back to conversation deletion without removing files", async () => {
  const { client, calls } = fakeClient({ "worktree:roots": refusedByOldDaemon, "worktree:status": refusedByOldDaemon });
  assert.equal(await checkArchive(client, state(), 2), null);
  calls.length = 0;
  const notices: string[] = [];
  const result = await archiveFromPhone({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: (message) => {
      notices.push(message);
    },
    refresh: async () => {},
  });
  assert.equal(result, "hidden");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["worktree:roots", "snapshot", "chat:patch", "chat:delete"],
  );
  assert.ok(calls[2] !== undefined);
  assert.deepEqual(calls[2].args, ["/work/shop", 2, { archived: true, unread: false }]);
  assert.deepEqual(notices, []);
});

test("a running Chat is stopped, hidden, its worktree removed, then the Project is read again", async () => {
  const order: string[] = [];
  const { client, calls } = fakeClient(
    {
      "agent:interrupt": () => {
        order.push("stop");
      },
      "chat:patch": (args) => {
        order.push(`patch ${JSON.stringify((args as unknown[])[2])}`);
      },
      "worktree:remove": () => {
        order.push("remove");
        return { removed: true };
      },
    },
    state(),
    { "/work/shop#2": {} },
  );
  let confirmed = false;
  const result = await archiveFromPhone({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: true,
    onConfirm: () => {
      confirmed = true;
    },
    notify: () => {},
    refresh: async () => {
      order.push("refresh");
    },
  });
  assert.equal(result, "removed");
  assert.equal(confirmed, true);
  assert.deepEqual(order, ["stop", 'patch {"archived":true,"unread":false}', "remove", "refresh"]);
  const removal = calls.find((call) => call.method === "worktree:remove")!;
  assert.deepEqual(removal.args, ["/wt/shop/x-1", { force: false, base: "main", projectPath: "/work/shop", chatId: "/work/shop#2", seen: clean }]);
  assert.deepEqual(calls.find((call) => call.method === "agent:interrupt")!.args, ["/work/shop#2"]);
});

test("a refused removal brings the Chat back with the desktop notice", async () => {
  const { client, calls } = fakeClient({
    "worktree:status": () => clean,
    "worktree:remove": () => Promise.reject(new Error("WORKTREE_CHANGED: /wt/shop/x-1 changed after it was checked.")),
  });
  const notices: string[] = [];
  const result = await archiveFromPhone({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: (message) => {
      notices.push(message);
    },
    refresh: async () => {},
  });
  assert.equal(result, "kept");
  assert.deepEqual(notices, ["It changed after you checked, so the chat and its worktree stay."]);
  assert.deepEqual(
    calls.filter((call) => call.method === "chat:patch").map((call) => call.args[2]),
    [{ archived: true, unread: false }, { archived: false }],
  );
  assert.equal((calls.find((call) => call.method === "worktree:remove")!.args[1] as { force: boolean }).force, false);
  assert.equal(
    calls.some((call) => call.method === "agent:interrupt"),
    false,
    "an idle Chat has no turn to stop",
  );
});

test("a worktree another Chat took up after the check is only hidden from", async () => {
  const now = state();
  now.sessions[3] = session(3, 2);
  const { client, calls } = fakeClient({}, now);
  const result = await archiveFromPhone({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: () => {},
    refresh: async () => {},
  });
  assert.equal(result, "hidden");
  assert.equal(
    calls.some((call) => call.method === "worktree:remove"),
    false,
  );
});

test("Chats delete immediately while preserving unsaved files in Project and project-less Chats", async () => {
  for (const chatsHome of [false, true]) {
    for (const status of [clean, dirty]) {
      const { client, calls } = fakeClient({ "worktree:status": () => status });
      const result = await archiveFromPhone({
        client,
        projectPath: "/work/shop",
        state: state(),
        chat: session(2, 2),
        running: false,
        chatsHome,
        notify: () => {},
        refresh: async () => {},
      });
      assert.equal(result, status.removable ? "removed" : "hidden");
      assert.deepEqual(calls.find((call) => call.method === "chat:patch")?.args[2], { archived: true, unread: false });
      const removal = calls.find((call) => call.method === "worktree:remove");
      if (status.removable) {
        assert.ok(removal);
        assert.equal((removal.args[1] as { force: boolean }).force, false);
      } else {
        assert.equal(removal, undefined, "Unsaved files and unpushed commits stay on disk");
        assert.deepEqual(calls.find((call) => call.method === "chat:delete")?.args, ["/work/shop", 2]);
      }
    }
  }
});

test("an Undo on the toast calls the deletion off and brings the Chat back", async () => {
  const { client, calls } = fakeClient({ "worktree:status": () => clean });
  const work = archiveNow({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: () => {},
    refresh: async () => {},
    undoMs: 10_000,
  });
  // The row leaves the list and the toast offers the Undo at once.
  assert.ok(archiveActivity().hidden.has("/work/shop#2"));
  assert.equal(archiveActivity().deleted, "/work/shop#2");
  assert.equal(undoDelete("/work/shop#2"), true);
  assert.equal(await work, "undone");
  assert.equal(
    calls.some((call) => call.method === "worktree:remove" || call.method === "chat:delete" || call.method === "chat:patch"),
    false,
    "nothing was hidden or removed",
  );
  assert.equal(archiveActivity().deleted, "");
  assert.equal(archiveActivity().hidden.size, 0);
});

test("an Undo after the hide brings the Chat back without removing its worktree", async () => {
  let release = () => {};
  const hidden = new Promise<void>((resolve) => (release = resolve));
  const { client, calls } = fakeClient({
    "worktree:status": () => clean,
    "chat:patch": () => {
      release();
      return undefined;
    },
  });
  const work = archiveNow({
    client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: () => {},
    refresh: async () => {},
    undoMs: 10_000,
  });
  await hidden;
  undoDelete("/work/shop#2");
  assert.equal(await work, "undone");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat:patch").map((call) => call.args[2]),
    [{ archived: true, unread: false }, { archived: false }],
  );
  assert.equal(
    calls.some((call) => call.method === "worktree:remove"),
    false,
  );
});

test("whether to stop is read when the archive runs, not when Archive was tapped", async () => {
  // Idle when tapped, running by the time it is confirmed: the turn is stopped.
  const started = fakeClient({}, state(), { "/work/shop#2": {} });
  await archiveFromPhone({
    client: started.client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: () => {},
    refresh: async () => {},
  });
  assert.equal(
    started.calls.some((call) => call.method === "agent:interrupt"),
    true,
  );
  // Running when tapped, finished since: nothing to stop.
  const finished = fakeClient();
  await archiveFromPhone({
    client: finished.client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: true,
    notify: () => {},
    refresh: async () => {},
  });
  assert.equal(
    finished.calls.some((call) => call.method === "agent:interrupt"),
    false,
  );
});

test("a second tap during deletion does not repeat the operation", async () => {
  let finish!: () => void;
  const { client, calls } = fakeClient({
    "worktree:remove": () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const request = { client, projectPath: "/work/shop", state: state(), chat: session(2, 2), running: false, notify: () => {}, refresh: async () => {} };
  const first = archiveFromPhone(request);
  // Past the (empty) Undo window, a timer away, to the removal.
  while (!calls.some((call) => call.method === "worktree:remove")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await archiveFromPhone(request), "busy");
  finish();
  assert.equal(await first, "removed");
  assert.equal(calls.filter((call) => call.method === "worktree:remove").length, 1);
});

test("a dropped connection during the removal: a worktree that is gone counts as removed, one still there stays", async () => {
  const lost = () => Promise.reject(new Error("Connection lost. Reconnect to your computer. Check the Chat before sending again."));
  // The Mac finished removing it: no restore, no notice.
  const gone = state();
  delete (gone.worktrees as Record<string, unknown>)[2];
  let removing = false;
  const finished = fakeClient({
    "worktree:remove": () => {
      removing = true;
      return lost();
    },
    snapshot: () => ({ project: { state: removing ? gone : state() }, runs: { runs: {} } }),
  });
  const notices: string[] = [];
  const result = await archiveFromPhone({
    client: finished.client,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: false,
    notify: (message) => {
      notices.push(message);
    },
    refresh: async () => {},
  });
  assert.equal(result, "removed");
  assert.deepEqual(notices, []);
  assert.deepEqual(
    finished.calls.filter((call) => call.method === "chat:patch").map((call) => call.args[2]),
    [{ archived: true, unread: false }],
  );
  // Still there: the Chat comes back, and the notice says why.
  const kept = fakeClient({ "worktree:remove": lost });
  const keptNotices: string[] = [];
  assert.equal(
    await archiveFromPhone({
      client: kept.client,
      projectPath: "/work/shop",
      state: state(),
      chat: session(2, 2),
      running: false,
      notify: (message) => {
        keptNotices.push(message);
      },
      refresh: async () => {},
    }),
    "kept",
  );
  assert.deepEqual(keptNotices, [
    "Couldn't remove the worktree: Connection lost. Reconnect to your computer. Check the Chat before sending again. The chat stays so you can find it.",
  ]);
  assert.deepEqual(
    kept.calls.filter((call) => call.method === "chat:patch").map((call) => call.args[2]),
    [{ archived: true, unread: false }, { archived: false }],
  );
});

test("checkArchive names what the Chat's Terminals run, and leaves idle ones out", async () => {
  const terminals = {
    "terminal:list": () =>
      Promise.resolve({
        terminals: [
          { id: "a", title: "npm", busy: true },
          { id: "b", title: "zsh", busy: false },
        ],
      }),
  };
  const plan = await checkArchive(fakeClient(terminals).client, state(), 2, "/repo#2");
  assert.deepEqual(plan, { milagreOwned: true, shared: false, status: clean, terminals: ["npm"] });
  // A Mac without Terminals answers with an error: the plan stays as it was.
  const old = { "terminal:list": () => Promise.reject(new Error("terminal:list is not available from mobile")) };
  assert.deepEqual(await checkArchive(fakeClient(old).client, state(), 2, "/repo#2"), { milagreOwned: true, shared: false, status: clean });
});

for (const method of ["worktree:roots", "worktree:status", "terminal:list"]) {
  test(`a stalled ${method} check falls back to archiving without removing the Worktree`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client } = fakeClient({ [method]: () => new Promise(() => {}) });
    const checking = checkArchive(client, state(), 2, "/work/shop#2");
    t.mock.timers.tick(5_000);
    const plan = await checking;
    assert.deepEqual(
      archiveChoices({ plan: plan!, running: false }).choices.map((choice) => choice.mode),
      ["hide"],
    );
  });
}

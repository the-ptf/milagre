import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, CoordinatorState } from "@milagre/shared/model";
import type { ArchivePlan, WorktreeStatus } from "@milagre/shared/archive";
import { archiveDialog, archiveFromPhone, checkArchive, confirmArchive, type AlertButton, type ArchiveClient, type ShowAlert } from "./archive.ts";

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

// An alert that presses the button whose text matches `press` (or reports what it was shown).
function fakeAlert(press: string | null) {
  const shown: { title: string; message?: string; buttons: AlertButton[] }[] = [];
  const alert: ShowAlert = (title, message, buttons, options) => {
    shown.push({ title, message, buttons });
    if (press === null) options?.onDismiss?.();
    else buttons.find((button) => button.text === press)?.onPress?.();
  };
  return { alert, shown };
}

test("the dialog shows the desktop choice for each plan, with Cancel, the danger one destructive", () => {
  const plan = (patch: Partial<ArchivePlan>): ArchivePlan => ({ milagreOwned: true, shared: false, status: clean, ...patch });
  assert.deepEqual(archiveDialog(plan({}), false), {
    title: "Archive this Chat?",
    choices: [{ mode: "remove", text: "Archive and remove worktree", style: "default" }],
  });
  assert.deepEqual(archiveDialog(plan({ status: dirty }), false), {
    title: "Archive this Chat?",
    message: "2 uncommitted files and 1 unpushed commit will be lost. Commit and push them first to keep them.",
    choices: [{ mode: "delete", text: "Archive and delete worktree", style: "destructive" }],
  });
  for (const patch of [{ milagreOwned: false, status: null }, { shared: true, status: null }, { status: null }]) {
    assert.deepEqual(archiveDialog(plan(patch), false).choices, [{ mode: "hide", text: "Confirm archive", style: "destructive" }]);
  }
  // A running Chat is stopped first, and the choices say so.
  assert.deepEqual(
    archiveDialog(plan({}), true).choices.map((choice) => choice.text),
    ["Stop, archive and remove worktree"],
  );
  assert.deepEqual(
    archiveDialog(plan({ status: dirty }), true).choices.map((choice) => choice.text),
    ["Stop, archive and delete worktree"],
  );
  assert.deepEqual(
    archiveDialog(plan({ shared: true, status: null }), true).choices.map((choice) => choice.text),
    ["Stop and archive"],
  );
  // An older Mac: today's plain archive.
  assert.deepEqual(archiveDialog(null, false), { title: "Archive this Chat?", choices: [{ mode: "hide", text: "Archive", style: "destructive" }] });
});

test("confirmArchive puts Cancel first and resolves to the pressed choice, or null", async () => {
  const dialog = archiveDialog({ milagreOwned: true, shared: false, status: dirty }, false);
  const pressed = fakeAlert("Archive and delete worktree");
  assert.equal(await confirmArchive(pressed.alert, dialog), "delete");
  assert.ok(pressed.shown[0] !== undefined);
  assert.deepEqual(
    pressed.shown[0].buttons.map((button) => [button.text, button.style]),
    [
      ["Cancel", "cancel"],
      ["Archive and delete worktree", "destructive"],
    ],
  );
  assert.equal(pressed.shown[0].message, dialog.message);
  assert.equal(await confirmArchive(fakeAlert("Cancel").alert, dialog), null);
  assert.equal(await confirmArchive(fakeAlert(null).alert, dialog), null);
});

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

test("an older daemon that refuses the check falls back to the plain hide-only archive, without an error", async () => {
  const { client, calls } = fakeClient({ "worktree:roots": refusedByOldDaemon, "worktree:status": refusedByOldDaemon });
  assert.equal(await checkArchive(client, state(), 2), null);
  calls.length = 0;
  const { alert, shown } = fakeAlert("Archive");
  const notices: string[] = [];
  const result = await archiveFromPhone({
    client,
    alert,
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
  assert.ok(shown[0] !== undefined);
  assert.deepEqual(
    shown[0].buttons.map((button) => button.text),
    ["Cancel", "Archive"],
  );
  assert.equal(shown[0].message, undefined);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["worktree:roots", "snapshot", "chat:patch"],
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
  const { alert } = fakeAlert("Stop, archive and remove worktree");
  let confirmed = false;
  const result = await archiveFromPhone({
    client,
    alert,
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
    "worktree:status": () => dirty,
    "worktree:remove": () => Promise.reject(new Error("WORKTREE_CHANGED: /wt/shop/x-1 changed after it was checked.")),
  });
  const notices: string[] = [];
  const result = await archiveFromPhone({
    client,
    alert: fakeAlert("Archive and delete worktree").alert,
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
  assert.equal((calls.find((call) => call.method === "worktree:remove")!.args[1] as { force: boolean }).force, true);
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
    alert: fakeAlert("Archive and remove worktree").alert,
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

test("Cancel changes nothing", async () => {
  const { client, calls } = fakeClient();
  let refreshed = false;
  const result = await archiveFromPhone({
    client,
    alert: fakeAlert("Cancel").alert,
    projectPath: "/work/shop",
    state: state(),
    chat: session(2, 2),
    running: true,
    notify: () => {},
    refresh: async () => {
      refreshed = true;
    },
  });
  assert.equal(result, "cancelled");
  // Only the checks ran: nothing was hidden, removed or ended.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["worktree:roots", "worktree:status", "terminal:list"],
  );
  assert.equal(refreshed, false);
});

test("whether to stop is read when the archive runs, not when Archive was tapped", async () => {
  // Idle when tapped, running by the time it is confirmed: the turn is stopped.
  const started = fakeClient({}, state(), { "/work/shop#2": {} });
  await archiveFromPhone({
    client: started.client,
    alert: fakeAlert("Archive and remove worktree").alert,
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
    alert: fakeAlert("Stop, archive and remove worktree").alert,
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

test("a second tap while a Chat is archiving asks nothing and removes nothing", async () => {
  const { client, calls } = fakeClient();
  let press: (() => void) | undefined;
  let shown = 0;
  const alert: ShowAlert = (_title, _message, buttons) => {
    shown++;
    press = () => buttons.find((button) => button.text === "Archive and remove worktree")!.onPress!();
  };
  const request = { client, alert, projectPath: "/work/shop", state: state(), chat: session(2, 2), running: false, notify: () => {}, refresh: async () => {} };
  const first = archiveFromPhone(request);
  // oxlint-disable-next-line no-unmodified-loop-condition -- the alert callback assigns press while the loop yields to the event loop
  for (let i = 0; i < 5 && !press; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await archiveFromPhone(request), "busy");
  press!();
  assert.equal(await first, "removed");
  assert.equal(shown, 1);
  assert.equal(calls.filter((call) => call.method === "worktree:remove").length, 1);
  // Once it is over, the Chat can be archived again.
  assert.notEqual(await archiveFromPhone({ ...request, alert: fakeAlert("Cancel").alert }), "busy");
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
    alert: fakeAlert("Archive and remove worktree").alert,
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
      alert: fakeAlert("Archive and remove worktree").alert,
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
  assert.equal(archiveDialog(plan, false).message, "Archiving ends the Terminal running npm.");
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
      archiveDialog(plan, false).choices.map((choice) => choice.mode),
      ["hide"],
    );
  });
}

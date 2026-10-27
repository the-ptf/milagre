import assert from "node:assert/strict";
import test from "node:test";
import { diffState } from "@milagre/shared/state-patch";

// A stand-in for the preload: the test plays the host's events and answers state:read.
type Listener = (update: any) => void;
const raw: Record<string, Listener[]> = { project: [], link: [], agent: [], snapshot: [], computer: [] };
const host = { epoch: "host-1", version: 0, state: {} as any, reads: 0, hold: null as null | Promise<void> };
(globalThis as any).window = {
  milagre: {
    onRuntimeSnapshot: (listener: Listener) => (raw.snapshot.push(listener), () => {}),
    onComputerEvent: (listener: Listener) => (raw.computer.push(listener), () => {}),
    onProjectState: (listener: Listener) => (raw.project.push(listener), () => {}),
    onLinkState: (listener: Listener) => (raw.link.push(listener), () => {}),
    onAgentEvent: (listener: Listener) => (raw.agent.push(listener), () => {}),
    async readState() {
      host.reads++;
      const read = { state: host.state, version: host.version, epoch: host.epoch };
      await host.hold;
      return read;
    },
  },
};
const { stateEvents } = await import("./state-events.ts");

const project = "/code/shop";
const states: any[] = [];
const events: any[] = [];
stateEvents.onProjectState(({ path, state }) => path === project && states.push(state));
stateEvents.onAgentEvent((event) => events.push(event));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The host's next state for the Project, sent as its patch (or `resync`) the way the daemon sends it. */
function change(next: any, { resync = false, channel = "project" } = {}) {
  const previous = host.state;
  const base = host.version;
  host.state = next;
  host.version++;
  const numbering = resync
    ? { resync: true, version: host.version, epoch: host.epoch }
    : { patch: diffState(previous, next), base, version: host.version, epoch: host.epoch };
  if (channel === "project") for (const listener of raw.project) listener({ path: project, ...numbering });
  else for (const listener of raw.agent) listener({ chatId: `${project}#1`, event: { type: "turn-completed" }, seq: host.version, ...numbering });
}

test("the first patch reads the state; later patches apply to it and keep what didn't change", async () => {
  const messages = [{ id: 1, body: "hi" }];
  host.state = { sessions: { 1: { id: 1, title: "One" } }, messages };
  host.version = 5;
  change({ ...host.state, sessions: { 1: { id: 1, title: "Renamed" } } });
  await tick();
  assert.equal(host.reads, 1, "nothing was held for the Project, so it is read");
  assert.equal(states.at(-1).sessions[1].title, "Renamed");
  const before = states.at(-1);
  change({ ...host.state, sessions: { 1: { id: 1, title: "Again" } } });
  assert.equal(host.reads, 1);
  assert.equal(states.at(-1).sessions[1].title, "Again");
  assert.equal(states.at(-1).messages, before.messages);
});

test("a turn's end brings its state as a patch on the agent event", () => {
  change({ ...host.state, messages: [...host.state.messages, { id: 2, body: "done" }] }, { channel: "agent" });
  const event = events.at(-1);
  assert.equal(event.state.messages.length, 2);
  assert.equal("patch" in event, false, "listeners see a whole state, not the patch");
});

test("a missed patch reads the state again, and patches that arrive during the read follow it", async () => {
  // One patch never arrives.
  host.state = { ...host.state, sessions: { 1: { id: 1, title: "Missed" } } };
  host.version++;
  let release!: () => void;
  host.hold = new Promise((resolve) => (release = resolve));
  change({ ...host.state, sessions: { 1: { id: 1, title: "After the gap" } } });
  await tick();
  const reads = host.reads;
  // The read answered with the state above; this one comes while it's on its way.
  change({ ...host.state, sessions: { 1: { id: 1, title: "During the read" } } });
  change({ ...host.state, sessions: { 1: { id: 1, title: "Second queued patch" } } });
  host.hold = null;
  release();
  await tick();
  assert.equal(host.reads, reads);
  assert.equal(states.at(-1).sessions[1].title, "Second queued patch");
  change({ ...host.state, sessions: { 1: { id: 1, title: "After replay" } } });
  assert.equal(states.at(-1).sessions[1].title, "After replay");
  assert.equal(host.reads, reads, "the replay advanced to the last queued version");
});

test("a new host, or resync, reads the state again", async () => {
  const reads = host.reads;
  host.epoch = "host-2";
  host.version = 1;
  change({ ...host.state, sessions: { 1: { id: 1, title: "New host" } } });
  await tick();
  assert.equal(host.reads, reads + 1);
  assert.equal(states.at(-1).sessions[1].title, "New host");
  change({ ...host.state, sessions: { 1: { id: 1, title: "Too large to patch" } } }, { resync: true });
  await tick();
  assert.equal(host.reads, reads + 2);
  assert.equal(states.at(-1).sessions[1].title, "Too large to patch");
});

test("an older host's whole states pass through", () => {
  const whole = { sessions: { 1: { id: 1, title: "Whole" } }, messages: [] };
  for (const listener of raw.project) listener({ path: project, state: whole });
  assert.equal(states.at(-1), whole);
});

test("a turn's end that needs a read waits for it, with the events behind it, so its run and reply arrive together", async () => {
  host.epoch = "host-3";
  host.version = 1;
  let release!: () => void;
  host.hold = new Promise((resolve) => (release = resolve));
  const before = events.length;
  change({ ...host.state, messages: [...host.state.messages, { id: 3, body: "saved reply" }] }, { channel: "agent" });
  for (const listener of raw.agent) listener({ chatId: `${project}#2`, event: { type: "message-delta", text: "next" }, seq: 99 });
  await tick();
  assert.equal(events.length, before, "nothing reaches the window while the state is read");
  host.hold = null;
  release();
  await tick();
  const [ended, delta] = events.slice(before);
  assert.equal(ended.event.type, "turn-completed");
  assert.equal(ended.state.messages.at(-1).body, "saved reply");
  assert.equal(delta.event.type, "message-delta");
  assert.equal("state" in delta, false);
});

for (const remote of [false, true]) {
  test(`${remote ? "paired computer" : "local host"} reconnect refreshes Chat pages without waiting for a new message`, () => {
    const resets: string[] = [];
    const off = stateEvents.onMessages((update) => {
      if (update.reset) resets.push(update.scope);
    });
    const prefix = remote ? "remote|" : "";
    const snapshot = {
      projects: [
        { path: `${prefix}/shop`, state: { messages: [], messagesInChats: true } },
        { path: `${prefix}/legacy`, state: { messages: [] } },
      ],
      links: [{ linkId: `${prefix}11111111-1111-4111-8111-111111111111`, state: { messages: [], messagesInChats: true } }],
    };
    try {
      if (remote) for (const listener of raw.computer) listener({ channel: "runtime:snapshot", payload: snapshot });
      else for (const listener of raw.snapshot) listener(snapshot);
      assert.deepEqual(resets, [`${prefix}/shop`, `milagre-link:${prefix}11111111-1111-4111-8111-111111111111`]);
    } finally {
      off();
    }
  });
}

test("a state read from before reconnect cannot restore stale state after the snapshot", async () => {
  let release!: () => void;
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  change({ ...host.state, sessions: { 1: { id: 1, title: "Before reconnect" } } }, { resync: true });
  await tick();
  for (const listener of raw.snapshot) listener({ projects: [{ path: project, state: { messages: [], messagesInChats: true } }] });
  const announced = states.length;
  host.hold = null;
  release();
  await tick();
  assert.equal(states.length, announced, "a cancelled read must not replace the reconnect snapshot");
  change({ ...host.state, sessions: { 1: { id: 1, title: "After reconnect" } } });
  await tick();
  assert.equal(states.at(-1).sessions[1].title, "After reconnect");
});

test("a reconnect keeps the last state's number: the next patch applies without a read", async () => {
  change({ ...host.state, sessions: { 1: { id: 1, title: "Settled" } } }, { resync: true });
  await tick();
  const reads = host.reads;
  for (const listener of raw.snapshot) listener({ projects: [{ path: project, state: { messages: [], messagesInChats: true } }] });
  change({ ...host.state, sessions: { 1: { id: 1, title: "After reconnect, unchanged meanwhile" } } });
  await tick();
  assert.equal(host.reads, reads, "no state read when nothing changed during the disconnect");
  assert.equal(states.at(-1).sessions[1].title, "After reconnect, unchanged meanwhile");
});

test("a reconnect releases the agent events held behind the read it drops", async () => {
  const events: any[] = [];
  const off = stateEvents.onAgentEvent((update) => events.push(update));
  let release!: () => void;
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  change({ ...host.state, sessions: { 1: { id: 1, title: "Reading" } } }, { resync: true });
  await tick();
  for (const listener of raw.agent) listener({ chatId: `${project}#1`, event: { type: "turn-end" } });
  assert.equal(events.length, 0, "held while the scope is read");
  try {
    for (const listener of raw.snapshot) listener({ projects: [{ path: project, state: { messages: [], messagesInChats: true } }] });
    assert.equal(events.length, 1, "released by the reconnect");
    assert.equal(events[0].event.type, "turn-end");
    host.hold = null;
    release();
    await tick();
    assert.equal(events.length, 1, "not delivered twice when the dropped read answers");
  } finally {
    off();
  }
});

test("a paired computer's snapshot without Projects resets its Links only", () => {
  const resets: string[] = [];
  const off = stateEvents.onMessages((update) => {
    if (update.reset) resets.push(update.scope);
  });
  try {
    for (const listener of raw.computer)
      listener({
        channel: "runtime:snapshot",
        payload: { links: [{ linkId: "remote|22222222-2222-4222-8222-222222222222", state: { messages: [], messagesInChats: true } }] },
      });
    assert.deepEqual(resets, ["milagre-link:remote|22222222-2222-4222-8222-222222222222"]);
  } finally {
    off();
  }
});

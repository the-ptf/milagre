import assert from "node:assert/strict";
import test from "node:test";
import { diffState } from "@milagre/shared/state-patch";

// A stand-in for the preload: the test plays the host's events and answers state:read.
type Listener = (update: any) => void;
const raw: Record<string, Listener[]> = { project: [], link: [], agent: [] };
const host = { epoch: "host-1", version: 0, state: {} as any, reads: 0, hold: null as null | Promise<void> };
(globalThis as any).window = {
  milagre: {
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

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import type { CoordinatorState } from "../model";
import { activeChatKeys, draftTileKey, gridChats } from "./chat-grid.ts";

const NO_WORK = { delegations: [], negotiations: [], receiveOnly: [] };

test("activeChatKeys: running, delegated and unread Chats, never a Named Link's or an archived one", () => {
  const idle = { approvals: [], questions: [] };
  const runs = { "/a#1": idle, "milagre-link:abc#2": idle } as unknown as AgentRuns;
  const work = { ...NO_WORK, delegations: [{ to_chat: "/b#3" }] } as never;
  const states = {
    "/a": {
      sessions: {
        4: { id: 4, unread: true },
        5: { id: 5, unread: true, archived: true },
        6: { id: 6 },
      },
    } as unknown as CoordinatorState,
  };
  assert.deepEqual(activeChatKeys(runs, work, states).toSorted(), ["/a#1", "/a#4", "/b#3"]);
});

const hiddenRun = { routineId: "r1", runId: "u1", hidden: true };

test("activeChatKeys: a hidden Run Chat stays out of the grid, running, delegated or unread, until its run waits on the user", () => {
  const states = {
    "/a": {
      sessions: {
        1: { id: 1, routine: hiddenRun, unread: true },
        2: { id: 2, routine: hiddenRun },
        3: { id: 3, routine: hiddenRun },
        4: { id: 4, routine: hiddenRun },
        5: { id: 5, routine: hiddenRun, unread: true },
        6: { id: 6, routine: { ...hiddenRun, hidden: false }, unread: true },
        7: { id: 7, routine: { ...hiddenRun, hidden: false } },
      },
    } as unknown as CoordinatorState,
  };
  const run = (approvals: number, questions: number) => ({ approvals: Array.from({ length: approvals }), questions: Array.from({ length: questions }) });
  const runs = { "/a#2": run(0, 0), "/a#3": run(1, 0), "/a#4": run(0, 1), "/a#5": run(1, 0), "/a#7": run(0, 0) } as unknown as AgentRuns;
  const work = { ...NO_WORK, delegations: [{ to_chat: "/a#2" }, { to_chat: "/a#1" }] } as never;
  // 1 (unread) and 2 (running, delegated) stay out; 3, 4 (waiting, asking) and 5 (unread and waiting) show; 6 and 7 are kept Chats.
  assert.deepEqual(activeChatKeys(runs, work, states).toSorted(), ["/a#3", "/a#4", "/a#5", "/a#6", "/a#7"]);
  // A Run Chat's Delegation target with no state loaded, or a Chat with no session, isn't hidden by this rule.
  assert.deepEqual(activeChatKeys({} as AgentRuns, { ...NO_WORK, delegations: [{ to_chat: "/b#9" }] } as never, {}), ["/b#9"]);
});

test("gridChats: tiles keep their slot, new ones join at the end, the focused one stays", () => {
  assert.deepEqual(gridChats([], ["/a#1", "/a#2"], null), ["/a#1", "/a#2"]);
  // /a#1 went idle but is focused: it stays where it was.
  assert.deepEqual(gridChats(["/a#1", "/a#2"], ["/a#2", "/a#3"], "/a#1"), ["/a#1", "/a#2", "/a#3"]);
  // Focus moved on: /a#1 leaves and the rest shift up.
  assert.deepEqual(gridChats(["/a#1", "/a#2", "/a#3"], ["/a#3", "/a#2"], "/a#2"), ["/a#2", "/a#3"]);
  // An idle Chat focused from the sidebar joins at the end.
  assert.deepEqual(gridChats(["/a#2"], ["/a#2"], "/b#9"), ["/a#2", "/b#9"]);
});

test("gridChats: nothing changed returns the same array", () => {
  const previous = ["/a#1", "/a#2"];
  assert.equal(gridChats(previous, ["/a#2", "/a#1"], "/a#1"), previous);
});

test("gridChats: a new Chat's draft tile keeps its slot, and the saved Chat takes it", () => {
  const draft = draftTileKey("/a");
  assert.deepEqual(gridChats(["/a#1", "/a#2"], ["/a#2"], draft), ["/a#2", draft]);
  assert.deepEqual(gridChats(["/a#2", draft, "/a#3"], ["/a#2", "/a#3"], "/a#4"), ["/a#2", "/a#4", "/a#3"]);
  // Leaving the draft for a tile already there drops the draft, nothing takes its slot.
  assert.deepEqual(gridChats(["/a#2", draft, "/a#3"], ["/a#2", "/a#3"], "/a#3"), ["/a#2", "/a#3"]);
});

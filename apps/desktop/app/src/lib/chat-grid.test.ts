import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import type { CoordinatorState } from "../model";
import { activeChatKeys, gridChats } from "./chat-grid.ts";

const NO_WORK = { delegations: [], negotiations: [], receiveOnly: [] };

test("activeChatKeys: running, delegated and unread Chats, never a Named Link's or an archived one", () => {
  const runs = { "/a#1": {}, "milagre-link:abc#2": {} } as unknown as AgentRuns;
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

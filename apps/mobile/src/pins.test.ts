import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@milagre/shared/model";
import { pinPatch } from "./pins.ts";

const chat = (id: number, pin_order?: number): AgentSession => ({
  id,
  worktree_id: 1,
  agent_name: "main",
  status: "Created",
  ...(pin_order === undefined ? {} : { pinned: true, pin_order }),
});

test("pinPatch pins at the end, unpins, and moves a pinned Chat one place", () => {
  const sessions: [AgentSession, AgentSession, AgentSession, AgentSession] = [chat(1, 0), chat(2, 1), chat(3, 2), chat(4)];
  assert.deepEqual(pinPatch("pin", sessions[3], sessions), { pinned: true, pin_order: 3 });
  assert.deepEqual(pinPatch("unpin", sessions[1], sessions), { pinned: false });
  assert.deepEqual(pinPatch("pin-up", sessions[2], sessions), { pinned: true, pin_order: 0.5 });
  assert.deepEqual(pinPatch("pin-down", sessions[0], sessions), { pinned: true, pin_order: 1.5 });
  assert.equal(pinPatch("pin-up", sessions[0], sessions), null);
  assert.equal(pinPatch("pin-down", sessions[2], sessions), null);
});

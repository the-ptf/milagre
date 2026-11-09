import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingOnScreen, pendingOrigin } from "./pending-chats.ts";
import type { MobilePendingChat } from "./session.tsx";

const HOST = "relay://mac";
const PROJECT = "/p";

function pending(origin: string, overrides: Partial<MobilePendingChat> = {}): MobilePendingChat {
  return {
    preview: {
      session: { id: -2, worktree_id: 1, agent_name: "main", status: "Created" },
      message: { id: -2, session_id: -2, body: "Fix the build", role: "user" },
      startedAt: 0,
      sortId: 10,
      targetSessionId: null,
    },
    hostId: HOST,
    projectPath: PROJECT,
    originChatId: origin,
    originSessionId: null,
    worktreeId: 1,
    newWorktree: false,
    accepted: false,
    ...overrides,
  } as MobilePendingChat;
}

test("each New Chat in a Worktree has its own origin", () => {
  assert.equal(pendingOrigin(PROJECT, undefined, "1", "a"), "/p#new:1@a");
  assert.notEqual(pendingOrigin(PROJECT, undefined, "1", "a"), pendingOrigin(PROJECT, undefined, "1", "b"));
  // An open Chat is its own origin, whatever draft the screen holds.
  assert.equal(pendingOrigin(PROJECT, "7", "1", "a"), "/p#7");
});

test("a New Chat opened while another one is still sending starts empty", () => {
  const sending = pending(pendingOrigin(PROJECT, undefined, "1", "first"));
  const chats = { [`${HOST}|${sending.originChatId}`]: sending };
  const fresh = { hostId: HOST, projectPath: PROJECT, origin: pendingOrigin(PROJECT, undefined, "1", "second") };
  assert.equal(pendingOnScreen(chats, fresh), undefined);
  // Even after the Mac took the first one and gave it a Chat.
  const accepted = { ...sending, accepted: true, preview: { ...sending.preview, targetSessionId: 9, acceptedSessionId: 9 } };
  assert.equal(pendingOnScreen({ [`${HOST}|${sending.originChatId}`]: accepted }, fresh), undefined);
});

test("the drawer reopens a sending New Chat by its draft, and its Chat once the Mac took it", () => {
  const sending = pending(pendingOrigin(PROJECT, undefined, "1", "first"), { draft: "first" });
  const chats = { [`${HOST}|${sending.originChatId}`]: sending };
  assert.equal(pendingOnScreen(chats, { hostId: HOST, projectPath: PROJECT, origin: pendingOrigin(PROJECT, undefined, "1", "first") }), sending);
  const accepted = { ...sending, accepted: true, preview: { ...sending.preview, targetSessionId: 9, acceptedSessionId: 9 } };
  const opened = { hostId: HOST, projectPath: PROJECT, origin: pendingOrigin(PROJECT, "9", "1", "other"), id: "9" };
  assert.equal(pendingOnScreen({ [`${HOST}|${sending.originChatId}`]: accepted }, opened), accepted);
});

test("a send to another computer or Project stays off this screen", () => {
  const origin = pendingOrigin(PROJECT, undefined, "1", "first");
  const elsewhere = pending(origin, { hostId: "relay://other" });
  assert.equal(pendingOnScreen({ x: elsewhere }, { hostId: HOST, projectPath: PROJECT, origin }), undefined);
  assert.equal(pendingOnScreen({ x: pending(origin, { projectPath: "/q" }) }, { hostId: HOST, projectPath: PROJECT, origin }), undefined);
});

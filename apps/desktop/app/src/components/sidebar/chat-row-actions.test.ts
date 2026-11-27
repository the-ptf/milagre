import assert from "node:assert/strict";
import test from "node:test";
import { undoHistory } from "../../lib/undo-history.ts";
import { updateTabSet } from "../../lib/workspace-tabs-store.ts";
import { chatRowActions, foldTabRows, frontChat, type RowActionsNow } from "./chat-row-actions.ts";
import type { ChatRowActions, SidebarRecent } from "./ChatRow";

const row = (id: string, extra: Partial<SidebarRecent> = {}): SidebarRecent => ({ id, label: `Chat ${id}`, mark: "idle", tabSet: "/p#wt:7", ...extra });

test("with tabs on, a Worktree's rows fold into its main Chat's, which shows the most pressing mark", () => {
  const rows = [
    row("9", { mark: "question" }),
    row("1", { tabSet: "/p#chat:1" }),
    row("4"),
    row("5", { parent: "4", mark: "running" }),
    row("6", { doneAt: 1 }),
  ];
  assert.equal(foldTabRows(rows, false), rows);
  const folded = foldTabRows(rows, true);
  assert.deepEqual(
    folded.map((item) => [item.id, item.mark, item.tabChats]),
    [
      ["1", "idle", undefined],
      ["4", "question", ["9", "5"]],
      ["6", "idle", undefined],
    ],
  );
});

test("a folded row opens the Chat whose tab was in front, or its own", () => {
  const folded = row("4", { tabChats: ["9"] });
  assert.equal(frontChat(folded), "4");
  updateTabSet("/p#wt:7", () => ({
    tabs: [
      { kind: "chat", chatId: 4 },
      { kind: "chat", chatId: 9 },
    ],
    active: "chat:9",
  }));
  assert.equal(frontChat(folded), "9");
  updateTabSet("/p#wt:7", () => ({
    tabs: [
      { kind: "chat", chatId: 4 },
      { kind: "browser", chatId: 9, pageId: "a" },
    ],
    active: "browser:9:a",
  }));
  assert.equal(frontChat(folded), "9");
  assert.equal(frontChat(row("4")), "4");
});

test("Done, Snooze and Delete on a folded row take its whole Worktree, each as one Undo step", async () => {
  const calls: unknown[][] = [];
  const base: ChatRowActions = {
    onDone: (id) => calls.push(["done", id]),
    onReopen: (id) => calls.push(["reopen", id]),
    onSnooze: (id, until) => calls.push(["snooze", id, until]),
    onWake: (id) => calls.push(["wake", id]),
    onArchiveCheck: async (id, together) => (calls.push(["check", id, together]), { milagreOwned: true, shared: false, status: null }),
    onArchive: (id, mode, plan, together) => void calls.push(["delete", id, mode, plan.shared, together]),
    onUndoArchive: (id) => (calls.push(["restore", id]), true),
  };
  const now = (): RowActionsNow => ({
    recents: [row("4", { tabChats: ["9", "5"] }), row("1")],
    actions: base,
    sidebarLinks: {} as RowActionsNow["sidebarLinks"],
  });
  const actions = chatRowActions(base, null, "/p", now);
  actions.onDone!("4");
  assert.deepEqual(calls.splice(0), [
    ["done", "4"],
    ["done", "9"],
    ["done", "5"],
  ]);
  undoHistory.undo();
  assert.deepEqual(calls.splice(0), [
    ["reopen", "4"],
    ["reopen", "9"],
    ["reopen", "5"],
  ]);
  actions.onSnooze!("1", 99);
  assert.deepEqual(calls.splice(0), [["snooze", "1", 99]]);
  await actions.onArchiveCheck!("4");
  assert.deepEqual(calls.splice(0), [["check", "4", ["9", "5"]]]);
  await actions.onArchive!("4", "remove", { milagreOwned: true, shared: false, status: null });
  assert.deepEqual(calls.splice(0), [
    ["delete", "9", "hide", true, undefined],
    ["delete", "5", "hide", true, undefined],
    ["delete", "4", "remove", false, ["9", "5"]],
  ]);
  undoHistory.undo();
  assert.deepEqual(calls.splice(0), [
    ["restore", "4"],
    ["restore", "9"],
    ["restore", "5"],
  ]);
});

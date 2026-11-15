import assert from "node:assert/strict";
import test from "node:test";
import { sidebarModes, splitGroupRows } from "./sidebar-modes.ts";

const modes = (collapsed: boolean, chatList: "list" | "grouped" | "tree", currentKey = "/code/shop", scopeCount = 3) =>
  sidebarModes({ collapsed, chatList, currentKey, scopeCount });

test("the expanded one list builds every scope's rows but no Project sections", () => {
  assert.deepEqual(modes(false, "list"), {
    showAll: true,
    oneList: true,
    buildGroups: true,
    bySection: false,
    tree: false,
    railByScope: false,
    railByChat: false,
  });
});

test("the collapsed one list still builds rows, for a rail of chats", () => {
  const collapsed = modes(true, "list");
  assert.equal(collapsed.buildGroups, true);
  assert.equal(collapsed.railByChat, true);
  assert.equal(collapsed.railByScope, false);
});

test("grouped and tree sidebars draw Project sections when expanded and scope icons when collapsed", () => {
  for (const chatList of ["grouped", "tree"] as const) {
    assert.equal(modes(false, chatList).bySection, true);
    assert.equal(modes(false, chatList).tree, chatList === "tree");
    const rail = modes(true, chatList);
    assert.equal(rail.buildGroups, false);
    assert.equal(rail.railByScope, true);
    assert.equal(rail.railByChat, false);
  }
});

test("a rail with one scope has no scope icons to switch between", () => {
  assert.equal(modes(true, "grouped", "/code/shop", 1).railByScope, false);
});

test("without an open scope the list setting falls back to Project sections", () => {
  const none = modes(false, "list", "");
  assert.equal(none.oneList, false);
  assert.equal(none.bySection, true);
  assert.equal(modes(true, "list", "").railByScope, true);
});

test("pinned and the rest come from the shown rows, Done and Snoozed from all of them", () => {
  const all = [{ id: "1", pinned: true }, { id: "2" }, { id: "3", doneAt: 5 }, { id: "4", snoozed: true }];
  const shown = all.filter((row) => !row.doneAt && !row.snoozed);
  const split = splitGroupRows(all, shown, (row) => Boolean(row.snoozed));
  assert.deepEqual(Object.fromEntries(Object.entries(split).map(([key, rows]) => [key, rows.map((row) => row.id)])), {
    pinned: ["1"],
    rest: ["2"],
    done: ["3"],
    snoozed: ["4"],
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { chatFamily, rowKeys, shownChats } from "./subchat-rows.ts";

const row = (id: string, parent?: string) => ({ id, label: id, ...(parent ? { parent } : {}) });

test("subchats follow their parent's row, and a folded family shows the parent alone", () => {
  const rows = [row("4", "1"), row("2"), row("1"), row("3", "1")];
  const open = shownChats(rows, { ...rowKeys("/p"), folded: new Set() });
  assert.deepEqual(
    open.map(({ item, subchat, family }) => [item.id, subchat, family?.count, family?.folded]),
    [
      ["1", false, 2, false],
      ["4", true, undefined, undefined],
      ["3", true, undefined, undefined],
      ["2", false, undefined, undefined],
    ],
  );
  const folded = shownChats(rows, { ...rowKeys("/p"), folded: new Set(["/p#1"]) });
  assert.deepEqual(
    folded.map(({ item }) => item.id),
    ["1", "2"],
  );
  assert.equal(folded[0]!.family!.onToggle, open[0]!.family!.onToggle, "one toggle per family keeps the row's memo");
});

test("a subchat whose parent isn't listed stays a row of its own", () => {
  const shown = shownChats([row("2", "9"), row("3")], { ...rowKeys("/p"), folded: new Set() });
  assert.deepEqual(
    shown.map(({ item, subchat }) => [item.id, subchat]),
    [
      ["2", false],
      ["3", false],
    ],
  );
});

test("a Chat's family: its topmost listed ancestor and that one's live subchats", () => {
  const sessions = {
    1: { id: 1 },
    2: { id: 2, parent: 1 },
    3: { id: 3, parent: 2 },
    4: { id: 4, parent: 1, archived: true },
    5: { id: 5, parent: 1, done_at: 10 },
    6: { id: 6 },
    7: { id: 7, parent: 8 },
  };
  assert.deepEqual(chatFamily(sessions, "/p#3"), { root: "/p#1", children: ["/p#2", "/p#3"] });
  assert.deepEqual(chatFamily(sessions, "/p#1"), { root: "/p#1", children: ["/p#2", "/p#3"] });
  assert.equal(chatFamily(sessions, "/p#6"), null);
  assert.equal(chatFamily(sessions, "/p#7"), null, "a parent that's gone leaves no family");
});

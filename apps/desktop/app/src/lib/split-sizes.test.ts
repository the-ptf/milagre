import assert from "node:assert/strict";
import test from "node:test";
import { placeColumns, readSplitSizes, saveSplitSizes, shareColumns, shareRows } from "./split-sizes.ts";

test("placeColumns: even by default, weighted once dragged, rows split by their share", () => {
  const empty = { columns: {}, rows: {} };
  assert.deepEqual(placeColumns([["a"], ["b", "c"]], empty).placed, [
    { left: 0, width: 50, share: 1 },
    { left: 50, width: 50, share: 0.5 },
  ]);
  const dragged = shareRows(shareColumns(empty, "a", "b", 0.25), "c", 0.7);
  assert.deepEqual(placeColumns([["a"], ["b", "c"]], dragged).placed, [
    { left: 0, width: 25, share: 1 },
    { left: 25, width: 75, share: 0.7 },
  ]);
});

test("shareColumns moves only the dragged pair", () => {
  const three = shareColumns({ columns: {}, rows: {} }, "b", "c", 0.75);
  assert.deepEqual(three.columns, { b: 1.5, c: 0.5 });
  assert.deepEqual(
    placeColumns([["a"], ["b"], ["c"]], three).placed.map((column) => Math.round(column.width * 100) / 100),
    [33.33, 50, 16.67],
  );
});

test("split sizes round-trip and drop what isn't a positive number", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.deepEqual(readSplitSizes(storage), { columns: {}, rows: {} });
  saveSplitSizes(storage, { columns: { a: 2 }, rows: { c: 0.6 } });
  assert.deepEqual(readSplitSizes(storage), { columns: { a: 2 }, rows: { c: 0.6 } });
  store.set("milagre.chatSplitSizes", '{"columns":{"a":"x","b":-1,"c":3},"rows":null}');
  assert.deepEqual(readSplitSizes(storage), { columns: { c: 3 }, rows: {} });
  store.set("milagre.chatSplitSizes", "{");
  assert.deepEqual(readSplitSizes(storage), { columns: {}, rows: {} });
});

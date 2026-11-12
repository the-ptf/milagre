import assert from "node:assert/strict";
import test from "node:test";
import { fileSpanIndex } from "./file-links.ts";

test("a read or edit step's file is the title's code span", () => {
  assert.equal(fileSpanIndex("Read `App.tsx`", "/r/App.tsx"), 1);
  assert.equal(fileSpanIndex("Edited `App.tsx`", "/r/App.tsx"), 1);
  assert.equal(fileSpanIndex("Created `notes.txt`", "/r/notes.txt"), 1);
  assert.equal(fileSpanIndex("Wrote `notes.txt`", "/r/notes.txt"), 1);
  assert.equal(fileSpanIndex("Ran `npm test`", "/r/x"), -1);
  assert.equal(fileSpanIndex("Read `App.tsx`", undefined), -1);
  assert.equal(fileSpanIndex("Edited 3 files", "/r/x"), -1);
});

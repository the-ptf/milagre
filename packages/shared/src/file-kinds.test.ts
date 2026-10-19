import test from "node:test";
import assert from "node:assert/strict";
import { fileKind } from "./file-kinds.mjs";

test("fileKind maps extensions to badges and icons", () => {
  assert.equal(fileKind("x.tsx").icon, "react");
  assert.equal(fileKind("x.ts").badge, "TS");
  assert.equal(fileKind("x.ts").icon, null);
  assert.equal(fileKind("dir/").icon, "folder");
  assert.equal(fileKind("a/logo.PNG").icon, "image");
  assert.equal(fileKind("README").icon, "file");
  assert.equal(fileKind("x.kt").badge, "KT");
  assert.match(fileKind("x.py").color, /^#[0-9a-f]{6}$/i);
});

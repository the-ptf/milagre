import assert from "node:assert/strict";
import test from "node:test";
import { groupByOrigin, originId } from "./project-origin.mjs";

test("originId reads ssh, scp-like and https remotes of one repo the same", () => {
  for (const url of [
    "git@github.com:the-ptf/milagre-ade.git",
    "https://github.com/the-ptf/milagre-ade",
    "https://victor@github.com/The-PTF/milagre-ade.git/",
    "ssh://git@github.com/the-ptf/milagre-ade.git",
  ])
    assert.equal(originId(url), "github.com/the-ptf/milagre-ade");
});

test("originId: a local path, a drive letter or nothing has no origin", () => {
  for (const url of ["/Users/victor/repos/app.git", "file:///Users/victor/repos/app.git", "C:\\repos\\app", "", null, undefined, "not a url"])
    assert.equal(originId(url), null);
});

const choice = (key: string, computerId: string, origin?: string) => ({ key, computerId, origin });

test("groupByOrigin: one entry per origin across computers, in its first copy's place", () => {
  const groups = groupByOrigin([
    choice("/a", "local", "github.com/x/a"),
    choice("/b", "local", "github.com/x/b"),
    choice("m1|/a", "m1", "github.com/x/a"),
    choice("m2|/a", "m2", "github.com/x/a"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["/a", "/b"],
  );
  assert.deepEqual(
    groups[0]?.copies.map((copy) => copy.key),
    ["/a", "m1|/a", "m2|/a"],
  );
});

test("groupByOrigin: no origin, or a second clone on the same computer, stays its own row", () => {
  const groups = groupByOrigin([
    choice("/a", "local", "github.com/x/a"),
    choice("/a-2", "local", "github.com/x/a"),
    choice("/plain", "local"),
    choice("m1|/plain", "m1"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.copies.length),
    [1, 1, 1, 1],
  );
});

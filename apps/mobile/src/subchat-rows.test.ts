import { test } from "node:test";
import assert from "node:assert/strict";
import { nestChatRows } from "./subchat-rows.ts";

const chat = (id: number, extra: { parent?: number; pinned?: boolean } = {}, path = "/p") => ({
  kind: "chat" as const,
  key: `mac|${path}#${id}`,
  chat: { id, ...extra },
});
const project = (path: string) => ({ kind: "project" as const, key: `mac|${path}` });

test("each Project's subchats sit under their parent; pinned rows keep their place", () => {
  const rows = [project("/p"), chat(9, { pinned: true }), chat(3, { parent: 1 }), chat(2), chat(1), chat(4, { parent: 3 }), project("/q"), chat(3, {}, "/q")];
  const nested = nestChatRows(rows, new Set());
  assert.deepEqual(
    nested.map((row) => [row.key, "subchat" in row ? row.subchat : undefined, "family" in row ? row.family?.count : undefined]),
    [
      ["mac|/p", undefined, undefined],
      ["mac|/p#9", undefined, undefined],
      ["mac|/p#1", undefined, 2],
      ["mac|/p#3", true, undefined],
      ["mac|/p#4", true, undefined],
      ["mac|/p#2", undefined, undefined],
      ["mac|/q", undefined, undefined],
      ["mac|/q#3", undefined, undefined],
    ],
  );
});

test("a folded family shows its parent alone, and a list without subchats comes back as it was", () => {
  const rows = [chat(2, { parent: 1 }), chat(1)];
  assert.deepEqual(
    nestChatRows(rows, new Set(["mac|/p#1"])).map((row) => row.key),
    ["mac|/p#1"],
  );
  const plain = [chat(1), chat(2)];
  assert.equal(nestChatRows(plain, new Set()), plain);
});

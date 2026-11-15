import { test } from "node:test";
import assert from "node:assert/strict";
import { keepRpcResult } from "./use-rpc.ts";
import type { Client } from "./client.ts";

const client = {} as Client;
const answer = (data: unknown, identity = "poll") => ({ client, call: "read", retention: "read", identity, data, error: "" });

test("identical polls retain the loaded object and data, including reordered JSON keys", () => {
  const first = keepRpcResult(null, answer({ a: [1, { b: 2 }], c: true }));
  const next = keepRpcResult(first, answer({ c: true, a: [1, { b: 2 }] }));
  assert.equal(next, first);
  assert.equal(next.data, first.data);
  assert.notEqual(keepRpcResult(next, answer({ a: [2], c: true })), next);
});

test("explicit refresh completes with new metadata but keeps identical data", () => {
  const first = keepRpcResult(null, answer({ a: 1 }));
  const next = keepRpcResult(first, answer({ a: 1 }, "refresh"));
  assert.notEqual(next, first);
  assert.equal(next.identity, "refresh");
  assert.equal(next.data, first.data);
  const recovered = keepRpcResult({ ...next, error: "offline" }, answer({ a: 1 }, "refresh"));
  assert.equal(recovered.error, "");
  assert.equal(recovered.data, first.data);
});

test("another client or method never reuses the previous response", () => {
  const first = keepRpcResult(null, answer({ a: 1 }));
  const data = { a: 1 };
  assert.equal(keepRpcResult(first, { ...answer(data), client: {} as Client }).data, data);
  assert.equal(keepRpcResult(first, { ...answer(data), call: "other" }).data, data);
});

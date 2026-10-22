import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { splitBody, createAssembler, toBase64, fromBase64 } from "./relay-rpc.mjs";

test("base64 round trips", () => {
  const bytes = new Uint8Array(randomBytes(1001));
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test("base64 matches Buffer for every remainder length", () => {
  for (let n = 0; n < 12; n++) {
    const bytes = new Uint8Array(randomBytes(n));
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
    assert.deepEqual(fromBase64(Buffer.from(bytes).toString("base64")), bytes);
  }
});

test("fromBase64 rejects non-base64 text", () => {
  assert.throws(() => fromBase64("ab$d"), /Not base64/);
});

test("chunked body round trip (10 MB)", () => {
  const body = new Uint8Array(randomBytes(10 * 1024 * 1024));
  const chunks = splitBody(body);
  assert.ok(chunks.length > 1);
  const assembler = createAssembler();
  let result;
  chunks.forEach((chunk, i) => {
    result = assembler.add({ t: "res", id: 7, status: 200, headers: { "content-type": "image/png" }, chunk, more: i < chunks.length - 1 });
  });
  assert.equal(result.done, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, body);
});

test("an empty body is one empty chunk", () => {
  assert.deepEqual(splitBody(new Uint8Array()), [""]);
});

test("drop mid-body forgets the partial response", () => {
  const assembler = createAssembler();
  assert.equal(assembler.add({ t: "res", id: 1, status: 200, headers: {}, chunk: toBase64(new Uint8Array([1])), more: true }).done, false);
  assembler.drop(1);
  const result = assembler.add({ t: "res", id: 1, status: 200, headers: {}, chunk: toBase64(new Uint8Array([2])), more: false });
  assert.deepEqual(result.body, new Uint8Array([2]));
});

test("more than 64 MiB for one response is refused", () => {
  const assembler = createAssembler();
  const big = toBase64(new Uint8Array(1024 * 1024));
  assert.throws(() => {
    for (let i = 0; i < 65; i++) assembler.add({ t: "res", id: 3, status: 200, headers: {}, chunk: big, more: true });
  }, /too large/);
});

test("interleaved responses assemble independently", () => {
  const assembler = createAssembler();
  const part = (id, byte, more) => ({ t: "res", id, status: 200 + id, headers: {}, chunk: toBase64(new Uint8Array([byte])), more });
  assembler.add(part(1, 1, true));
  assembler.add(part(2, 9, true));
  const two = assembler.add(part(2, 8, false));
  const one = assembler.add(part(1, 2, false));
  assert.deepEqual(two.body, new Uint8Array([9, 8]));
  assert.equal(two.status, 202);
  assert.deepEqual(one.body, new Uint8Array([1, 2]));
});

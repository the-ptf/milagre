// Executes production split/assemble, host requestPart and mobile dispatch with in-memory carriers only.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { splitBody, createAssembler } from "../../../packages/shared/src/relay-rpc.mjs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const host = read("../../../apps/daemon/src/phone-channels.cjs");
const mobile = read("../../../apps/mobile/src/relay-transport.ts");
const rpc = read("../../../packages/shared/src/relay-rpc.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const body = (size) => Uint8Array.from({ length: size }, (_, i) => i % 251);
const specs = [0, 1, 2, 3, 262144, 262145, 524291].map((size) => ({
  size,
  method: "POST",
  path: "/rpc",
  headers: { "x-z": "first", "content-type": "application/json", "x-a": "last" },
}));
const partCode = host.match(/  function requestPart\(current, conn, record, message\) \{[\s\S]*?\n  \}/)[0];
const requestPart = Function(
  "createAssembler",
  "trace",
  `
const MAX_INFLIGHT=16, MAX_QUEUED=64, MAX_UPLOAD=8*1024*1024, MAX_QUEUED_BYTES=16*1024*1024, queueWaitMs=20000;
const routeOk = path => typeof path==='string' && path.startsWith('/') && !path.startsWith('//');
const tooManyRequests=new Uint8Array(), tooLarge=new Uint8Array();
const refuseRequest=(c,id,r,m,status)=>trace.push({rejected:m.id,status});
const respond=()=>{throw new Error('unexpected response');};
const forward=(c,id,r,meta,bytes)=>trace.push({meta,body:Buffer.from(bytes).toString('hex')});
${partCode}
return requestPart;`,
);
const requests = specs.map((s, i) => {
  const chunks = splitBody(body(s.size));
  const parts = chunks.map((chunk, index) => ({
    t: "req",
    id: i + 1,
    method: s.method,
    path: s.path,
    headers: s.headers,
    chunk,
    more: index < chunks.length - 1,
  }));
  const trace = [];
  const receive = requestPart(createAssembler, trace);
  const record = { inflight: 0, uploads: new Map(), queue: [], rejected: new Set(), assembler: createAssembler() };
  for (const part of parts) receive({}, 1, record, part);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].body, Buffer.from(body(s.size)).toString("hex"));
  return { ...s, id: i + 1, hashes: parts.map((p) => hash(JSON.stringify(p))), bodyHash: hash(Buffer.from(trace[0].body, "hex")) };
});
const dispatchCode = stripTypeScriptTypes(mobile.match(/  function dispatch\(c: Conn, message: RelayMessage\) \{[\s\S]*?\n  \}/)[0]);
const dispatch = Function("send", "down", `${dispatchCode}; return dispatch;`);
const messages = [
  {
    t: "batch",
    items: [
      { t: "res", id: 1, status: 201, headers: { etag: "first" }, chunk: "YQ==", more: true },
      { t: "live", id: 3, data: "first" },
      { t: "batch", items: [{ t: "ping" }, { t: "res", id: 2, status: 200, headers: {}, chunk: "", more: false }] },
      { t: "res", id: 1, status: 500, headers: { etag: "ignored" }, chunk: "Yg==", more: false },
      { t: "live", id: 3, data: "lone:\ud800 low:\udfff PUA:\u{f0000} ESC:\u{10fffe}" },
      { t: "live-close", id: 3, code: 1000 },
      { t: "live", id: 3, data: "late" },
      { t: "res", id: 99, status: 200, headers: {}, chunk: "", more: false },
      { t: "future", data: { ignored: true } },
    ],
  },
];
const events = [];
const c = { assembler: createAssembler(), pending: new Map(), lives: new Map() };
for (const id of [1, 2])
  c.pending.set(id, {
    resolve: (r) => events.push({ t: "res", id, status: r.status, headers: r.headers, body: Buffer.from(r.body).toString("hex") }),
    reject: (e) => {
      throw e;
    },
  });
c.lives.set(3, { onData: (data) => events.push({ t: "live", id: 3, data }) });
const run = dispatch(
  (_connection, m) => events.push(m),
  (_live, connection) => {
    connection.lives.delete(3);
    events.push({ t: "live-close", id: 3 });
  },
);
for (const m of messages) run(c, m);
const fixtures = {
  sources: { host: hash(host), mobile: hash(mobile), rpc: hash(rpc) },
  requests,
  messages: messages.map((m) => JSON.stringify(m)),
  eventsJson: JSON.stringify(events),
};
const file = new URL("./fixtures/phone.json", import.meta.url);
if (process.argv.includes("--record")) {
  writeFileSync(file, JSON.stringify(fixtures, null, 2) + "\n");
  console.log("Recorded actual Node phone assembly and mobile dispatch fixtures.");
} else {
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), fixtures);
  const result = spawnSync(process.argv[2], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const rust = JSON.parse(result.stdout);
  assert.deepEqual(rust.events, events);
  for (const i of specs.keys()) {
    const assembler = createAssembler();
    let done;
    for (const p of rust.responses[i]) done = assembler.add(JSON.parse(p));
    assert.equal(hash(done.body), requests[i].bodyHash);
    const trace = [];
    const receive = requestPart(createAssembler, trace);
    const record = { inflight: 0, uploads: new Map(), queue: [], rejected: new Set(), assembler: createAssembler() };
    for (const p of rust.requests[i]) receive({}, 1, record, JSON.parse(p));
    assert.equal(hash(Buffer.from(trace[0].body, "hex")), requests[i].bodyHash);
    assert.deepEqual(rust.requests[i].map(hash), requests[i].hashes);
  }
  console.log(
    "Node host assembled 7 Rust requests, Node assembled 7 Rust responses, and actual mobile dispatch matches ordered Rust events including lone surrogates/PUA.",
  );
}

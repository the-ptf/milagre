// Actual Node lifecycle function bodies, fake clock/fetch/carrier only. No service import/start.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const source = readFileSync(new URL("../../../apps/daemon/src/phone-channels.cjs", import.meta.url), "utf8");
const names = ["closeLives", "release", "dropConn", "dropOwn", "sendEncoded", "flushBatch", "forward", "onFrame"];
const functions = names
  .map((name) => {
    const code = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
    assert.ok(code, name);
    return code[0];
  })
  .join("\n");
const frameCode = source.match(/function frame\(type, conn, payload = new Uint8Array\(\)\) \{[^]*?\n\}/)[0];
const make = Function(
  "trace",
  "deferred",
  `
const OPEN=1, DATA=2, CLOSE=3, helloMs=15000, batchMs=50, BATCH_BYTES=512*1024, REQUEST_TIMEOUT=340000, MAX_RESPONSE=64*1024*1024;
const FORWARDED_HEADERS=[], BLOCKED_HEADERS=new Set(), JSON_HEADERS={};
const token='synthetic', bridgeUrl='fake-carrier:', diagnostics=null, encoder=new TextEncoder();
let serial=0; const timers=new Map();
const setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;};
const clearTimeout=id=>timers.delete(id), clearInterval=clearTimeout;
const AbortSignal={timeout:ms=>({ms,aborted:false})};
const fetchBridge=(url,options)=>new Promise(resolve=>{deferred.push({resolve,signal:options.signal});});
${frameCode}
const sendFrame=(current,t,conn,payload)=>current.send(frame(t,conn,payload));
const joinBatch=()=>encoder.encode('{}');
const respond=(current,conn,record)=>sendEncoded(current,conn,record,encoder.encode('null'),true);
const createAssembler=()=>({});
${functions}
return {forward,dropConn,dropOwn,onFrame,sendEncoded,timers,setTimeout,frame};
`,
);
function base(run, session, conn) {
  const r = {
    state: "open",
    key: "synthetic",
    channel: { sealEncoded: (b) => b },
    lives: new Map(),
    inflight: 0,
    queue: [],
    queuedBytes: 0,
    uploads: new Map(),
    rejected: new Set(),
    batched: [new Uint8Array(10)],
    batchedBytes: 10,
    batch: true,
    batchTimer: run.setTimeout(() => {}, 50),
    helloTimer: run.setTimeout(() => {}, 15000),
    pendingTimer: run.setTimeout(() => {}, 20000),
    abort: {
      abort() {
        trace.abort++;
      },
    },
    peer: {
      close() {
        trace.peer++;
        run.dropOwn(session, conn, r, true);
      },
    },
  };
  r.lives.set(1, {
    close() {
      trace.live++;
    },
  });
  r.queue.push({ meta: { id: 2 }, body: new Uint8Array(5), expiry: run.setTimeout(() => {}, 20000) });
  r.queuedBytes = 5;
  return r;
}
let trace = { abort: 0, peer: 0, live: 0 };
const deferred = [],
  run = make(trace, deferred),
  sent = [];
const session = { conns: new Map(), send: (bytes) => sent.push(bytes[0]) };
const old = base(run, session, 7n);
session.conns.set(7n, old);
const inflight = run.forward(session, 7n, old, { id: 1, method: "POST", path: "/rpc", headers: {} }, new Uint8Array(3));
assert.equal(old.inflight, 1);
run.onFrame(session, run.frame(1, 7n));
const replacement = session.conns.get(7n);
assert.notEqual(replacement, old);
assert.equal(replacement.state, "hello");
run.dropOwn(session, 7n, old, true);
run.sendEncoded(session, 7n, old, new Uint8Array([0]), true);
assert.equal(session.conns.get(7n), replacement);
assert.equal(sent.length, 0);
assert.equal(old.queue.length, 0);
assert.equal(old.batched.length, 0);
assert.equal(old.lives.size, 0);
const inflightAfterClose = old.inflight;
assert.equal(deferred[0].signal.aborted, false); // Node does NOT abort an active fetch on disconnect.
deferred[0].resolve({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
await inflight;
assert.equal(old.inflight, 0);
assert.equal(sent.length, 0);
run.dropConn(session, 7n, false);
assert.equal(run.timers.size, 0);
const observed = {
  replacementKeepsSuccessor: true,
  lateResponseFrames: sent.length,
  queuedAfterClose: old.queue.length,
  batchAfterClose: old.batched.length,
  liveClosed: trace.live,
  peerClosed: trace.peer,
  approvalAborted: trace.abort,
  nodeInflightAfterClose: inflightAfterClose,
  nodeFetchAbortedOnDisconnect: deferred[0].signal.aborted,
  timersRemaining: run.timers.size,
};
const fixture = { sourceSha256: createHash("sha256").update(source).digest("hex"), observed };
const path = new URL("./fixtures/registry-node.json", import.meta.url);
if (process.argv[2] === "--record") {
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
} else {
  assert.deepEqual(fixture, JSON.parse(readFileSync(path, "utf8")));
  console.log(
    "Actual Node release/replacement/late-fetch trace matches fixture; Node fetch continues, while Rust explicitly cancels its owned in-flight work token.",
  );
}

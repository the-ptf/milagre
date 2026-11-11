// Actual Node forwarding + splitBody with synthetic fetch only. Never imports a service.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { splitBody, MAX_RESPONSE, CHUNK } from "../../../packages/shared/src/relay-rpc.mjs";
const source = readFileSync(new URL("../../../apps/daemon/src/phone-channels.cjs", import.meta.url), "utf8");
const rpc = readFileSync(new URL("../../../packages/shared/src/relay-rpc.mjs", import.meta.url), "utf8");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const functions = ["respond", "forward"]
  .map((name) => {
    const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
    assert.ok(match, name);
    return match[0];
  })
  .join("\n");
const constants = ["REQUEST_TIMEOUT", "BLOCKED_HEADERS", "FORWARDED_HEADERS"]
  .map((name) => {
    const match = source.match(new RegExp(`^const ${name} = .*;$`, "m"));
    assert.ok(match, name);
    return match[0];
  })
  .join("\n");
const make = Function(
  "fetchBridge",
  "sendMessage",
  "splitBody",
  "MAX_RESPONSE",
  `
${constants}
const bridgeUrl='http://synthetic.invalid', token='synthetic-http-bridge-token';
const encoder=new TextEncoder(), JSON_HEADERS={"content-type":"application/json"};
const AbortSignal={timeout:ms=>({ms})};
${functions}
return forward;
`,
);
const bytes = (spec) => (spec.hex !== undefined ? Buffer.from(spec.hex, "hex") : Buffer.alloc(spec.size, spec.byte));
const cases = [
  {
    name: "get-filter-and-ignore-body",
    request: {
      id: 1,
      method: "GET",
      path: "/rpc?x=1",
      headers: JSON.parse(
        '{"z":"last","10":"ten","2":"two","Host":"bad","ORIGIN":"bad","AUTHORIZATION":"bad","Connection":"bad","Content-Length":"1","Transfer-Encoding":"bad","Upgrade":"bad","Cookie":"bad","__proto__":"ignored","X-Test":"keep"}',
      ),
      body: { hex: "ff00" },
    },
    outcome: {
      kind: "response",
      status: 200,
      headers: { "Content-Type": " application/octet-stream\t", ETag: "one", etag: "two", "set-cookie": "secret", "x-other": "drop" },
      body: { hex: "ff000180" },
    },
  },
  {
    name: "post-lossless-json-bytes",
    request: {
      id: 2,
      method: "POST",
      path: "/rpc",
      headers: { "content-type": "application/json" },
      body: { hex: Buffer.from('{"lone":"\\ud800","pua":"\ue000"}').toString("hex") },
    },
    outcome: { kind: "response", status: 201, headers: {}, body: { hex: "" } },
  },
  {
    name: "empty-post-multipart",
    request: { id: 3, method: "POST", path: "/rpc", headers: {}, body: { hex: "" } },
    outcome: { kind: "response", status: 206, headers: { "content-type": "application/octet-stream" }, body: { size: CHUNK + 1, byte: 165 } },
  },
  ...["timeout", "unavailable", "too-large"].map((kind, i) => ({
    name: kind,
    request: { id: i + 4, method: "GET", path: "/rpc", headers: {}, body: { hex: "" } },
    outcome: { kind },
  })),
];
const observed = [];
for (const test of cases) {
  const frames = [];
  let plan;
  const forward = make(
    async (url, options) => {
      plan = {
        method: options.method,
        url,
        headers: options.headers,
        bodyBytes: options.body?.length ?? null,
        bodySha256: options.body ? digest(options.body) : null,
        timeoutMs: options.signal.ms,
      };
      if (test.outcome.kind === "timeout") throw { name: "TimeoutError" };
      if (test.outcome.kind === "unavailable") throw new Error("synthetic failure");
      const huge = test.outcome.kind === "too-large";
      return {
        status: huge ? 200 : test.outcome.status,
        headers: new Headers(test.outcome.headers),
        arrayBuffer: async () => (huge ? new ArrayBuffer(MAX_RESPONSE + 1) : bytes(test.outcome.body)),
      };
    },
    (_, __, ___, message) => frames.push(message),
    splitBody,
    MAX_RESPONSE,
  );
  const record = { inflight: 0, queue: [], queuedBytes: 0 };
  const current = { conns: new Map([[1, record]]) };
  await forward(current, 1, record, test.request, bytes(test.request.body));
  assert.equal(record.inflight, 0);
  const body = Buffer.concat(frames.map((f) => Buffer.from(f.chunk, "base64")));
  observed.push({
    plan,
    status: frames[0].status,
    headers: frames[0].headers,
    bodyBytes: body.length,
    bodySha256: digest(body),
    frames: frames.map((f) => digest(JSON.stringify(f))),
  });
}
const fixture = { sourceSha256: digest(source), rpcSha256: digest(rpc), cases, observed };
const path = new URL("./fixtures/http-node.json", import.meta.url);
if (process.argv[2] === "--record") writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
else {
  assert.deepEqual(fixture, JSON.parse(readFileSync(path, "utf8")));
  const rust = JSON.parse(execFileSync(process.argv[2], { input: JSON.stringify(cases), maxBuffer: 2 * 1024 * 1024 }));
  assert.deepEqual(rust, observed);
  console.log("Six actual Node forwarding traces match Rust plans, response bytes and every frame hash; synthetic fetch only.");
}

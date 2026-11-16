// Measures CPU and base64 payload, not cellular/relay round-trip latency or native Hermes performance.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { forPhone, forChatList } = require("../apps/daemon/src/mobile-bridge.cjs");
const { splitBody, createAssembler } = require("@milagre/shared/relay-rpc");
const messages = Array.from({ length: 1000 }, (_, i) => ({
  id: i + 3,
  session_id: Math.floor(i / 100) + 2,
  role: i % 2 ? "assistant" : "user",
  context: null,
  ...(i % 2 ? {} : { clientMessageId: "sent-input-" + i }),
  body: Array.from(
    { length: i % 2 ? 50 : 1 },
    (_, j) => `Change ${i}, line ${j}: verify component ${i * 31 + j} handles its state and keeps existing messages visible.\n`,
  ).join(""),
  steps: [],
}));
const sessions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 2, { id: i + 2, worktree_id: 1, title: "Chat " + i, status: "Idle" }]));
const project = { path: "/fixture", state: { sessions, worktrees: { 1: { id: 1, name: "main", path: "/fixture" } }, messages } };
const runs = { runs: {}, seq: 0 };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const kind of ["full", "summary"]) {
  const samples = [];
  let bytes, frames;
  for (let trial = 0; trial < 5; trial++) {
    const start = performance.now();
    const value = kind === "full" ? { project: forPhone(project), runs } : forChatList(project, runs);
    bytes = new TextEncoder().encode(JSON.stringify({ v: 1, result: value }));
    frames = splitBody(bytes);
    const encodedAt = performance.now();
    const assembler = createAssembler();
    let response;
    for (const [index, chunk] of frames.entries())
      response = assembler.add({ t: "res", id: 1, status: 200, headers: {}, chunk, more: index < frames.length - 1 });
    if (!response.done) throw new Error("Incomplete response");
    const parsed = JSON.parse(new TextDecoder().decode(response.body));
    if (!parsed.result.project.state.sessions[2]) throw new Error("Lost chat metadata");
    samples.push({ encodeMs: encodedAt - start, decodeMs: performance.now() - encodedAt });
  }
  const result = {
    kind,
    jsonBytes: bytes.length,
    base64Bytes: frames.reduce((sum, frame) => sum + frame.length, 0),
    frames: frames.length,
    encodeMedianMs: median(samples.map((sample) => sample.encodeMs)),
    decodeMedianMs: median(samples.map((sample) => sample.decodeMs)),
    samples,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
if (process.env.MILAGRE_BENCHMARK_OUTPUT) fs.writeFileSync(process.env.MILAGRE_BENCHMARK_OUTPUT, JSON.stringify(results, null, 2) + "\n");

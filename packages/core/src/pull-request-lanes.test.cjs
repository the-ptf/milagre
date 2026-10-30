const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

// Each child owns a fresh production pool, so a regression that deadlocks it cannot poison later tests.
// Stub only the OS process boundary, before loading the readers. Do not inject their exec argument:
// that would bypass the default adapter composition which originally acquired each Git slot twice.
const scenario = String.raw`
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");
const [reader, lane, failure] = process.argv.slice(1);
const active = { git: 0, gh: 0 };
const peak = { git: 0, gh: 0 };
let failing = failure;
const pr = { number: 810, url: "https://github.com/example/project/pull/810", state: "OPEN", headRefName: "feature" };
function execute(command, args, options, done) {
  active[command]++;
  peak[command] = Math.max(peak[command], active[command]);
  setImmediate(() => {
    active[command]--;
    const error = failing === command ? Object.assign(new Error("process failed"), { code: 1 }) : null;
    const stdout = command === "gh" ? JSON.stringify([pr]) : args.includes("symbolic-ref") ? "feature\n" : "/project\n";
    done(error, stdout, "");
  });
}
// Match Node's execFile promise API, including its { stdout, stderr } result.
execute[promisify.custom] = (...args) => new Promise((resolve, reject) => {
  execute(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
childProcess.execFile = execute;
const { lanes, LIMITS, background } = require("./process-lanes.cjs");
const { createGit } = require("./git/client.cjs");
const { readPullRequestState, createPullRequestReader } = require("./pull-request.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const empty = { running: 0, interactive: 0, background: 0 };
const read = reader === "state" ? readPullRequestState : createPullRequestReader({ ttlMs: 0 });
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ git: lanes.stats("git"), gh: lanes.stats("gh"), active }));
  process.exit(1);
}, 3000);
(async () => {
  const burst = () => Promise.all(Array.from({ length: LIMITS.git }, (_, i) => read("/project/" + i)));
  const reads = lane === "background" ? background(burst) : burst();
  // Let all readers acquire their slots before another independent Git caller arrives.
  await tick();
  assert.equal(active.git, LIMITS.git - (lane === "background" ? 1 : 0), "Git leaves its background reserve free");
  const independent = createGit().read.out("/project", ["rev-parse", "--show-toplevel"]);
  const [results, root] = await Promise.all([reads, independent]);
  assert.equal(root, failure === "git" ? null : "/project");
  for (const result of results) {
    if (failure !== "none") assert.deepEqual(result, reader === "state" ? { known: false, pr: null } : null);
    else assert.equal((reader === "state" ? result.pr : result).number, 810);
  }
  await tick();
  for (const kind of ["git", "gh"]) {
    assert.deepEqual(lanes.stats(kind), empty);
    assert.equal(active[kind], 0);
    assert.ok(peak[kind] <= LIMITS[kind]);
  }
  if (failure === "none") {
    assert.equal(peak.gh, LIMITS.gh - (lane === "background" ? 1 : 0), "gh still obeys its pool and background reserve");
  }
  // Errors must free their slots: healthy work on the same pool and same reader can recover.
  failing = "none";
  const recovered = await burst();
  for (const result of recovered) assert.equal((reader === "state" ? result.pr : result).number, 810);
  await tick();
  for (const kind of ["git", "gh"]) assert.deepEqual(lanes.stats(kind), empty);
  clearTimeout(watchdog);
})().catch((error) => { console.error(error); process.exit(1); });
`;

for (const reader of ["state", "batched"]) {
  for (const lane of ["interactive", "background"]) {
    for (const failure of ["none", "git", "gh"]) {
      test(`default ${reader} reader: eight ${lane} reads, ${failure} failure, independent Git and recovery`, async () => {
        const result = await promisify(execFile)(process.execPath, ["-e", scenario, reader, lane, failure], { cwd: __dirname, timeout: 10_000 });
        assert.equal(result.stderr, "");
      });
    }
  }
}

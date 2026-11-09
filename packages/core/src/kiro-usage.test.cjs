const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createKiroUsage, parseKiroUsage, removeSessionsIn } = require("./kiro-usage.cjs");

const USAGE = `\x1b[1mEstimated Usage\x1b[0m | resets on 2026-11-01 | KIRO POWER
Credits (452.97 of 10000 covered in plan), 4.5%
Overages: Disabled
`;

test("/usage becomes the month's window, with the amounts as its detail", () => {
  assert.deepEqual(parseKiroUsage(USAGE), {
    window: {
      id: "kiro:month",
      label: "Kiro credits",
      shortLabel: "mo",
      usedPercent: 4.5297,
      resetsAt: "2026-11-01T00:00:00.000Z",
      detail: "452.97 of 10,000 credits",
    },
    plan: "KIRO POWER",
  });
  assert.equal(parseKiroUsage("Not logged in"), null);
});

test("the first read waits briefly, later reads answer at once and refresh when the numbers are old", async () => {
  let clock = 0;
  let asked = 0;
  let release;
  const ask = () => {
    asked += 1;
    return asked === 1 ? new Promise((resolve) => (release = () => resolve({ output: USAGE }))) : Promise.resolve({ output: USAGE.replace("452.97", "500") });
  };
  const read = createKiroUsage({ cli: async () => ({ command: "/k" }), ask, now: () => clock, firstWaitMs: 5, freshMs: 1000 });
  const first = await read();
  assert.equal(first.status, "unavailable");
  assert.match(first.message, /Reading/);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await read()).windows[0].detail, "452.97 of 10,000 credits");
  assert.equal(asked, 1);
  clock = 2000;
  // Old numbers answer at once while the next read runs.
  assert.equal((await read()).windows[0].detail, "452.97 of 10,000 credits");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await read()).windows[0].detail, "500 of 10,000 credits");
});

test("a missing or signed-out kiro-cli leaves Kiro out of the sidebar", async () => {
  const missing = createKiroUsage({ cli: async () => ({ command: null, problem: "missing" }), firstWaitMs: 50 });
  assert.equal((await missing()).status, "unavailable");
  const signedOut = createKiroUsage({ cli: async () => ({ command: "/k" }), ask: async () => ({ output: "Not logged in\n" }), firstWaitMs: 50 });
  assert.equal((await signedOut()).status, "unavailable");
});

test("only the session records /usage left in its own folder are removed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-kiro-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".kiro", "sessions", "cli");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, cwd] of [
    ["mine", "/tmp/milagre-kiro-usage-x"],
    ["theirs", "/Users/me/project"],
  ]) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ session_id: id, cwd }));
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), "");
  }
  await removeSessionsIn("/tmp/milagre-kiro-usage-x", home);
  assert.deepEqual(fs.readdirSync(dir).toSorted(), ["theirs.json", "theirs.jsonl"]);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { addedLines, createPrGuides, shapeGuide } = require("./pr-guide.cjs");

const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " one", "-two", "+TWO", "+three", " four"].join("\n");
const pr = {
  number: 7,
  title: "fix",
  body: "",
  files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
  headRefOid: "a".repeat(40),
  url: "https://github.com/a/b/pull/7",
};

test("addedLines reads new-file line numbers from hunks", () => {
  assert.deepEqual([...addedLines(PATCH)], [2, 3]);
});

test("shapeGuide keeps only what the PR has and copies code from the head commit", async () => {
  const parsed = {
    stops: [
      {
        title: "The change",
        kind: "implementation",
        summary: "It changes two.",
        attention: { kind: "risk", text: "Check the caller." },
        excerpts: [
          {
            path: "src/a.ts",
            startLine: 1,
            endLine: 400,
            notes: [
              { line: 2, text: "Renamed." },
              { line: 99, text: "Out of range." },
            ],
          },
          { path: "src/invented.ts", startLine: 1, endLine: 3, notes: [] },
        ],
        files: [
          { path: "src/a.ts", note: "Main" },
          { path: "nope.ts", note: "Made up" },
        ],
        questions: ["Is TWO right?", ""],
      },
      { title: "", kind: "ui", summary: "No title", excerpts: [], files: [], questions: [] },
    ],
  };
  const guide = await shapeGuide(parsed, { pr, patches: new Map([["src/a.ts", PATCH]]), show: async () => "one\nTWO\nthree\nfour" });
  assert.equal(guide.stops.length, 1);
  const [stop] = guide.stops;
  assert.deepEqual(stop.attention, { kind: "risk", text: "Check the caller." });
  assert.equal(stop.excerpts.length, 1);
  assert.deepEqual(stop.excerpts[0].lines, [
    { number: 1, text: "one", added: false },
    { number: 2, text: "TWO", added: true },
    { number: 3, text: "three", added: true },
    { number: 4, text: "four", added: false },
  ]);
  assert.deepEqual(stop.excerpts[0].notes, [{ letter: "A", line: 2, text: "Renamed." }]);
  assert.deepEqual(stop.files, [{ path: "src/a.ts", note: "Main" }]);
  assert.deepEqual(stop.questions, ["Is TWO right?"]);
  assert.deepEqual(guide.notCovered, []);
});

test("a written guide is saved per PR, with the stops read, and rewriting clears them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pr-guides-"));
  const review = {
    detail: async () => ({ ok: true, pr: { ...pr, baseRefOid: "b".repeat(40) } }),
    diffFiles: async () => ({ isRepo: true, files: [{ path: "src/a.ts", binary: false }] }),
    diffFile: async () => ({ patch: PATCH }),
  };
  const prompts = [];
  const answer = JSON.stringify({
    stops: [{ title: "Stop", kind: "ui", summary: "S", attention: null, excerpts: [], files: [{ path: "src/a.ts", note: "n" }], questions: [] }],
  });
  const guides = createPrGuides({
    review,
    directory,
    models: () => ({
      claude: async () => {
        throw new Error("signed out");
      },
      codex: async ({ prompt }) => (prompts.push(prompt), answer),
    }),
    now: () => new Date("2026-10-25T12:00:00Z"),
  });
  const cwd = directory;
  assert.deepEqual(await guides.read({ url: pr.url }), { ok: true, guide: null, read: [], writing: false });
  assert.deepEqual(await guides.write({ cwd, number: 7, url: pr.url, provider: "claude" }), { ok: true, writing: true });
  assert.equal((await guides.read({ url: pr.url })).writing, true);
  await guides.settled();
  const saved = await guides.read({ url: pr.url });
  // Claude failed, so Codex wrote it.
  assert.equal(saved.guide.provider, "codex");
  assert.equal(saved.guide.stops[0].title, "Stop");
  assert.ok(prompts[0].includes("+TWO"));
  assert.deepEqual(await guides.markRead({ url: pr.url, stop: 0 }), { ok: true });
  assert.deepEqual((await guides.read({ url: pr.url })).read, [0]);
  await guides.write({ cwd, number: 7, url: pr.url, provider: "codex" });
  await guides.settled();
  assert.deepEqual((await guides.read({ url: pr.url })).read, []);
  await fs.rm(directory, { recursive: true, force: true });
});

test("a guide no model could write reports why", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pr-guides-"));
  const guides = createPrGuides({
    review: { detail: async () => ({ ok: false, message: "Sign in to GitHub on this Mac with `gh auth login`, then try again." }) },
    directory,
    models: () => ({}),
  });
  await guides.write({ cwd: directory, number: 7, url: pr.url });
  await guides.settled();
  const result = await guides.read({ url: pr.url });
  assert.equal(result.guide, null);
  assert.match(result.error, /gh auth login/);
  await fs.rm(directory, { recursive: true, force: true });
});

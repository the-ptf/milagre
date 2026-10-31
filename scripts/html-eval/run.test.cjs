const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, loadCases } = require("./run.cjs");
const { runSession, SYSTEM_PROMPT } = require("./session.cjs");
test("CLI rejects invalid bounds and duplicate case identifiers", () => {
  assert.throws(() => parseArgs(["--concurrency", "4"]));
  assert.throws(() => parseArgs(["--repeat", "1.5"]));
  assert.throws(() => parseArgs(["--budget", "NaN"]));
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "html-eval-test-"));
  try {
    const file = path.join(dir, "cases.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        cases: [
          { id: "a", prompt: "x" },
          { id: "a", prompt: "y" },
        ],
      }),
    );
    assert.throws(() => loadCases(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("successful CLI without a published HTML is failed and private config is removed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "html-eval-test-"));
  try {
    fs.mkdirSync(path.join(root, "sessions"));
    fs.mkdirSync(path.join(root, "private"));
    const cli = path.join(root, "fake-cli");
    fs.writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",is_error:false,total_cost_usd:0}));\n', { mode: 0o700 });
    const r = await runSession({
      root,
      caseSpec: { id: "empty", prompt: "x" },
      iteration: 1,
      model: "fake",
      cli,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: 3000,
      maxBudget: 2,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.exit.code, 0);
    assert.equal(r.finalHtml, null);
    assert.deepEqual(fs.readdirSync(path.join(root, "private")), []);
    await assert.rejects(runSession({ root, caseSpec: { id: "empty", prompt: "x" }, iteration: 1 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("timed-out CLI remains failed with cleanup and evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "html-eval-test-"));
  try {
    fs.mkdirSync(path.join(root, "sessions"));
    fs.mkdirSync(path.join(root, "private"));
    const cli = path.join(root, "fake-cli");
    fs.writeFileSync(cli, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o700 });
    const r = await runSession({
      root,
      caseSpec: { id: "timeout", prompt: "x" },
      iteration: 1,
      model: "fake",
      cli,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: 150,
      maxBudget: 2,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.timedOut, true);
    assert.deepEqual(fs.readdirSync(path.join(root, "private")), []);
    assert.ok(fs.existsSync(r.sessionFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

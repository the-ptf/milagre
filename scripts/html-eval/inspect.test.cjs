const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { coverage, loadReview } = require("./inspect.cjs");

test("placeholder, stale, failed and unfinished previews cannot validate final HTML", () => {
  const final = { htmlSha256: "final", startedAt: "2026-10-31T12:00:10Z" };
  const preview = { tool: "html_preview", htmlSha256: "final", finishedAt: "2026-10-31T12:00:09Z", input: { width: 375 } };
  for (const invalid of [
    { ...preview, htmlSha256: "placeholder" },
    { ...preview, isError: true },
    { ...preview, finishedAt: undefined },
    { ...preview, finishedAt: "2026-10-31T12:00:11Z" },
  ])
    assert.equal(coverage([invalid], final).finalHtmlPreviewedBeforeRender, false);
  assert.equal(coverage([preview], final).width375, true);
});

test("width adherence stays distinct from full QA matrix", () => {
  const final = { htmlSha256: "same", startedAt: "2026-10-31T12:00:10Z" };
  const calls = [375, 720].map((width) => ({
    tool: "html_preview",
    htmlSha256: "same",
    finishedAt: "2026-10-31T12:00:09Z",
    input: { width, appearance: "light" },
  }));
  const result = coverage(calls, final);
  assert.equal(result.width375 && result.width720, true);
  assert.equal(result.anyDark, false);
  assert.equal(result.fullQaMatrix, false);
  const current = coverage(calls, final, 340);
  assert.equal(current.widthNarrow, false, "historical 375 previews cannot satisfy a current 340 requirement");
  assert.ok(current.missingFinalHtml.includes("340/light"));
  const newCalls = calls.map((call) => ({ ...call, input: { ...call.input, width: call.input.width === 375 ? 340 : 720 } }));
  assert.equal(coverage(newCalls, final, 340).widthNarrow, true);
});

test("review requires explicit evidence, hash and all dimensions including untested", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "html-eval-review-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "review.json");
  const review = {
    reviewer: "tester",
    htmlSha256: "a".repeat(64),
    evidence: ["state.png"],
    scores: { correctness: 4, legibility: 3, responsiveness: 3, interaction: null, integration: 3 },
    findings: [],
  };
  const write = (value) => fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { example: value } }));
  write(review);
  assert.equal(loadReview(file).sessions.example.scores.interaction, null);
  write({ ...review, evidence: [] });
  assert.throws(() => loadReview(file), /evidence/);
  write({ ...review, scores: { ...review.scores, interaction: undefined } });
  assert.throws(() => loadReview(file), /interaction/);
});

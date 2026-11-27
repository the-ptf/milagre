import assert from "node:assert/strict";
import test from "node:test";
import { mentionsPullRequestUrl, parseReviewReport, reviewBabysitChanges, reviewCounts, reviewFixMessage, reviewForMePrompt } from "./pr-review.mjs";
import type { ReviewFinding } from "./pr-review.d.mts";

const pr = { url: "https://github.com/acme/web/pull/12", repo: "acme/web", number: 12, title: "Fix login" };

test("Review for me asks for findings, and to report them to Milagre when the review agent is on", () => {
  assert.match(reviewForMePrompt(pr), /^Review pull request https:\/\/github\.com\/acme\/web\/pull\/12 \(acme\/web#12: Fix login\)/);
  assert.doesNotMatch(reviewForMePrompt(pr), /pr_review_report/);
  assert.match(reviewForMePrompt(pr, { report: true }), /pr_review_report/);
});

test("a task names a PR only by its exact URL", () => {
  assert.equal(mentionsPullRequestUrl(`Review ${pr.url} (x)`, pr.url), true);
  assert.equal(mentionsPullRequestUrl(`Review ${pr.url}3`, pr.url), false);
  assert.equal(mentionsPullRequestUrl(`Review ${pr.url}/files`, pr.url), false);
});

test("a report is checked, trimmed and sorted high first", () => {
  const parsed = parseReviewReport({
    url: `${pr.url}/`,
    summary: "  Two issues. ",
    findings: [
      { path: "a.ts", line: 3, severity: "low", title: "Nit", body: "" },
      { path: "b.ts", line: 0, severity: "high", title: "Crash", body: "Throws", suggestion: "Guard it" },
    ],
  });
  assert.ok(!(parsed instanceof Error));
  assert.equal(parsed.url, pr.url);
  assert.equal(parsed.summary, "Two issues.");
  assert.deepEqual(
    parsed.findings.map((finding) => [finding.severity, finding.line, finding.suggestion]),
    [
      ["high", null, "Guard it"],
      ["low", 3, null],
    ],
  );
  assert.match(String(parseReviewReport({ url: "https://example.com/x", findings: [] })), /url must be/);
  assert.match(String(parseReviewReport({ url: pr.url })), /findings must be a list/);
  assert.match(String(parseReviewReport({ url: pr.url, findings: [{ path: "a", severity: "urgent", title: "x" }] })), /Finding 1 needs/);
});

const finding = (change: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1",
  path: "src/app.ts",
  line: 7,
  severity: "high",
  title: "Null deref",
  body: "user can be null",
  suggestion: "Return early",
  status: "open",
  ...change,
});

test("counts leave dismissed findings out", () => {
  assert.deepEqual(reviewCounts({ findings: [finding({}), finding({ id: "f2", severity: "low" }), finding({ id: "f3", status: "dismissed" })] }), {
    open: 2,
    high: 1,
    medium: 0,
    low: 1,
  });
  assert.deepEqual(reviewCounts(null), { open: 0, high: 0, medium: 0, low: 0 });
});

test("Fix in Chat and Babysit say where, what and the suggested fix", () => {
  assert.equal(
    reviewFixMessage(pr.url, [finding({})]),
    `Fix these review findings on ${pr.url}:\n\n- [high] src/app.ts:7: Null deref\n  user can be null\n  Suggested fix: Return early`,
  );
  assert.deepEqual(reviewBabysitChanges([finding({ line: null })]), [
    { id: "review:f1", text: "Review finding (high) at src/app.ts: Null deref. Suggested fix: Return early" },
  ]);
});

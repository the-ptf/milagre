import assert from "node:assert/strict";
import test from "node:test";
import { mentionsPullRequest, reviewPrompt, reviewingUrls } from "./review-for-me.ts";

const URL = "https://github.com/acme/app/pull/12";

test("the review prompt names the PR and keeps the agent read-only", () => {
  const prompt = reviewPrompt({ url: URL, repo: "acme/app", number: 12, title: "Fix the flush" });
  assert.match(prompt, /^Review pull request https:\/\/github\.com\/acme\/app\/pull\/12 \(acme\/app#12: Fix the flush\)\./);
  assert.match(prompt, /Don't push, comment on GitHub, approve or merge\.$/);
});

test("a task reviews a PR only while it runs and only when its prompt names that exact PR", () => {
  assert.equal(mentionsPullRequest(`Review pull request ${URL} (x)`, URL), true);
  assert.equal(mentionsPullRequest(`Review pull request ${URL}3 (x)`, URL), false);
  assert.equal(mentionsPullRequest(`see ${URL}/files`, URL), false);
  const cards = [
    { column: "running", task: { prompt: reviewPrompt({ url: URL, repo: "acme/app", number: 12, title: "t" }) } },
    { column: "done", task: { prompt: `Review pull request ${URL}4` } },
    { column: "running", task: { prompt: "Something else" } },
  ];
  assert.deepEqual([...reviewingUrls(cards, [URL, `${URL}4`])], [URL]);
});

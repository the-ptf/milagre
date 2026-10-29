import assert from "node:assert/strict";
import test from "node:test";
import { associatedPullRequest } from "./chats.mjs";

const first = { url: "https://github.com/team/first/pull/12", cwd: "/work/first" };
const second = { url: "https://github.com/team/second/pull/12", cwd: "/work/second" };

test("associated PR links match their repository, including files, checks, comments and case variants", () => {
  for (const suffix of ["", "/", "/files", "/checks?check_run_id=123", "#issuecomment-123", "/commits/abc"]) {
    assert.equal(associatedPullRequest(`https://github.com/TEAM/second/pull/12${suffix}`, [first, second]), second);
  }
});

test("unrelated and malformed links cannot select a Chat's PR by number alone", () => {
  for (const url of [
    "https://github.com/team/third/pull/12",
    "https://example.com/team/second/pull/12",
    "https://github.com/team/second/pull/123",
    "https://github.com/team/second/pull/12wrong",
    "https://github.com/team/second/issues/12",
    "https://github.com@evil.example/team/second/pull/12",
    "https://github.com:8080/team/second/pull/12",
    "javascript:alert(1)",
    "/team/second/pull/12",
  ])
    assert.equal(associatedPullRequest(url, [first, second]), undefined, url);
  assert.equal(associatedPullRequest(second.url, []), undefined);
});

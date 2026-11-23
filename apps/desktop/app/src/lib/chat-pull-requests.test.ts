import assert from "node:assert/strict";
import test from "node:test";
import { chatPullRequests, ownsWorktree, pullRequestRefs, pullRequestRefsCache, rowPullRequests } from "./chat-pull-requests.ts";
import type { ChatStep } from "../model.ts";

const url = (n: number) => `https://github.com/example/repo/pull/${n}`;
const shell = (detail: string, status: "done" | "failed" = "done"): ChatStep => ({ id: detail, kind: "shell", title: "Ran", status, detail });
const reply = (...steps: ChatStep[]) => ({ steps });
const pr = (
  number: number,
  extra: Partial<{ state: "OPEN" | "MERGED"; hasConflicts: boolean; readyToMerge: boolean; isBehind: boolean; changesRequested: boolean }> = {},
) => ({ number, url: url(number), title: `PR ${number}`, state: "OPEN" as const, readyToMerge: false, hasConflicts: false, ...extra });

test("finds the URL gh prints after creating a PR", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(shell(`$ git push -u origin HEAD && gh pr create --title "Add chips" --body "Closes #44"\nbranch 'x' set up to track 'origin/x'.\n${url(84)}\n`)),
    ]),
    [url(84)],
  );
});

test("keeps creation order across replies and drops repeats", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(shell(`$ gh pr create --fill\n${url(84)}`)),
      reply(shell(`$ gh pr create --fill\n${url(90)}`), shell(`$ gh pr create --fill\n${url(84)}`)),
    ]),
    [url(84), url(90)],
  );
});

test("ignores PR URLs from other gh commands and failed steps", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(
        shell(`$ gh pr list --json url\n${url(70)}`),
        shell(`$ gh pr view 71\ntitle: Something\nurl: ${url(71)}`),
        shell(`$ gh pr create --fill\n${url(72)}`, "failed"),
        { ...shell(`$ gh pr create\n${url(73)}`), kind: "edit" },
      ),
    ]),
    [],
  );
});

test("a URL inside the PR body is not the created PR", () => {
  const detail = `$ gh pr create --title "Follow-up" --body "$(cat <<'EOF'\nFollows ${url(80)} and\n${url(81)}\nEOF\n)"\n${url(82)}`;
  // Only the last bare URL line is what gh printed; the body's lines come first.
  assert.deepEqual(pullRequestRefs([reply(shell(detail))]), [url(82)]);
});

test("merged PRs come from the merge command's argument", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(
        shell("$ gh pr merge 88 --squash --delete-branch\n"),
        shell(`$ gh pr merge ${url(90)} --squash`),
        shell("$ cd /tmp/x && gh pr merge -R example/other 12 --merge --subject 'Ship it'"),
        shell('$ gh pr merge --squash --body "long body" 91; echo done'),
      ),
    ]),
    ["88", url(90), "https://github.com/example/other/pull/12", "91"],
  );
});

test("merging the current branch adds nothing: the branch PR already shows", () => {
  assert.deepEqual(pullRequestRefs([reply(shell("$ gh pr merge --squash --auto"))]), []);
});

test("refuses arguments that could be read as gh flags or paths", () => {
  assert.deepEqual(pullRequestRefs([reply(shell("$ gh pr merge $PR --squash"), shell("$ gh pr merge feature/x"))]), []);
});

test("a merged number matching a created URL is the same PR", () => {
  assert.deepEqual(pullRequestRefs([reply(shell(`$ gh pr create --fill\n${url(88)}`), shell("$ gh pr merge 88 --squash"))]), [url(88)]);
});

test("the chat's PRs keep creation order and include the branch PR once", () => {
  const found = { [url(84)]: pr(84, { state: "MERGED" }), "88": pr(88), [url(90)]: null };
  assert.deepEqual(
    chatPullRequests([url(84), "88", url(90)], found, pr(92)).map((item) => item.number),
    [84, 88, 92],
  );
  assert.deepEqual(
    chatPullRequests([url(84), "88"], found, pr(88)).map((item) => item.number),
    [84, 88],
  );
  assert.deepEqual(chatPullRequests([], {}, undefined), []);
});

test("a PR the chat named that is also the branch PR uses the branch's fresher copy", () => {
  const found = { "88": pr(88) };
  const [only] = chatPullRequests(["88"], found, pr(88, { changesRequested: true }));
  assert.equal(only.changesRequested, true);
});

test("the row shows PRs that need attention first, then the rest in order", () => {
  const prs = [
    pr(84, { state: "MERGED" }),
    pr(88),
    pr(90, { hasConflicts: true }),
    pr(91, { readyToMerge: true }),
    pr(92, { isBehind: true }),
    pr(93, { changesRequested: true }),
  ];
  assert.deepEqual(
    rowPullRequests(prs).map((item) => item.number),
    [90, 92, 93, 88, 91, 84],
  );
});

test("the refs cache rescans a chat only when one of its messages is a different object", () => {
  const read = pullRequestRefsCache();
  const first = reply(shell(`$ gh pr create --fill\n${url(88)}`));
  const refs = read("a#1", [first]);
  assert.deepEqual(refs, [url(88)]);
  assert.equal(read("a#1", [first]), refs);
  assert.notEqual(read("a#1", [first, reply()]), refs);
  assert.deepEqual(read("a#1", [reply(shell(`$ gh pr create --fill\n${url(89)}`))]), [url(89)]);
  assert.deepEqual(read("a#2", [first]), [url(88)]);
});

test("a push links the branches git reports, or the refspecs when it printed none", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(
        shell(
          "$ git push -u origin HEAD\nTo github.com:example/repo.git\n * [new branch]      HEAD -> fix/login\nbranch 'fix/login' set up to track 'origin/fix/login'.",
        ),
        shell("$ cd app && git push 2>&1 | tail -3\nTo github.com:example/repo.git\n   861d7fc7..1034ef67  fix/login -> fix/login"),
        shell("$ git push --force-with-lease origin feat/chips\nTo github.com:example/repo.git\n + 1a2b3c4...5d6e7f8 feat/chips -> feat/chips (forced update)"),
        shell("$ git push -q -u origin fix/quiet && gh pr view --web"),
        shell("$ git push origin HEAD:refs/heads/fix/renamed"),
      ),
    ]),
    ["push:fix/login", "push:feat/chips", "push:fix/quiet", "push:fix/renamed"],
  );
});

test("a failed push, a deletion, tags and a bare HEAD link nothing", () => {
  assert.deepEqual(
    pullRequestRefs([
      reply(
        shell("$ git push origin fix/failed\n ! [rejected]        fix/failed -> fix/failed (fetch first)", "failed"),
        shell("$ git push origin --delete old/branch\nTo github.com:example/repo.git\n - [deleted]         old/branch"),
        shell("$ git push --tags\nTo github.com:example/repo.git\n * [new tag]         v1.0 -> v1.0"),
        shell("$ git push -q origin HEAD"),
        shell("$ git push origin -- --upload-pack=x ../escape"),
      ),
    ]),
    [],
  );
});

test("a Chat owns its Worktree only outside the Project folder and with no other open Chat in it", () => {
  const state = {
    sessions: {
      1: { id: 1, worktree_id: 1 },
      2: { id: 2, worktree_id: 1 },
      3: { id: 3, worktree_id: 2 },
      4: { id: 4, worktree_id: 3 },
      5: { id: 5, worktree_id: 3, archived: true },
    },
    worktrees: { 1: { path: "/repo" }, 2: { path: "/repo-chips" }, 3: { path: "/repo-login" } },
  };
  assert.equal(ownsWorktree(state, 1, "/repo"), false, "the Project folder is shared by every Local Chat");
  assert.equal(ownsWorktree({ ...state, sessions: { 1: state.sessions[1] } }, 1, "/repo"), false, "even with one Chat in it");
  assert.equal(ownsWorktree(state, 3, "/repo"), true);
  assert.equal(ownsWorktree(state, 4, "/repo"), true, "an archived Chat doesn't share the Worktree");
  assert.equal(ownsWorktree({ ...state, sessions: { ...state.sessions, 6: { id: 6, worktree_id: 2 } } }, 3, "/repo"), false);
  assert.equal(ownsWorktree(state, 99, "/repo"), false);
  assert.equal(ownsWorktree(null, 1, "/repo"), false);
});

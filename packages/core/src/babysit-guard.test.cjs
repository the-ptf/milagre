const assert = require("node:assert/strict");
const test = require("node:test");
const { babysitDenial } = require("./babysit-guard.cjs");

const at = (level, resolveThreads = level >= 4) => ({ level, resolveThreads });
const SETTINGS = "Change it in Settings › Experimental › Babysit PRs.";
const UNREADABLE = "Babysitting can't check a request body read from a file, so it's blocked.";
const denied = (command, guard) => assert.notEqual(babysitDenial(command, guard), null, command);
const allowed = (command, guard) => assert.equal(babysitDenial(command, guard), null, command);

test("report only denies git push", () => {
  assert.equal(babysitDenial("git push", at(1)), `Babysit level Report only doesn't allow pushing to GitHub. ${SETTINGS}`);
  assert.equal(babysitDenial("git push --force-with-lease origin HEAD", at(2)), `Babysit level Fix, don't push doesn't allow pushing to GitHub. ${SETTINGS}`);
});

test("fix and push allows git push", () => {
  for (const level of [3, 4, 5]) allowed("git push origin HEAD", at(level));
  allowed("git commit -m 'fix' && git push", at(3));
});

test("push is caught through git options, env prefixes and wrappers", () => {
  for (const command of [
    "git -C /repo push",
    "git -c user.name=x push origin",
    "git --no-pager push",
    "git --git-dir /repo/.git push",
    "/usr/bin/git push",
    "FOO=1 git push",
    "env GIT_TRACE=1 git push",
    "sudo -u me git push",
    "nohup git push &",
    "echo origin | xargs git push",
    "git -c alias.ship=push ship",
    "git send-pack origin main",
    "git subtree push --prefix=docs origin gh-pages",
    "gh pr update-branch 4",
    "gh pr update-branch 4 --rebase",
    "gh repo sync owner/fork --branch main",
    "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
    "gh api --method PUT repos/o/r/pulls/1/update-branch",
    "gh api --method PUT repos/o/r/pulls/1/update-branch/",
    "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'",
  ])
    denied(command, at(2));
  // Reading is fine at every level.
  allowed("git status && git log --oneline -3 && git fetch origin", at(1));
  allowed("gh api repos/o/r/git/refs/heads/main", at(1));
});

test("words in quotes are not commands", () => {
  allowed(`git commit -m "don't git push yet; gh pr merge later"`, at(2));
  allowed(`echo 'git push' > notes.txt`, at(1));
  allowed(`grep -rn "gh pr comment" docs`, at(1));
});

test("level 3 denies gh pr comment", () => {
  assert.equal(babysitDenial('gh pr comment 42 --body "Fixed in abc123"', at(3)), `Babysit level Fix and push doesn't allow replying on GitHub. ${SETTINGS}`);
  for (const command of [
    "gh pr review 42 --comment -b 'done'",
    "gh issue comment 42 --body hi",
    "gh api -X POST repos/o/r/pulls/42/comments/7/replies -f body=done",
    "gh api --method=POST repos/o/r/issues/42/comments -f body=done",
    "gh api repos/o/r/issues/42/comments -f body=done",
    "gh api -XPATCH repos/o/r/issues/comments/9 -f body=edited",
    "gh api repos/o/r/pulls/42/reviews --input review.json",
    `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'`,
    `gh api graphql -F query='mutation($id: ID!) { addPullRequestReviewComment(input: {}) { clientMutationId } }'`,
    `gh api graphql --raw-field query='mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }'`,
  ])
    denied(command, at(3));
  allowed("gh api repos/o/r/pulls/42/comments", at(3));
  allowed("gh api -X GET repos/o/r/issues/42/comments", at(3));
  allowed("gh pr view 42 --comments && gh pr checks 42", at(1));
});

test("level 4 allows gh pr comment", () => {
  allowed('gh pr comment 42 --body "Fixed in abc123 <!-- milagre-babysit -->"', at(4));
  allowed("gh api -X POST repos/o/r/pulls/42/comments/7/replies -f body=done", at(4));
  allowed(`gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'`, at(4));
});

test("re-requesting review needs level 5", () => {
  const reason = `Babysit level Fix, push and reply doesn't allow re-requesting review. ${SETTINGS}`;
  assert.equal(babysitDenial("gh pr edit 42 --add-reviewer alice", at(4)), reason);
  denied("gh pr edit 42 --add-reviewer=alice", at(4));
  denied("gh api -X POST repos/o/r/pulls/42/requested_reviewers -f 'reviewers[]=alice'", at(4));
  denied("gh api -X POST repos/o/r/pulls/42/requested_reviewers/ -f 'reviewers[]=alice'", at(4));
  denied(`gh api graphql -f query='mutation { requestReviews(input: {pullRequestId: "x", userIds: ["y"]}) { clientMutationId } }'`, at(4));
  allowed("gh pr edit 42 --add-reviewer alice", at(5));
  allowed("gh pr edit 42 --add-reviewer alice -R o/r", at(5));
  allowed("gh api repos/o/r/pulls/42/requested_reviewers", at(1));
});

test("resolve denied when switch off", () => {
  const resolve = `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "t"}) { thread { isResolved } } }'`;
  assert.equal(
    babysitDenial(resolve, at(5, false)),
    `Babysit level Fix, push, reply and re-request review doesn't allow resolving review threads. ${SETTINGS}`,
  );
  denied(resolve, at(3, true));
  allowed(resolve, at(4, true));
  // Reading threads is not resolving them.
  allowed(
    `gh api graphql -f query='query { repository(owner: "o", name: "r") { pullRequest(number: 1) { reviewThreads(first: 50) { nodes { isResolved } } } } }'`,
    at(1),
  );
});

test("merge is always denied", () => {
  for (const level of [1, 2, 3, 4, 5]) {
    assert.equal(babysitDenial("gh pr merge 42 --squash", at(level)), "Babysitting never merges.");
    assert.equal(babysitDenial("gh api -X PUT repos/o/r/pulls/42/merge", at(level)), "Babysitting never merges.");
    assert.equal(babysitDenial("gh api -X PUT /repos/o/r/pulls/42/merge/", at(level)), "Babysitting never merges.");
    assert.equal(
      babysitDenial(`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, at(level)),
      "Babysitting never merges.",
    );
    assert.equal(
      babysitDenial(`gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'`, at(level)),
      "Babysitting never merges.",
    );
  }
  // Merging the base into the branch locally is how conflicts get fixed.
  allowed("git merge origin/main", at(2));
});

test("chained push is caught", () => {
  for (const command of [
    "npm test && git push",
    "npm test || git push",
    "npm test; git push",
    "npm test & git push",
    "git status | git push",
    "npm test\ngit push",
    "bash -c 'npm test && git push'",
    `sh -c "git -C /repo push"`,
    "zsh -lc 'git push'",
    "echo $(git push)",
    "echo `git push`",
    `eval "git push"`,
    "(cd /repo && git push)",
    "{ git push; }",
    "if true; then git push; fi",
  ])
    denied(command, at(2));
});

test("a GraphQL body piped in or read from a file is checked", () => {
  denied(`echo '{"query":"mutation { mergePullRequest(input: {}) { clientMutationId } }"}' | gh api graphql --input -`, at(5));
  denied(`gh api graphql --input - <<'EOF'\n{"query":"mutation { resolveReviewThread(input: {}) { clientMutationId } }"}\nEOF`, at(3, false));
  // A file can't be read here, so a GraphQL call from one is refused whatever the level, and no setting changes that.
  const unreadable = "Babysitting can't check a GraphQL request read from a file, so it's blocked.";
  assert.equal(babysitDenial("gh api graphql --input body.json", at(5)), unreadable);
  assert.equal(babysitDenial("gh api graphql -F query=@mutation.graphql", at(1)), unreadable);
  allowed("gh api graphql -f query='query { viewer { login } }'", at(1));
});

test("a heredoc's body is text, not commands", () => {
  // Claude Code's own way of writing a commit message.
  allowed(`git commit -m "$(cat <<'EOF'\nFix the flaky test\n\nDon't git push until CI is green; gh pr merge later.\nEOF\n)"`, at(2));
  allowed(`gh pr comment 4 --body-file - <<'EOF'\nFixed in abc123. I won't gh pr merge this myself.\nEOF`, at(4));
  allowed(`cat <<-"NOTE" > notes.txt\n\tgit push when ready\n\tNOTE\nnpm test`, at(1));
  allowed(`cat <<EOF > notes.txt\ngit push\nEOF`, at(1));
  // What follows the body is still checked, and so is a command on the heredoc's own line.
  denied(`cat <<'EOF' > notes.txt\nnothing here\nEOF\ngit push`, at(2));
  denied(`cat <<'EOF' | git push\nbody\nEOF`, at(2));
  denied(`gh pr comment 4 --body-file - <<'EOF'\nFixed.\nEOF`, at(3));
});

test("a heredoc fed to a shell is a script, and its body is checked", () => {
  for (const command of [
    "bash <<'EOF'\ngit push\nEOF",
    "sh <<EOF\ngit push\nEOF",
    "cat <<EOF | sh\ngit push\nEOF",
    "zsh -s <<-EOF\n\tnpm test && git push\n\tEOF",
    "source /dev/stdin <<EOF\ngit push\nEOF",
    "eval \"$(cat <<'EOF'\ngit push\nEOF\n)\"",
    "$(cat <<EOF\ngit push\nEOF\n)",
    "echo 'git push' | sh",
  ])
    denied(command, at(2));
  assert.equal(babysitDenial("cat <<EOF | bash -s\ngh pr merge 4\nEOF", at(5)), "Babysitting never merges.");
  // Text for a command that isn't a shell stays text.
  allowed(`git commit -m "$(cat <<'EOF'\nDon't git push yet.\nEOF\n)"`, at(2));
  allowed(`gh pr comment 4 --body-file - <<'EOF'\nI won't gh pr merge this.\nEOF`, at(4));
});

test("a here-string fed to a shell is a script", () => {
  denied(`bash <<< "git push"`, at(1));
  denied(`bash <<<"git push origin HEAD"`, at(1));
  denied(`cat <<< "git push" | sh`, at(1));
  assert.equal(babysitDenial(`sh <<< 'gh pr merge 1'`, at(5)), "Babysitting never merges.");
  denied(`echo "$(bash <<< 'git push')"`, at(1));
  // Text for any other command is only text, and what follows the here-string is still checked.
  allowed(`grep foo <<< "git push"`, at(1));
  denied(`grep foo <<< "x"; git push`, at(1));
});

test("closing or reopening the PR is always denied", () => {
  const reason = "Babysitting never closes or reopens the PR.";
  for (const level of [1, 3, 5]) {
    assert.equal(babysitDenial("gh pr close 42", at(level)), reason);
    assert.equal(babysitDenial("gh pr close 42 --delete-branch -c done", at(level)), reason);
    assert.equal(babysitDenial("gh pr reopen 42", at(level)), reason);
    assert.equal(babysitDenial(`gh api graphql -f query='mutation { closePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`, at(level)), reason);
    assert.equal(babysitDenial("gh api -X PATCH repos/o/r/pulls/42 -f state=closed", at(level)), reason);
  }
});

test("a REST edit of a PR or issue that sets its state, or whose body can't be read, never runs", () => {
  const close = "Babysitting never closes or reopens the PR.";
  for (const level of [4, 5]) {
    assert.equal(babysitDenial(`echo '{"state":"closed"}' | gh api -X PATCH repos/o/r/pulls/42 --input -`, at(level)), close);
    assert.equal(babysitDenial(`gh api -X PATCH repos/o/r/issues/42 --input - <<< '{"state": "open"}'`, at(level)), close);
    assert.equal(babysitDenial("gh api -X PATCH repos/o/r/pulls/42 -F state=closed", at(level)), close);
    assert.equal(babysitDenial("gh api -X PATCH repos/o/r/pulls/42 --raw-field=state=closed", at(level)), close);
    assert.equal(babysitDenial("gh api -X PATCH repos/o/r/pulls/42 --input body.json", at(level)), UNREADABLE);
    assert.equal(babysitDenial("cat body.json | gh api -X PATCH repos/o/r/pulls/42 --input -", at(level)), UNREADABLE);
  }
  // A body piped in that only edits the title is a reply.
  allowed(`echo '{"title":"Better"}' | gh api -X PATCH repos/o/r/pulls/42 --input -`, at(4));
  denied(`echo '{"title":"Better"}' | gh api -X PATCH repos/o/r/pulls/42 --input -`, at(3));
});

test("closing or reopening an issue is always denied; editing or commenting on one is a reply", () => {
  const close = "Babysitting never closes or reopens the PR.";
  for (const level of [1, 5]) {
    assert.equal(babysitDenial("gh issue close 42", at(level)), close);
    assert.equal(babysitDenial("gh issue close 42 --reason 'not planned'", at(level)), close);
    assert.equal(babysitDenial("gh issue reopen 42", at(level)), close);
  }
  const reply = `Babysit level Fix and push doesn't allow replying on GitHub. ${SETTINGS}`;
  assert.equal(babysitDenial("gh issue edit 42 --add-label bug", at(3)), reply);
  assert.equal(babysitDenial("gh issue comment 42 --body hi", at(3)), reply);
  for (const command of ["gh issue edit 42 --add-label bug", "gh issue comment 42 --body hi"]) allowed(command, at(4));
  allowed("gh issue view 42", at(1));
});

test("ANSI-C quoting is decoded, so it can't hide a command", () => {
  for (const command of [
    `bash -c $'git push'`,
    `echo $'git push' | sh`,
    `$'git' push`,
    `$'\\x67it' push`,
    `$'\\147it' push`,
    `$'\\u0067it' push`,
    `bash -c $'git\\tpush'`,
    `sh -c $'gh pr merge 1'`,
  ])
    denied(command, at(1));
  assert.equal(babysitDenial(`sh -c $'gh pr merge 1'`, at(5)), "Babysitting never merges.");
  allowed(`echo $'line one\\nline two'`, at(1));
  allowed(`grep $'git push' notes.txt`, at(1));
  // An escape past Unicode's end reads as a replacement character, never a throw.
  allowed(`echo $'\\U7fffffff'`, at(1));
});

test("labels, assignees and milestones on a PR or issue are reply-level writes", () => {
  for (const command of [
    "gh api -X POST repos/o/r/issues/42/labels -f 'labels[]=bug'",
    "gh api -X DELETE repos/o/r/issues/42/labels/bug",
    "gh api -X PUT repos/o/r/issues/42/labels -f 'labels[]=bug'",
    "gh api -X POST repos/o/r/issues/42/assignees -f 'assignees[]=me'",
    "gh api -X DELETE repos/o/r/issues/42/assignees -f 'assignees[]=me'",
    "gh api -X PATCH repos/o/r/issues/42 -F milestone=3",
    "gh api -X PATCH repos/o/r/pulls/42 -f 'assignees[]=me'",
  ]) {
    denied(command, at(3));
    allowed(command, at(4));
  }
  allowed("gh api repos/o/r/issues/42/labels", at(1));
});

test("editing the PR or marking it ready is a reply", () => {
  const reason = `Babysit level Fix and push doesn't allow replying on GitHub. ${SETTINGS}`;
  assert.equal(babysitDenial("gh pr edit 42 --title 'Better title'", at(3)), reason);
  assert.equal(babysitDenial("gh pr ready 42", at(3)), reason);
  denied("gh pr ready 42 --undo", at(1));
  denied("gh pr edit 42 --body-file notes.md", at(2));
  denied("gh pr edit 42 --add-label bug", at(3));
  denied("gh api -X PATCH repos/o/r/pulls/42 -f title=Better", at(3));
  // --add-reviewer with another flag is both.
  assert.equal(
    babysitDenial("gh pr edit 42 --add-reviewer alice --title x", at(4)),
    `Babysit level Fix, push and reply doesn't allow re-requesting review. ${SETTINGS}`,
  );
  for (const command of ["gh pr edit 42 --title 'Better title'", "gh pr ready 42", "gh api -X PATCH repos/o/r/pulls/42 -f title=Better"])
    allowed(command, at(4));
  allowed("gh pr view 42 --json isDraft", at(1));
});

test("<< in arithmetic is a shift, not a heredoc", () => {
  denied("(( x = 1 << 2 ))\ngit push", at(2));
  denied("echo $((1<<2))\ngit push", at(2));
  denied("(( y <<= 1 )); git push", at(2));
});

test("anything that isn't a guarded command passes", () => {
  for (const command of ["", "ls", "npm test", "gh pr checks 42 --watch", "gh run view 123 --log-failed", "git rebase origin/main", "git commit -am wip"])
    allowed(command, at(1));
});

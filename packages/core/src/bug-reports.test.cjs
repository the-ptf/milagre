const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBugReports, postWithGh, prefilledUrl, readHostLog, foldLog } = require("./bug-reports.cjs");

const KNOWN = [
  { kind: "org", value: "northwind-health" },
  { kind: "repo", value: "claims-ledger" },
  { kind: "worktree", value: "/Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p" },
  { kind: "branch", value: "mreyes/adjudication-retry" },
  { kind: "home", value: "/Users/mreyes" },
];
const INPUT = {
  title: "Delegation to claims-ledger never reports back",
  feature: "delegation",
  what_happened: "A Delegation from /Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p to northwind-health/claims-ledger stayed open.",
  expected: "The report comes back to the parent Chat.",
  steps: ["Delegate from a Chat on branch mreyes/adjudication-retry", "Wait for the report"],
  error_text: "Delegation report failed: ENOENT /Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p/.milagre/report.json",
};
const LEAKS = ["claims-ledger", "northwind", "mreyes", "adjudication", "chat-7k2p"];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const events = [];
  const posted = [];
  const reports = createBugReports({
    send: (chatId, event) => events.push({ chatId, event }),
    active: () => true,
    facts: async () => ({ version: "0.232.0", os: "macOS 27.0 (arm64)", provider: "Claude", model: "claude-opus-5-5", effort: "high", permissionMode: "auto" }),
    known: async () => KNOWN,
    readLog: async () => ["[delegations] report for /Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p failed (×3)"],
    post: async (report) => {
      posted.push(report);
      return { posted: true, url: "https://github.com/the-ptf/milagre/issues/1001" };
    },
    ...options,
  });
  t.after(() => reports.close());
  const shown = () => events.findLast((item) => item.event.type === "question-request")?.event;
  const start = async (chatId = "chat", input = INPUT) => {
    const result = reports.definitions(chatId)[0].run(input);
    result.catch(() => {});
    await tick();
    return { result, request: shown() };
  };
  return { events, posted, reports, start, shown };
}

for (const action of ["stop", "restart", "close"]) {
  test(`${action} during preparation cannot show or post a late report`, async (t) => {
    const collection = deferred();
    let running = true;
    let calls = 0;
    const { reports, start, events, posted, shown } = fixture(t, {
      active: () => running,
      known: () => (++calls === 1 ? collection.promise : Promise.resolve(KNOWN)),
    });
    const first = await start();
    assert.equal(shown(), undefined);
    running = false;
    if (action === "close") reports.close();
    else reports.cancel("chat");
    let cancelled;
    first.result.then((value) => {
      cancelled = value;
    });
    await tick();
    assert.match(cancelled ?? "", /cancelled/);
    let replacement;
    if (action === "restart") {
      running = true;
      replacement = await start();
      assert.ok(replacement.request);
    }
    collection.resolve(KNOWN);
    await tick();
    const questions = events.filter(({ event }) => event.type === "question-request");
    assert.equal(questions.length, action === "restart" ? 1 : 0);
    assert.equal(posted.length, 0);
    if (replacement) {
      const { request, result } = replacement;
      const { title, body } = request.bugReport;
      assert.equal(reports.answer("chat", request.requestId, { title: [title], body: [body] }), true);
      assert.equal(JSON.parse(await result).posted, true);
      assert.equal(posted.length, 1);
    }
  });
}

test("preparation reserves the Chat against duplicate requests", async (t) => {
  const collection = deferred();
  const { reports, start } = fixture(t, { known: () => collection.promise });
  await start();
  let failure;
  reports
    .definitions("chat")[0]
    .run(INPUT)
    .catch((error) => {
      failure = error.message;
    });
  await tick();
  reports.cancel("chat");
  collection.resolve(KNOWN);
  await tick();
  assert.match(failure ?? "", /already has a bug report/);
});

test("a failed preparation releases its reservation for another request", async (t) => {
  let calls = 0;
  const { reports, start } = fixture(t, {
    known: async () => {
      if (++calls === 1) throw new Error("collection failed");
      return KNOWN;
    },
  });
  await assert.rejects(reports.definitions("chat")[0].run(INPUT), /collection failed/);
  const next = await start();
  assert.ok(next.request);
});

test("a card cannot post after its Chat becomes inactive", async (t) => {
  let running = true;
  const { start, reports, posted } = fixture(t, { active: () => running });
  const { request, result } = await start();
  running = false;
  const { title, body } = request.bugReport;
  assert.equal(reports.answer("chat", request.requestId, { title: [title], body: [body] }), false);
  assert.match(await result, /cancelled/);
  assert.equal(posted.length, 0);
});

test("the user is shown the redacted report, with Milagre's facts, before anything is posted", async (t) => {
  const { start, posted } = fixture(t);
  const { request } = await start();
  const report = request.bugReport;
  assert.equal(posted.length, 0);
  assert.equal(report.repo, "the-ptf/milagre");
  assert.equal(report.title, "Delegation to <repo> never reports back");
  for (const value of LEAKS) assert.ok(!`${report.title}${report.body}`.includes(value), `${value} leaked`);
  assert.match(report.body, /^A Delegation from <worktree> to <org>\/<repo> stayed open\./);
  assert.match(report.body, /### Steps to reproduce\n\n1\. Delegate from a Chat on branch <branch>\n2\. Wait for the report/);
  assert.match(report.body, /### Error\n\n```text\nDelegation report failed: ENOENT <worktree>\/<path>\n```/);
  assert.match(
    report.body,
    /- Milagre: 0\.232\.0\n- OS: macOS 27\.0 \(arm64\)\n- Agent: Claude · claude-opus-5-5 · effort high\n- Permission mode: auto\n- Feature: Delegation and Links/,
  );
  assert.match(report.body, /<summary>Host log, last lines \(redacted\)<\/summary>\n\n```text\n\[delegations\] report for <worktree> failed \(×3\)\n```/);
  assert.ok(report.redactions >= 5);
  assert.ok(request.requestId.startsWith("milagre-bug-report-"));
});

test("approving posts exactly the text the user saw, and the agent gets the link", async (t) => {
  const { start, posted, events, reports } = fixture(t);
  const { result, request } = await start();
  const { title, body } = request.bugReport;
  assert.equal(reports.answer("another-chat", request.requestId, { title: [title], body: [body] }), false);
  assert.equal(reports.answer("chat", request.requestId, { title: [title], body: [body] }), true);
  const response = JSON.parse(await result);
  assert.deepEqual(posted, [{ repo: "the-ptf/milagre", title, body }]);
  assert.equal(response.posted, true);
  assert.equal(response.editedByUser, undefined);
  assert.equal(response.url, "https://github.com/the-ptf/milagre/issues/1001");
  assert.ok(events.some((item) => item.event.type === "question-resolved" && item.event.outcome === "answered"));
  // A replayed answer posts nothing more.
  assert.equal(reports.answer("chat", request.requestId, { title: [title], body: [body] }), false);
  assert.equal(posted.length, 1);
});

test("an edit that adds private details comes back redacted for another look, and nothing is posted", async (t) => {
  const { start, posted, reports, shown } = fixture(t);
  const { result, request } = await start();
  const edited = `${request.bugReport.body}\n\nAlso seen in northwind-health/claims-ledger on https://claims.northwind.example.com/admin by marisol@northwind-health.com.`;
  assert.equal(reports.answer("chat", request.requestId, { title: [request.bugReport.title], body: [edited] }), true);
  await tick();
  assert.equal(posted.length, 0);
  const again = shown();
  assert.notEqual(again.requestId, request.requestId);
  assert.equal(again.bugReport.recheck, true);
  assert.ok(!again.bugReport.body.includes("northwind"));
  assert.ok(!again.bugReport.body.includes("marisol"));
  assert.match(again.bugReport.body, /Also seen in <org>\/<repo> on <url> by <email>\.$/);
  // The old request is closed; the new one carries the same wait to the post.
  assert.equal(reports.answer("chat", request.requestId, { title: [again.bugReport.title], body: [again.bugReport.body] }), false);
  assert.equal(reports.answer("chat", again.requestId, { title: [again.bugReport.title], body: [again.bugReport.body] }), true);
  assert.equal(JSON.parse(await result).posted, true);
  assert.equal(posted[0].body, again.bugReport.body);
});

test("removing text posts the shorter report without another look", async (t) => {
  const { start, posted, reports } = fixture(t);
  const { result, request } = await start();
  const body = request.bugReport.body.replace(/\n\n<details>[\s\S]*?<\/details>/, "");
  assert.equal(reports.answer("chat", request.requestId, { title: ["Delegation never reports back"], body: [body] }), true);
  const response = JSON.parse(await result);
  assert.equal(response.editedByUser, true);
  assert.match(response.instructions, /The user edited the report/);
  assert.deepEqual(posted, [{ repo: "the-ptf/milagre", title: "Delegation never reports back", body }]);
});

test("trusted-host URLs are redacted before preview and edits require a fresh approval before posting", async (t) => {
  const privateUrl = "https://relay.milagre.cloud/pair?token=FAKE_PRIVATE_TOKEN_1234567890&project=claims-ledger";
  const { start, posted, reports, shown } = fixture(t, { readLog: async () => [privateUrl] });
  const { result, request } = await start("chat", { ...INPUT, what_happened: `Pairing failed at ${privateUrl}` });
  assert.equal(posted.length, 0);
  assert.match(request.bugReport.body, /Pairing failed at <url>/);
  assert.ok(!request.bugReport.body.includes("FAKE_PRIVATE_TOKEN"));
  const edited = `${request.bugReport.body}\nhttps://github.com/the-ptf/milagre/issues/new?body=%63laims-ledger&api_key=FAKE_EDIT_TOKEN`;
  reports.answer("chat", request.requestId, { title: [request.bugReport.title], body: [edited] });
  await tick();
  assert.equal(posted.length, 0);
  const again = shown();
  assert.notEqual(again.requestId, request.requestId);
  assert.equal(again.bugReport.recheck, true);
  assert.ok(!again.bugReport.body.includes("FAKE_EDIT_TOKEN"));
  assert.ok(!again.bugReport.body.includes("laims-ledger"));
  assert.equal(reports.answer("chat", request.requestId, { title: ["Old approval"], body: [edited] }), false);
  reports.answer("chat", again.requestId, { title: [again.bugReport.title], body: [again.bugReport.body] });
  assert.equal(JSON.parse(await result).posted, true);
  assert.deepEqual(posted, [{ repo: "the-ptf/milagre", title: again.bugReport.title, body: again.bugReport.body }]);
});

test("when gh can't post, the agent gets the prefilled page to hand over as a short link", async (t) => {
  const { start, reports } = fixture(t, {
    post: async (report) => ({
      posted: false,
      reason: "The GitHub CLI (gh) isn't signed in to github.com on this computer.",
      openUrl: prefilledUrl(report.repo, report.title, report.body),
    }),
  });
  const { result, request } = await start();
  reports.answer("chat", request.requestId, { title: [request.bugReport.title], body: [request.bugReport.body] });
  const response = JSON.parse(await result);
  assert.equal(response.posted, false);
  assert.equal(new URL(response.openUrl).searchParams.get("body"), request.bugReport.body);
  assert.match(response.instructions, /short Markdown link/);
});

test("cancelling, a stopped turn or an expired request posts nothing", async (t) => {
  let now = 1_000;
  const { start, posted, reports } = fixture(t, { now: () => now });
  const first = await start("chat");
  assert.equal(reports.answer("chat", first.request.requestId, null), true);
  assert.match(await first.result, /cancelled the bug report\. Nothing was posted/);

  const second = await start("chat");
  reports.cancel("chat");
  assert.match(await second.result, /cancelled\. Nothing was posted/);

  const third = await start("chat");
  now += 16 * 60 * 1000;
  assert.equal(reports.answer("chat", third.request.requestId, { title: ["x"], body: ["y"] }), false);
  assert.match(await third.result, /expired/);
  assert.equal(posted.length, 0);
});

test("bad answers and a second report in the same Chat are refused", async (t) => {
  const { start, reports } = fixture(t);
  const { request } = await start();
  assert.throws(() => reports.answer("chat", request.requestId, { title: [""], body: ["x"] }), /Give the report a title/);
  assert.throws(() => reports.answer("chat", request.requestId, { title: ["x".repeat(161)], body: ["x"] }), /Give the report a title/);
  await assert.rejects(reports.definitions("chat")[0].run(INPUT), /already has a bug report waiting/);
  const idle = createBugReports({ send: () => {}, active: () => false, facts: async () => ({}), known: async () => [] });
  await assert.rejects(idle.definitions("chat")[0].run(INPUT), /running Chat/);
});

test("gh posts under the user's account; without gh, signed out or failing, the prefilled page is the way", async () => {
  const report = { repo: "the-ptf/milagre", title: "A title", body: "A body" };
  const calls = [];
  const run = (outcomes) => async (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    return outcomes.shift();
  };
  const done = await postWithGh(report, {
    run: run([
      { ok: true, stdout: "", stderr: "" },
      { ok: true, stdout: "Creating issue in the-ptf/milagre\n\nhttps://github.com/the-ptf/milagre/issues/1002\n", stderr: "" },
    ]),
  });
  assert.deepEqual(done, { posted: true, url: "https://github.com/the-ptf/milagre/issues/1002" });
  assert.deepEqual(calls.at(-1), {
    command: "gh",
    args: ["issue", "create", "--repo", "the-ptf/milagre", "--title", "A title", "--body-file", "-"],
    input: "A body",
  });

  const missing = await postWithGh(report, { run: run([{ ok: false, missing: true, stdout: "", stderr: "" }]) });
  assert.equal(missing.posted, false);
  assert.match(missing.reason, /isn't installed/);
  assert.equal(missing.openUrl, prefilledUrl(report.repo, report.title, report.body));

  const signedOut = await postWithGh(report, { run: run([{ ok: false, stdout: "", stderr: "not logged in" }]) });
  assert.match(signedOut.reason, /isn't signed in/);

  const failed = await postWithGh(report, {
    run: run([
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "", stderr: "GraphQL: Could not resolve to a Repository\n" },
    ]),
  });
  assert.match(failed.reason, /couldn't create the issue: GraphQL: Could not resolve to a Repository/);
});

test("the prefilled link fits GitHub's limit, dropping the host log before the text", () => {
  const body = `What happened\n\n<details>\n<summary>Host log</summary>\n\n${"log line\n".repeat(900)}\n</details>\n\nFooter`;
  const url = prefilledUrl("the-ptf/milagre", "Title", body);
  assert.ok(url.length <= 7500);
  const shown = new URL(url).searchParams.get("body");
  assert.equal(shown, "What happened\n\nFooter");
  const long = prefilledUrl("the-ptf/milagre", "Title", "word ".repeat(4000));
  assert.ok(long.length <= 7500);
  assert.match(new URL(long).searchParams.get("body"), /Shortened to fit/);
});

test("the host log keeps its last meaningful lines, repeats folded", async (t) => {
  assert.deepEqual(
    foldLog([
      '{"status":"ready","pid":1}',
      "[routines] kept a Run's Worktree",
      "(Use `Milagre --trace-warnings ...` to show where the warning was created)",
      "[routines] kept a Run's Worktree",
      "",
      "Daemon connection closed",
      "[routines] kept a Run's Worktree",
    ]),
    ["Daemon connection closed", "[routines] kept a Run's Worktree (×3)"],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-bug-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "daemon.log");
  fs.writeFileSync(file, `${"x".repeat(70 * 1024)}\n${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}\n`);
  const lines = await readHostLog(file);
  assert.equal(lines.length, 25);
  assert.equal(lines.at(-1), "line 39");
  assert.deepEqual(await readHostLog(path.join(dir, "missing.log")), []);
});

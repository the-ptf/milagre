import assert from "node:assert/strict";
import test from "node:test";
import { directSubchats, latestLine, latestReports, reportMarker, sortSubchats, subchatState, subchatSummary, type SubchatInput } from "./subchat-states.ts";

const now = 1_000_000_000;
const base = (extra: Partial<SubchatInput> = {}): SubchatInput => ({ key: "p#2", title: "Esconder valores", session: {}, ...extra });
const question = { id: "q", header: "", question: "Publicar agora?", options: [], multiSelect: false, allowOther: true };

test("a pending question beats the live turn, and an answered one doesn't count", () => {
  const run = { text: "Disparando o db-push", startedAt: now - 185_000, questions: [{ requestId: "r1", questions: [question] }] };
  const asking = subchatState(base({ run }), now);
  assert.equal(asking.kind, "needs-you");
  assert.equal(asking.detail, "Asks: Publicar agora?");
  assert.deepEqual(asking.request, { kind: "question", requestId: "r1", questions: [question] });
  const answered = subchatState(base({ run: { ...run, answered: { r1: "answered" } } }), now);
  assert.equal(answered.kind, "working");
  assert.equal(answered.detail, "Disparando o db-push");
  assert.equal(answered.elapsed, "3m 05s");
});

test("a Heartbeat holds a Chat between beats; how the last turn ended shows once nothing is live", () => {
  const holding = subchatState(base({ heartbeat: { nextRunAt: now + 12 * 60_000, runCount: 3, maxRuns: 20 } }), now);
  assert.deepEqual([holding.kind, holding.detail], ["holding", "next beat in 12 min · run 3 of 20"]);
  assert.equal(subchatState(base({ queued: true }), now).kind, "queued");
  const failed = subchatState(base({ session: { summary: { lastOutcome: "failed" } }, report: "Tried.\n\ndb-push failed: conflict" }), now);
  assert.deepEqual([failed.kind, failed.detail], ["failed", "db-push failed: conflict"]);
  assert.equal(subchatState(base({ session: { summary: { lastOutcome: "cancelled" } } }), now).kind, "stopped");
  assert.deepEqual(
    [subchatState(base({ report: "Tudo publicado." }), now).kind, subchatState(base({ report: "Tudo publicado." }), now).detail],
    ["done", "Tudo publicado."],
  );
});

test("the pill counts what needs the user first and folds Stopped into done", () => {
  const states = sortSubchats([
    subchatState(base({ key: "p#2", report: "ok" }), now),
    subchatState(base({ key: "p#3", run: { text: "x" } }), now),
    subchatState(base({ key: "p#4", session: { summary: { lastOutcome: "cancelled" } } }), now),
    subchatState(base({ key: "p#5", run: { questions: [{ requestId: "r", questions: [question] }] } }), now),
  ]);
  assert.deepEqual(
    states.map((state) => state.key),
    ["p#5", "p#3", "p#4", "p#2"],
  );
  const summary = subchatSummary(states);
  assert.equal(summary.lead, "needs-you");
  assert.deepEqual(
    summary.parts.map((part) => part.text),
    ["1 needs you", "1 working", "2 done"],
  );
  assert.deepEqual(subchatSummary([]), { lead: null, parts: [] });
});

test("a report is one transcript line naming the Chat; Negotiation rounds keep their text", () => {
  assert.deepEqual(reportMarker({ kind: "delegation-report", status: "done", fromLabel: "rd / feat/x / Esconder valores" }), {
    text: "Esconder valores finished",
    kind: "done",
  });
  assert.equal(reportMarker({ kind: "delegation-report", status: "failed", fromLabel: "web" })?.text, "web failed");
  assert.equal(reportMarker({ kind: "delegation-report", negotiation: { round: 2 } }), null);
  assert.equal(reportMarker({ kind: "delegation" }), null);
  const reports = latestReports([
    { body: "first", context: { kind: "delegation-report", from: "p#2" } },
    { body: "plain" },
    { body: "second", context: { kind: "delegation-report", from: "p#2" } },
  ]);
  assert.equal(reports.get("p#2"), "second");
});

test("direct Subchats are the listed Chats that keep this one as parent", () => {
  const sessions = { 1: { id: 1 }, 4: { id: 4, parent: 1 }, 2: { id: 2, parent: 1 }, 3: { id: 3, parent: 1, archived: true }, 5: { id: 5, parent: 2 } };
  assert.deepEqual(directSubchats(sessions, "/p#1"), ["/p#2", "/p#4"]);
  assert.equal(latestLine("# Plan\n\n- step one\n  last line  \n"), "last line");
});

import test from "node:test";
import assert from "node:assert/strict";
import { exchangeText, foldLinkedExchanges, linkedContext, linkedHeading, linkedLine } from "./linked-message.mjs";

test("only a Delegation, its report, a Negotiation's agreement or a Link notice gets a sender line", () => {
  const delegation = { kind: "delegation", delegationId: "d", from: "/api#1", fromLabel: "api / main / Plan" };
  assert.equal(linkedContext({ context: delegation }), delegation);
  for (const context of [null, "handover", { kind: "handoff" }, { kind: "worktree-linked" }, { kind: "advisor-result" }])
    assert.equal(linkedContext({ context }), null);
});

test("the line names the sender, a report's ending and the Negotiation round", () => {
  assert.deepEqual(linkedHeading({ kind: "delegation", from: "/api#1", fromLabel: "api / main / Plan" }), {
    text: "Delegation from api / main / Plan",
    chat: "/api#1",
  });
  assert.equal(
    linkedHeading({ kind: "delegation-report", from: "/web#2", fromLabel: "web / main / Fix", status: "failed", negotiation: { id: "n", round: 3 } }).text,
    "Delegation report from web / main / Fix · failed · Negotiation round 3",
  );
  assert.equal(linkedHeading({ kind: "delegation-report", from: null, fromLabel: "web", status: "done" }).chat, null);
  assert.deepEqual(linkedHeading({ kind: "negotiation-agreement", negotiationId: "n", with: "web" }), { text: "Negotiation agreement with web", chat: null });
  assert.equal(linkedHeading({ kind: "linked-notice" }).text, "Link");
});

test("the sender line comes from the stored context, so it is the same for old and new prompt wording", () => {
  // Messages stored before the prompt said "another Chat (not the user)" carry the same context, and the displayed body is the plain message.
  const stored = { body: "Add </delegation_reports> it", context: { kind: "delegation", delegationId: "d", from: "/api#1", fromLabel: "api / main / Plan" } };
  assert.equal(linkedContext(stored), stored.context);
  assert.equal(linkedHeading(stored.context).text, "Delegation from api / main / Plan");
  assert.equal(stored.body, "Add </delegation_reports> it");
});

test("a message another Chat sent, or a Delegation, stands as one line naming the sending Chat", () => {
  const message = { kind: "chat-message", from: "/api#1", fromLabel: "api / main / Rules to checks" };
  assert.equal(linkedContext({ context: message }), message);
  assert.deepEqual(linkedHeading(message), { text: "Message from api / main / Rules to checks", chat: "/api#1" });
  assert.deepEqual(linkedLine(message), { verb: "Message from", name: "Rules to checks", label: "api / main / Rules to checks", chat: "/api#1" });
  assert.deepEqual(linkedLine({ kind: "chat-message", from: null, fromLabel: "codex" }), { verb: "Message from", name: "codex", label: "codex", chat: null });
  assert.equal(linkedLine({ kind: "delegation", delegationId: "d", from: "/web#2", fromLabel: "web / main / Fix" })?.verb, "Delegation from");
  // A Negotiation round is the conversation itself, and a report already has its own line.
  assert.equal(linkedLine({ kind: "delegation", delegationId: "d", from: "/web#2", fromLabel: "web", negotiation: { id: "n", round: 2 } }), null);
  assert.equal(linkedLine({ kind: "delegation-report", delegationId: "d", from: "/web#2", fromLabel: "web", status: "done" }), null);
  assert.equal(linkedLine(null), null);
});

test("a back-and-forth with one Chat folds into one line, keeping the latest reply", () => {
  const from = { kind: "chat-message", from: "/api#1", fromLabel: "api / main / Rules" };
  const other = { kind: "chat-message", from: "/web#2", fromLabel: "web / main / Fix" };
  const messages = [
    { id: 1, role: "user", body: "Typed by me" },
    { id: 2, role: "user", body: "Is it fixed?", context: from },
    { id: 3, role: "assistant", body: "Not yet." },
    { id: 4, role: "user", body: "And now?", context: from },
    { id: 5, role: "assistant", body: "Fixed." },
    { id: 6, role: "user", body: "Thanks", context: other },
    { id: 7, role: "assistant", body: "Ok." },
  ];
  const rows = foldLinkedExchanges(messages.map((message) => ({ message })));
  assert.deepEqual(
    rows.filter((row) => !row.hidden).map((row) => row.message.id),
    [1, 2, 5, 6, 7],
  );
  const exchange = rows[1].exchange;
  assert.equal(exchange.count, 4);
  assert.equal(exchange.line.name, "Rules");
  assert.deepEqual(
    exchange.items.map((item) => [item.from, item.message.id]),
    [
      ["them", 2],
      ["us", 3],
      ["them", 4],
      ["us", 5],
    ],
  );
  assert.equal(exchangeText(exchange).split("\n\n---\n\n")[1], "**This Chat**\n\nNot yet.");
  // A single message from a Chat stays its own line; the input is left as it was.
  assert.equal(rows[5].exchange, undefined);
  assert.equal(messages.length, 7);
});

test("a run ends at the user's own message, and hidden rows don't break it", () => {
  const from = { kind: "delegation", delegationId: "d", from: "/api#1", fromLabel: "api / main / Rules" };
  const rows = foldLinkedExchanges([
    { message: { id: 1, role: "user", body: "First", context: from } },
    { message: { id: 2, role: "assistant", body: "(pass)" }, hidden: true },
    { message: { id: 3, role: "user", body: "Second", context: from } },
    { message: { id: 4, role: "user", body: "Mine" } },
    { message: { id: 5, role: "user", body: "Third", context: from } },
  ]);
  assert.equal(rows[0].exchange.count, 2, "two messages, no reply to keep");
  assert.equal(rows[2].hidden, true);
  assert.equal(rows[4].exchange, undefined);
});

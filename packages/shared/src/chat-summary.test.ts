import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./model.ts";
import { chatSummary, sameSummary, summarizeChat } from "./chat-summary.mjs";

const message = (id: number, extra: Partial<ChatMessage>): ChatMessage => ({ id, session_id: 1, body: "", context: null, ...extra }) as ChatMessage;

test("a Chat's summary holds what the lists show, in the Project's order", () => {
  const messages = [
    message(4, { role: "user", body: "  \n" }),
    message(5, { role: "user", body: "Fix the login\nand the tests", model: "opus" }),
    message(7, {
      role: "assistant",
      outcome: "failed",
      steps: [{ id: "s", kind: "shell", title: "Ran", status: "done", detail: "$ gh pr create --fill\nhttps://github.com/a/b/pull/12" }],
    }),
    // A message re-sent after a split reply sits after it with a lower id.
    message(6, { role: "user", body: "and again", model: "sonnet" }),
    message(8, { role: "assistant", context: { kind: "git-action" } as never, body: "Committed" }),
  ];
  assert.deepEqual(summarizeChat(messages), {
    count: 5,
    firstId: 4,
    lastId: 8,
    titleLine: "Fix the login",
    lastOutcome: "failed",
    pullRequests: ["https://github.com/a/b/pull/12"],
    lastModel: "sonnet",
  });
  assert.deepEqual(summarizeChat([]), { count: 0 });
});

test("a handoff still preparing is named, and the host's summary is preferred to working one out", () => {
  const divider = message(3, { context: { kind: "handoff", status: "preparing", from: { provider: "claude" }, to: { provider: "codex" } } as never });
  assert.equal(summarizeChat([divider]).openHandoff, 3);
  const kept = { count: 9 };
  assert.equal(chatSummary({ summary: kept }, [divider]), kept);
  assert.equal(chatSummary({}, [divider]).count, 1);
});

test("summaries compare by what they say", () => {
  assert.ok(sameSummary({ count: 1, pullRequests: ["1"] }, { count: 1, pullRequests: ["1"] }));
  assert.ok(!sameSummary({ count: 1 }, { count: 2 }));
  assert.ok(!sameSummary({ count: 1, pullRequests: ["1"] }, { count: 1, pullRequests: ["2"] }));
});

test("a Chat that started from a Linear issue names the issue, so a comment on it can find the Chat", () => {
  const card = message(3, {
    role: "user",
    body: "Look at ENG-12",
    context: { kind: "linear-issue", key: "ENG-12", title: "T", url: "u", state: { name: "Todo", type: "unstarted", color: "#aaa" }, workspace: "acme" },
  });
  const summary = summarizeChat([card, message(4, { role: "assistant", body: "On it." })]);
  assert.equal(summary.linearIssue, "ENG-12");
  assert.equal(summary.linearWorkspace, "acme");
  // Only the first message counts: a card further down is a different matter.
  const later = summarizeChat([message(1, { role: "user", body: "hi" }), card]);
  assert.equal(later.linearIssue, undefined);
  assert.equal(sameSummary(summary, summarizeChat([card, message(4, { role: "assistant", body: "On it." })])), true);
});

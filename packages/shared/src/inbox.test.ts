import { test } from "node:test";
import assert from "node:assert/strict";
import * as attention from "./attention.mjs";

test("inbox includes questions, approvals and unread outcomes across Projects and Links, but hides archived and cancelled Chats", () => {
  const scopes = [
    {
      path: "/work/events",
      name: "Events",
      state: {
        sessions: {
          1: { id: 1, title: "Digest", provider: "claude" },
          2: { id: 2, title: "Finished", unread: true, summary: { lastOutcome: "completed", lastAt: 200 } },
          3: { id: 3, unread: true, archived: true, summary: { lastOutcome: "completed" } },
          4: { id: 4, unread: true, summary: { lastOutcome: "cancelled" } },
          5: { id: 5, unread: true, summary: { lastOutcome: "failed", lastAt: 300 } },
        },
        messages: [],
      },
    },
    { path: "milagre-link:shop", name: "Shop + API", state: { sessions: { 6: { id: 6, title: "Checkout" } }, messages: [] } },
  ];
  const runs = {
    "/work/events#1": { questions: [{ requestId: "q", questions: [{ id: "layout", question: "Which layout?" }] }], approvals: [], startedAt: 10 },
    "milagre-link:shop#6": { questions: [], approvals: [{ requestId: "a", title: "Run tests", command: "npm test" }], startedAt: 20 },
  };
  const result = (attention as any).inboxSnapshot(scopes, runs);
  assert.deepEqual(
    result.items.map((item: any) => [item.key, item.status]),
    [
      ["/work/events#1", "question"],
      ["milagre-link:shop#6", "approval"],
      ["/work/events#5", "failed"],
      ["/work/events#2", "completed"],
    ],
  );
  assert.equal(result.items[0].question.requestId, "q");
  assert.equal(result.items[1].project, "Shop + API");
  assert.equal(result.items[1].permission.command, "npm test");
});

test("answered requests disappear immediately; a new run and background subagents suppress stale completions", () => {
  const scopes = [
    {
      path: "/p",
      name: "P",
      state: {
        sessions: {
          1: { id: 1, unread: true, summary: { lastOutcome: "completed" } },
          2: { id: 2, unread: true, summary: { lastOutcome: "completed" }, subagents: [{ id: "bg", background: true, status: "running" }] },
        },
        messages: [],
      },
    },
  ];
  const result = (attention as any).inboxSnapshot(scopes, { "/p#1": { approvals: [{ requestId: "a" }], questions: [], answered: { a: "allow" } } });
  assert.equal(result.items.length, 0);
  assert.deepEqual(
    result.agents.map((item: any) => [item.key, item.status]),
    [
      ["/p#1", "working"],
      ["/p#2", "working"],
    ],
  );
});

test("activity mode adds working pages; requests-only mode hides activity and outcomes from both surfaces", () => {
  const agents = ["question", "approval", "working", "completed", "failed"].map((status, index) => ({ key: String(index), status }));
  const snapshot = { agents, items: agents.filter((item) => item.status !== "working") };
  const requests = attention.visibleInbox(snapshot as any, false);
  assert.deepEqual(
    requests.agents.map((item) => item.status),
    ["question", "approval"],
  );
  assert.deepEqual(
    requests.items.map((item) => item.status),
    ["question", "approval"],
  );
  const activity = attention.visibleInbox(snapshot as any, true);
  assert.equal(activity.agents.length, 5);
  assert.equal(activity.items.length, 5);
  assert.equal(activity.items.at(-1)?.status, "working");
});

test("working preview follows the active step, then the streaming reply, with a bounded summary", () => {
  const scopes = [{ path: "/p", name: "P", state: { sessions: { 1: { id: 1 } }, messages: [] } }];
  const run = { approvals: [], questions: [], text: "Preparing\n a plan.", steps: [{ title: "Reading files", status: "running" }] };
  assert.equal(attention.inboxSnapshot(scopes as any, { "/p#1": run } as any).agents[0].preview, "Reading files");
  run.steps = [];
  assert.equal(attention.inboxSnapshot(scopes as any, { "/p#1": run } as any).agents[0].preview, "Preparing a plan.");
  run.text = "a".repeat(500);
  assert.equal(attention.inboxSnapshot(scopes as any, { "/p#1": run } as any).agents[0].preview?.length, 240);
});

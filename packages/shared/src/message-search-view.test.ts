import assert from "node:assert/strict";
import test from "node:test";
import { failedLines, hitDetail, readMessageFilters } from "./message-search-view.ts";

const hit = {
  projectPath: "/p",
  projectName: "relay",
  chat: { id: 2, title: "Deploy", archived: true, lastAt: 1_000 },
  message: { id: 9, session_id: 2 },
  score: 4,
  snippet: "wrangler deploy",
  highlight: [0, 8] as [number, number],
  term: "wrangler",
};

test("a hit names its Chat, its Project only across several, and how long ago the Chat was active", () => {
  assert.equal(hitDetail(hit, { now: 1_000 + 3 * 3_600_000, withProject: true }), "Deploy · relay · 3h");
  assert.equal(hitDetail({ ...hit, chat: { ...hit.chat, lastAt: undefined } }, { now: 0, withProject: false }), "Deploy");
});

test("unreadable Projects read as one line each, and stored filters fall back to the defaults", () => {
  assert.deepEqual(failedLines({ failed: [{ projectPath: "/q", projectName: "q", error: "Gone." }] }, "Studio"), ["Couldn't search Studio › q: Gone."]);
  assert.deepEqual(readMessageFilters({ scope: "here", archived: true }), { scope: "here", archived: true });
  assert.deepEqual(readMessageFilters("nonsense"), { scope: "all", archived: false });
});

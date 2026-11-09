import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { OpenDelegation } from "../model";
import { remoteDelegationsFrom, remoteRunStatus, replyTail } from "./remote-delegation.ts";

const STUDIO = "0b6f3c2e-1d4a-4c8e-9f00-2a1b3c4d5e6f";
const delegation = (extra: Partial<OpenDelegation> = {}): OpenDelegation => ({
  id: "d1",
  link_id: null,
  from_chat: "/api#1",
  to_chat: `${STUDIO}|/web#9`,
  from_label: "api",
  to_label: "web on studio",
  status: "running",
  message: "Do it",
  computer: { id: STUDIO, name: "studio" },
  ...extra,
});
const run = (extra: Partial<AgentRun> = {}): AgentRun => ({ text: "", model: "m", steps: [], approvals: [], questions: [], answered: {}, ...extra });

test("a Chat mirrors only the Delegations it sent to other computers", () => {
  const local = delegation({ id: "d2", computer: undefined, to_chat: "/web#3" });
  const elsewhere = delegation({ id: "d3", from_chat: "/api#2" });
  const work = { delegations: [delegation(), local, elsewhere], negotiations: [], receiveOnly: [] };
  assert.deepEqual(
    remoteDelegationsFrom(work, "/api#1").map((item) => item.id),
    ["d1"],
  );
  assert.deepEqual(remoteDelegationsFrom(work, null), []);
});

test("the mirrored turn's status follows the other computer's run", () => {
  assert.equal(remoteRunStatus(delegation({ to_chat: null }), undefined), "sending");
  assert.equal(remoteRunStatus(delegation(), undefined), "starting");
  assert.equal(remoteRunStatus(delegation(), run()), "working");
  assert.equal(remoteRunStatus(delegation(), run({ questions: [{ requestId: "q" } as AgentRun["questions"][number]] })), "question");
  assert.equal(
    remoteRunStatus(
      delegation(),
      run({ approvals: [{ requestId: "a" } as AgentRun["approvals"][number]], questions: [{ requestId: "q" } as AgentRun["questions"][number]] }),
    ),
    "approval",
  );
});

test("a long reply shows its end, from a word start", () => {
  assert.equal(replyTail("short reply  \n"), "short reply");
  const long = `${"word ".repeat(200)}last`;
  const tail = replyTail(long);
  assert.ok(tail.startsWith("…word"), tail.slice(0, 10));
  assert.ok(tail.endsWith("last"));
  assert.ok(tail.length <= 601);
});

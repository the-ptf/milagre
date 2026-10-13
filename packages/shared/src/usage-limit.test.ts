import assert from "node:assert/strict";
import test from "node:test";
import { limitChoices, limitHeadline, resetTime, switchedText, usageLimitOf } from "./usage-limit.mjs";
import type { ProjectAccountsSnapshot, UsageLimitContext } from "./model.ts";

const NOW = new Date(2026, 9, 13, 12, 0);
const limit: UsageLimitContext = { kind: "limit", provider: "claude", accountId: "default", resetsAt: new Date(2026, 9, 13, 16, 10).toISOString() };
const snapshot: ProjectAccountsSnapshot = {
  scopeKey: "/work/app",
  providers: [
    {
      provider: "claude",
      accountId: null,
      effectiveId: "default",
      defaultId: "default",
      accounts: [
        { id: "default", provider: "claude", label: "Default", state: "ready" },
        { id: "work", provider: "claude", label: "Work", state: "ready", email: "me@work.com", plan: "Max" },
        { id: "side", provider: "claude", label: "Side", state: "ready", limitedUntil: new Date(2026, 9, 13, 14, 0).toISOString() },
        { id: "old", provider: "claude", label: "Old", state: "signed-out" },
        { id: "gone", provider: "claude", label: "Removed account", state: "error", missing: true },
      ],
    },
    {
      provider: "codex",
      accountId: null,
      effectiveId: "default",
      defaultId: "default",
      accounts: [{ id: "c", provider: "codex", label: "C", state: "ready" }],
    },
  ],
};

test("only a reply the usage limit stopped has a limit", () => {
  assert.equal(usageLimitOf({ context: limit }), limit);
  assert.equal(usageLimitOf({ context: null }), null);
  assert.equal(usageLimitOf({ context: { kind: "compaction", status: "done" } }), null);
});

test("the reset reads as a time today, a weekday and time later, and nothing once past", () => {
  const time = (hour: number, minute: number) => new Date(2026, 9, 13, hour, minute).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  assert.equal(resetTime(limit.resetsAt, NOW), time(16, 10));
  assert.match(resetTime(new Date(2026, 9, 15, 9, 0).toISOString(), NOW) ?? "", /^\S+ /);
  assert.equal(resetTime(new Date(2026, 9, 13, 11, 0).toISOString(), NOW), null);
  assert.equal(resetTime(undefined, NOW), null);
  assert.deepEqual(limitHeadline(limit, NOW), { title: "Claude hit its usage limit", detail: `It resets at ${time(16, 10)}.` });
  assert.equal(limitHeadline({ kind: "limit", provider: "codex" }, NOW).detail, "It resets later.");
});

test("the card offers the provider's other accounts, and says why one can't be picked", () => {
  const time = new Date(2026, 9, 13, 14, 0).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  assert.deepEqual(limitChoices(snapshot, limit, NOW), [
    { id: "work", label: "me@work.com", detail: "Personal", disabled: false },
    { id: "side", label: "Side", detail: `Limited until ${time}`, disabled: true },
    { id: "old", label: "Old", detail: "Not signed in", disabled: true },
  ]);
  assert.deepEqual(limitChoices(null, limit, NOW), []);
});

test("after a switch the card says whether the Chat continues by itself", () => {
  assert.equal(switchedText({ continued: true, label: "me@work.com" }), "Switched to me@work.com. Continuing…");
  assert.equal(switchedText({ continued: false, label: "me@work.com" }), "Switched to me@work.com. Send your message again to continue.");
});

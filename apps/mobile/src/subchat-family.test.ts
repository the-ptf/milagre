import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@milagre/shared/model";
import { bookmarkOf, BESIDE_PARENT, familyMenu } from "./subchat-family.ts";

const now = 1_000_000_000;
const session = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Chat ${id}`, agent_name: `Chat ${id}`, ...extra }) as unknown as AgentSession;
const sessions = {
  1: session(1),
  2: session(2, { parent: 1 }),
  3: session(3, { parent: 2 }),
  4: session(4, { parent: 2 }),
};
const base = { sessions, attention: [] as string[], runs: undefined };

test("a top-level Chat has no bookmark; a Subchat's names its nearest listed parent", () => {
  assert.equal(bookmarkOf({ ...base, key: "/p#1" }), null);
  assert.deepEqual(bookmarkOf({ ...base, key: "/p#3" }), { parent: "/p#2", title: "Chat 2", needsYou: false, running: false });
  assert.equal(bookmarkOf({ ...base, key: "/p#3", sessions: undefined }), null);
});

test("an archived parent is skipped, so the bookmark points at the Chat the sidebar shows above", () => {
  const archived = { ...sessions, 2: session(2, { parent: 1, archived: true }) };
  assert.equal(bookmarkOf({ ...base, sessions: archived, key: "/p#3" })?.parent, "/p#1");
});

test("the parent needs you when it is in the Attention list or its own run holds a question or an approval", () => {
  assert.equal(bookmarkOf({ ...base, key: "/p#3", attention: ["/p#2"] })?.needsYou, true);
  const asking = { "/p#2": { approvals: [], questions: [{ requestId: "r", questions: [] }] } };
  assert.equal(bookmarkOf({ ...base, key: "/p#3", runs: asking })?.needsYou, true);
  const working = { "/p#2": { approvals: [], questions: [], startedAt: now } };
  assert.deepEqual(
    [bookmarkOf({ ...base, key: "/p#3", runs: working })?.needsYou, bookmarkOf({ ...base, key: "/p#3", runs: working })?.running],
    [false, true],
  );
});

const menu = (key: string, children: string[], extra: Partial<Parameters<typeof familyMenu>[0]> = {}) =>
  familyMenu({ sessions, key, children, routines: [], routinesOn: false, runs: undefined, now, canOpenBeside: false, ...extra });

test("the family menu names the top Chat and the parent, ticks the open Chat and gives every Subchat its state in words", () => {
  const sections = menu("/p#3", ["/p#3", "/p#4"], { runs: { "/p#4": { approvals: [], questions: [], startedAt: now, text: "Reading" } } });
  assert.deepEqual(
    sections.map((section) =>
      section.items.map((item) => [item.title, "subtitle" in item ? item.subtitle : undefined, "checked" in item ? item.checked : undefined]),
    ),
    [
      [
        ["Chat 1", "Top Chat", false],
        ["Chat 2", "Parent", false],
      ],
      [
        ["Chat 3", "Done", true],
        ["Chat 4", "Working", false],
      ],
    ],
  );
  assert.equal(sections[1]?.title, "2 Subchats");
});

test("a direct child of the top Chat has just a Parent; a top Chat lists only its Subchats", () => {
  assert.deepEqual(
    menu("/p#2", ["/p#2", "/p#3", "/p#4"])[0]?.items.map((item) => item.subtitle),
    ["Parent"],
  );
  const top = menu("/p#1", ["/p#2", "/p#3", "/p#4"]);
  assert.equal(top.length, 1);
  assert.equal(top[0]?.title, "3 Subchats");
});

test("Open beside parent is offered only when asked for, below the rest", () => {
  assert.equal(
    menu("/p#3", ["/p#3"]).some((section) => section.items.some((item) => item.id === BESIDE_PARENT)),
    false,
  );
  const sections = menu("/p#3", ["/p#3"], { canOpenBeside: true });
  assert.deepEqual(
    sections.at(-1)?.items.map((item) => item.title),
    ["Open beside parent"],
  );
});

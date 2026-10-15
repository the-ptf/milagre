import assert from "node:assert/strict";
import test from "node:test";
import type { ChatStep } from "@milagre/shared/model";
import { subagentDesigns } from "./subagent-designs.ts";

const step = (id: string, agent: string | undefined, status: ChatStep["status"], extra: Partial<ChatStep> = {}): ChatStep => ({
  id,
  kind: "artifact",
  title: "Showed `Card`",
  status,
  tool: "design_show",
  ...(agent ? { agent } : {}),
  ...extra,
});

test("a subagent's design work: the call running now, or the last design it saved", () => {
  const designs = subagentDesigns([
    step("1", "noah", "done", { artifact: { id: "card", version: 1, title: "Card", format: "design" } }),
    step("2", "noah", "done", { artifact: { id: "list", version: 2, title: "List", format: "design" } }),
    step("3", "esther", "running", { title: "Showed `Profile`" }),
    step("4", "moses", "running", { title: "Edited `a design`", tool: "design_apply" }),
    step("5", undefined, "done", { artifact: { id: "main", version: 1, title: "Main", format: "design" } }),
    step("6", "ruth", "done", { tool: "artifact_show", artifact: { id: "page", version: 1, title: "Page", format: "html" } }),
  ]);
  assert.deepEqual(Object.fromEntries(designs), {
    noah: { title: "List", id: "list", designing: false },
    esther: { title: "Profile", id: null, designing: true },
    moses: { title: null, id: null, designing: true },
  });
});

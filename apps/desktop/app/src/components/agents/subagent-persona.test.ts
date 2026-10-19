import assert from "node:assert/strict";
import test from "node:test";
import { subagentColor, subagentName, subagentPersona } from "./subagent-persona.ts";

test("a subagent's persona is its name and colour by its place among the Chat's subagents, with its task", () => {
  const agent = (id: string, title: string) => ({ id, title, status: "running" as const, startedAt: 0, updatedAt: 0, transcript: [] });
  const crew = [agent("a", "Research"), agent("b", "Design the profile screen")];
  assert.deepEqual(subagentPersona(crew, "b"), { name: "Noah", color: "blue", task: "Design the profile screen" });
  assert.equal(subagentPersona(crew, "missing"), null);
  assert.equal(subagentColor(4), "mint");
});

test("names repeat with a number once every name is taken", () => {
  assert.equal(subagentName(0), "Moses");
  assert.equal(subagentName(16), "Moses 2");
  assert.equal(subagentName(33), "Noah 3");
});

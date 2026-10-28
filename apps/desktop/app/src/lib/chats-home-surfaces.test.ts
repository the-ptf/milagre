import assert from "node:assert/strict";
import test from "node:test";
import { projectSurfaces } from "./project-surfaces.ts";

test("the Chats home has no Git or Project settings, and is named No project", () => {
  assert.deepEqual(projectSurfaces({ name: "chats", git: true, kind: "chats" }), { git: false, settings: false, name: "No project" });
});

test("a Git Project has every surface under its own name", () => {
  assert.deepEqual(projectSurfaces({ name: "happiergym", git: true }), { git: true, settings: true, name: "happiergym" });
  assert.deepEqual(projectSurfaces({ name: "happiergym" }), { git: true, settings: true, name: "happiergym" });
});

test("a plain-folder Project has no Git but keeps its settings", () => {
  assert.deepEqual(projectSurfaces({ name: "notes", git: false }), { git: false, settings: true, name: "notes" });
});

test("no open Project shows everything", () => {
  assert.deepEqual(projectSurfaces(null), { git: true, settings: true, name: "" });
});

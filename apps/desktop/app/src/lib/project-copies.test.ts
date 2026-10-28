import assert from "node:assert/strict";
import test from "node:test";
import { CHATS_GROUP_KEY, NO_PROJECT_LABEL } from "@milagre/shared/chats-home";

const stored = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
};
(globalThis as any).window = {
  milagre: {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
const { chatsGroup, pickedProjectKey, projectPickerRows } = await import("./project-copies.ts");

const STUDIO = "c-studio";
const HOME = "/Users/v/Library/Application Support/Milagre/chats";
const STUDIO_HOME = `${STUDIO}|/Users/s/Library/Application Support/Milagre/chats`;

const noProject = chatsGroup([
  { computerId: STUDIO, computer: "Studio", home: { path: STUDIO_HOME, exists: false } },
  { computerId: "local", computer: "MacBook", home: { path: HOME, exists: true } },
]);

const project = (key: string, name: string, computerId = "local", computer = "MacBook") => {
  const copy = { key, name, computerId, computer, online: true };
  return { ...copy, copies: [copy] };
};

test("chatsGroup has one copy per computer, this Mac first", () => {
  assert.equal(noProject.key, CHATS_GROUP_KEY);
  assert.equal(noProject.name, NO_PROJECT_LABEL);
  assert.deepEqual(
    noProject.copies.map((copy) => [copy.key, copy.computerId, copy.computer, copy.name]),
    [
      [HOME, "local", "MacBook", NO_PROJECT_LABEL],
      // A computer whose home isn't made yet is still a place to start: picking it makes the home there.
      [STUDIO_HOME, STUDIO, "Studio", NO_PROJECT_LABEL],
    ],
  );
  assert.equal(noProject.computerId, "local");
});

test("picker lists No project first, then Projects", () => {
  const groups = [project("/code/milagre-ade", "milagre-ade"), project("/code/happiergym", "happiergym")];
  assert.deepEqual(
    projectPickerRows({ groups, noProject, query: "" }).map((group) => group.name),
    [NO_PROJECT_LABEL, "milagre-ade", "happiergym"],
  );
  // The home open as the draft's Project is No project, never a Project row of its own.
  assert.deepEqual(
    projectPickerRows({ groups: [project(HOME, "No project"), ...groups], noProject, query: "" }).map((group) => group.key),
    [CHATS_GROUP_KEY, "/code/milagre-ade", "/code/happiergym"],
  );
  assert.deepEqual(
    projectPickerRows({ groups, noProject, query: "happ" }).map((group) => group.name),
    ["happiergym"],
  );
  assert.deepEqual(
    projectPickerRows({ groups, noProject, query: "no proj" }).map((group) => group.name),
    [NO_PROJECT_LABEL],
  );
  assert.deepEqual(
    projectPickerRows({ groups, query: "" }).map((group) => group.name),
    ["milagre-ade", "happiergym"],
  );
});

test("picking No project calls onProjectChange with this Mac's home key", () => {
  assert.equal(pickedProjectKey(noProject, "/code/milagre-ade"), HOME);
  // Already on another computer's home: picking No project again stays there.
  assert.equal(pickedProjectKey(noProject, STUDIO_HOME), STUDIO_HOME);
  assert.equal(pickedProjectKey(project("/code/happiergym", "happiergym"), "/code/milagre-ade"), "/code/happiergym");
});

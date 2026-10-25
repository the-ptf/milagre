import assert from "node:assert/strict";
import test from "node:test";
import type { HostView } from "./all-computers-store.ts";
import { newChatProjects, pickNewChatProject } from "./new-chat-project.ts";

const view = (hostId: string, state: HostView["state"], paths: string[], hidden: string[] = []): HostView => ({
  hostId,
  name: hostId.toUpperCase(),
  state,
  lastSuccess: 0,
  loaded: true,
  projects: [...paths.map((path) => ({ path })), ...hidden.map((path) => ({ path, hidden: true }))],
  copies: new Map(),
  errors: new Map(),
});

test("New Chat lists every shown Project, named by its folder when unnamed", () => {
  assert.deepEqual(newChatProjects([view("mac", "online", ["/code/a"], ["/code/secret"]), view("deer", "offline", ["/code/b"])]), [
    { hostId: "mac", hostName: "MAC", offline: false, path: "/code/a", name: "a" },
    { hostId: "deer", hostName: "DEER", offline: true, path: "/code/b", name: "b" },
  ]);
});

test("New Chat opens the last new Chat's Project, then the open one, then the first reachable one", () => {
  const projects = newChatProjects([view("mac", "online", ["/a", "/b"]), view("deer", "offline", ["/c"])]);
  assert.equal(pickNewChatProject(projects, { hostId: "mac", projectPath: "/b" }, { hostId: "mac", projectPath: "/a" })?.path, "/b");
  assert.equal(pickNewChatProject(projects, { hostId: "mac", projectPath: "/gone" }, { hostId: "mac", projectPath: "/b" })?.path, "/b");
  assert.equal(pickNewChatProject(projects, { hostId: "deer", projectPath: "/c" }, null)?.path, "/a");
  assert.equal(pickNewChatProject([], null, null), undefined);
});

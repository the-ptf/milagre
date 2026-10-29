import assert from "node:assert/strict";
import test from "node:test";
import type { HostView } from "./all-computers-store.ts";
import { newChatChoices, newChatProjectGroups, newChatProjects, noProjectChoice, pickNewChatProject, preferredCopy } from "./new-chat-project.ts";

const view = (hostId: string, state: HostView["state"], paths: string[], hidden: string[] = [], home?: HostView["home"]): HostView => ({
  hostId,
  name: hostId.toUpperCase(),
  state,
  lastSuccess: 0,
  loaded: true,
  projects: [...paths.map((path) => ({ path })), ...hidden.map((path) => ({ path, hidden: true }))],
  copies: new Map(),
  errors: new Map(),
  ...(home !== undefined ? { home } : {}),
});
const home = (path: string, exists = true) => ({ path, exists });

test("New Chat includes sidebar-hidden Projects, named by their folder when unnamed", () => {
  assert.deepEqual(newChatProjects([view("mac", "online", ["/code/a"], ["/code/secret"]), view("deer", "offline", ["/code/b"])]), [
    { hostId: "mac", hostName: "MAC", offline: false, path: "/code/a", name: "a" },
    { hostId: "mac", hostName: "MAC", offline: false, path: "/code/secret", name: "secret" },
    { hostId: "deer", hostName: "DEER", offline: true, path: "/code/b", name: "b" },
  ]);
});

test("New Chat adds each computer's known Projects after its recent ones, once each, and a computer without them keeps its recent ones", () => {
  const known = new Map([["mac", [{ path: "/code/a" }, { path: "/code/old", name: "Old", origin: "github.com/x/old" }]]]);
  assert.deepEqual(newChatProjects([view("mac", "online", ["/code/a"]), view("deer", "online", ["/code/b"])], known), [
    { hostId: "mac", hostName: "MAC", offline: false, path: "/code/a", name: "a" },
    { hostId: "mac", hostName: "MAC", offline: false, path: "/code/old", name: "Old", origin: "github.com/x/old" },
    { hostId: "deer", hostName: "DEER", offline: false, path: "/code/b", name: "b" },
  ]);
});

test("New Chat opens the last new Chat's Project, then the open one, then the first reachable one", () => {
  const projects = newChatProjects([view("mac", "online", ["/a", "/b"]), view("deer", "offline", ["/c"])]);
  assert.equal(pickNewChatProject(projects, { hostId: "mac", projectPath: "/b" }, { hostId: "mac", projectPath: "/a" })?.path, "/b");
  assert.equal(pickNewChatProject(projects, { hostId: "mac", projectPath: "/gone" }, { hostId: "mac", projectPath: "/b" })?.path, "/b");
  assert.equal(pickNewChatProject(projects, { hostId: "deer", projectPath: "/c" }, null)?.path, "/a");
  assert.equal(pickNewChatProject([], null, null), undefined);
});

test("one repository on several computers is one row, opening on the computer last used for it", () => {
  const projects = [
    { hostId: "mac", hostName: "Santo", offline: false, path: "/code/app", name: "app", origin: "github.com/x/app" },
    { hostId: "mac", hostName: "Santo", offline: false, path: "/code/plain", name: "plain" },
    { hostId: "arketa", hostName: "Arketa", offline: false, path: "/work/app", name: "app", origin: "github.com/x/app" },
    { hostId: "away", hostName: "Away", offline: true, path: "/Users/v/app", name: "app", origin: "github.com/x/app" },
  ];
  const groups = newChatProjectGroups(projects);
  assert.deepEqual(
    groups.map((group) => [group.path, group.copies.map((copy) => copy.hostId)]),
    [
      ["/code/app", ["mac", "arketa", "away"]],
      ["/code/plain", ["mac"]],
    ],
  );
  const [app] = groups;
  assert.ok(app);
  assert.equal(preferredCopy(app, "arketa", "mac").hostId, "arketa");
  assert.equal(preferredCopy(app, "away", "mac").hostId, "mac");
  assert.equal(preferredCopy(app, null, "elsewhere").hostId, "mac");
});

test("newChatProjects lists No project first", () => {
  const views = [
    view("mac", "online", ["/code/a"], [], home("/Users/v/.milagre/chats")),
    view("deer", "online", ["/code/b"], [], home("/Users/d/.milagre/chats", false)),
    // A computer whose daemon predates Chats without a Project has no home to offer.
    view("old", "online", ["/code/c"], [], null),
  ];
  const choices = newChatChoices(views, null, "mac");
  assert.deepEqual(
    choices.map((choice) => (choice.kind === "no-project" ? "No project" : choice.path)),
    ["No project", "/code/a", "/code/b", "/code/c"],
  );
  const [first] = choices;
  assert.ok(first?.kind === "no-project");
  assert.equal(first.name, "No project");
  assert.deepEqual(
    first.copies.map((copy) => [copy.hostId, copy.home.path, copy.home.exists]),
    [
      ["mac", "/Users/v/.milagre/chats", true],
      ["deer", "/Users/d/.milagre/chats", false],
    ],
  );
  // The homes are never Projects of their own.
  assert.ok(newChatProjects(views).every((project) => !project.path.endsWith("/.milagre/chats")));
  // With no computer that has a home, there is no No project row.
  assert.deepEqual(
    newChatChoices([view("old", "online", ["/code/c"], [], null), view("unread", "checking", ["/code/d"])], null, "old").map((choice) => choice.kind),
    ["project", "project"],
  );
});

test("No project is offered as soon as a computer connects, before its Chats home was read", () => {
  // Just paired: the open computer answers but hasn't said where its home is yet.
  const choice = noProjectChoice([view("mac", "checking", ["/code/a"]), view("deer", "online", ["/code/b"]), view("away", "offline", ["/c"])], null, "mac");
  assert.ok(choice);
  assert.equal(choice.computerId, "mac");
  assert.deepEqual(
    choice.copies.map((copy) => [copy.hostId, copy.home.exists]),
    [
      ["mac", false],
      ["deer", false],
    ],
    "a home not read yet is made on pick; an offline computer that never said is left out",
  );
  // Once the computer says it has none, the row goes.
  assert.equal(noProjectChoice([view("mac", "online", ["/code/a"], [], null)], null, "mac"), undefined);
});

test("No project defaults to the computer last used for a Chat", () => {
  const views = [
    view("mac", "online", ["/a"], [], home("/m/chats")),
    view("deer", "online", ["/b"], [], home("/d/chats", false)),
    view("away", "offline", ["/c"], [], home("/w/chats")),
  ];
  assert.equal(noProjectChoice(views, "deer", "mac")?.computerId, "deer");
  // A last computer that is offline or gone gives way to the open one, then to the first that answers.
  assert.equal(noProjectChoice(views, "away", "mac")?.computerId, "mac");
  assert.equal(noProjectChoice(views, "gone", "elsewhere")?.computerId, "mac");
  assert.equal(noProjectChoice([view("away", "offline", ["/c"], [], home("/w/chats"))], null, "away")?.computerId, "away");
  // The last new Chat having run in a home never makes New Chat pick that home as a Project.
  const projects = newChatProjects(views);
  assert.equal(pickNewChatProject(projects, { hostId: "mac", projectPath: "/m/chats" }, { hostId: "mac", projectPath: "/m/chats" })?.path, "/a");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasLink } from "@milagre/shared/chat-links";
import {
  createChatLink,
  createLinkTitle,
  endNamer,
  linkMenuSection,
  linkNoticeIsProblem,
  linkPickerItems,
  linkSummary,
  linkedAccessibilityLabel,
  linkedLabels,
  projectsScopeSubtitle,
  removeChatLink,
  type LinkChat,
} from "./chat-links.ts";
import { askLinkChoice, currentLinkQuestion, setLinkPresenter } from "./link-chat-store.ts";

const login: LinkChat = {
  projectPath: "/web",
  projectName: "web",
  projectId: "w",
  chatId: 1,
  title: "Login form",
  branch: "login-form",
  worktreePath: "/wt/login",
};
const sameTree: LinkChat = { ...login, chatId: 2, title: "Login copy" };
const api: LinkChat = { projectPath: "/api", projectName: "api", projectId: "a", chatId: 7, title: "Auth endpoint", branch: "auth", worktreePath: "/wt/auth" };
const docs: LinkChat = { projectPath: "/docs", projectName: "docs", projectId: "d", chatId: 3, title: "Docs", worktreePath: "/wt/docs" };
const link = (id: string, a: CanvasLink["a"], b: CanvasLink["b"]): CanvasLink => ({ id, a, b, created_at: "2026-10-10" });
const projects = [
  { id: "w", path: "/web", name: "web" },
  { id: "a", path: "/api", name: "api" },
  { id: "d", path: "/docs", name: "docs" },
];

test("a Chat's linked ends are named from the registry and the other Project's branches", () => {
  const links = [
    link("1", { project_id: "w", worktree_path: "/wt/login" }, { project_id: "a", worktree_path: "/wt/auth" }),
    link("2", { project_id: "d" }, { project_id: "w" }),
  ];
  const names = endNamer(projects, (path, worktree) => (path === "/api" && worktree === "/wt/auth" ? "auth" : undefined));
  const labels = linkedLabels(links, { project_id: "w", worktree_path: "/wt/login" }, names);
  assert.deepEqual(
    labels.map((item) => [item.link.id, item.label]),
    [
      ["1", "api / auth"],
      ["2", "All of docs"],
    ],
  );
  assert.equal(linkedAccessibilityLabel(labels.map((item) => item.label)), "Linked to api / auth, All of docs");
  // Another Worktree of web is reached only by the whole-Project Link; a Project the phone has no branch for shows its folder.
  assert.deepEqual(
    linkedLabels(links, { project_id: "w", worktree_path: "/wt/other" }, names).map((item) => item.label),
    ["All of docs"],
  );
  const folderLabels = linkedLabels(
    [link("3", { project_id: "w", worktree_path: "/wt/x" }, { project_id: "d", worktree_path: "/wt/docs/" })],
    { project_id: "w", worktree_path: "/wt/x" },
    names,
  );
  assert.ok(folderLabels[0]);
  assert.equal(folderLabels[0].label, "docs / docs");
  assert.deepEqual(linkedLabels(links, undefined, names), []);
});

test("the ⋯ menu offers Link with… for a Project Chat, and Remove Link with… only when it has a Link", () => {
  assert.equal(linkMenuSection({ available: false, worktreePath: "/wt", linked: 1 }), null, "an older Mac shows no Link items");
  assert.equal(linkMenuSection({ available: true, linked: 0 }), null, "a Chat without a Worktree (or a shared Link Chat) has none");
  assert.deepEqual(
    linkMenuSection({ available: true, worktreePath: "/wt", linked: 0 })?.items.map((item) => item.id),
    ["link-with"],
  );
  assert.deepEqual(linkMenuSection({ available: true, worktreePath: "/wt", linked: 2 })?.items, [
    { id: "link-with", title: "Link with…", systemImage: "link" },
    { id: "link-remove", title: "Remove Link with…", systemImage: "xmark.circle" },
  ]);
});

test("the picker lists every other Chat and disables the ones that can't be linked, with why", () => {
  const links = [link("1", { project_id: "w", worktree_path: "/wt/login" }, { project_id: "d" })];
  assert.deepEqual(linkPickerItems(links, login, [login, sameTree, api, docs]), [
    { id: "/web#2", title: "Login copy", subtitle: "web / login-form · Same worktree", keywords: "web / login-form", disabled: true },
    { id: "/api#7", title: "Auth endpoint", subtitle: "api / auth", keywords: "api / auth" },
    { id: "/docs#3", title: "Docs", subtitle: "docs · Already linked", keywords: "docs", disabled: true },
  ]);
});

test("the confirmation's copy names both Chats and reads Create Link and ask once there is text", () => {
  assert.equal(linkSummary(login, docs), "login-form ⇄ Docs");
  assert.equal(linkSummary(login, api, "projects"), "web ⇄ api");
  assert.equal(projectsScopeSubtitle(login, api), "Every Worktree of web and api, new ones too");
  assert.equal(createLinkTitle("  "), "Create Link");
  assert.equal(createLinkTitle("Add the endpoint"), "Create Link and ask");
});

test("Create Link adds the Link, grants Delegations ahead and asks the source Chat, in that order", async () => {
  const calls: unknown[][] = [];
  const sent: { body: string; prompt: string }[] = [];
  const made = link("9", { project_id: "w" }, { project_id: "a" });
  const result = await createChatLink({
    call: async <T>(method: string, args: unknown[]) => {
      calls.push([method, ...args]);
      return (method === "canvas:link-add" ? [link("0", { project_id: "d" }, { project_id: "w" }), made] : undefined) as T;
    },
    source: login,
    target: api,
    choice: { scope: "projects", grant: true, text: " Add the login endpoint " },
    send: async (message) => {
      calls.push(["send"]);
      sent.push(message);
    },
  });
  assert.deepEqual(calls, [["canvas:link-add", { project_id: "w" }, { project_id: "a" }], ["linked:grant", "/web#1", "9"], ["send"]]);
  assert.ok(sent[0] !== undefined);
  assert.match(sent[0].body, /^Add the login endpoint\n\nDestination: “Auth endpoint” \(api \/ auth\), in a linked Worktree\.$/);
  assert.match(sent[0].prompt, /That Chat is \/api#7 in the linked Worktree \/wt\/auth\./);
  assert.equal(result.notice, "Link created. Asked “Login form”.");
  assert.equal(result.links?.length, 2);
});

test("Create Link between Worktrees of one Project links the Worktrees, and skips the grant and the ask when not chosen", async () => {
  const calls: unknown[][] = [];
  const other: LinkChat = { ...sameTree, chatId: 5, worktreePath: "/wt/other", branch: "other" };
  const result = await createChatLink({
    call: async <T>(method: string, args: unknown[]) => {
      calls.push([method, ...args]);
      return [link("4", args[0] as CanvasLink["a"], args[1] as CanvasLink["b"])] as T;
    },
    source: login,
    target: other,
    choice: { scope: "projects", grant: false, text: "" },
    send: async () => assert.fail("nothing to ask"),
  });
  assert.deepEqual(calls, [["canvas:link-add", { project_id: "w", worktree_path: "/wt/login" }, { project_id: "w", worktree_path: "/wt/other" }]]);
  assert.equal(result.notice, "Link created");
});

test("Create Link says what failed, and keeps a Link that was made", async () => {
  const failed = await createChatLink({
    call: async () => {
      throw new Error("Worktree is gone");
    },
    source: login,
    target: api,
    choice: { scope: "worktrees", grant: true, text: "Ask" },
    send: async () => {},
  });
  assert.deepEqual(failed, { links: null, notice: "Could not create the Link: Worktree is gone" });
  const asked = await createChatLink({
    call: async <T>(_method: string, args: unknown[]) => [link("5", args[0] as CanvasLink["a"], args[1] as CanvasLink["b"])] as T,
    source: login,
    target: api,
    choice: { scope: "worktrees", grant: false, text: "Ask" },
    send: async () => {
      throw new Error("Connection lost");
    },
  });
  assert.ok(asked.links?.[0]);
  assert.equal(asked.links[0].id, "5");
  assert.equal(asked.notice, "Link created. Could not ask “Login form”: Connection lost");
});

test("Remove Link removes it by id and reports the list or the failure", async () => {
  const calls: unknown[][] = [];
  const removed = await removeChatLink(async <T>(method: string, args: unknown[]) => {
    calls.push([method, ...args]);
    return [] as T;
  }, "9");
  assert.deepEqual(calls, [["canvas:link-remove", "9"]]);
  assert.deepEqual(removed, { links: [], notice: "Link removed" });
  const failed = await removeChatLink(async () => {
    throw new Error("No such Link");
  }, "9");
  assert.deepEqual(failed, { links: null, notice: "Could not remove the Link: No such Link" });
});

test("only notices that say something didn't happen are shown", () => {
  assert.equal(linkNoticeIsProblem("Link created"), false);
  assert.equal(linkNoticeIsProblem("Link created. Asked “Login form”."), false);
  assert.equal(linkNoticeIsProblem("Link removed"), false);
  assert.equal(linkNoticeIsProblem("Link created. Could not ask “Login form”: Connection lost"), true);
  assert.equal(linkNoticeIsProblem("Could not remove the Link: No such Link"), true);
});

test("the confirmation question resolves once, and a newer one dismisses an older one", async () => {
  let shown = 0;
  setLinkPresenter(() => {
    shown++;
  });
  const first = askLinkChoice(login, api);
  const second = askLinkChoice(login, docs);
  assert.equal(await first, null);
  assert.equal(currentLinkQuestion()?.target, docs);
  currentLinkQuestion()!.choose({ scope: "worktrees", grant: false, text: "" });
  assert.deepEqual(await second, { scope: "worktrees", grant: false, text: "" });
  assert.equal(currentLinkQuestion(), null);
  assert.equal(shown, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  canLinkProjects,
  endpointCovers,
  findLink,
  LINK_PROBLEM_LABEL,
  linkAskMessage,
  linkBetween,
  linkedEndLabel,
  linkedEnds,
  linkEndpoints,
  linkProblem,
} from "./chat-links.mjs";

const alpha = { project_id: "p1", worktree_path: "/p1/alpha" };
const bravo = { project_id: "p1", worktree_path: "/p1/bravo" };
const web = { project_id: "p2", worktree_path: "/p2/web" };
const links = [
  { id: "w", a: alpha, b: bravo, created_at: "" },
  { id: "p", a: { project_id: "p2" }, b: { project_id: "p3" }, created_at: "" },
];

test("endpointCovers: a Worktree end covers itself, a Project end covers every Worktree of its Project", () => {
  assert.equal(endpointCovers(alpha, alpha), true);
  assert.equal(endpointCovers(alpha, bravo), false);
  assert.equal(endpointCovers({ project_id: "p1" }, bravo), true);
  assert.equal(endpointCovers({ project_id: "p2" }, bravo), false);
  assert.equal(endpointCovers(undefined, alpha), false);
});

test("linkBetween finds a Link either way round, Project ends included", () => {
  assert.equal(linkBetween(links, alpha, bravo)?.id, "w");
  assert.equal(linkBetween(links, bravo, alpha)?.id, "w");
  assert.equal(linkBetween(links, { project_id: "p3", worktree_path: "/p3/x" }, web)?.id, "p");
  assert.equal(linkBetween(links, alpha, web), undefined);
});

test("linkedEnds lists each Link that reaches a Worktree with its other end", () => {
  assert.deepEqual(
    linkedEnds(links, alpha).map(({ link, other }) => [link.id, other]),
    [["w", bravo]],
  );
  assert.deepEqual(
    linkedEnds(links, web).map(({ link, other }) => [link.id, other]),
    [["p", { project_id: "p3" }]],
  );
  assert.deepEqual(linkedEnds(links, { project_id: "p9", worktree_path: "/x" }), []);
});

test("linkEndpoints: Worktrees by default, whole Projects only across two Projects", () => {
  assert.equal(canLinkProjects(alpha, bravo), false);
  assert.equal(canLinkProjects(alpha, web), true);
  assert.deepEqual(linkEndpoints(alpha, web), [alpha, web]);
  assert.deepEqual(linkEndpoints(alpha, web, "projects"), [{ project_id: "p1" }, { project_id: "p2" }]);
  assert.deepEqual(linkEndpoints(alpha, bravo, "projects"), [alpha, bravo], "one Project falls back to its Worktrees");
});

test("findLink finds the exact Link made between two endpoints", () => {
  assert.equal(findLink(links, bravo, alpha)?.id, "w");
  assert.equal(findLink(links, { project_id: "p3" }, { project_id: "p2" })?.id, "p");
  assert.equal(findLink(links, { project_id: "p1" }, { project_id: "p2" }), undefined);
});

test("linkProblem and linkedEndLabel say why a Chat can't be picked and name the other end", () => {
  assert.equal(linkProblem(links, alpha, { ...alpha }), "same-worktree");
  assert.equal(linkProblem(links, alpha, bravo), "linked");
  assert.equal(linkProblem(links, alpha, web), null);
  assert.equal(LINK_PROBLEM_LABEL.linked, "Already linked");
  assert.equal(linkedEndLabel(web, { project: "web", branch: "login-form" }), "web / login-form");
  assert.equal(linkedEndLabel(web, { project: "web" }), "web / web", "the folder name without a branch");
  assert.equal(linkedEndLabel({ project_id: "p2" }, { project: "web" }), "All of web");
  assert.equal(linkedEndLabel({ project_id: "p9" }), "All of Unavailable Project");
});

test("linkAskMessage names the destination in the body and gives the agent its Chat ref and Worktree", () => {
  const { body, prompt } = linkAskMessage("  Wire the new endpoint into the form \n", {
    label: "Login form",
    chatRef: "/p2#4",
    worktreePath: "/p2/web",
    projectName: "web",
    branch: "login-form",
  });
  assert.equal(body, "Wire the new endpoint into the form\n\nDestination: “Login form” (web / login-form), in a linked Worktree.");
  assert.ok(prompt.startsWith(body));
  assert.match(prompt, /\/p2#4/);
  assert.match(prompt, /\/p2\/web/);
  assert.match(prompt, /Delegation/);
});

test("Chat mode actions enforce isolated cross-Project eligibility, labels, and explicit recovery", async () => {
  const { sharedChatEligibility, chatModeActions, chatModeEndLabel, chatModeLabel } = await import("./chat-links.mjs");
  const projects = [
    { id: "p1", path: "/p1", name: "Frontend" },
    { id: "p2", path: "/p2", name: "Backend" },
  ];
  const pair = { id: "edge", a: alpha, b: web, created_at: "" };
  assert.equal(sharedChatEligibility(pair, projects), null);
  assert.deepEqual(chatModeActions(pair, projects), [{ mode: "shared", label: "Use shared Chat" }]);
  assert.deepEqual(chatModeActions({ ...pair, b: bravo }, projects), []);
  assert.deepEqual(chatModeActions({ ...pair, a: { project_id: "p1", worktree_path: "/p1" } }, projects), []);
  assert.deepEqual(chatModeActions({ ...pair, a: { project_id: "p1" } }, projects), []);
  const active = { ...pair, sharedChat: { linkId: "owner", sessionId: 1 } };
  assert.deepEqual(chatModeActions(active, projects), [{ mode: "separate", label: "Use separate Chats" }]);
  assert.deepEqual(chatModeActions({ ...active, chatModeTransition: "separate" }, []), [{ mode: "separate", label: "Finish switching" }]);
  assert.equal(chatModeActions({ ...active, chatModeTransition: "shared" }, projects)[0].label, "Finish switching");
  assert.match(chatModeLabel({ ...active, chatModeTransition: "shared" }), /Switching/);
  assert.equal(chatModeEndLabel(alpha, projects, "feature/cart"), "Frontend / feature/cart");
});

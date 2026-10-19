import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneSnapshot, memberForDiff } from "./chat-scope.ts";
import { parseLocation } from "./navigation-store.ts";
import type { OpenLink } from "@milagre/shared/model";

const id = "f1713d69-569d-405b-a0b2-19bfdf565a76";
const link: OpenLink = {
  link: { id, name: "Food", projectIds: ["api", "web"], createdAt: "" },
  projects: [
    { id: "api", name: "API", path: "/api" },
    { id: "web", name: "Web", path: "/web" },
  ],
  state: {
    next_id: 8,
    preparations: {},
    messages: [],
    sessions: {
      7: {
        id: 7,
        agent_name: "Food",
        status: "Created",
        workspacePath: "/owned/workspace",
        worktrees: [
          { projectId: "api", projectPath: "/api", worktreePath: "/owned/api", branch: "feature/api", base: "main" },
          { projectId: "web", projectPath: "/web", worktreePath: "/owned/web", branch: "feature/web", base: "develop" },
        ],
      },
    },
  },
};

test("the mobile view keeps canonical Link identity and maps shared Chats only for existing Chat UI", () => {
  const runs = { runs: {}, seq: 8 };
  const copy = phoneSnapshot({ link, runs });
  assert.equal(copy.project.path, `milagre-link:${id}`);
  assert.equal(copy.project.link, link);
  assert.ok(copy.project.state.sessions[7] !== undefined);
  assert.equal(copy.project.state.sessions[7].worktree_id, 7);
  assert.ok(copy.project.state.worktrees[7] !== undefined);
  assert.equal(copy.project.state.worktrees[7].path, "/owned/workspace");
  assert.equal(copy.runs, runs);
  assert.ok(link.state.sessions[7] !== undefined);
  assert.equal("worktree_id" in link.state.sessions[7], false, "view mapping never changes canonical Link state");
  assert.equal(memberForDiff(copy.project, 7, "web")?.path, "/owned/web");
  assert.equal(memberForDiff(copy.project, 7, "web")?.base, "develop");
  assert.equal(memberForDiff(copy.project, 7, undefined), undefined, "shared workspace never becomes an implicit Git target");
  assert.equal(memberForDiff(copy.project, 7, "other"), undefined);
});

test("last Chat restoration accepts valid Links and rejects malformed scope keys", () => {
  const value = { hostId: "mac", projectPath: `milagre-link:${id}`, chatId: 7 };
  assert.deepEqual(parseLocation(JSON.stringify(value)), value);
  for (const owner of ["milagre-link:bad", "milagre-link:" + id + "/outside", "relative"])
    assert.equal(parseLocation(JSON.stringify({ ...value, projectPath: owner })), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyLocalMcpDraft,
  localMcpClientConfig,
  localMcpClientDetail,
  localMcpConfiguration,
  localMcpDescription,
  localMcpDraftFor,
  localMcpDraftValid,
  localMcpReadOnly,
  setLocalMcpDraftKind,
  toggleLocalMcpDraftProject,
} from "./local-mcp.ts";

test("design-only forms grant one Chat and selected IDs without management or publishing", () => {
  const config = localMcpConfiguration({
    ...emptyLocalMcpDraft(),
    label: "Design editor",
    kind: "designs",
    chatId: "/project#2",
    designIds: "one, two",
    write: true,
  });
  assert.deepEqual(config.grants, { designs: { chatId: "/project#2", designIds: ["one", "two"], capabilities: ["read", "write"] } });
});
test("all-projects forms require a non-blank label, grant wildcard project access, and round-trip cleanly", () => {
  assert.equal(localMcpDraftValid(emptyLocalMcpDraft()), false);
  assert.equal(localMcpDraftValid({ ...emptyLocalMcpDraft(), label: "   ", kind: "all-projects" }), false);
  const draft = { ...emptyLocalMcpDraft(), label: "All repos", kind: "all-projects" as const, write: true };
  assert.equal(localMcpDraftValid(draft), true);
  const config = localMcpConfiguration(draft);
  assert.deepEqual(config.grants, {
    projects: { projectPaths: "*", capabilities: ["read"] },
    worktrees: { projectPaths: "*", capabilities: ["read", "create"] },
    chats: { projectPaths: "*", capabilities: ["read", "create", "start"] },
  });
  const roundTripped = localMcpDraftFor(config);
  assert.equal(roundTripped.kind, "all-projects");
  assert.deepEqual(roundTripped.projectPaths, []);
  assert.equal(roundTripped.write, true);
  assert.equal(roundTripped.baseGrants, undefined);
  const connection = { ...config, id: "c-all", revision: 1, createdAt: "now" };
  assert.match(localMcpDescription(connection), /projects: read \(all Projects\)/);
  assert.equal(
    localMcpClientDetail({ id: "codex", label: "Codex CLI", configPath: "/tmp/config.toml", enabled: true, state: "configured", connection }),
    "All Projects · Read and write",
  );
  assert.deepEqual(localMcpReadOnly(connection).grants.worktrees, { projectPaths: "*", capabilities: ["read"] });
});
test("mixed wildcard and explicit per-group grants preserve wildcard scopes until the scope choice changes", () => {
  const mixed = {
    id: "c-mixed",
    revision: 1,
    createdAt: "now",
    label: "Mixed CLI",
    grants: {
      projects: { projectPaths: "*" as const, capabilities: ["read"] as ("read" | "create")[] },
      worktrees: { projectPaths: ["/repo-a"], capabilities: ["read"] as ("read" | "create")[] },
    },
  };
  assert.equal(
    localMcpClientDetail({ id: "codex", label: "Codex CLI", configPath: "/tmp/config.toml", enabled: true, state: "configured", connection: mixed }),
    "Custom Project scope · Read only",
  );
  const draft = localMcpDraftFor(mixed);
  assert.equal(localMcpDraftValid(draft), true);
  assert.deepEqual(localMcpConfiguration({ ...draft, write: true }).grants, {
    projects: { projectPaths: "*", capabilities: ["read"] },
    worktrees: { projectPaths: ["/repo-a"], capabilities: ["read", "create"] },
  });
  const toggled = toggleLocalMcpDraftProject(draft, "/repo-b");
  assert.deepEqual(localMcpConfiguration(toggled).grants.projects, { projectPaths: ["/repo-a", "/repo-b"], capabilities: ["read"] });
  const switched = setLocalMcpDraftKind(draft, "all-projects");
  assert.deepEqual(localMcpConfiguration(switched).grants.worktrees, { projectPaths: "*", capabilities: ["read"] });
});
test("restricting grants removes writes without granting new resources or groups", () => {
  const input = {
    id: "c",
    createdAt: "now",
    revision: 1,
    label: "Connection",
    grants: {
      chats: { projectPaths: ["/allowed"], capabilities: ["read", "start"] as ("read" | "start")[] },
      designs: { chatId: "/allowed#1", designIds: ["a"], capabilities: ["read", "write"] as ("read" | "write")[] },
    },
  };
  assert.deepEqual(localMcpReadOnly(input).grants, {
    chats: { projectPaths: ["/allowed"], capabilities: ["read"] },
    designs: { chatId: "/allowed#1", designIds: ["a"], capabilities: ["read"] },
  });
  assert.deepEqual(JSON.parse(localMcpClientConfig({ connection: input, token: "one-time", url: "http://127.0.0.1:123/mcp" })).mcpServers.milagre.headers, {
    Authorization: "Bearer one-time",
  });
});

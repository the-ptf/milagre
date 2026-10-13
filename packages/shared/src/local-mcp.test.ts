import test from "node:test";
import assert from "node:assert/strict";
import { emptyLocalMcpDraft, localMcpConfiguration, localMcpReadOnly, localMcpClientConfig } from "./local-mcp.ts";

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

import assert from "node:assert/strict";
import test from "node:test";
import { MCP_SECRET_MASK } from "@milagre/shared/mcp";
import { mcpHeadersPayload, renameHeader, type McpHeaderRow } from "./mcp-headers.ts";

const row = (patch: Partial<McpHeaderRow>): McpHeaderRow => ({ id: 1, key: "Authorization", value: "", masked: false, ...patch });

test("a masked header goes back as the mask, even when focus cleared its field", () => {
  assert.deepEqual(mcpHeadersPayload([row({ masked: true, value: "" })]), { headers: { Authorization: MCP_SECRET_MASK } });
  assert.deepEqual(mcpHeadersPayload([row({ masked: true, value: MCP_SECRET_MASK })]), { headers: { Authorization: MCP_SECRET_MASK } });
});

test("a typed value replaces the mask", () => {
  assert.deepEqual(mcpHeadersPayload([row({ masked: false, value: "Bearer new" })]), { headers: { Authorization: "Bearer new" } });
});

test("renaming a masked header drops the mask and asks for a new value", () => {
  const renamed = renameHeader(row({ masked: true, value: MCP_SECRET_MASK }), "X-Token");
  assert.deepEqual(renamed, { id: 1, key: "X-Token", value: "", masked: false, needsValue: true });
  assert.deepEqual(mcpHeadersPayload([renamed]), { error: "Enter a value for X-Token." });
  assert.deepEqual(mcpHeadersPayload([{ ...renamed, value: "abc" }]), { headers: { "X-Token": "abc" } });
});

test("renaming an unmasked header is only a rename; blank rows are skipped", () => {
  assert.equal(renameHeader(row({ value: "v" }), "X").needsValue, undefined);
  assert.deepEqual(mcpHeadersPayload([row({ key: "", value: "" })]), { headers: {} });
});

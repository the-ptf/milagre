import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_CALLBACK_URL,
  SLACK_APP_MANIFEST,
  SLACK_PRESET,
  connectorPreset,
  connectorPresetInput,
  connectorReach,
  connectorStateLine,
  searchConnectorPresets,
  type ConnectorSummary,
} from "./connectors.ts";

const summary = (patch: Partial<ConnectorSummary>): ConnectorSummary => ({
  id: "slack",
  name: "Slack",
  url: "https://mcp.slack.com/mcp",
  clientId: null,
  hasClientSecret: false,
  headers: [],
  off: [],
  state: "connected",
  tools: 30,
  ...patch,
});

test("the Slack app manifest turns on MCP access and returns to Milagre's callback", () => {
  assert.equal(SLACK_APP_MANIFEST.settings.is_mcp_enabled, true);
  assert.deepEqual(SLACK_APP_MANIFEST.oauth_config.redirect_urls, [CONNECTOR_CALLBACK_URL]);
  assert.equal(SLACK_APP_MANIFEST.oauth_config.pkce_enabled, true);
  const manifest = JSON.parse(new URL(SLACK_PRESET.appUrl ?? "").searchParams.get("manifest_json") ?? "{}");
  assert.deepEqual(manifest, SLACK_APP_MANIFEST);
});

test("presets turn into connector input by how they sign in", () => {
  assert.deepEqual(connectorPresetInput(SLACK_PRESET, { name: "Slack A", clientId: " 1.2 ", clientSecret: "s" }), {
    name: "Slack A",
    url: "https://mcp.slack.com/mcp",
    clientId: "1.2",
    clientSecret: "s",
  });
  assert.throws(() => connectorPresetInput(SLACK_PRESET, { name: "Slack A" }), /Client ID/);
  const github = searchConnectorPresets("github")[0];
  assert.deepEqual(connectorPresetInput(github, { name: "GitHub", token: "Bearer abc" }).headers, { Authorization: "Bearer abc" });
  assert.throws(() => connectorPresetInput(github, { name: "GitHub", token: "" }), /token/);
  const linear = searchConnectorPresets("linear")[0];
  assert.deepEqual(connectorPresetInput(linear, { name: "Linear" }), { name: "Linear", url: "https://mcp.linear.app/mcp" });
  assert.equal(connectorPreset({ url: "https://mcp.slack.com/mcp/" })?.id, "slack");
});

test("state and reach read the way the rows show them", () => {
  const accounts = [
    { provider: "claude" as const, accountId: "a" },
    { provider: "codex" as const, accountId: "b" },
  ];
  assert.equal(connectorStateLine(summary({})), "30 tools");
  assert.equal(connectorStateLine(summary({ tools: 1 })), "1 tool");
  assert.equal(connectorStateLine(summary({ state: "failed", problem: "App is not enabled" })), "Failed: App is not enabled");
  assert.equal(connectorReach(summary({}), accounts), "All accounts");
  assert.equal(connectorReach(summary({ off: ["codex:b"] }), accounts), "1 of 2 accounts");
  assert.equal(connectorReach(summary({ off: ["codex:b", "claude:a"] }), accounts), "No accounts");
});

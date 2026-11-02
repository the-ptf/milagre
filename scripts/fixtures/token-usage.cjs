const { buildReport } = require("../../packages/core/src/token-usage.cjs");

const home = "/home/.milagre/chats";
const link = "milagre-link:12345678-1234-1234-1234-123456789abc";
const now = Date.parse("2026-11-01T12:00:00Z");
const report = buildReport({
  now,
  range: "7d",
  timeZone: "UTC",
  prices: null,
  projects: [
    { path: home, name: "Chats without a Project", state: { sessions: { 7: { id: 7, title: "Plan the release", native_session_id: "home-native" } } } },
    { path: link, name: "App and API", state: { sessions: { 7: { id: 7, title: "Update both apps", native_session_id: "link-native" } } } },
  ],
  rows: ["home-native", "link-native"].map((session) => ({
    provider: "codex",
    model: "gpt-6-astra",
    hour: Math.floor(now / 3_600_000) - 1,
    session,
    cwd: "/unregistered-workspace",
    title: "",
    milagre: true,
    input: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    requests: 1,
  })),
});
const accountUsage = {
  accountKey: "all-fixture",
  providers: [
    ["claude", "personal", "personal@example.test", 21],
    ["claude", "work", "work@example.test", 76],
    ["codex", "default", "codex@example.test", 42],
  ].map(([provider, id, email, usedPercent]) => ({
    provider,
    account: { id, label: id[0].toUpperCase() + id.slice(1), email, state: "ready", ...(id !== "work" ? { default: true } : {}) },
    status: "ok",
    updatedAt: new Date(now).toISOString(),
    windows: (id === "work" ? ["Five-hour", "Daily", "Weekly", "Weekly · Opus", "Weekly · Sonnet"] : ["Five-hour", "Daily", "Weekly"]).map((label) => ({
      id: label,
      label,
      shortLabel: label,
      usedPercent,
      resetsAt: new Date(now + 3600000).toISOString(),
    })),
  })),
};
module.exports = { home, link, accountUsage, report: { ...report, firstScan: false, refreshing: false, pricing: { status: "unavailable" } } };

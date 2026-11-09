import assert from "node:assert/strict";
import test from "node:test";
import { cliMessage, cliNotice, cliTabLabel, extractOutdatedProvider, messageParts, requiredCliVersion } from "./cli-status.ts";

test("a CLI with a problem gets a short tab label, and one that runs gets none", () => {
  assert.equal(cliTabLabel({ state: "missing", message: "m" }), "Not installed");
  assert.equal(cliTabLabel({ state: "outdated", message: "m" }), "Update");
  assert.equal(cliTabLabel({ state: "logged-out", message: "m" }), "Log in");
  assert.equal(cliTabLabel({ state: "broken", message: "m" }), "Not working");
  assert.equal(cliTabLabel({ state: "ready" }), null);
  assert.equal(cliTabLabel(null), null);
  assert.equal(cliTabLabel(undefined), null);
});

test("the notice ends at the command, while the tooltip keeps the whole message", () => {
  const message = "Codex isn't logged in. Run `codex login` in a terminal, then send your message again.";
  assert.equal(cliNotice({ state: "logged-out", message }), "Codex isn't logged in. Run `codex login` in a terminal.");
  assert.equal(cliMessage({ state: "logged-out", message }), message);
  assert.equal(
    cliNotice({
      state: "outdated",
      message: "Milagre needs Codex 0.158.0 or later, and you have 0.150.0. Run `codex update` in a terminal, then send your message again.",
    }),
    "Milagre needs Codex 0.158.0 or later, and you have 0.150.0. Run `codex update` in a terminal.",
  );
  assert.equal(
    cliNotice({
      state: "broken",
      message: "Codex (/x/codex) didn't start: env: node: No such file or directory. Check that it runs in a terminal, then send your message again.",
    }),
    "Codex (/x/codex) didn't start: env: node: No such file or directory. Check that it runs in a terminal.",
  );
  assert.equal(cliNotice({ state: "logged-out", message: "Codex isn't logged in." }), "Codex isn't logged in.");
  assert.equal(cliMessage({ state: "ready" }), null);
  assert.equal(cliNotice({ state: "ready" }), null);
  assert.equal(cliNotice({ state: "missing" }), null);
  assert.equal(cliNotice(null), null);
});

test("an outdated CLI status retains the minimum version for its updater", () => {
  assert.equal(
    requiredCliVersion({
      state: "outdated",
      message: "Milagre needs Codex 0.160.0 or later, and you have 0.147.0. Run `codex update` in a terminal, then send your message again.",
    }),
    "0.160.0",
  );
  assert.equal(requiredCliVersion({ state: "outdated", message: "Codex needs an update." }), undefined);
  assert.equal(requiredCliVersion({ state: "ready" }), undefined);
});

test("backtick spans become code", () => {
  assert.deepEqual(messageParts("Run `codex login` in a terminal, then send your message again."), [
    { text: "Run ", code: false },
    { text: "codex login", code: true },
    { text: " in a terminal, then send your message again.", code: false },
  ]);
  assert.deepEqual(messageParts("Install it with `curl -fsSL https://claude.ai/install.sh | bash`"), [
    { text: "Install it with ", code: false },
    { text: "curl -fsSL https://claude.ai/install.sh | bash", code: true },
  ]);
  assert.deepEqual(messageParts("No code here."), [{ text: "No code here.", code: false }]);
});

test("extractOutdatedProvider detects outdated provider from message", () => {
  assert.equal(
    extractOutdatedProvider(
      "Milagre needs Claude Code 2.1.286 or later, and you have 2.1.285. Run `claude update` in a terminal, then send your message again.",
    ),
    "claude",
  );
  assert.equal(
    extractOutdatedProvider("Milagre needs Codex 0.158.0 or later, and you have 0.150.0. Run `codex update` in a terminal, then send your message again."),
    "codex",
  );
  assert.equal(
    extractOutdatedProvider(
      "Milagre needs Antigravity 1.3.0 or later, and you have 1.2.0. Update it from Milagre Settings \u2192 Accounts, then send your message again.",
    ),
    "antigravity",
  );
  assert.equal(extractOutdatedProvider("Regular chat response"), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { alwaysAllowLabel, approvalKind, commandInTitle } from "./approval-copy.ts";

test("an approval's kind is in words, never the agent's tool name", () => {
  assert.equal(approvalKind({ kind: "command", tool: "Bash" }), "Command");
  assert.equal(approvalKind({ kind: "edit", tool: "Write" }), "File change");
  assert.equal(approvalKind({ kind: "other", tool: "MCP: Linear" }), "MCP: Linear");
});

test("a short one-line command in the title is not repeated in the details", () => {
  assert.equal(commandInTitle({ command: "npm test" }, "Run `npm test`"), true);
  assert.equal(commandInTitle({ command: "npm test" }, "Run this command?"), false);
  assert.equal(commandInTitle({ command: "a\nb" }, "Run `a\nb`"), false);
  const long = `echo ${"x".repeat(90)}`;
  assert.equal(commandInTitle({ command: long }, `Run \`${long}\``), false);
  assert.equal(commandInTitle({}, "Run"), false);
});

test("Always allow names what it covers", () => {
  assert.equal(alwaysAllowLabel({ kind: "command" }), "Always allow in this Chat");
  assert.equal(alwaysAllowLabel({ kind: "delegation" }), "Always allow for this Link in this Chat");
  assert.equal(
    alwaysAllowLabel({ kind: "delegation", delegation: { target: "", message: "", negotiation: false, computer: "Santo" } }),
    "Always allow for Santo in this Chat",
  );
  assert.equal(alwaysAllowLabel({ kind: "setup" }), "Trust this version");
});

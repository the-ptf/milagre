#!/usr/bin/env node
// Pure Node policy fixtures; no provider process or live turns. Read implementations from this checkout.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../..");
function readNode(relative, extra = "") {
  const filename = path.join(root, relative);
  const localRequire = createRequire(filename);
  const loaded = { exports: {} };
  const resolve = (id) => {
    if (id === "@milagre/shared/babysit") return localRequire(path.join(root, "packages/shared/src/babysit.mjs"));
    if (id === "@milagre/shared/subchat-escalation") return localRequire(path.join(root, "packages/shared/src/subchat-escalation.mjs"));
    return localRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + extra, { module: loaded, exports: loaded.exports, require: resolve }, { filename });
  return loaded.exports;
}
// Export private action classification for the trusted owner classifier contract, without changing Node.
const { actionsOf, babysitDenial } = readNode("packages/core/src/babysit-guard.cjs", "\nmodule.exports.actionsOf = actionsOf;\n");
const { advisorPolicy, advisorCodexConfig } = readNode("packages/core/src/agents/advisor-policy.cjs");
const { EscalationTurn } = readNode("packages/core/src/escalation-guard.cjs");
const { ESCALATION_TOOL_CALLS, ESCALATION_TOOL_GRACE } = require(path.join(root, "packages/shared/src/subchat-escalation.mjs"));
const commands = [
  "git status",
  "git push origin HEAD",
  "gh pr merge 1",
  "gh pr close 1",
  "gh pr reopen 1",
  "gh pr comment 1 --body hello",
  "gh pr edit 1 --add-reviewer reviewer",
  'gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:"id"}) { thread { id } } }"',
  "gh api graphql -F query=@body.graphql",
  "gh api repos/o/r/pulls/1 --input body.json",
  "env X=1 bash -lc 'git push origin HEAD; gh pr comment 1 --body hi'",
  "echo $(gh pr merge 1)",
  "git -c alias.ship=push ship",
  "eval \"$(cat <<'END'\ngh pr merge 1\nEND\n)\"",
  "gh api repos/o/r/pulls/1 -X PATCH -f state=closed",
  "gh api repos/o/r/pulls/1/merge -X PUT",
];
const babysit = [];
for (const command of commands)
  for (const level of [1, 2, 3, 4, 5])
    for (const resolveThreads of [false, true]) {
      babysit.push({ command, level, resolveThreads, actions: [...actionsOf(command)], denial: babysitDenial(command, { level, resolveThreads }) });
    }
const advisors = [];
for (const inherited of [{}, { mcp_servers: { github: { url: "https://example.test" }, milagre: { enabled: true } } }])
  for (const url of [null, "http://127.0.0.1:1234/mcp"]) {
    advisors.push({ inherited, url, expected: advisorCodexConfig(inherited, url), policy: advisorPolicy("codex", []) });
  }
const requests = [{ chatId: "child", requestId: "request" }];
const escalation = [];
for (const calls of [0, 6, 7, 8, 9])
  for (const call of [
    { name: "read_linked_file", input: {}, readOnly: true },
    { name: "chat_respond", input: { chatId: "child", requestId: "request" } },
    { name: "chat_respond", input: { chatId: "other", requestId: "request" } },
    { name: "tasks_set", input: {} },
    { name: "unknown", input: {} },
  ]) {
    let stopped = false;
    const turn = new EscalationTurn({ requests }, () => {
      stopped = true;
    });
    for (let n = 0; n < calls; n++) turn.called();
    escalation.push({ requests, calls, call, denial: turn.denial(call), stopped });
  }
const out = path.join(__dirname, "../tests/fixtures/conformance/codex-guards.json");
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      generatedFrom: "babysit-guard.cjs, escalation-guard.cjs, advisor-policy.cjs",
      babysit,
      advisors,
      escalation,
      toolCalls: ESCALATION_TOOL_CALLS,
      toolGrace: ESCALATION_TOOL_GRACE,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Recorded ${babysit.length} babysit, ${advisors.length} advisor, ${escalation.length} escalation cases`);

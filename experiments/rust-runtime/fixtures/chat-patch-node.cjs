// Runs actual Node runtime patch handlers against explicit state/writer/clock doubles.
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { patchSession } = require("../../../packages/shared/src/project-edits.mjs");
const { isRunChat, withRunChatsHidden } = require("../../../packages/core/src/routines/runtime-adapter.cjs");
const source = fs.readFileSync(require.resolve("../../../packages/core/src/runtime.cjs"), "utf8");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
let state = input.state,
  now = 0,
  done = [];
let handler;
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error("Node patch source boundary changed");
  return source.slice(a, b);
}
const code = [
  section("  async function keepRunChat(", "  // `done`"),
  section("  function sessionPatch(", "  // Writing to a Done Chat"),
  section('  commands.handle("chat:patch",', '  commands.handle("chat:delete",'),
].join("\n");
vm.runInNewContext(code, {
  Date: { now: () => now },
  patchSession,
  isRunChat,
  withRunChatsHidden,
  scopeStates: { has: (p) => p === input.scope, get: async () => state },
  heldState: () => state,
  editProject: async (_path, edit) => {
    state = edit(state);
  },
  routines: { chatDone: (chat) => done.push(chat) },
  commands: {
    handle: (_name, fn) => {
      handler = fn;
    },
  },
});
(async () => {
  const observations = [];
  for (const op of input.operations) {
    now = op.now;
    await handler({}, input.scope, op.id, op.patch);
    observations.push({ state, done: done.slice() });
  }
  console.log(JSON.stringify({ observations, runtimeSha256: createHash("sha256").update(source).digest("hex") }));
})();

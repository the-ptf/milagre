const test = require("node:test");
const assert = require("node:assert/strict");
const { runProductCommand, productHelp } = require("./product-commands.cjs");
const { parseCommandArgs } = require("./command-args.cjs");
test("computer add accepts its label shortcut with positional and named links", async () => {
  const calls = [];
  const client = {
    call: async (method, args) => {
      calls.push([method, args]);
      return { ok: true };
    },
  };
  await runProductCommand(client, ["computers", "add", "link"], { flags: [["name", "Box"]] });
  await runProductCommand(client, ["computers", "add"], {
    flags: [
      ["link", "link"],
      ["name", "Box"],
    ],
  });
  assert.deepEqual(calls, [
    ["computers:add", ["link", { name: "Box" }]],
    ["computers:add", ["link", { name: "Box" }]],
  ]);
  await assert.rejects(
    runProductCommand(client, ["computers", "add"], {
      flags: [
        ["link", "link"],
        ["name", true],
      ],
    }),
    /Invalid arguments/,
  );
  assert.equal(calls.length, 2);
});

test("worktree create prints only the new Worktree and Chat unless --full is requested", async () => {
  const projectPath = "/project";
  const input = JSON.stringify({ projectPath, prompt: "" });
  const path = "/trees/feature";
  const project = {
    path: projectPath,
    state: {
      worktrees: { 1: { path: projectPath, name: "main" }, 3: { path, name: "feature" } },
      sessions: { 2: { id: 2, worktree_id: 1 }, 4: { id: 4, worktree_id: 3 } },
      messages: [{ text: "unrelated history" }],
    },
  };
  const created = { project, worktreeId: 3, setupNote: "No setup command found." };
  const methods = ["worktree:create"];
  const forms = [];
  const client = {
    call(method, args) {
      if (method === "daemon:status") return { methods };
      if (method === "daemon:state-patches") return forms.push(...args);
      assert.equal(method, "worktree:create");
      assert.deepEqual(args, [JSON.parse(input)]);
      return created;
    },
  };
  const run = (...args) => {
    const { positionals, values, flags } = parseCommandArgs(["worktree", "create", ...args]);
    return runProductCommand(client, positionals, { ...values, flags });
  };
  const summary = { worktreeId: 3, chatId: "/project#4", branch: "feature", path, setupNote: created.setupNote };
  assert.deepEqual(await run("--input", input), summary);
  methods.push("daemon:state-patches");
  assert.deepEqual(await run("--json", "--project-path", projectPath, "--prompt", ""), summary);
  assert.deepEqual(await run("--full", "--input", input), created);
  assert.deepEqual(forms, [{ messages: false, transcripts: false, archivedSubagents: false }]);
  assert.match(await productHelp(null, ["worktree", "create"], {}), /--full/);
  project.git = false;
  assert.equal((await run("--input", input)).branch, null);
});

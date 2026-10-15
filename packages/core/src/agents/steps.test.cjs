const assert = require("node:assert/strict");
const test = require("node:test");
const { capOutput, claudeStep, claudeStepResult, codexStep, codexStepResult } = require("./steps.cjs");

// Shapes recorded from Claude Code 2.1.287 and codex-cli 0.158.0.
const ok = (content, extra = {}) => ({ type: "tool_result", tool_use_id: "t", content, ...extra });

test("Claude: commands, reads and edits get a title and a kind", () => {
  assert.deepEqual(claudeStep("t1", "Bash", { command: "npm test", description: "Run tests" }), {
    id: "t1",
    kind: "shell",
    title: "Ran `npm test`",
    detail: "$ npm test\n",
  });
  assert.deepEqual(claudeStep("t2", "Read", { file_path: "/repo/src/App.tsx" }), {
    id: "t2",
    kind: "read",
    title: "Read `App.tsx`",
    file: "/repo/src/App.tsx",
  });
  assert.deepEqual(claudeStep("t3", "Edit", { file_path: "/repo/src/App.tsx", old_string: "a", new_string: "b" }), {
    id: "t3",
    kind: "edit",
    title: "Edited `App.tsx`",
    file: "/repo/src/App.tsx",
  });
  assert.deepEqual(claudeStep("t4", "Write", { file_path: "/repo/notes.txt", content: "hi" }), {
    id: "t4",
    kind: "edit",
    title: "Wrote `notes.txt`",
    file: "/repo/notes.txt",
  });
  assert.equal(claudeStep("t5", "NotebookEdit", { notebook_path: "/repo/a.ipynb" }).title, "Edited `a.ipynb`");
  assert.equal(claudeStep("t5", "NotebookEdit", { notebook_path: "/repo/a.ipynb" }).file, "/repo/a.ipynb");
  assert.equal("file" in claudeStep("t6", "Read", {}), false);
  assert.deepEqual(claudeStep("t6", "Grep", { pattern: "greet", path: "src" }), { id: "t6", kind: "search", title: "Searched for `greet` in `src`" });
  assert.deepEqual(claudeStep("t7", "Glob", { pattern: "**/*.js" }), { id: "t7", kind: "search", title: "Found files matching `**/*.js`" });
  assert.deepEqual(claudeStep("t8", "WebSearch", { query: "IANA example domain" }), {
    id: "t8",
    kind: "search",
    title: "Searched the web for `IANA example domain`",
  });
});

test("Claude: other tools say what they used", () => {
  assert.deepEqual(claudeStep("t1", "WebFetch", { url: "https://example.com", prompt: "x" }), {
    id: "t1",
    kind: "other",
    title: "Fetched `https://example.com`",
  });
  assert.deepEqual(claudeStep("t2", "Agent", { description: "List files", prompt: "Run ls", subagent_type: "general-purpose" }), {
    id: "t2",
    kind: "other",
    title: "Ran an agent: List files",
  });
  assert.equal(claudeStep("t3", "TodoWrite", { todos: [] }).title, "Updated the to-do list");
  assert.equal(claudeStep("t4", "mcp__argent__list-devices", {}).title, "Used `list-devices` from argent");
  assert.equal(claudeStep("t5", "ToolSearch", { query: "select:Glob" }).title, "Used ToolSearch");
});

test("Claude: long or multi-line commands become one short line, without stray backticks", () => {
  const step = claudeStep("t1", "Bash", { command: "cat <<'EOF' > a.txt\nhello `world`\nEOF" });
  assert.equal(step.title, "Ran `cat <<'EOF' > a.txt hello 'world' EOF`");
  assert.equal(step.detail, "$ cat <<'EOF' > a.txt\nhello `world`\nEOF\n");
  const long = claudeStep("t2", "Bash", { command: "x".repeat(200) }).title;
  assert.equal(long, `Ran \`${"x".repeat(79)}…\``);
});

test("Claude: a command's result is its output; a failure is marked failed", () => {
  const bash = { id: "t1", name: "Bash", input: { command: "echo out" } };
  assert.deepEqual(claudeStepResult(bash, ok("out", { is_error: false }), { stdout: "out", stderr: "", interrupted: false }), {
    id: "t1",
    status: "done",
    detail: "$ echo out\nout",
  });
  const missing = { id: "t2", name: "Bash", input: { command: "cat missing.txt" } };
  assert.deepEqual(claudeStepResult(missing, ok("Exit code 1\ncat: missing.txt: No such file or directory", { is_error: true }), "Error: Exit code 1"), {
    id: "t2",
    status: "failed",
    detail: "$ cat missing.txt\nExit code 1\ncat: missing.txt: No such file or directory",
  });
  const denied = claudeStepResult(
    { id: "t3", name: "Write", input: { file_path: "/a", content: "x" } },
    ok("Denied in Milagre", { is_error: true }),
    "Error: Denied in Milagre",
  );
  assert.deepEqual(denied, { id: "t3", status: "failed", detail: "Denied in Milagre" });
});

test("Claude: a read keeps no output unless it failed", () => {
  const read = { id: "t1", name: "Read", input: { file_path: "/repo/a.js" } };
  assert.deepEqual(claudeStepResult(read, ok("1\texport const a = 1;\n")), { id: "t1", status: "done" });
  assert.deepEqual(claudeStepResult(read, ok("File does not exist.", { is_error: true })), { id: "t1", status: "failed", detail: "File does not exist." });
});

test("Claude: edits show Claude Code's own patch, or the change from the input", () => {
  const edit = { id: "t1", name: "Edit", input: { file_path: "/repo/app.js", old_string: "  return `Hello ${name}`;", new_string: "  return `Hi ${name}`;" } };
  const structured = {
    filePath: "/repo/app.js",
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [" export function greet(name) {", "-  return `Hello ${name}`;", "+  return `Hi ${name}`;", " }"],
      },
    ],
  };
  assert.deepEqual(claudeStepResult(edit, ok("The file /repo/app.js has been updated successfully."), structured), {
    id: "t1",
    status: "done",
    detail: "@@ -1,3 +1,3 @@\n export function greet(name) {\n-  return `Hello ${name}`;\n+  return `Hi ${name}`;\n }",
  });
  const write = { id: "t2", name: "Write", input: { file_path: "/repo/notes.txt", content: "one\ntwo" } };
  assert.deepEqual(claudeStepResult(write, ok("File created successfully at: /repo/notes.txt"), { type: "create", structuredPatch: [], originalFile: null }), {
    id: "t2",
    status: "done",
    detail: "+one\n+two",
  });
});

test("Claude: agents show their report, or that they started in the background", () => {
  const agent = { id: "t1", name: "Agent", input: { description: "List files", prompt: "Run ls" } };
  const report = { status: "completed", content: [{ type: "text", text: "README.md and src." }], totalToolUseCount: 2 };
  assert.deepEqual(claudeStepResult(agent, ok([{ type: "text", text: "[Subagent hand-back] …" }]), report), {
    id: "t1",
    status: "done",
    detail: "README.md and src.",
  });
  const launched = { isAsync: true, status: "async_launched", agentId: "a1", description: "List files", prompt: "Run ls", outputFile: "/tmp/a1.output" };
  assert.deepEqual(claudeStepResult(agent, ok([{ type: "text", text: "Async agent launched successfully." }]), launched), {
    id: "t1",
    status: "done",
    title: "Started an agent: List files",
  });
});

test("Claude: other results show their text; to-do lists show the items", () => {
  assert.deepEqual(claudeStepResult({ id: "t1", name: "WebFetch", input: {} }, ok([{ type: "text", text: "Page text" }, { type: "image" }])), {
    id: "t1",
    status: "done",
    detail: "Page text\n[image]",
  });
  assert.deepEqual(claudeStepResult({ id: "t2", name: "ToolSearch", input: {} }, ok("")), { id: "t2", status: "done" });
  const todos = {
    id: "t3",
    name: "TodoWrite",
    input: {
      todos: [
        { content: "Write tests", status: "completed" },
        { content: "Ship", status: "in_progress" },
        { content: "Celebrate", status: "pending" },
      ],
    },
  };
  assert.deepEqual(claudeStepResult(todos, ok("Todos have been modified successfully.")), {
    id: "t3",
    status: "done",
    detail: "[x] Write tests\n[~] Ship\n[ ] Celebrate",
  });
});

const command = (overrides = {}) => ({
  type: "commandExecution",
  id: "exec-1",
  command: "/bin/zsh -lc 'npm test'",
  cwd: "/repo",
  processId: null,
  source: "agent",
  status: "inProgress",
  commandActions: [{ type: "unknown", command: "npm test" }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...overrides,
});

test("Codex: commands show the command without the shell wrapper", () => {
  assert.deepEqual(codexStep(command()), { id: "exec-1", kind: "shell", title: "Ran `npm test`", detail: "$ npm test\n" });
  assert.deepEqual(codexStepResult(command({ status: "completed", aggregatedOutput: "ok 1\nok 2\n", exitCode: 0 })), {
    id: "exec-1",
    status: "done",
    detail: "$ npm test\nok 1\nok 2\n",
  });
  assert.deepEqual(codexStepResult(command({ status: "failed", aggregatedOutput: "1 failing\n", exitCode: 1 })), {
    id: "exec-1",
    status: "failed",
    detail: "$ npm test\n1 failing\n",
  });
  assert.deepEqual(codexStepResult(command({ status: "declined" })), { id: "exec-1", status: "failed", detail: "$ npm test\nDeclined." });
});

test("Codex: reads, searches and listings Codex recognised get their own kind", () => {
  const read = command({
    command: "/bin/zsh -lc 'cat src/app.js'",
    commandActions: [{ type: "read", command: "cat src/app.js", name: "app.js", path: "/repo/src/app.js" }],
  });
  assert.deepEqual(codexStep(read), { id: "exec-1", kind: "read", title: "Read `app.js`", detail: "$ cat src/app.js\n", file: "/repo/src/app.js" });
  assert.deepEqual(codexStepResult({ ...read, status: "completed", exitCode: 0, aggregatedOutput: "export function greet() {}\n" }), {
    id: "exec-1",
    status: "done",
  });
  assert.deepEqual(codexStepResult({ ...read, status: "failed", exitCode: 1, aggregatedOutput: "cat: src/app.js: No such file or directory\n" }), {
    id: "exec-1",
    status: "failed",
    detail: "$ cat src/app.js\ncat: src/app.js: No such file or directory\n",
  });

  const search = command({
    command: "/bin/zsh -lc 'rg -n greet src'",
    commandActions: [{ type: "search", command: "rg -n greet src", query: "greet", path: "src" }],
  });
  assert.deepEqual(codexStep(search), { id: "exec-1", kind: "search", title: "Searched for `greet` in `src`", detail: "$ rg -n greet src\n" });
  const list = command({ command: "/bin/zsh -lc ls", commandActions: [{ type: "listFiles", command: "ls", path: null }] });
  assert.deepEqual(codexStep(list), { id: "exec-1", kind: "search", title: "Listed files", detail: "$ ls\n" });
  const both = command({
    command: "/bin/zsh -lc 'cat a && cat b'",
    commandActions: [
      { type: "read", command: "cat a", name: "a", path: "/a" },
      { type: "read", command: "cat b", name: "b", path: "/b" },
    ],
  });
  assert.equal(codexStep(both).kind, "shell");
});

test("Codex: file changes show what changed and the diff", () => {
  const created = { type: "fileChange", id: "exec-2", status: "inProgress", changes: [{ path: "/repo/notes.txt", kind: { type: "add" }, diff: "one\ntwo\n" }] };
  assert.deepEqual(codexStep(created), { id: "exec-2", kind: "edit", title: "Created `notes.txt`", file: "/repo/notes.txt" });
  assert.deepEqual(codexStepResult({ ...created, status: "completed" }), {
    id: "exec-2",
    status: "done",
    title: "Created `notes.txt`",
    detail: "--- /repo/notes.txt\n+one\n+two\n",
  });
  const edited = {
    type: "fileChange",
    id: "exec-3",
    status: "declined",
    changes: [
      { path: "/repo/app.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "/repo/old.js", kind: { type: "delete" }, diff: "gone\n" },
    ],
  };
  assert.deepEqual(codexStep(edited).title, "Edited 2 files");
  assert.deepEqual(codexStepResult(edited), {
    id: "exec-3",
    status: "failed",
    title: "Edited 2 files",
    detail: "--- /repo/app.js\n@@ -1 +1 @@\n-a\n+b\n\n--- /repo/old.js\n-gone\n",
  });
});

test("Codex: MCP tools, web searches and images", () => {
  const mcp = { type: "mcpToolCall", id: "exec-4", server: "argent", tool: "list-devices", status: "inProgress", arguments: {}, result: null, error: null };
  assert.deepEqual(codexStep(mcp), { id: "exec-4", kind: "other", title: "Used `list-devices` from argent" });
  assert.deepEqual(codexStepResult({ ...mcp, status: "completed", result: { content: [{ type: "text", text: '{"devices":[]}' }], structuredContent: null } }), {
    id: "exec-4",
    status: "done",
    detail: '{"devices":[]}',
  });
  assert.deepEqual(codexStepResult({ ...mcp, status: "failed", error: { message: "server not running" } }), {
    id: "exec-4",
    status: "failed",
    detail: "server not running",
  });

  // Codex only knows the query once the search is done.
  const search = { type: "webSearch", id: "exec-5", query: "", action: null, results: null };
  assert.deepEqual(codexStep(search), { id: "exec-5", kind: "search", title: "Searched the web" });
  const found = {
    ...search,
    query: "IANA example domain",
    action: { type: "search", query: "IANA example domain", queries: null },
    results: [{ type: "text_result", title: "Example Domains", url: "https://www.iana.org/help/example-domains", snippet: "…" }],
  };
  assert.deepEqual(codexStepResult(found), {
    id: "exec-5",
    status: "done",
    title: "Searched the web for `IANA example domain`",
    detail: "Example Domains\nhttps://www.iana.org/help/example-domains",
  });

  assert.deepEqual(codexStep({ type: "imageView", id: "exec-6", path: "/repo/shot.png" }), {
    id: "exec-6",
    kind: "image",
    title: "Viewed `shot.png`",
    file: "/repo/shot.png",
  });
  assert.deepEqual(codexStep({ type: "dynamicToolCall", id: "exec-7", tool: "lookup", arguments: {}, status: "inProgress" }), {
    id: "exec-7",
    kind: "other",
    title: "Used `lookup`",
  });
});

test("Codex: a generated image is an image step that ends with its file and prompt", () => {
  const item = { type: "imageGeneration", id: "ig_1", status: "in_progress", revisedPrompt: null, result: "", failure: null };
  assert.deepEqual(codexStep(item), { id: "ig_1", kind: "image", title: "Generating an image" });
  const done = { ...item, status: "completed", revisedPrompt: "A lighthouse at dusk", result: "iVBOR", savedPath: "/home/.codex/generated_images/ig_1.png" };
  assert.deepEqual(codexStepResult(done), {
    id: "ig_1",
    status: "done",
    title: "Generated an image",
    detail: "A lighthouse at dusk",
    file: "/home/.codex/generated_images/ig_1.png",
  });
  const limited = { ...item, status: "failed", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: null } };
  assert.deepEqual(codexStepResult(limited), { id: "ig_1", status: "failed", title: "Couldn't generate an image", note: "image limit reached" });
  // Without a file or the image itself there is nothing to show.
  assert.equal(codexStepResult({ ...item, status: "completed" }).status, "failed");
});

test("Codex: messages, reasoning and other items are not steps", () => {
  for (const type of ["agentMessage", "reasoning", "userMessage", "plan", "somethingNew"]) assert.equal(codexStep({ type, id: "x" }), null);
});

test("a long command's starting detail keeps its end too", () => {
  const command = `cat > big.txt <<'EOF'\n${"x".repeat(60_000)}\nEOF`;
  const claude = claudeStep("t1", "Bash", { command }).detail;
  assert.ok(claude.length <= 20_012 && claude.endsWith("\nEOF\n"));
  const codex = codexStep({ type: "commandExecution", id: "e", command, status: "inProgress", commandActions: [{ type: "unknown", command }] }).detail;
  assert.ok(codex.length <= 20_012 && codex.endsWith("\nEOF\n"));
});

test("command output keeps its end when it's long", () => {
  assert.equal(capOutput("short"), "short");
  const capped = capOutput(`${"a".repeat(5_000)}${"b".repeat(20_000)}`);
  assert.equal(capped, `… truncated\n${"b".repeat(20_000)}`);
});

test("editable design creation and batches show cards for Claude and Codex", () => {
  const artifact = { id: "welcome", version: 3, title: "Welcome screen", format: "design" };
  const result = JSON.stringify({ ...artifact, versions: 3, format: "design", width: 390, height: 844 });
  for (const tool of ["design_show", "design_apply"]) {
    const args = tool === "design_show" ? { title: "Welcome screen" } : { id: "welcome", expectedVersion: 2, operations: [] };
    const title = tool === "design_show" ? "Showed `Welcome screen`" : "Edited `a design`";
    const completedTitle = tool === "design_show" ? "Showed `Welcome screen`" : "Edited `Welcome screen`";
    const name = `mcp__milagre__${tool}`;
    assert.deepEqual(claudeStep("design-1", name, args), { id: "design-1", kind: "artifact", title, tool });
    assert.deepEqual(claudeStepResult({ id: "design-1", name, input: args }, ok(result)), { id: "design-1", status: "done", artifact, title: completedTitle });
    assert.deepEqual(claudeStepResult({ id: "design-1", name, input: args }, ok("Design version conflict", { is_error: true })), {
      id: "design-1",
      status: "failed",
      detail: "Design version conflict",
    });

    const call = { type: "mcpToolCall", id: "design-2", server: "milagre", tool, status: "inProgress", arguments: args };
    assert.deepEqual(codexStep(call), { id: "design-2", kind: "artifact", title, tool });
    assert.deepEqual(codexStepResult({ ...call, status: "completed", result: { content: [{ type: "text", text: result }] } }), {
      id: "design-2",
      status: "done",
      artifact,
      title: completedTitle,
    });
    assert.deepEqual(codexStepResult({ ...call, status: "failed", error: { message: "Design version conflict" } }), {
      id: "design-2",
      status: "failed",
      detail: "Design version conflict",
    });
  }
});

test("a completed design step carries the design's group", () => {
  const call = { id: "design-1", name: "mcp__milagre__design_show", input: { title: "Welcome" } };
  const result = (group) => ok(JSON.stringify({ id: "welcome", version: 1, title: "Welcome", format: "design", group }));
  assert.deepEqual(claudeStepResult(call, result("Onboarding")).artifact, {
    id: "welcome",
    version: 1,
    title: "Welcome",
    format: "design",
    group: "Onboarding",
  });
  assert.deepEqual(claudeStepResult(call, result(42)).artifact, { id: "welcome", version: 1, title: "Welcome", format: "design" });
});

test("completed design activity uses the saved title and leaves malformed results without a fabricated title", () => {
  const call = { id: "design-1", name: "mcp__milagre__design_show", input: { title: "Requested name" } };
  const content = JSON.stringify({ id: "welcome", version: 1, title: "Saved `screen`\nname", format: "design" });
  assert.equal(claudeStepResult(call, ok(content)).title, "Showed `Saved 'screen' name`");
  assert.equal(claudeStepResult(call, ok("invalid result")).title, undefined);
  const item = { type: "mcpToolCall", id: "design-2", server: "milagre", tool: "design_apply", status: "completed", arguments: { id: "welcome" } };
  assert.equal(codexStepResult({ ...item, result: { content: [{ type: "text", text: content }] } }).title, "Edited `Saved 'screen' name`");
  assert.equal(codexStepResult({ ...item, result: { content: [{ type: "text", text: "invalid result" }] } }).title, undefined);
});

test("resolving a design comment reads as that, with the agent's note", () => {
  const call = { id: "t1", name: "mcp__milagre__artifact_resolve_comment", input: { id: "0a1b2c3d", note: "Bigger title" } };
  assert.deepEqual(claudeStepResult(call, ok('{"id":"0a1b2c3d"}')), { id: "t1", status: "done", detail: "Bigger title" });
  assert.deepEqual(claudeStep("t1", "mcp__milagre__artifact_resolve_comment", { id: "0a1b2c3d", note: "Bigger title" }), {
    id: "t1",
    kind: "other",
    title: "Resolved a design comment",
    detail: "Bigger title",
  });
  assert.deepEqual(
    codexStep({ type: "mcpToolCall", id: "e1", server: "milagre", tool: "artifact_resolve_comment", status: "inProgress", arguments: { note: "Done" } }),
    {
      id: "e1",
      kind: "other",
      title: "Resolved a design comment",
      detail: "Done",
    },
  );
});

test("HTML artifact tool renders a typed artifact card for both providers", () => {
  const artifact = { id: "explanation", title: "Explanation", version: 2, format: "html" };
  const args = { title: artifact.title, html: "<p>Why it works</p>" };
  const text = JSON.stringify({ ...artifact, versions: 1, width: 1280, height: 800 });
  const name = "mcp__milagre__artifact_show";
  assert.deepEqual(claudeStep("html-1", name, args), { id: "html-1", kind: "artifact", title: "Showed `Explanation`", tool: "artifact_show" });
  assert.deepEqual(claudeStepResult({ id: "html-1", name, input: args }, ok(text)), { id: "html-1", status: "done", artifact, title: "Showed `Explanation`" });
  const call = { type: "mcpToolCall", id: "html-2", server: "milagre", tool: "artifact_show", status: "inProgress", arguments: args };
  assert.deepEqual(codexStep(call), { id: "html-2", kind: "artifact", title: "Showed `Explanation`", tool: "artifact_show" });
  assert.deepEqual(codexStepResult({ ...call, status: "completed", result: { content: [{ type: "text", text }] } }), {
    id: "html-2",
    status: "done",
    artifact,
    title: "Showed `Explanation`",
  });
});

test("a design result with an image attached still produces the Chat card", () => {
  const artifact = { id: "welcome", version: 2, title: "Welcome", format: "design" };
  const summary = JSON.stringify({ ...artifact, warnings: [] });
  // The block list a Claude tool_result carries when Milagre attaches the rendered design.
  const block = ok([
    { type: "text", text: summary },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ]);
  const step = claudeStepResult({ id: "call-1", name: "mcp__milagre__design_show", input: {} }, block, undefined);
  assert.deepEqual(step.artifact, artifact);
  // Codex's mcpToolCall carries MCP-shaped blocks.
  const call = { type: "mcpToolCall", id: "design-3", server: "milagre", tool: "design_show", status: "completed", arguments: {} };
  const codex = codexStepResult({
    ...call,
    result: {
      content: [
        { type: "text", text: summary },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    },
  });
  assert.deepEqual(codex.artifact, artifact);
});

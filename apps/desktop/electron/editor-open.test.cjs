const { test } = require("node:test");
const assert = require("node:assert/strict");
test("editor bridge returns Result for success, validation, launch failure and thrown failure", async () => {
  const { createEditorOpener } = require("./editor-open.cjs");
  const calls = [];
  const open = createEditorOpener({
    editors: async () => ["editor"],
    open: async (request, options) => {
      calls.push({ request, options });
      return null;
    },
  });
  assert.deepEqual(await open({ root: "/project", path: "file.ts", line: 12 }), { ok: true, value: null });
  assert.equal(calls[0].request.path, "file.ts");
  assert.equal("fallbacks" in calls[0].request, false);
  assert.deepEqual(calls[0].options.editors, ["editor"]);
  // Fallbacks reach the opener as strings only.
  await open({ root: "/project", path: "casos/a.md", fallbacks: ["/project/.routines/r/casos/a.md", 7, null] });
  assert.deepEqual(calls[1].request.fallbacks, ["/project/.routines/r/casos/a.md"]);
  calls.length = 1;
  assert.deepEqual(await open(null), { ok: false, error: { code: "EDITOR_OPEN", message: "File not found" } });
  assert.equal(calls.length, 1);
  assert.deepEqual(await createEditorOpener({ editors: async () => [], open: async () => "Editor missing" })({ root: "/p" }), {
    ok: false,
    error: { code: "EDITOR_OPEN", message: "Editor missing" },
  });
  assert.deepEqual(
    await createEditorOpener({
      editors: async () => {
        throw new Error("Lookup failed");
      },
      open: async () => null,
    })({ root: "/p" }),
    { ok: false, error: { code: "EDITOR_OPEN", message: "Lookup failed" } },
  );
});

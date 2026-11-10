const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { editorInvocation } = require("./editor-command.cjs");
test("Windows VS Code opens paths with spaces and shell characters as literal arguments", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "resources/app/out"), { recursive: true });
  const file = path.join(root, "bin/code.cmd");
  fs.writeFileSync(file, "wrapper");
  fs.writeFileSync(path.join(root, "Code.exe"), "exe");
  fs.writeFileSync(path.join(root, "resources/app/out/cli.js"), "cli");
  const args = ["-g", "C:\\Project files\\$(command) & file.ts:42"];
  const result = editorInvocation(file, args, { platform: "win32" });
  assert.equal(result.file, path.join(root, "Code.exe"));
  assert.deepEqual(result.args, [path.join(root, "resources/app/out/cli.js"), ...args]);
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, "1");
  fs.unlinkSync(path.join(root, "Code.exe"));
  assert.throws(() => editorInvocation(file, args, { platform: "win32" }));
});
test("Windows editors run the executable and script their own launcher names, wherever their install keeps them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-editor-layouts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const launcher = (exe, cli) =>
    `@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0${exe}" "%~dp0${cli}" %*\r\nIF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%\r\nendlocal\r\n`;
  // VS Code keeps each release's files in a folder named after its commit.
  write("Code/Code.exe", "exe");
  write("Code/a5b5009513/resources/app/out/cli.js", "cli");
  write("Code/bin/code.cmd", launcher("..\\Code.exe", "..\\a5b5009513\\resources\\app\\out\\cli.js"));
  const code = editorInvocation(path.join(root, "Code/bin/code.cmd"), ["-g", "x.ts:3"], { platform: "win32" });
  assert.equal(code.file, path.join(root, "Code/Code.exe"));
  assert.deepEqual(code.args, [path.join(root, "Code/a5b5009513/resources/app/out/cli.js"), "-g", "x.ts:3"]);
  // Cursor's bin folder sits inside resources\app.
  write("cursor/Cursor.exe", "exe");
  write("cursor/resources/app/out/cli.js", "cli");
  write("cursor/resources/app/bin/cursor.cmd", launcher("..\\..\\..\\Cursor.exe", "..\\out\\cli.js"));
  const cursor = editorInvocation(path.join(root, "cursor/resources/app/bin/cursor.cmd"), [], { platform: "win32" });
  assert.equal(cursor.file, path.join(root, "cursor/Cursor.exe"));
  assert.deepEqual(cursor.args, [path.join(root, "cursor/resources/app/out/cli.js")]);
  // A launcher that names another program, or a script outside the editor's install, is refused.
  write("Code/bin/code.cmd", launcher("..\\Other.exe", "..\\a5b5009513\\resources\\app\\out\\cli.js"));
  assert.throws(() => editorInvocation(path.join(root, "Code/bin/code.cmd"), [], { platform: "win32" }), /incomplete/);
  write("elsewhere/cli.js", "cli");
  write("Code/bin/code.cmd", launcher("..\\Code.exe", "..\\..\\elsewhere\\cli.js"));
  assert.throws(() => editorInvocation(path.join(root, "Code/bin/code.cmd"), [], { platform: "win32" }), /incomplete/);
});
test("other platforms and unknown editor wrappers retain standard invocation", () => {
  assert.equal(editorInvocation("/usr/bin/code", ["/project"], { platform: "linux" }), null);
  assert.equal(editorInvocation("/trusted/bin/other.cmd", [], { platform: "win32" }), null);
});

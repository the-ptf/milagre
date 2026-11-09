const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "../apps/mobile/src");

test("mobile ui stays a compatibility barrel without inline primitives", () => {
  const source = ts.createSourceFile("ui.tsx", fs.readFileSync(path.join(root, "ui.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.ok(source.statements.length > 0);
  for (const statement of source.statements) {
    assert.ok(ts.isExportDeclaration(statement), "put primitive implementations in primitives/, leaving only re-exports in ui.tsx");
    assert.ok(statement.moduleSpecifier.text.startsWith("./primitives/"));
  }
});

test("mobile primitives depend directly on each other instead of cycling through ui", () => {
  const directory = path.join(root, "primitives");
  assert.ok(fs.existsSync(directory), "mobile primitives need their own directory");
  for (const name of fs.readdirSync(directory).filter((name) => /\.tsx?$/.test(name))) {
    const source = ts.createSourceFile(name, fs.readFileSync(path.join(directory, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const target = statement.moduleSpecifier?.text;
      if (!target?.startsWith(".")) continue;
      assert.notEqual(path.resolve(directory, target).replace(/\.tsx?$/, ""), path.join(root, "ui"), `${name} must import a sibling directly`);
    }
  }
});

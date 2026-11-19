const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.join(__dirname, "../apps/mobile/src");

test("mobile primitives depend directly on each other instead of cycling through ui", () => {
  const directory = path.join(root, "primitives");
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

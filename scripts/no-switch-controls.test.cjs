const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const roots = ["apps/desktop/app/src", "apps/mobile/src"];
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(tsx|ts)$/.test(entry.name) && !/\.(test|gen)\.ts$/.test(entry.name) ? [file] : [];
  });
}

test("desktop and mobile use checkboxes and checked choices instead of switches", () => {
  const offenders = [];
  for (const file of roots.flatMap(sources)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxAttribute(node) && ["role", "accessibilityRole"].includes(node.name.text) && node.initializer?.text === "switch") offenders.push(file);
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "Switch") offenders.push(file);
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^(Switch|RowSwitch)$/.test(node.tagName.getText(source))) offenders.push(file);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual([...new Set(offenders)], [], "Use shared checkboxes, checked lists or radio groups; switches are banned.");
});

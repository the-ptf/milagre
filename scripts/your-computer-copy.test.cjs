const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// The desktop app runs on macOS, Windows and Linux, so copy calls the other machine "your computer", never "your Mac".
// Desktop copy that names the Mac goes through lib/shortcut-hints (`thisComputer`, `ThisComputer`, `computerNoun`), which
// says "Mac" only on a Mac. The phone (apps/mobile/src) is checked by the milagre-design/copy-computer lint rule.
const root = path.resolve(__dirname, "..");
const YOUR_MAC = /\byour Mac\b/i;

// Copy written before this check. Each entry matches one string literal in that file containing `text`; fix the copy
// and delete the entry. An entry that matches nothing fails the test, so the list only shrinks.
const ALLOWED = [];

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(file);
    return /\.(tsx?|mts|cts)$/.test(entry.name) && !/\.(test|gen)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

/** Every string a file's code holds: string literals, template pieces and JSX text. */
function strings(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  (function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))
      out.push({ value: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    ts.forEachChild(node, visit);
  })(source);
  return out;
}

test('copy says "your computer", not "your Mac"', () => {
  const unused = new Set(ALLOWED);
  const offenders = [];
  for (const file of sources(path.join(root, "apps/desktop/app/src"))) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const { value, line } of strings(file).filter(({ value }) => YOUR_MAC.test(value))) {
      const allowed = [...unused].find((entry) => entry.file === relative && value.includes(entry.text));
      if (allowed) unused.delete(allowed);
      else offenders.push(`${relative}:${line} ${JSON.stringify(value.trim().slice(0, 80))}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Say "your computer": Milagre runs on macOS, Windows and Linux. Use thisComputer / ThisComputer / computerNoun from lib/shortcut-hints.',
  );
  assert.deepEqual(
    [...unused].map(({ file, text }) => `${file}: ${text}`),
    [],
    "These allowlisted strings no longer say your Mac: delete their entries from ALLOWED",
  );
});

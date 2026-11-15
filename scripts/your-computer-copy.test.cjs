const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// The desktop app runs on macOS, Windows and Linux, so the phone calls the other machine "your computer", never
// "your Mac" (the voice rule in apps/mobile/src/design-system-catalogue.ts). Desktop copy that names the
// Mac goes through lib/shortcut-hints (`thisComputer`, `ThisComputer`, `computerNoun`), which says "Mac" only on a Mac.
const root = path.resolve(__dirname, "..");
const YOUR_MAC = /\byour Mac\b/i;

// Copy written before this check. Each entry matches one string literal in that file containing `text`; fix the copy
// and delete the entry. An entry that matches nothing fails the test, so the list only shrinks.
const VIOLATION = "pre-dates this check: should say your computer";
const ALLOWED = [
  { file: "apps/mobile/src/design-system-catalogue.ts", text: '"This iPhone" or "This iPad"', reason: "the voice rule itself, quoting the banned phrase" },
  { file: "apps/mobile/src/design-system-catalogue.ts", text: '"This phone", "On this device"', reason: "the voice rule itself, quoting the banned phrase" },
  { file: "apps/mobile/src/relay-transport.ts", text: "Your Mac isn't reachable", reason: VIOLATION },
  { file: "apps/mobile/src/relay-transport.ts", text: "Pairing is closed on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/voice-section.tsx", text: "your Mac corrects misheard", reason: VIOLATION },
  { file: "apps/mobile/src/use-designs.ts", text: "Reconnect to your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/prompt-field.tsx", text: "to mention files", reason: VIOLATION },
  { file: "apps/mobile/src/project-search.tsx", text: "to search its Projects", reason: VIOLATION },
  { file: "apps/mobile/src/project-navigation.tsx", text: "on your phone and your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/project-navigation.tsx", text: "to remove Projects", reason: VIOLATION },
  { file: "apps/mobile/src/project-navigation.tsx", text: "Open Settings → Devices in Milagre on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/use-open-project.ts", text: "Couldn't find that folder on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/client.ts", text: "Your Mac refused this phone", reason: VIOLATION },
  { file: "apps/mobile/src/client.ts", text: "mobile host are running on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/client.ts", text: "Could not load this image from your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/designs-setting.ts", text: "to use Designs", reason: VIOLATION },
  { file: "apps/mobile/src/mac-settings-sections.tsx", text: "your Mac", reason: `fallback computer name; ${VIOLATION}` },
  { file: "apps/mobile/src/babysit-section.tsx", text: "to use Babysit PRs", reason: VIOLATION },
  { file: "apps/mobile/src/browser.tsx", text: "Opening through your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/mac-update.tsx", text: "Could not reach your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/browser-sign-ins-section.tsx", text: "your Mac", reason: `fallback computer name; ${VIOLATION}` },
  { file: "apps/mobile/src/app/link-projects.tsx", text: "to link Projects", reason: VIOLATION },
  { file: "apps/mobile/src/app/link-projects.tsx", text: "Open at least two Projects on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/app/choose-projects.tsx", text: "Open a Project on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/app/add-computer.tsx", text: "Point at the QR code on your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/app/add-computer.tsx", text: "On your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/app/(settings)/settings.tsx", text: "Your Mac", reason: `fallback computer name; ${VIOLATION}` },
  { file: "apps/mobile/src/app/(settings)/settings.tsx", text: "Update your Mac", reason: VIOLATION },
  { file: "apps/mobile/src/app/(settings)/skills.tsx", text: "your Mac's home folder", reason: VIOLATION },
];

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
  for (const file of ["apps/mobile/src", "apps/desktop/app/src"].flatMap((dir) => sources(path.join(root, dir)))) {
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
    'Say "your computer": Milagre runs on macOS, Windows and Linux. On desktop, use thisComputer / ThisComputer / computerNoun from lib/shortcut-hints.',
  );
  assert.deepEqual(
    [...unused].map(({ file, text }) => `${file}: ${text}`),
    [],
    "These allowlisted strings no longer say your Mac: delete their entries from ALLOWED",
  );
});

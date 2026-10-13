// Regenerate the Lucide icon geometry used by design icon layers. Run: node scripts/generate-design-icons.cjs
const fs = require("node:fs");
const path = require("node:path");

const ELEMENTS = new Set(["path", "rect", "circle", "line", "polyline", "polygon", "ellipse"]);
const ATTRIBUTE = /^(d|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|points)$/;
const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

const root = path.dirname(require.resolve("lucide-static/package.json"));
const nodes = JSON.parse(fs.readFileSync(path.join(root, "icon-nodes.json"), "utf8"));
const icons = {};
for (const [name, children] of Object.entries(nodes)) {
  icons[name] = children
    .map(([tag, attributes]) => {
      if (!ELEMENTS.has(tag)) throw new Error(`${name}: unexpected <${tag}>`);
      const pairs = Object.entries(attributes).filter(([key]) => ATTRIBUTE.test(key));
      return `<${tag} ${pairs.map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}/>`;
    })
    .join("");
}
const out = path.resolve(__dirname, "../packages/shared/src");
fs.writeFileSync(
  path.join(out, "design-icons.mjs"),
  `// Lucide ${require("lucide-static/package.json").version} (ISC, see design-icons.LICENSE.txt). Regenerate: node scripts/generate-design-icons.cjs\n` +
    `export const designIcons = ${JSON.stringify(icons)};\n\n` +
    `const distance = (a, b) => {\n` +
    `  const row = Array.from({ length: b.length + 1 }, (_, index) => index);\n` +
    `  for (let i = 1; i <= a.length; i++) {\n` +
    `    let previous = row[0];\n` +
    `    row[0] = i;\n` +
    `    for (let j = 1; j <= b.length; j++) {\n` +
    `      const current = row[j];\n` +
    `      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));\n` +
    `      previous = current;\n` +
    `    }\n` +
    `  }\n` +
    `  return row[b.length];\n` +
    `};\n\n` +
    `/** The closest Lucide names to a misspelled one, for validation errors. */\n` +
    `export function designIconSuggestions(name, count = 3) {\n` +
    `  return Object.keys(designIcons)\n` +
    `    .map((candidate) => [candidate, distance(name, candidate)])\n` +
    `    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))\n` +
    `    .slice(0, count)\n` +
    `    .map(([candidate]) => candidate);\n` +
    `}\n`,
);
fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "design-icons.LICENSE.txt"));

// Adds the terminal and code colours of every theme to src/settings/appearance/theme_vectors.json under "code", by
// running the TypeScript engine (packages/shared/src/themes). Needs Node 24 (it runs the .ts files directly).
//   node tools/gen-theme-code-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const themes = new URL("../../../packages/shared/src/themes/index.ts", import.meta.url);
const { resolvePalette, themes: registry } = await import(themes.href);
const file = fileURLToPath(new URL("../src/settings/appearance/theme_vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(file, "utf8"));
// The same custom theme `every_theme_palette_matches_the_typescript_engine` builds.
const custom = {
  light: { background: "#f5f0e6", text: "#2b2b2b", accent: "#c2410c" },
  dark: { background: "#101820", text: "#e6edf3", accent: "#ff7a59" },
};
const SYNTAX = ["plain", "comment", "keyword", "string", "number", "function", "type", "tag", "property", "operator", "punctuation"];
const code = {};
for (const choice of [...registry.map((t) => t.id), "custom"]) {
  for (const scheme of ["light", "dark"]) {
    const p = resolvePalette(choice, scheme, custom);
    code[`${choice}:${scheme}`] = {
      ansi: [...p.ansi],
      syntax: SYNTAX.map((kind) => p.syntax[kind]),
      cursor: p.cursor,
      selection: p.selection,
    };
  }
}
vectors.code = code;
vectors.codeSyntaxOrder = SYNTAX;
writeFileSync(file, JSON.stringify(vectors) + "\n");
console.log(`${Object.keys(code).length} theme schemes`);

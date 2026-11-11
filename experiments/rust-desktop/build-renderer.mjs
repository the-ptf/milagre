import { build } from "vite";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
await import("./build-content.mjs");
await build({ configFile: fileURLToPath(new URL("./vite.config.mjs", import.meta.url)) });

// A successful JS build can still omit Tailwind utilities when its scan base is
// the experiment instead of the production renderer. Fail before packaging.
const assets = new URL("./dist/assets/", import.meta.url);
const css = readdirSync(assets)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(new URL(name, assets), "utf8"))
  .join("\n");
for (const selector of [".flex{", ".size-6{", ".h-full{", ".bg-page{", ".contents{", ".rounded-control{"]) {
  assert.ok(css.includes(selector), `Production Tailwind utility missing: ${selector}`);
}
const html = readFileSync(new URL("./dist/index.html", import.meta.url), "utf8");
assert.ok(html.indexOf('<meta charset="UTF-8"') < 1024, "Charset must be detected before the long CSP");
assert.ok(html.indexOf('<meta charset="UTF-8"') < html.indexOf('http-equiv="Content-Security-Policy"'), "Charset must precede CSP");

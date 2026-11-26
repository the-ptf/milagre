import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("the viewer still calls functions it defines once Wrangler's bundler renames them", async () => {
  const bundled = await build({
    stdin: { contents: 'export { VIEWER_HEAD } from "./viewer.mjs";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "js" },
    bundle: true,
    format: "esm",
    write: false,
    keepNames: false,
  });
  const { VIEWER_HEAD } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const script = VIEWER_HEAD.slice(VIEWER_HEAD.indexOf("<script>") + 8, -"</script>".length);
  const defined = new Set([...script.matchAll(/function (mv\w+)\(/g)].map((match) => match[1]));
  const called = new Set([...script.matchAll(/(?<![\w.])(mv[A-Z]\w*)\(/g)].map((match) => match[1]));
  assert.ok(defined.has("mvStart"));
  assert.deepEqual(
    [...called].filter((name) => !defined.has(name)),
    [],
  );
});

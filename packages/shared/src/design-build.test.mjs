import assert from "node:assert/strict";
import test from "node:test";
import { designBuildHtml, designBuildLayers } from "./design-build.mjs";
import { designHtml } from "./design.mjs";

const before = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#ffffff",
  nodes: [
    { id: "title", type: "text", x: 24, y: 64, width: 300, height: 40, text: "Today", fontSize: 32, fill: "#000000" },
    { id: "card", type: "rectangle", x: 24, y: 128, width: 342, height: 64, fill: "#eeeeee", radius: 16 },
  ],
};
const after = {
  ...before,
  nodes: [before.nodes[0], { ...before.nodes[1], fill: "#2467d5" }, { id: "row.2", type: "rectangle", x: 24, y: 210, width: 342, height: 64, fill: "#eeeeee" }],
};

test("designBuildLayers lists the layers a version adds or changes, every layer of a new design", () => {
  assert.deepEqual(designBuildLayers(before, after), ["card", "row.2"]);
  assert.deepEqual(designBuildLayers(null, after), ["title", "card", "row.2"]);
  assert.deepEqual(designBuildLayers(after, after), []);
});

test("designBuildHtml fades the landed layers in one after another, and leaves the page alone otherwise", () => {
  const html = designHtml(after);
  const built = designBuildHtml(html, designBuildLayers(null, after), "#2467d5");
  for (const id of ["title", "card", "row.2"]) assert.ok(html.includes(`data-design-node="${id}"`));
  const delays = [...built.matchAll(/\[data-design-node="([^"]+)"\]\{animation-delay:(\d+)ms\}/g)].map((match) => [match[1], Number(match[2])]);
  assert.deepEqual(delays, [
    ["title", 0],
    ["card", 150],
    ["row.2", 300],
  ]);
  assert.match(built, /outline-color:#2467d5/);
  assert.match(built, /prefers-reduced-motion:reduce\)\{\[data-design-node\]\{animation:none!important\}/);
  assert.equal(built.replace(/<style id="milagre-build">.*?<\/style>/, ""), html);
  assert.equal(designBuildHtml(html, []), html);
  assert.equal(designBuildHtml(html, ['x"]{}</style><script>']), html, "an id a layer can't have never reaches the page");
  assert.doesNotMatch(designBuildHtml(html, ["card"], "red;}</style>"), /red;/);
});

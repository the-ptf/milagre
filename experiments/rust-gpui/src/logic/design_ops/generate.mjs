// Generates the parity vectors for the design edit operations from the desktop's own modules in packages/shared/src.
// Run from experiments/rust-gpui: `node src/logic/design_ops/generate.mjs`.
//
// Writes src/logic/design_ops/vectors.json:
// - apply: applyDesignOperations run on the batches in cases.json and on edits of every fixture design (the result
//   document, or the error it throws).
// - diff: diffDesignDocuments from a document to the result of a batch, for cases.json, the fixture edits and every
//   pair of consecutive fixture versions.
// - snap: the preview controller's snap (DESIGN_CONTROLLER_SCRIPT, evaluated here) for moves and resizes of fixture
//   layers, with the layout boxes it snapped against.
//
// validateDesignDocument needs zod, which this worktree may not have installed: the shared modules are copied to a
// temporary folder beside a link to a node_modules that has it (MILAGRE_NODE_MODULES, else the main checkout's).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crate = resolve(here, "../../..");
const repo = resolve(crate, "../..");
const shared = join(repo, "packages/shared/src");
const fixtureDir = join(crate, "src/workspace/panel/designs/fixture");

function nodeModules() {
  if (process.env.MILAGRE_NODE_MODULES) return process.env.MILAGRE_NODE_MODULES;
  if (existsSync(join(repo, "node_modules/zod"))) return join(repo, "node_modules");
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
  return join(dirname(common), "node_modules");
}

const work = mkdtempSync(join(tmpdir(), "design-ops-"));
try {
  mkdirSync(join(work, "src"));
  for (const name of readdirSync(shared))
    if (/\.(mjs|json)$/.test(name) || name === "design-catalog-fonts") cpSync(join(shared, name), join(work, "src", name), { recursive: true });
  writeFileSync(join(work, "package.json"), '{"type":"module"}');
  symlinkSync(nodeModules(), join(work, "node_modules"));
  const design = await import(pathToFileURL(join(work, "src", "design.mjs")).href);
  const { applyDesignOperations, diffDesignDocuments, validateDesignDocument, designLayout, DESIGN_CONTROLLER_SCRIPT } = design;

  const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const message = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const apply = [];
  const diff = [];
  const run = (name, document, operations) => {
    try {
      apply.push({ name, document, operations, result: applyDesignOperations(clone(document), clone(operations)) });
    } catch (error) {
      apply.push({ name, document, operations, error: message(error) });
    }
  };
  const differ = (name, before, after) => diff.push({ name, before, after, operations: diffDesignDocuments(clone(before), clone(after)) });

  for (const item of cases.apply) run(item.name, cases.documents[item.document], item.operations);
  for (const item of cases.diff) {
    const before = cases.documents[item.document];
    differ(item.name, before, item.operations ? applyDesignOperations(clone(before), clone(item.operations)) : before);
  }

  // Edits of the fixture designs, the kinds the editor makes.
  const fixtures = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8")));
  const snap = [];
  const snapSource = /function snap\(axis, values, excluded\) \{[\s\S]*?\n {2}\}\n/.exec(DESIGN_CONTROLLER_SCRIPT);
  if (!snapSource) throw new Error("The controller's snap function moved.");
  for (const fixture of fixtures) {
    fixture.versions.forEach((version, index) => {
      if (index) differ(`${fixture.id} v${index} to v${index + 1}`, fixture.versions[index - 1], version);
    });
    const document = fixture.versions.at(-1);
    const nodes = document.nodes;
    const first = (test) => nodes.find(test);
    const text = first((n) => n.type === "text");
    const styled = first((n) => n.textStyle);
    const bound = first((n) => n.bindings);
    const free = first((n) => n.parentId && !nodes.find((p) => p.id === n.parentId)?.layout?.match(/horizontal|vertical/));
    const parent = first((n) => n.type === "frame" && nodes.some((c) => c.parentId === n.id) && n.parentId);
    const edits = [
      text && ["edit text", [{ op: "update", id: text.id, patch: { text: "Edited in the GPUI port" } }]],
      text && ["edit font size", [{ op: "update", id: text.id, patch: { fontSize: 19 } }]],
      styled && ["override a text style", [{ op: "update", id: styled.id, patch: { fontWeight: 600 } }]],
      bound && ["override a binding", [{ op: "update", id: bound.id, patch: { [Object.keys(bound.bindings)[0]]: 3 } }]],
      free && ["move", [{ op: "update", id: free.id, patch: { x: (free.x ?? 0) + 13, y: (free.y ?? 0) - 7 } }]],
      free && ["resize", [{ op: "update", id: free.id, patch: { width: free.width + 20, height: free.height + 5, widthMode: "fixed", heightMode: "fixed" } }]],
      [
        "add a rectangle",
        [
          {
            op: "insert",
            node: { id: "rectangle-1a2b3c4d", name: "Rectangle", type: "rectangle", x: 32, y: 32, width: 160, height: 120, fill: "#dce6df", radius: 12 },
          },
        ],
      ],
      parent && ["delete a frame", [{ op: "delete", id: parent.id }]],
      parent && ["duplicate a frame", [{ op: "duplicate", id: parent.id, newId: "copy-frame" }]],
      parent && ["auto layout", [{ op: "update", id: parent.id, patch: { layout: "vertical", gap: 12, padding: 16, align: "center" } }]],
      parent && [
        "make a component and an instance",
        [
          { op: "update", id: parent.id, patch: { component: true } },
          {
            op: "insert",
            node: { id: "instance-1", type: "frame", componentId: parent.id, width: parent.width, height: parent.height, x: 10, y: 10, name: "Copy instance" },
          },
        ],
      ],
      styled && ["unset a text style", [{ op: "unset", id: styled.id, fields: ["textStyle"] }]],
      ["background", [{ op: "document", patch: { background: "#f4f4f5" } }]],
    ].filter(Boolean);
    for (const [name, operations] of edits) {
      const label = `${fixture.id}: ${name}`;
      run(label, document, operations);
      const result = apply.at(-1).result;
      if (result) differ(label, document, result);
    }

    // Snapping, as the controller computes it during a drag.
    const checked = validateDesignDocument(clone(document));
    const layout = designLayout(checked);
    const bounds = Object.fromEntries(layout);
    const byId = new Map(checked.nodes.map((node) => [node.id, node]));
    const snapIn = new Function("design", "bounds", "nodes", `${snapSource[0]}; return snap;`)(checked, bounds, byId);
    const movable = checked.nodes.filter((node) => bounds[node.id]).slice(0, 12);
    const offsets = [
      [0, 0],
      [3, -2],
      [7, 11],
      [-15, 4],
      [40, 40],
      [-61, 23],
      [118, -9],
      [5.4, 2.6],
    ];
    for (const node of movable) {
      for (const resizing of [false, true]) {
        for (const [rx, ry] of offsets) {
          const box = bounds[node.id];
          let dx = Math.round(rx),
            dy = Math.round(ry);
          const excluded = new Set([node.id]);
          const sx = snapIn("x", resizing ? [box.x + box.width + dx] : [box.x + dx, box.x + box.width / 2 + dx, box.x + box.width + dx], excluded);
          const sy = snapIn("y", resizing ? [box.y + box.height + dy] : [box.y + dy, box.y + box.height / 2 + dy, box.y + box.height + dy], excluded);
          snap.push({ design: fixture.id, target: node.id, resizing, raw: [rx, ry], dx: dx + sx.delta, dy: dy + sy.delta, guides: [sx.line, sy.line] });
        }
      }
    }
    snap.push({ design: fixture.id, document: checked, bounds: [...layout].map(([id, box]) => [id, box.x, box.y, box.width, box.height]) });
  }

  writeFileSync(join(here, "vectors.json"), JSON.stringify({ apply, diff, snap }) + "\n");
  console.log(`apply ${apply.length} (${apply.filter((v) => v.error).length} errors), diff ${diff.length}, snap ${snap.length}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

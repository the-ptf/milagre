// The real shared Design engine is the oracle. No render mocks or live profiles.
import { createHash } from "node:crypto";
import { readFile, access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  designDocumentSchema,
  designOperationSchema,
  validateDesignDocument,
  applyDesignOperations,
  validateDesignConsistency,
  loadDesignFonts,
  designHtml,
} from "../../../packages/shared/src/design.mjs";
import { designIcons } from "../../../packages/shared/src/design-icons.mjs";
import { namedColors } from "../../../packages/shared/src/design-color-names.mjs";
const require = createRequire(import.meta.url);
const { createChatArtifacts } = require("../../../packages/core/src/chat-artifacts.cjs");
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceFiles = ["design.mjs", "design-kit.mjs", "design-components.mjs", "design-fonts.mjs", "design-colors.mjs", "design-icons.mjs", "design-paint.mjs"];
const clone = (value) => JSON.parse(JSON.stringify(value));
async function contract() {
  const sources = {};
  for (const file of sourceFiles)
    sources[file] = createHash("sha256")
      .update(await readFile(path.join(here, "../../../packages/shared/src", file)))
      .digest("hex");
  return {
    sources,
    zodVersion: require("zod/package.json").version,
    document: z.toJSONSchema(designDocumentSchema, { unrepresentable: "any", io: "input" }),
    operation: z.toJSONSchema(designOperationSchema, { unrepresentable: "any", io: "input" }),
    icons: Object.keys(designIcons),
    colors: namedColors,
  };
}
const base = {
  schemaVersion: 1,
  width: 390,
  height: 844,
  background: "#fff",
  nodes: [
    { id: "card", type: "frame", width: 350, height: 200, x: 20, y: 20, layout: "vertical", padding: 16, gap: 8 },
    { id: "title", type: "text", parentId: "card", width: 300, height: 40, text: "Hello", fontFamily: "Inter", fontSize: 20 },
    { id: "button", type: "rectangle", parentId: "card", width: 300, height: 40, fill: "rebeccapurple", radius: 8 },
    { id: "check", type: "icon", parentId: "card", width: 24, height: 24, icon: "check", fill: "#202720" },
  ],
};
const kit = {
  id: "brand",
  version: 1,
  title: "Brand",
  colors: { paper: "#fff", ink: "#202720", accent: "rebeccapurple" },
  textStyles: { heading: { fontFamily: "Inter", fontSize: 20, fontWeight: 600, lineHeight: 1.35 } },
  spacing: { small: 8, large: 16 },
  radii: { control: 8 },
  components: {},
  references: [{ title: "System", source: "Project design system" }],
};
const styled = { ...clone(base), kit: clone(kit), tokens: { custom: "rgb(10 20 30 / 50%)" }, consistency: { mode: "advisory" } };
styled.nodes[0].bindings = { padding: "large", gap: "small" };
styled.nodes[1].textStyle = "heading";
styled.nodes[2].bindings = { radius: "control" };
const component = {
  ...clone(base),
  nodes: [
    {
      id: "master",
      type: "frame",
      name: "Button",
      width: 160,
      height: 48,
      component: true,
      componentProperties: {
        label: { nodeId: "label", field: "text" },
        state: { nodeId: "glyph", field: "icon", options: ["check", "x"] },
        hide: { nodeId: "master", field: "hidden" },
      },
    },
    { id: "label", type: "text", parentId: "master", width: 120, height: 32, text: "Save" },
    { id: "glyph", type: "icon", parentId: "master", width: 24, height: 24, icon: "check" },
    { id: "instance", type: "frame", componentId: "master", width: 1, height: 1, x: 190, y: 20, componentValues: { label: "Send", state: "x", hide: false } },
  ],
};
function fixtures() {
  const cases = [];
  const add = (name, document, operations, options = {}) => {
    const item = { name, document: clone(document), ...options };
    if (operations !== undefined) item.operations = operations;
    try {
      let value = operations === undefined ? validateDesignDocument(document) : applyDesignOperations(document, operations);
      if (options.consistency) validateDesignConsistency(value);
      item.result = value;
    } catch (error) {
      item.error = error.message;
      if (error.code) item.code = error.code;
      if (error.issues) item.issues = error.issues;
      item.structural = error.name === "ZodError";
    }
    cases.push(item);
  };
  add("basic", base);
  add("pinned kit resolution", styled);
  add("components expanded", component);
  add("child before parent", base, [
    { op: "insert", node: { id: "lateChild", parentId: "lateParent", type: "text", text: "Later", width: 40, height: 20 } },
    { op: "insert", node: { id: "lateParent", type: "frame", width: 100, height: 100 } },
  ]);
  add("local edits detach only targeted bindings", styled, [
    { op: "update", id: "card", patch: { padding: 9 } },
    { op: "update", id: "title", patch: { fontSize: 22 } },
    { op: "update", id: "button", patch: { radius: 3 } },
  ]);
  add("explicit binding remains authoritative", styled, [
    { op: "update", id: "card", patch: { padding: 9, bindings: { padding: "large" } } },
    { op: "update", id: "title", patch: { fontSize: 22, textStyle: "heading" } },
  ]);
  add("unset fields", styled, [
    { op: "unset", id: "card", fields: ["bindings"] },
    { op: "unset", id: "title", fields: ["textStyle", "parentId"] },
  ]);
  add("duplicate tree", styled, [{ op: "duplicate", id: "card", newId: "copy" }]);
  add("duplicate then cascading delete", base, [
    { op: "duplicate", id: "card", newId: "copy", x: -40, y: 32 },
    { op: "delete", id: "card" },
  ]);
  add("token merge", styled, [{ op: "document", patch: { tokens: { extra: "#00ff00" }, background: "$extra" } }]);
  add("kit replacement resets colors", styled, [
    { op: "document", patch: { kit: { ...kit, version: 2, colors: { paper: "black", ink: "white", accent: "red" } }, tokens: { local: "blue" } } },
  ]);
  add("replace inherits policy", styled, [{ op: "replace", document: base }]);
  add("instance overrides", component, [
    { op: "update", id: "instance", patch: { componentValues: { label: "Go", state: "check" }, hidden: true, locked: true } },
  ]);
  add("master update propagates", component, [
    { op: "update", id: "master", patch: { width: 220 } },
    { op: "update", id: "label", patch: { text: "New master" } },
  ]);
  add("instance duplicate", component, [{ op: "duplicate", id: "instance", newId: "duplicate" }]);
  add("main duplicate remaps properties", component, [{ op: "duplicate", id: "master", newId: "otherMaster" }]);
  add("detach allows local edit", component, [
    { op: "detach", id: "instance" },
    { op: "update", id: "instance", patch: { width: 320 } },
  ]);
  const expanded = validateDesignDocument(component);
  const child = expanded.nodes.find((n) => n.parentId === "instance");
  add("generated child is read only", expanded, [{ op: "update", id: child.id, patch: { text: "No" } }]);
  add("generated child cannot duplicate", expanded, [{ op: "duplicate", id: child.id, newId: "no" }]);
  add("instance rejects ordinary child", component, [{ op: "insert", node: { id: "stray", type: "text", parentId: "instance", width: 10, height: 10 } }]);
  add("instance protects root geometry", component, [{ op: "update", id: "instance", patch: { width: 100 } }]);
  add("master delete requires detach", component, [{ op: "delete", id: "master" }]);
  add("master child delete removes expanded source", component, [
    { op: "update", id: "master", patch: { componentProperties: { hide: { nodeId: "master", field: "hidden" } } } },
    { op: "update", id: "instance", patch: { componentValues: { hide: true } } },
    { op: "delete", id: "label" },
  ]);
  add("invalid source forged by replacement", component, [{ op: "replace", document: { ...expanded, nodes: expanded.nodes.filter((n) => n.id !== "label") } }]);
  add("unknown component property", component, [{ op: "update", id: "instance", patch: { componentValues: { unknown: 1 } } }]);
  add("wrong component option", component, [{ op: "update", id: "instance", patch: { componentValues: { state: "plus" } } }]);
  add("wrong component type", component, [{ op: "update", id: "instance", patch: { componentValues: { label: 5 } } }]);
  add("unset component fields blocked", component, [{ op: "unset", id: "instance", fields: ["bindings"] }]);
  add("detach non-instance", base, [{ op: "detach", id: "card" }]);
  add("duplicate collision", base, [{ op: "duplicate", id: "card", newId: "title" }]);
  add("missing layer", base, [{ op: "delete", id: "missing" }]);
  add("past insertion index", base, [{ op: "insert", index: 900, node: { id: "new", type: "frame", width: 10, height: 10 } }]);
  add("all operations validate before mutation", base, [
    { op: "update", id: "title", patch: { fontSize: 0 } },
    { op: "update", id: "title", patch: { fontSize: 20 } },
  ]);
  add("unknown document field rejected", { ...base, futureSchema: true });
  add("unknown node field rejected", { ...base, nodes: [{ ...base.nodes[0], futureField: 1 }] });
  add("update id rejected", base, [{ op: "update", id: "card", patch: { id: "rename" } }]);
  add("cyclic parent", base, [{ op: "update", id: "card", patch: { parentId: "card" } }]);
  add("non-frame parent", base, [{ op: "update", id: "card", patch: { parentId: "title" } }]);
  add("missing token", base, [{ op: "document", patch: { background: "$missing" } }]);
  add("missing text style", styled, [{ op: "update", id: "title", patch: { textStyle: "missing" } }]);
  add("missing spacing token", styled, [{ op: "update", id: "card", patch: { bindings: { gap: "missing" } } }]);
  add("bindings need kit", { ...base, nodes: [{ ...base.nodes[0], bindings: { gap: "small" } }] });
  add("unknown icon", base, [{ op: "update", id: "check", patch: { icon: "chek" } }]);
  add("icon prohibited fields", base, [{ op: "update", id: "check", patch: { radius: 1 } }]);
  add("icon only icon type", base, [{ op: "update", id: "title", patch: { icon: "check" } }]);
  for (const color of [
    "#abcd",
    "#12345678",
    "RGB(100%, 0%, 0%, 40%)",
    "hsl(-30 20% 70% / .4)",
    "hsl(400, 50%, 50%)",
    "rgb(1 2% 3 / 200%)",
    "transparent",
    " rgb(0, 10, 20) ",
    "rgb(1%, 2, 3)",
    "#12345",
    "var(--foo)",
    "rgb(1e999 2 3)",
    "hsl(20 30 40)",
  ]) {
    add("paint " + color, { ...base, background: color });
  }
  add("font unicode and comma", { ...base, nodes: [{ ...base.nodes[1], parentId: undefined, fontFamily: "Noto Sans, 日本語, sans-serif" }] });
  add("font quoted rejected", { ...base, nodes: [{ ...base.nodes[1], parentId: undefined, fontFamily: '"Inter"' }] });
  add("HTTPS image accepted", { ...base, nodes: [{ id: "photo", type: "image", width: 10, height: 10, src: "https://example.invalid/image.png" }] });
  add("HTTP image rejected", { ...base, nodes: [{ id: "photo", type: "image", width: 10, height: 10, src: "http://example.invalid/image.png" }] });
  add("data SVG image rejected", { ...base, nodes: [{ id: "photo", type: "image", width: 10, height: 10, src: "data:image/svg+xml;base64,YQ==" }] });
  const strict = { ...clone(styled), consistency: { mode: "strict" } };
  add("strict kit valid", strict, undefined, { consistency: true });
  add(
    "strict kit drift",
    strict,
    [
      { op: "update", id: "card", patch: { padding: 17 } },
      { op: "update", id: "title", patch: { fill: "red", fontSize: 30 } },
    ],
    { consistency: true },
  );
  add(
    "strict kit exact exception",
    { ...strict, consistency: { mode: "strict", exceptions: [{ nodeId: "card", field: "padding", value: 17, reason: "  Approved space change  " }] } },
    [{ op: "update", id: "card", patch: { padding: 17 } }],
    { consistency: true },
  );
  add("strict hidden layer ignored", strict, [{ op: "update", id: "card", patch: { hidden: true, padding: 17 } }], { consistency: true });
  add("strict no kit", { ...base, consistency: { mode: "strict" } }, undefined, { consistency: true });
  add("strict empty kit field", { ...strict, kit: { ...kit, radii: {} } }, [{ op: "unset", id: "button", fields: ["bindings"] }], { consistency: true });
  add("strict equivalent color aliases", strict, [{ op: "document", patch: { tokens: { paper: "rgb(255 255 255)" }, background: "white" } }], {
    consistency: true,
  });
  add("UTF16 lone surrogate text", { ...base, nodes: [{ id: "text", type: "text", width: 100, height: 20, text: "x\ud800y\udfff" }] });
  add("UTF16 field boundary accepted", { ...base, nodes: [{ id: "text", name: "😀".repeat(80), type: "text", width: 100, height: 20 }] });
  add("Zod Unicode scalar boundary accepted", { ...base, nodes: [{ id: "text", name: "😀".repeat(81), type: "text", width: 100, height: 20 }] });
  add("Zod Unicode scalar boundary rejected", { ...base, nodes: [{ id: "text", name: "😀".repeat(161), type: "text", width: 100, height: 20 }] });
  add("CSS JavaScript BOM whitespace", { ...base, background: "rgb(1\ufeff2\ufeff3)" });
  add("CSS NEL is not JavaScript whitespace", { ...base, background: "rgb(1\u00852\u00853)" });
  add("image NEL remains a URL character", {
    ...base,
    nodes: [{ id: "image", type: "image", width: 10, height: 10, src: "https://example.invalid/a\u0085b" }],
  });
  add("exception value reason remains untrimmed", {
    ...styled,
    consistency: {
      mode: "advisory",
      exceptions: [{ nodeId: "card", field: "typography", value: { reason: "  preserve  " }, reason: "  Intentional exception  " }],
    },
  });
  return cases;
}
async function render(document) {
  await loadDesignFonts(document);
  return designHtml(document);
}
async function storeFixture(root) {
  await access(path.join(root, "MILAGRE-ISOLATED-COPY"));
  const directory = path.join(root, "node-design-store");
  await mkdir(directory);
  const chat = "/fixture#7";
  const now = Date.now;
  let tick = 1000;
  Date.now = () => tick;
  const api = createChatArtifacts({
    directory,
    validateChat: async (id) => {
      if (id !== chat) throw Error("Unknown fixture Chat.");
    },
    readKit: async () => clone(kit),
  });
  await loadDesignFonts(styled);
  const fontCss = designHtml(validateDesignDocument(styled)).match(/<style>(@font-face[\s\S]*?)<\/style>/)[1];
  const fontKey = createHash("sha256").update(fontCss).digest("hex");
  const actions = [
    ["showDesign", { id: "screen", title: "  Welcome  ", group: " Onboarding ", document: styled }],
    ["apply", { id: "screen", expectedVersion: 1, operations: [{ op: "update", id: "title", patch: { text: "Second revision" } }] }],
    ["get", { id: "screen", version: 1 }],
    [
      "showDesign",
      { id: "variant", title: "Variant", from: { id: "screen", version: 1 }, operations: [{ op: "update", id: "title", patch: { text: "Variant text" } }] },
    ],
    ["showDesign", { id: "screen", title: "No optimistic version", document: base }],
    ["apply", { id: "screen", expectedVersion: 1, operations: [{ op: "delete", id: "card" }] }],
    ["showDesign", { id: "screen", expectedVersion: 2, title: "Replacement", group: "", document: base }],
    ["get", { id: "screen", version: 2 }],
    ["showDesign", { id: "strict", title: "Strict", document: { ...styled, consistency: { mode: "strict" } } }],
    ["showDesign", { id: "strict", expectedVersion: 1, title: "Cannot erase policy", document: { ...styled, consistency: undefined } }],
    ["apply", { id: "strict", expectedVersion: 2, operations: [{ op: "update", id: "title", patch: { fontSize: 44 } }] }],
    ["showDesign", { id: "wrong-kit", title: "Wrong snapshot", document: { ...styled, kit: { ...kit, title: "Spoof" } } }],
    ["list", { format: "design" }],
    ["get", { id: "screen", version: 1, fonts: { have: [] } }],
    ["get", { id: "screen", version: 1, fonts: { have: [fontKey] } }],
    ["exportDesign", { id: "screen", version: 1, format: "json" }],
    ["exportDesign", { id: "screen", version: 1, format: "svg" }],
  ];
  const outputs = [];
  for (let index = 0; index < actions.length; index++) {
    tick = 1000 + 100 * index;
    const [method, args] = actions[index];
    try {
      outputs.push({ result: await api[method]({ chatId: chat, ...args }) });
    } catch (error) {
      outputs.push({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  }
  // Exercise retained historical source/preview pairs and the 50 revision cap.
  for (let version = 1; version <= 52; version++) {
    const args = { chatId: chat, id: "history", title: "History", document: base, ...(version > 1 ? { expectedVersion: version - 1 } : {}) };
    tick = 10000 + version;
    await api.showDesign(args);
    actions.push(["showDesign", { ...args, time: tick }]);
    outputs.push({
      result: await api.get({ chatId: chat, id: "history" }).then(({ html: _html, document: _document, latest: _latest, ...summary }) => summary),
    });
  }
  const files = {};
  async function visit(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(folder, entry.name), name + "/");
      else {
        const bytes = await readFile(path.join(folder, entry.name));
        files[name] = entry.name.endsWith(".json")
          ? { json: JSON.parse(bytes) }
          : { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      }
    }
  }
  await visit(directory);
  Date.now = now;
  return { chat, kit, actions, outputs, files };
}
const mode = process.argv[2] ?? "fixtures";
let value;
if (mode === "contract") value = await contract();
else if (mode === "fixtures") value = { contract: await contract(), cases: fixtures() };
else if (mode === "render") {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  process.stdout.write(await render(JSON.parse(raw)));
} else if (mode === "store") value = await storeFixture(path.resolve(process.argv[3]));
else throw Error("Unknown Design fixture mode");
if (value !== undefined) process.stdout.write(JSON.stringify(value));

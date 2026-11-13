// Runs the production Node store only inside a caller-created disposable Isolation.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createChatArtifacts, htmlArtifactToolDefinitions } = require("../../../packages/core/src/chat-artifacts.cjs");
const CHAT = "/fixture#7";
const hash = crypto.createHash("sha256").update(CHAT).digest("hex").slice(0, 32);
const root = path.resolve(process.argv[2] || "");
const directory = path.join(root, "node-store");
const worktree = path.join(root, "worktree");
const now = Date.now;
let tick = 1000;
Date.now = () => tick;

async function tree(storeDirectory, inline) {
  const out = {};
  const visit = async (folder, prefix = "") => {
    for (const item of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (item.name === ".rust-content.lock") continue;
      if (item.isDirectory()) await visit(path.join(folder, item.name), name + "/");
      else if (item.isFile()) {
        const bytes = await fs.readFile(path.join(folder, item.name));
        const key = inline ? name.replaceAll(inline, "$INLINE") : name;
        out[key] =
          name.endsWith(".json") || item.name === "comments"
            ? { json: JSON.parse(bytes.toString("utf8")) }
            : { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      }
    }
  };
  await visit(storeDirectory);
  return out;
}

(async () => {
  await fs.access(path.join(root, "MILAGRE-ISOLATED-COPY"));
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, "demo.mp4"), Buffer.alloc(600 * 1024, 7));
  await fs.writeFile(path.join(worktree, "chart.png"), "png");
  const seed = path.join(root, "seed", hash);
  await fs.mkdir(path.join(seed, "split"), { recursive: true });
  await fs.writeFile(path.join(seed, "old.json"), JSON.stringify({ id: "old", versions: [{ version: 1, title: "Old", html: "<p>Old</p>", createdAt: 1 }] }));
  await fs.writeFile(path.join(seed, "split", "meta.json"), JSON.stringify({ id: "split", versions: [{ version: 1, title: "Newer", createdAt: 2 }] }));
  await fs.writeFile(path.join(seed, "split", "v1.html"), "<p>Newer</p>");
  await fs.mkdir(path.join(seed, "design"));
  await fs.writeFile(
    path.join(seed, "design", "meta.json"),
    JSON.stringify({
      id: "design",
      versions: [{ version: 1, title: "Saved Design", format: "design", width: 390, height: 844, createdAt: 3, group: "Welcome" }],
    }),
  );
  await fs.writeFile(path.join(seed, "design", "v1.html"), "<main>Design preview</main>");
  await fs.writeFile(path.join(seed, "design", "v1.design.json"), JSON.stringify({ schemaVersion: 1, width: 390, height: 844, nodes: [] }));
  await fs.cp(path.join(root, "seed"), directory, { recursive: true });
  const api = createChatArtifacts({
    directory,
    validateChat: async (id) => {
      if (id !== CHAT) throw Error("Unknown fixture Chat.");
    },
  });
  const readTool = htmlArtifactToolDefinitions(CHAT, api).find((tool) => tool.name === "artifact_read");
  const actions = [
    ["list", {}],
    ["get", { id: "old", version: 1 }],
    ["get", { id: "design", format: "design" }],
    [
      "show",
      {
        id: "another",
        title: " Media ",
        html: '<video src="assets/demo.mp4"></video><img src="./assets/chart.png">',
        assets: [
          { name: "demo.mp4", path: path.join(worktree, "demo.mp4") },
          { name: "chart.png", path: path.join(worktree, "chart.png") },
        ],
      },
    ],
    ["get", { id: "old", version: 1, format: "html" }],
    ["asset", { name: "demo.mp4", offset: 0, length: 10 }],
    ["asset", { name: "demo.mp4", offset: 0, length: Number.MAX_SAFE_INTEGER }],
    ["asset", { name: "demo.mp4", offset: 600 * 1024, length: 99 }],
    ["asset", { name: "demo.mp4", offset: 600 * 1024 + 1 }],
    [
      "show",
      {
        title: "Report",
        expectedVersion: 2,
        tabs: [
          { id: "overview", title: "  Overview  ", html: '<p>Summary <img src="assets/chart.png"></p>' },
          { id: "data", title: "Data", html: "<p>Details</p>" },
        ],
      },
    ],
    [
      "show",
      {
        title: "Updated tabs",
        tabs: [
          { id: "data", title: "More data", html: "<p>More details</p>" },
          { id: "overview", title: "Overview" },
        ],
      },
    ],
    ["get", { id: "split", version: 1 }],
    ["artifactRead", { id: "split" }],
    ["artifactRead", { id: "split", tab: "data" }],
    ["artifactRead", { id: "split", tab: "missing" }],
    ["asset", { name: "demo.mp4" }],
    ["asset", { name: "chart.png", length: 2 }],
    [
      "addComments",
      {
        comments: [
          {
            id: "00000001",
            design: { id: "split", version: 2, title: "Media" },
            text: "  More detail  ",
            x: 0.1,
            y: 0.2,
            near: 'The "caption"\n here',
            anchor: "#caption@0.2,0.3",
            tab: { id: "data", title: " Data " },
          },
        ],
      },
    ],
    ["addComments", { comments: [{ id: "00000001", design: { id: "split", version: 2 }, text: "Retry differs" }] }],
    [
      "addComments",
      {
        comments: [
          {
            id: "00000002",
            design: { id: "old", version: 1 },
            text: "Old feedback",
            nodeId: "caption.text",
            x: -1,
            y: 0.5,
            near: "  ",
            anchor: "javascript:evil",
            tab: { id: "../no" },
          },
        ],
      },
    ],
    ["comments", { format: "html" }],
    ["resolveComment", { id: "00000001", note: "  Added detail  ", format: "html" }],
    ["comments", {}],
    ["show", { title: "a" + "😀".repeat(60), html: "<p>Current \ud800</p>", width: 300, height: 900 }],
    ["get", { id: "old", version: 1 }],
    ["render", { title: "Inline reply", html: "<p>Immutable</p>", height: 320 }],
    ["get", { id: "$INLINE" }],
    ["show", { id: "$INLINE", title: "No", html: "<p>No</p>" }],
    ["list", { format: "html" }],
    ["show", { id: "design", title: "No", html: "<p>No</p>" }],
    ["show", { title: "Conflict", expectedVersion: 0, html: "<p>No</p>" }],
    ["show", { title: "Tabs", tabs: [{ id: "new", title: "New" }] }],
    [
      "show",
      {
        title: "Tabs",
        tabs: [
          { id: "same", title: "A", html: "a" },
          { id: "same", title: "B", html: "b" },
        ],
      },
    ],
    ["show", { title: "Both", tabs: [], html: "x" }],
    ["list", { format: null }],
    ["asset", { name: "../outside" }],
    ["get", { id: "../outside" }],
    ["addComments", { comments: [{ id: "00000003", design: { id: "split", version: 99 }, text: "Future" }] }],
    ["addComments", { comments: [{ id: "00000003", design: { id: "split", version: 3 }, text: "Bad layer", nodeId: "1invalid" }] }],
  ];
  const outputs = [];
  let inline;
  const substitute = (value) => JSON.parse(JSON.stringify(value).replaceAll("$INLINE", inline || "$INLINE"));
  for (let index = 0; index < actions.length; index++) {
    tick = 1000 + index * 100;
    const [method, args] = actions[index];
    try {
      const result =
        method === "artifactRead"
          ? JSON.parse(await readTool.run(substitute(args)))
          : await api[method]({ chatId: CHAT, ...substitute(args) }, { roots: [worktree] });
      if (method === "render") inline = result.id;
      outputs.push({ result });
    } catch (error) {
      outputs.push({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  }
  await api.close();
  const result = { chat: CHAT, actions, outputs, disk: await tree(directory, inline) };
  await fs.writeFile(path.join(root, "node-expected.json"), JSON.stringify(result).replaceAll(inline, "$INLINE"));
  Date.now = now;
})().catch((error) => {
  Date.now = now;
  console.error(error);
  process.exitCode = 1;
});

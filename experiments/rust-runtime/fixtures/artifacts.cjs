// Record saved Artifact files from the real Node store, using a new disposable directory only.
// Committed bytes are copied into the Rust runtime under its dynamically admitted fixture Chat hashes.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createChatArtifacts } = require("../../../packages/core/src/chat-artifacts.cjs");
async function generate() {
  assert.deepEqual(process.argv.slice(2), ["--record"]);
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "milagre-artifact-record-"));
  const previousNow = Date.now;
  let tick = 1000;
  Date.now = () => tick++;
  try {
    const store = path.join(root, "artifacts");
    const worktree = path.join(root, "worktree");
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, "sample.bin"), Buffer.alloc(300 * 1024, 7));
    await fs.writeFile(path.join(worktree, "caption.txt"), "Artifact asset 🦀\n");
    const chatId = "/fixture#1";
    const api = createChatArtifacts({ directory: store, validateChat: async (id) => assert.equal(id, chatId) });
    await api.show({ chatId, id: "report", title: "Fixture report", html: "<main>Saved first version</main>" });
    await api.show(
      {
        chatId,
        id: "report",
        title: "Saved tabs",
        expectedVersion: 1,
        tabs: [
          { id: "overview", title: "Overview", html: '<main><h1>Saved report 🦀</h1><a href="assets/sample.bin">Data</a></main>' },
          { id: "details", title: "Details", html: '<main><pre>Saved details</pre><a href="assets/caption.txt">Caption</a></main>' },
        ],
        assets: [
          { name: "sample.bin", path: path.join(worktree, "sample.bin") },
          { name: "caption.txt", path: path.join(worktree, "caption.txt") },
        ],
      },
      { roots: [worktree] },
    );
    await api.addComments({
      chatId,
      comments: [
        {
          id: "00000001",
          design: { id: "report", version: 2, title: "Saved tabs" },
          text: "Keep this caption",
          x: 0.2,
          y: 0.3,
          tab: { id: "overview", title: "Overview" },
        },
      ],
    });
    const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 32);
    const source = path.join(store, hash);
    // Copy only generated saved files. No production directories or arbitrary output argument are accepted.
    const target = path.join(__dirname, "artifacts", "alpha-1");
    await fs.mkdir(target, { recursive: true });
    async function record(folder, output) {
      await fs.mkdir(output, { recursive: true });
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) await record(path.join(folder, entry.name), path.join(output, entry.name));
        else {
          assert.ok(entry.isFile());
          // Preserve Node's saved bytes; source formatters must not rewrite the recorded JSON/HTML.
          await fs.copyFile(path.join(folder, entry.name), path.join(output, `${entry.name}.fixture`));
        }
      }
    }
    await record(source, target);
    console.log("Recorded actual Node Artifact bytes for the isolated Rust fixture");
  } finally {
    Date.now = previousNow;
    await fs.rm(root, { recursive: true, force: true });
  }
}
generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

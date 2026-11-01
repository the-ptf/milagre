const test = require("node:test");
const assert = require("node:assert/strict");
const { createArtifactPreviews } = require("./artifact-preview.cjs");
test("artifact previews have unguessable URLs, independent CSP and owner-scoped cleanup", async () => {
  const previews = createArtifactPreviews();
  const url = previews.register(12, '<button onclick="this.textContent=2">1</button>');
  assert.match(url, /^milagre-artifact:\/\/preview\/[a-f0-9]{48}$/);
  const response = previews.handle(new Request(url));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'unsafe-inline'/);
  assert.match(await response.text(), /onclick/);
  assert.equal(previews.handle(new Request(`${url}?anything`)).status, 404);
  assert.equal(previews.handle(new Request(url, { method: "POST" })).status, 404);
  previews.release(99, url);
  assert.equal(previews.handle(new Request(url)).status, 200);
  previews.clear(12);
  assert.equal(previews.handle(new Request(url)).status, 404);
});
test("artifact preview registration bounds individual and total retained data", () => {
  const previews = createArtifactPreviews();
  assert.throws(() => previews.register(1, null), /too large/);
  assert.throws(() => previews.register(1, "x".repeat(8 * 1024 * 1024 + 1)), /too large/);
  const body = "x".repeat(8 * 1024 * 1024);
  for (let i = 0; i < 7; i++) previews.register(1, body);
  assert.throws(() => previews.register(1, body), /Too many/);
  previews.clear(1);
  assert.ok(previews.register(1, body));
});
test("an Artifact preview carries the page helper, and Pele when it has a Mermaid block", async () => {
  const previews = createArtifactPreviews();
  const plain = await previews.handle(new Request(previews.register(1, "<p>Plain</p>"))).text();
  assert.match(plain, /milagre:artifact-page/);
  assert.doesNotMatch(plain, /var pele=/);
  const drawn = await previews.handle(new Request(previews.register(1, '<pre class="mermaid">flowchart LR\n A --> B</pre>'))).text();
  assert.match(drawn, /var pele=/);
  assert.ok(drawn.indexOf("var pele=") < drawn.indexOf("milagre:artifact-page"), "Pele loads before the helper mounts it");
});
test("an Artifact preview's files load from its own address, read in chunks from the Chat's computer, by byte range", async () => {
  const bytes = Buffer.from("0123456789".repeat(40_000));
  const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const reads = [];
  const previews = createArtifactPreviews({
    readAsset: async (chatId, name, offset, length) => {
      reads.push({ chatId, name, offset, length });
      const end = Math.min(offset + Math.min(length, 256 * 1024), bytes.length);
      return { base64: bytes.subarray(offset, end).toString("base64"), hash };
    },
  });
  const asset = { name: "clip.mp4", hash, size: bytes.length, type: "video/mp4" };
  const url = previews.register(1, '<video src="assets/clip.mp4"></video><img src="assets/other.png">', { chatId: "/p#1", assets: [asset] });
  const page = previews.handle(new Request(url));
  assert.match(page.headers.get("Content-Security-Policy"), /media-src [^;]*milagre-artifact:/);
  const html = await page.text();
  assert.match(html, new RegExp(`<video src="${url}/assets/clip.mp4">`));
  assert.match(html, /<img src="assets\/other\.png">/, "a name the page has no file for stays as written");

  const whole = previews.handle(new Request(`${url}/assets/clip.mp4`));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("Content-Type"), "video/mp4");
  assert.equal(whole.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  assert.deepEqual(
    reads.map((read) => read.offset),
    [0, 256 * 1024],
  );
  const part = previews.handle(new Request(`${url}/assets/clip.mp4`, { headers: { Range: "bytes=10-19" } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), `bytes 10-19/${bytes.length}`);
  assert.equal(await part.text(), "0123456789");
  assert.equal(previews.handle(new Request(`${url}/assets/other.png`)).status, 404);
  assert.equal(previews.handle(new Request(`${url}/assets/clip.mp4`, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  previews.clear(1);
  assert.equal(previews.handle(new Request(`${url}/assets/clip.mp4`)).status, 404, "a released preview's files go with it");
});

test("inline replies have an independent sealed policy without the live Artifact helper", async () => {
  const { htmlRenderShell } = require("@milagre/shared/html-render");
  const previews = createArtifactPreviews();
  const url = previews.register(1, htmlRenderShell('<button onclick="this.textContent=2">1</button>'), { inline: true });
  const response = previews.handle(new Request(url));
  const document = await response.text();
  assert.match(document, /milagre:html-render/);
  assert.doesNotMatch(document, /milagre:artifact-page/);
  assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /milagre-artifact:/);
  previews.release(1, url);
  assert.equal(previews.handle(new Request(url)).status, 404);
});

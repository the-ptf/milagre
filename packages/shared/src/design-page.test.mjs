import test from "node:test";
import assert from "node:assert/strict";
import { validateDesignPageSnapshot, renderDesignPage, isSnapshotRaster, MAX_DESIGN_PAGE_HTML_BYTES } from "./design-page.mjs";
const document = () => ({ schemaVersion: 1, width: 390, height: 844, nodes: [{ id: "heading", type: "text", width: 300, height: 80, text: "Hello" }] });
const page = () => ({
  schemaVersion: 1,
  title: "Designs",
  designs: [
    { title: "First", document: document() },
    { title: "Second", document: document() },
  ],
});

test("a public page retains all designs but drops private envelope metadata", () => {
  const input = { ...page(), chatId: "/private/project#1", comments: [{ text: "secret" }] };
  input.designs[0].comments = ["secret"];
  const snapshot = validateDesignPageSnapshot(input);
  assert.deepEqual(Object.keys(snapshot), ["schemaVersion", "title", "designs"]);
  assert.deepEqual(Object.keys(snapshot.designs[0]), ["title", "document"]);
  assert.equal(snapshot.designs.length, 2);
  assert.doesNotMatch(renderDesignPage(input), /private\/project|secret|chatId/);
});
test("public HTML isolates generated SVG images, escapes labels and carries no source JSON", () => {
  const input = page();
  input.title = '</title><script>alert("title")</script>';
  input.designs[0].title = '"><img src=x onerror=alert(1)>';
  input.designs[0].document.nodes[0].text = '</script><script>alert("node")</script>';
  const html = renderDesignPage(input);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.equal((html.match(/<figure /g) ?? []).length, 2);
  assert.match(html, /&lt;\/title&gt;/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>|"schemaVersion"|"nodes"/);
});
test("snapshot limits reject incomplete pages and external or disguised image data", () => {
  assert.throws(() => validateDesignPageSnapshot({ ...page(), designs: [] }), /between 1 and 20/);
  assert.throws(() => validateDesignPageSnapshot({ ...page(), designs: Array(21).fill(page().designs[0]) }), /between 1 and 20/);
  const input = page();
  input.designs[0].document.nodes = [{ id: "image", type: "image", width: 100, height: 100, src: "https://example.com/photo.png" }];
  assert.throws(() => validateDesignPageSnapshot(input), /embedded/);
  input.designs[0].document.nodes[0].src = `data:image/png;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}`;
  assert.throws(() => validateDesignPageSnapshot(input), /embedded/);
  assert.equal(isSnapshotRaster("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isSnapshotRaster("data:image/gif;base64,R0lGODlh"), true);
});

test("the page text budget includes all designs before any SVG is generated", () => {
  const input = page();
  for (const design of input.designs)
    design.document.nodes = Array.from({ length: 3 }, (_, i) => ({ id: `text${i}`, type: "text", width: 1, height: 1, fontSize: 2, text: "a".repeat(10000) }));
  assert.throws(() => validateDesignPageSnapshot(input), { status: 413 });
  assert.throws(() => renderDesignPage(input), { status: 413 });
});

test("validated snapshots can be reused safely but cannot be mutated to bypass validation", () => {
  const snapshot = validateDesignPageSnapshot(page());
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.designs[0].document.nodes[0]));
  assert.throws(() => {
    snapshot.designs[0].document.nodes[0].text = "a".repeat(60000);
  }, TypeError);
  assert.equal(renderDesignPage(snapshot), renderDesignPage(page()));
  const clone = structuredClone(snapshot);
  clone.designs[0].document.nodes[0].src = "https://example.com/private";
  clone.designs[0].document.nodes[0].type = "image";
  assert.throws(() => renderDesignPage(clone), /embedded/);
});

test("rendering rejects image amplification at the 8 MiB HTML budget", () => {
  const input = page();
  const src = `data:image/png;base64,${Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(300000)]).toString("base64")}`;
  input.designs = Array.from({ length: 12 }, (_, i) => ({
    title: `Image ${i}`,
    document: { schemaVersion: 1, width: 390, height: 844, nodes: [{ id: "image", type: "image", width: 100, height: 100, src }] },
  }));
  assert.throws(() => renderDesignPage(input), { status: 413 });
});

test("an Artifact snapshot freezes one HTML page in an opaque sandbox without private envelope data", () => {
  const source = '<button onclick="this.textContent=42">Calculate</button><script>window.parent.document.title="escape"</script>';
  const input = {
    schemaVersion: 1,
    kind: "artifacts",
    title: "Explain",
    chatId: "/private#1",
    artifacts: [{ title: "Page", width: 1280, height: 800, html: source, comments: ["private"] }],
  };
  const snapshot = validateDesignPageSnapshot(input);
  assert.equal(snapshot.kind, "artifacts");
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.artifacts[0].html, source);
  assert.equal(Object.isFrozen(snapshot.artifacts[0]), true);
  const html = renderDesignPage(snapshot);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|private#1|"comments"/);
  assert.match(html, /&lt;script&gt;/);
  assert.throws(() => validateDesignPageSnapshot({ ...input, artifacts: [...input.artifacts, ...input.artifacts] }), /exactly one/);
  assert.throws(() => validateDesignPageSnapshot({ ...input, artifacts: [{ ...input.artifacts[0], html: "x".repeat(1000001) }] }), { status: 413 });
});

const allWeights = (index) => ({
  schemaVersion: 1,
  width: 390,
  height: 844,
  nodes: [400, 500, 600, 700].map((fontWeight) => ({
    id: `w${fontWeight}`,
    type: "text",
    y: fontWeight / 10,
    width: 300,
    height: 40,
    text: `Design ${index}`,
    fontWeight,
  })),
});
const fontFaceCount = (html) => decodeURIComponent(html.match(/src="data:image\/svg\+xml,([^"]+)"/)?.[1] ?? "").match(/@font-face/g)?.length ?? 0;

test("twenty designs that each use all four Inter weights still render, with embedded fonts", () => {
  const html = renderDesignPage({
    schemaVersion: 1,
    title: "Many",
    designs: Array.from({ length: 20 }, (_, index) => ({ title: `D${index}`, document: allWeights(index) })),
  });
  assert.equal(fontFaceCount(html), 4);
  assert.ok(Buffer.byteLength(html) < MAX_DESIGN_PAGE_HTML_BYTES);
});

test("a page that only fits without fonts falls back to system fonts instead of failing", () => {
  const png = `data:image/png;base64,${Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(100000, 1)]).toString("base64")}`;
  const designs = Array.from({ length: 20 }, (_, index) => {
    const document = allWeights(index);
    document.nodes.push({ id: "photo", type: "image", y: 300, width: 100, height: 100, src: png });
    return { title: `D${index}`, document };
  });
  const html = renderDesignPage({ schemaVersion: 1, title: "Heavy", designs });
  assert.doesNotMatch(html, /font-face/, "no @font-face, encoded or not");
  assert.match(html, /<figure /);
  assert.ok(Buffer.byteLength(html) < MAX_DESIGN_PAGE_HTML_BYTES);
});

const describedAs = (html) => /<title>[^<]*<\/title><meta name="description" content="([^"]*)">/.exec(html)?.[1];
const artifactPage = (html, title = "Pricing research") => ({
  schemaVersion: 1,
  kind: "artifacts",
  title,
  artifacts: [{ title, width: 390, height: 844, html }],
});

test("an Artifact's link preview description prefers its own meta description", () => {
  const html = renderDesignPage(artifactPage(`<head><meta content='Three plans &amp; "one" winner' name="description"></head><body><p>Body text</p></body>`));
  assert.equal(describedAs(html), "Three plans &amp; &quot;one&quot; winner");
});

test("an Artifact's link preview describes its visible text, not scripts, styles or a repeated title", () => {
  const body = `<title>Ignored</title><style>p{color:red}</style><script>const secret = 1;</script><h1>Pricing research</h1><!-- note --><p>Compares &nbsp;Pro&#x2F;Team tiers</p>`;
  assert.equal(describedAs(renderDesignPage(artifactPage(body))), "Compares Pro/Team tiers");
  const long = renderDesignPage(artifactPage(`<p>${"word ".repeat(80)}</p>`));
  const description = describedAs(long);
  assert.ok(description.length <= 200 && description.endsWith("word…"), description);
  assert.equal(describedAs(renderDesignPage(artifactPage("<script>only()</script>"))), undefined);
});

test("a Designs link preview names several designs and reads one design's visible text layers", () => {
  assert.equal(describedAs(renderDesignPage(page())), "2 designs: First and Second.");
  const nodes = [
    { id: "card", type: "frame", width: 300, height: 200, hidden: true },
    { id: "secret", type: "text", parentId: "card", width: 100, height: 20, text: "Draft copy" },
    { id: "heading", type: "text", width: 300, height: 40, text: "Welcome back" },
    { id: "cta", type: "text", width: 300, height: 40, text: "Start workout" },
  ];
  const single = { schemaVersion: 1, title: "Home", designs: [{ title: "Home", document: { schemaVersion: 1, width: 390, height: 844, nodes } }] };
  assert.equal(describedAs(renderDesignPage(single)), "Welcome back · Start workout");
  assert.equal(
    describedAs(renderDesignPage({ ...single, designs: [{ title: "Home", document: { schemaVersion: 1, width: 390, height: 844, nodes: [] } }] })),
    undefined,
  );
});

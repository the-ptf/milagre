const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDesignHostFonts } = require("./design-host-fonts.cjs");
const { fontInfo, designFontToolDefinitions } = require("./design-font-tools.cjs");
const { publicPageContent } = require("./design-page-content.cjs");

const VARIABLE = path.join(path.dirname(require.resolve("inter-font/package.json")), "Inter-VariableFont_slnt,wght.ttf");

async function fontFolder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-host-fonts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { renameDesignFont } = await import("@milagre/shared/design-font-file");
  await fs.copyFile(VARIABLE, path.join(directory, "SFNS.ttf"));
  const bold = await fs.readFile(path.join(path.dirname(VARIABLE), "ttf", "Inter-Bold.ttf"));
  await fs.writeFile(path.join(directory, "TestSans-Bold.ttf"), renameDesignFont(new Uint8Array(bold), "Test Sans", 700));
  await fs.writeFile(path.join(directory, "broken.ttf"), "not a font");
  return createDesignHostFonts({ directories: [directory] });
}

test("installed fonts are indexed under public names, Apple's system files included", async (t) => {
  const fonts = await fontFolder(t);
  await fonts.ready();
  assert.deepEqual(await fonts.families(), ["SF Pro", "SF Pro Display", "SF Pro Text", "Test Sans"]);
  const sf = fonts.family("sf pro");
  assert.equal(sf.apple, true);
  assert.deepEqual(sf.wght, { min: 100, max: 900 });
  assert.ok(sf.weights.includes(600));
  assert.deepEqual(fonts.family("Test Sans"), { family: "Test Sans", apple: false, weights: [700] });
  assert.equal(fonts.family("Missing"), null);
});

test("a face is instanced at the requested weight, renamed and measured", async (t) => {
  const fonts = await fontFolder(t);
  const { designFontFileInfo } = await import("@milagre/shared/design-font-file");
  const [regular, semibold] = await fonts.load([
    { key: "r", family: "SF Pro", cssFamily: "SF Pro", weight: 400, opsz: null },
    { key: "s", family: "SF Pro", cssFamily: "SF Pro", weight: 590, opsz: null },
  ]);
  const info = designFontFileInfo(new Uint8Array(Buffer.from(semibold.data, "base64")));
  assert.equal(info.family, "SF Pro");
  assert.equal(info.weightClass, 590);
  assert.equal(info.axes.length, 0);
  assert.equal(regular.advances.length, 206);
  assert.ok(semibold.advances[33] > regular.advances[33]);
});

test("design_font_info reports real weights, metrics and the share substitute", async (t) => {
  const fonts = await fontFolder(t);
  const sf = await fontInfo("SF Pro", fonts);
  assert.equal(sf.source, "installed");
  assert.equal(sf.apple, true);
  assert.equal(sf.substitute, "Inter");
  assert.ok(sf.axes.some((axis) => axis.tag === "wght"));
  assert.ok(sf.weights.some((weight) => weight.weight === 600));
  assert.ok(sf.metrics.capHeight > 0.6 && sf.metrics.capHeight < 0.8);
  assert.match(sf.note, /only in this computer's previews/);
  const missing = await fontInfo("SF Compact", fonts);
  assert.deepEqual([missing.available, missing.apple, missing.substitute], [false, true, "Inter"]);
  const bundled = await fontInfo("Bebas Neue", fonts);
  assert.deepEqual([bundled.source, bundled.weights], ["bundled", [{ weight: 400 }]]);
  const [tool] = designFontToolDefinitions({ fonts });
  assert.equal(tool.name, "design_font_info");
  const listed = JSON.parse(await tool.run({}));
  assert.deepEqual(listed.installed, ["SF Pro", "SF Pro Display", "SF Pro Text", "Test Sans"]);
  assert.ok(listed.bundled.includes("Inter"));
});

test("a published page names the substitute, never an Apple family", () => {
  const page = publicPageContent({
    schemaVersion: 1,
    title: "Watch",
    designs: [
      {
        title: "Face",
        document: {
          schemaVersion: 1,
          width: 390,
          height: 844,
          nodes: [
            { id: "a", type: "text", width: 100, height: 20, text: "10:09", fontFamily: "SF Pro Rounded, SF Pro, sans-serif" },
            { id: "b", type: "text", width: 100, height: 20, text: "Mon", fontFamily: "New York" },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    page.designs[0].document.nodes.map((node) => node.fontFamily),
    ["Inter, sans-serif", "Source Serif 4"],
  );
});

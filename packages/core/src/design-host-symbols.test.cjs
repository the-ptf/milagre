const test = require("node:test");
const assert = require("node:assert/strict");
const { createDesignHostSymbols } = require("./design-host-symbols.cjs");
const { publicPageContent } = require("./design-page-content.cjs");

test("SF Symbols are drawn once per name and weight, unknown ones come back empty", async () => {
  const runs = [];
  const symbols = createDesignHostSymbols({
    platform: "darwin",
    run: async (requests) => {
      runs.push(requests);
      return requests.map((request) => (request.name === "heart" ? { png: "AAAA", width: 24, height: 22 } : null));
    },
  });
  const first = await symbols.load([
    { key: "heart|400", name: "heart", weight: 0 },
    { key: "nope|400", name: "nope", weight: 0 },
  ]);
  assert.deepEqual(first, [{ key: "heart|400", png: "AAAA", width: 24, height: 22 }, null]);
  await symbols.load([{ key: "heart|400", name: "heart", weight: 0 }]);
  assert.deepEqual(runs, [
    [
      { name: "heart", weight: 0, size: 96 },
      { name: "nope", weight: 0, size: 96 },
    ],
  ]);
});

test("a host that isn't a Mac draws no SF Symbols", async () => {
  const symbols = createDesignHostSymbols({ platform: "linux", run: async () => assert.fail("never runs") });
  assert.equal(symbols.available, false);
  assert.deepEqual(await symbols.load([{ key: "a", name: "heart", weight: 0 }]), [null]);
});

test("a published page names the closest Lucide icon, never an SF Symbol", () => {
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
            { id: "a", type: "icon", width: 24, height: 24, icon: "sf:heart.fill", fontWeight: 600 },
            { id: "b", type: "icon", width: 24, height: 24, icon: "sf:figure.run", strokeWidth: 1.5 },
            { id: "c", type: "icon", width: 24, height: 24, icon: "bell" },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    page.designs[0].document.nodes.map((node) => [node.icon, node.strokeWidth]),
    [
      ["heart", 2.25],
      ["activity", 1.5],
      ["bell", undefined],
    ],
  );
});

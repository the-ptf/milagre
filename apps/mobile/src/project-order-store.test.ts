import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProjectOrder, boundedOrder, createProjectOrderStore, dropBefore, moveProject } from "./project-order-store.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const paths = (items: { path: string }[]) => items.map((item) => item.path);
const list = (...names: string[]) => names.map((name) => ({ path: `/code/${name}`, name }));

test("the saved order holds against the Mac's recent order, drops gone Projects and puts new ones on top", () => {
  assert.deepEqual(paths(applyProjectOrder(["/code/a", "/code/b", "/code/c"], list("c", "a", "b"))), ["/code/a", "/code/b", "/code/c"]);
  assert.deepEqual(paths(applyProjectOrder(["/code/a", "/code/b", "/code/c"], list("c", "a"))), ["/code/a", "/code/c"]);
  assert.deepEqual(paths(applyProjectOrder(["/code/a", "/code/b"], list("b", "d", "a"))), ["/code/d", "/code/a", "/code/b"]);
  assert.deepEqual(paths(applyProjectOrder([], list("x", "y"))), ["/code/x", "/code/y"]);
});

test("applying keeps each Project's own fields", () => {
  const projects = [{ path: "/code/a", name: "A", hidden: true }];
  assert.deepEqual(applyProjectOrder(["/code/a"], projects), projects);
});

test("each computer keeps its own order across launches", async () => {
  const disk = storage();
  const first = createProjectOrderStore(disk);
  await first.save("relay://mac", ["/code/b", "/code/a"]);
  await first.save("https://studio", ["/code/a", "/code/b"]);
  // A new launch is a new store over the same storage.
  const launch = createProjectOrderStore(disk);
  assert.deepEqual(paths(await launch.apply("relay://mac", list("a", "b"))), ["/code/b", "/code/a"]);
  assert.deepEqual(paths(await launch.apply("https://studio", list("b", "a"))), ["/code/a", "/code/b"]);
  assert.deepEqual(paths(await launch.apply("https://other", list("b", "a"))), ["/code/b", "/code/a"], "A computer without a saved order keeps the Mac's");
});

test("a damaged or failing storage leaves the Mac's order", async () => {
  const disk = storage();
  const store = createProjectOrderStore(disk);
  await store.save("h", ["/code/b", "/code/a"]);
  for (const key of disk.values.keys()) disk.values.set(key, "{not json");
  assert.deepEqual(paths(await store.apply("h", list("a", "b"))), ["/code/a", "/code/b"]);
  const broken = createProjectOrderStore({
    getItemAsync: async () => {
      throw new Error("locked");
    },
    setItemAsync: async () => {},
  });
  assert.deepEqual(paths(await broken.apply("h", list("a", "b"))), ["/code/a", "/code/b"]);
  await broken.save("h", ["/code/a"]);
});

test("an empty list is saved, so removed Projects added back start from the Mac's order", async () => {
  const store = createProjectOrderStore(storage());
  await store.save("h", ["/code/b", "/code/a"]);
  await store.save("h", []);
  assert.deepEqual(paths(await store.apply("h", list("a", "b"))), ["/code/a", "/code/b"]);
});

test("a saved value stays under the size SecureStore is safe with, however many Projects there are", async () => {
  const disk = storage();
  const store = createProjectOrderStore(disk);
  const many = Array.from({ length: 500 }, (_, i) => `/Users/someone/Code/a-long-project-folder-name-${i}`);
  await store.save("https://mac", many);
  const values = [...disk.values.values()];
  assert.equal(values.length, 1);
  assert.ok(new TextEncoder().encode(values[0]).length <= 1900);
  assert.ok(values[0] !== undefined);
  const kept = JSON.parse(values[0]).o as string[];
  assert.ok(kept.length > 10 && kept.length < many.length);
  assert.deepEqual(kept, many.slice(0, kept.length), "the first Projects are the ones kept");
  // The rest come back as new, on top, next launch.
  const shown = paths(await store.apply("https://mac", many.map((path) => ({ path })).toReversed()));
  assert.deepEqual(shown.slice(-kept.length), kept);
  assert.equal(boundedOrder("x", ["/é".repeat(2000)]).length, 0, "one huge path never exceeds the bound");
});

test("moveProject drops a Project before another, or at the end", () => {
  const order = ["/code/a", "/code/b", "/code/c"];
  assert.deepEqual(moveProject(order, "/code/c", "/code/a"), ["/code/c", "/code/a", "/code/b"], "before the first");
  assert.deepEqual(moveProject(order, "/code/a", "/code/c"), ["/code/b", "/code/a", "/code/c"], "down one");
  assert.deepEqual(moveProject(order, "/code/a", null), ["/code/b", "/code/c", "/code/a"], "to the end");
  assert.deepEqual(moveProject(order, "/code/a", "/code/a"), order, "onto itself is a no-op");
  assert.deepEqual(moveProject(order, "/code/x", "/code/a"), order, "an unknown Project is a no-op");
  assert.deepEqual(moveProject(order, "/code/a", "/code/x"), order, "an unknown target is a no-op");
});

test("dropBefore lands a header between the projects around the release, not on the first", () => {
  // An expanded list: each 40pt header is followed by 80pt of Chats. D is being dragged, so only A, B and C are measured.
  const bands = [
    { path: "/a", top: 0, bottom: 40 },
    { path: "/b", top: 120, bottom: 160 },
    { path: "/c", top: 240, bottom: 280 },
  ];
  assert.equal(dropBefore(bands, 200), "/c", "over B's Chats, between B and C: before C");
  assert.equal(dropBefore(bands, 130), "/b", "B's header, top half: before B");
  assert.equal(dropBefore(bands, 150), "/c", "B's header, lower half: after B");
  assert.equal(dropBefore(bands, 275), null, "C's header, lower half: at the end");
  assert.equal(dropBefore(bands, 400), null, "past the last header: at the end");
  assert.equal(dropBefore(bands, -10), "/a", "above the first: before it");
  const order = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(moveProject(order, "/d", dropBefore(bands, 200)), ["/a", "/b", "/d", "/c"]);
  // B dragged and released over its own group (its header's old place): the header after it is C, so B keeps its place.
  assert.deepEqual(
    moveProject(
      order,
      "/b",
      dropBefore(
        [
          { path: "/a", top: 0, bottom: 40 },
          { path: "/c", top: 240, bottom: 280 },
          { path: "/d", top: 360, bottom: 400 },
        ],
        160,
      ),
    ),
    order,
  );
});

test("each key is safe for SecureStore", async () => {
  const disk = storage();
  await createProjectOrderStore(disk).save("relay://H".repeat(3) + "/x?y=1", ["/code/a"]);
  assert.ok([...disk.values.keys()].every((key) => /^[A-Za-z0-9._-]+$/.test(key)));
});

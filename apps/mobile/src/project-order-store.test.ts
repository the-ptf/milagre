import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProjectOrder, boundedOrder, createProjectOrderStore } from "./project-order-store.ts";

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
  const shown = paths(await store.apply("https://mac", many.map((path) => ({ path })).reverse()));
  assert.deepEqual(shown.slice(-kept.length), kept);
  assert.equal(boundedOrder("x", ["/é".repeat(2000)]).length, 0, "one huge path never exceeds the bound");
});

test("each key is safe for SecureStore", async () => {
  const disk = storage();
  await createProjectOrderStore(disk).save("relay://H".repeat(3) + "/x?y=1", ["/code/a"]);
  assert.ok([...disk.values.keys()].every((key) => /^[A-Za-z0-9._-]+$/.test(key)));
});

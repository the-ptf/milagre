import { test } from "node:test";
import assert from "node:assert/strict";
import { createAllComputersStore, recentChats, type StoreDeps, type StoreClient } from "./all-computers-store.ts";
import type { SavedHost } from "./hosts-store.ts";

const token = "a".repeat(64);
const host = (id: string, extra: Partial<SavedHost> = {}): SavedHost => ({ id, name: id, address: id, token, lastUsed: 0, ...extra });
const copy = (path: string) => ({ project: { path, name: path, state: { sessions: {} } }, runs: { runs: {} }, previewOnly: true }) as never;

type Calls = { recent: number; lists: string[][]; opens: string[]; previews: string[] };
function fakeClient(id: string, options: { fail?: () => boolean; batch?: boolean; projects?: string[] } = {}) {
  const calls: Calls = { recent: 0, lists: [], opens: [], previews: [] };
  const check = () => {
    if (options.fail?.()) throw new Error("offline");
  };
  const client = {
    url: id,
    recentScopes: async () => {
      calls.recent++;
      check();
      return (options.projects ?? ["/a", "/b"]).map((path) => ({ path, name: path }));
    },
    call: async (_method: string, args: unknown[]) => {
      check();
      calls.opens.push(String(args[0]));
      return { path: String(args[0]) };
    },
    preview: async (path: string) => {
      check();
      calls.previews.push(path);
      return copy(path);
    },
    open: async (path: string) => copy(path),
    chatLists: async (paths: string[]) => {
      calls.lists.push(paths);
      check();
      if (options.batch === false) throw Object.assign(new Error("404"), { code: "unsupported" });
      return Object.fromEntries(
        paths.map((path) => [
          path,
          path === "/b" && options.projects?.includes("/broken")
            ? { error: "Not allowed" }
            : path === "/new" && !calls.opens.includes("/new")
              ? { error: "Open the project before reading its snapshot." }
              : copy(path),
        ]),
      );
    },
  };
  return { client: client as unknown as StoreClient, calls };
}

function setup(clients: Record<string, ReturnType<typeof fakeClient>>, extra: Partial<StoreDeps> = {}) {
  const clock = { now: 1000 };
  const timers: { run: () => void; ms: number; live: boolean }[] = [];
  const store = createAllComputersStore({
    createClient: (saved) => clients[saved.id]!.client,
    applyProjects: async (_id, list) => list,
    now: () => clock.now,
    random: () => 0.5,
    setTimer: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
    ...extra,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { store, timers, settle, clock };
}

test("each computer is read once the sidebar shows, with one batch read for its Projects", async () => {
  const clients = { "https://a": fakeClient("https://a"), "https://b": fakeClient("https://b") };
  const { store, timers, settle } = setup(clients);
  store.sync([host("https://a"), host("https://b")], null);
  assert.equal(clients["https://a"].calls.recent, 0, "nothing is read while no sidebar shows");
  const hide = store.show();
  await settle();
  const [a, b] = store.views();
  assert.equal(a?.state, "online");
  assert.equal(b?.state, "online");
  assert.deepEqual(clients["https://a"].calls.lists, [["/a", "/b"]]);
  assert.equal(clients["https://a"].calls.opens.length, 0, "the batch read does not open the Projects");
  assert.equal(a?.copies.size, 2);
  assert.equal(timers.filter((timer) => timer.live).length, 2);
  // A second sidebar mounting does not start a second poller.
  const second = store.show();
  await settle();
  assert.equal(clients["https://a"].calls.recent, 1);
  second();
  hide();
  assert.ok(
    timers.every((timer) => !timer.live),
    "hiding the last sidebar stops every timer",
  );
});

test("an older Mac without the batch route is read Project by Project, a broken Project alone falls back", async () => {
  const old = fakeClient("https://old", { batch: false });
  const mixed = fakeClient("https://mixed", { projects: ["/a", "/b", "/broken"] });
  const { store, settle } = setup({ "https://old": old, "https://mixed": mixed });
  store.sync([host("https://old"), host("https://mixed")], null);
  store.show();
  await settle();
  await settle();
  assert.deepEqual(old.calls.previews.sort(), ["/a", "/b"]);
  assert.equal(old.calls.opens.length, 2);
  assert.equal(store.viewOf("https://old")?.copies.size, 2);
  // A Project the Mac refused to list keeps its last data and is not asked again at the next read.
  assert.equal(mixed.calls.previews.length, 0);
  assert.equal(store.viewOf("https://mixed")?.errors.get("/b"), "Not allowed");
  assert.deepEqual(mixed.calls.lists, [["/a", "/b", "/broken"]]);
});

test("a Project the Mac has not opened is opened once, then read in the next batch", async () => {
  const mac = fakeClient("https://a", { projects: ["/a", "/new"] });
  const { store, timers, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  store.show();
  await settle();
  await settle();
  assert.deepEqual(mac.calls.opens, ["/new"]);
  assert.deepEqual(mac.calls.lists, [["/a", "/new"], ["/new"]]);
  assert.equal(store.viewOf("https://a")?.copies.size, 2);
  timers.at(-1)!.run();
  await settle();
  await settle();
  assert.deepEqual(mac.calls.opens, ["/new"], "opened once per computer, never repeatedly");
});

test("a computer that stops answering goes offline and keeps its last Chats", async () => {
  let down = false;
  const flaky = fakeClient("https://a", { fail: () => down });
  const { store, timers, settle } = setup({ "https://a": flaky });
  store.sync([host("https://a")], null);
  store.show();
  await settle();
  assert.equal(store.viewOf("https://a")?.state, "online");
  down = true;
  timers.at(-1)!.run();
  await settle();
  await settle();
  assert.equal(store.viewOf("https://a")?.state, "online", "one failed read after success is not yet offline");
  timers.at(-1)!.run();
  await settle();
  await settle();
  const view = store.viewOf("https://a")!;
  assert.equal(view.state, "offline");
  assert.equal(view.copies.size, 2);
  assert.ok(timers.at(-1)!.ms >= 24000, "an offline computer is read far less often");
});

test("the session's client is shared, and swapping it or forgetting the computer drops late work", async () => {
  const first = fakeClient("https://a");
  const second = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": first });
  let release!: () => void;
  const slow = {
    ...first.client,
    chatLists: () => new Promise<never>((resolve) => (release = () => resolve({ "/a": copy("/old") } as never))),
  } as unknown as StoreClient;
  store.sync([host("https://a")], { hostId: "https://a", client: slow, projects: [{ path: "/a", name: "a" }], reload: async () => {} });
  store.show();
  await settle();
  assert.equal(store.viewOf("https://a")?.state, "checking");
  store.sync([host("https://a")], { hostId: "https://a", client: second.client, projects: [{ path: "/a", name: "a" }], reload: async () => {} });
  await settle();
  release();
  await settle();
  const view = store.viewOf("https://a")!;
  assert.equal(view.state, "online");
  assert.equal(view.copies.get("/a")?.project.path, "/a", "the replaced client's late answer was dropped");
  assert.equal(first.calls.recent, 0, "the shared client never makes a second Project list");
  store.sync([host("https://a", { hidden: true })], null);
  assert.equal(store.viewOf("https://a"), undefined);
  assert.equal(store.clientFor("https://a"), null);
  assert.deepEqual(store.views(), []);
});

test("switching computers keeps listed Projects and Chats until the new session's Project list answers", async () => {
  const clients = { "https://a": fakeClient("https://a"), "https://b": fakeClient("https://b") };
  const { store, settle } = setup(clients);
  const hosts = [host("https://a"), host("https://b")];
  store.sync(hosts, null);
  const hide = store.show();
  await settle();
  hide();
  const before = store.viewOf("https://b")!;
  const selected = { hostId: "https://b", client: fakeClient("https://b").client, reload: async () => {} };
  // A cached Chat opens before recentScopes answers. Unknown is not an authoritative empty list.
  store.sync(hosts, { ...selected, projects: undefined });
  assert.equal(store.viewOf("https://b")!.projects, before.projects);
  assert.equal(store.viewOf("https://b")!.copies, before.copies);
  assert.equal(store.viewOf("https://b")!.loaded, true);
  // Further renders while the request is pending must not prune those Chats either.
  store.sync(hosts, { ...selected, projects: undefined });
  assert.equal(store.viewOf("https://b")!.copies, before.copies);
  store.sync(hosts, { ...selected, projects: before.projects });
  assert.equal(store.viewOf("https://b")!.copies, before.copies);
  // A real empty answer still removes Projects and their Chats.
  store.sync(hosts, { ...selected, projects: [] });
  assert.deepEqual(store.viewOf("https://b")!.projects, []);
  assert.equal(store.viewOf("https://b")!.copies.size, 0);
});

test("a selected computer with no Project list yet stays unloaded and requests its list", async () => {
  const mac = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": mac });
  let reloads = 0;
  store.sync([host("https://a")], {
    hostId: "https://a",
    client: mac.client,
    projects: undefined,
    reload: async () => {
      reloads++;
    },
  });
  assert.equal(store.viewOf("https://a")!.loaded, false);
  assert.deepEqual(store.viewOf("https://a")!.projects, []);
  store.show();
  await settle();
  assert.equal(reloads, 1);
});

test("refreshHosts reads only the named computers, their Project lists too", async () => {
  const clients = { "https://a": fakeClient("https://a"), "https://b": fakeClient("https://b") };
  const { store, settle } = setup(clients);
  store.sync([host("https://a"), host("https://b")], null);
  store.show();
  await settle();
  await store.refreshHosts(["https://b", "https://gone"]);
  assert.equal(clients["https://a"].calls.recent, 1);
  assert.equal(clients["https://b"].calls.recent, 2);
});

/** A client whose reads wait for the test, so it can hold requests open. */
function heldClient(id: string, projects = ["/a", "/b", "/c"]) {
  const started: string[] = [];
  const waiting: (() => void)[] = [];
  const hold = <T>(label: string, value: () => T) =>
    new Promise<T>((resolve) => {
      started.push(label);
      waiting.push(() => resolve(value()));
    });
  const client = {
    url: id,
    retired: false,
    retire() {
      this.retired = true;
    },
    recentScopes: () => hold("recent", () => projects.map((path) => ({ path, name: path }))),
    call: (_method: string, args: unknown[]) => hold(`open ${String(args[0])}`, () => ({ path: String(args[0]) })),
    preview: (path: string) => hold(`preview ${path}`, () => copy(path)),
    open: (path: string) => hold(`link ${path}`, () => copy(path)),
    chatLists: (paths: string[]) => hold(`lists ${paths.join(",")}`, () => Object.fromEntries(paths.map((path) => [path, copy(path)]))),
  };
  return { client, started, release: () => waiting.splice(0).forEach((run) => run()) };
}

test("replacing a computer's entry while three requests are active does not let a fourth start", async () => {
  const first = heldClient("https://a", ["/a", "/b", "/c", "/d"]);
  const clients = { "https://a": first as unknown as ReturnType<typeof fakeClient> };
  const { store, settle } = setup(clients);
  // The Mac answers the Project list with four Projects, but not the batch route: each is opened one request at a time.
  (first.client as unknown as StoreClient).chatLists = () => Promise.reject(Object.assign(new Error("404"), { code: "unsupported" }));
  store.sync([host("https://a")], null);
  store.show();
  await settle();
  first.release();
  await settle();
  assert.equal(first.started.filter((label) => label.startsWith("open ")).length, 3, "three opens are out at once");
  const second = heldClient("https://a");
  clients["https://a"] = second as unknown as ReturnType<typeof fakeClient>;
  store.sync([host("https://a", { token: "b".repeat(64) })], null);
  await settle();
  assert.equal(first.client.retired, true, "the replaced client starts nothing more");
  assert.deepEqual(second.started, [], "the new entry waits: the three requests of the old one still hold the slots");
  first.release();
  await settle();
  assert.deepEqual(second.started, ["recent"], "a slot freed only when the old requests settled");
});

test("re-pairing with a new relay key replaces the client, drops the old data and ignores its late answers", async () => {
  const relay = (key: string) => ({ url: "wss://relay.example", hostId: "h".repeat(22), key });
  const old = heldClient("relay://h", ["/old"]);
  const next = fakeClient("relay://h", { projects: ["/new"] });
  const clients = { "relay://h": old as unknown as ReturnType<typeof fakeClient> };
  const { store, settle } = setup(clients);
  store.sync([host("relay://h", { relay: relay("k".repeat(43)) })], null);
  store.show();
  await settle();
  old.release();
  await settle();
  assert.deepEqual(old.started, ["recent", "lists /old"]);
  assert.equal(store.viewOf("relay://h")?.projects[0]?.path, "/old");
  clients["relay://h"] = next;
  store.sync([host("relay://h", { relay: relay("q".repeat(43)) })], null);
  const view = store.viewOf("relay://h")!;
  assert.equal(old.client.retired, true);
  assert.equal(store.clientFor("relay://h"), next.client);
  assert.equal(view.loaded, false, "nothing of the old pairing carries over");
  assert.deepEqual(view.projects, []);
  assert.equal(view.copies.size, 0);
  old.release();
  await settle();
  await settle();
  const after = store.viewOf("relay://h")!;
  assert.deepEqual(
    after.projects.map((item) => item.path),
    ["/new"],
  );
  assert.deepEqual([...after.copies.keys()], ["/new"], "the old client's late answer was ignored");
  // The same pairing again keeps its entry and its client.
  store.sync([host("relay://h", { relay: relay("q".repeat(43)) })], null);
  assert.equal(store.clientFor("relay://h"), next.client);
});

test("an access secret or the relay's address is part of a computer's identity", async () => {
  const made: StoreClient[] = [];
  const store = createAllComputersStore({
    createClient: () => {
      const { client } = fakeClient("https://a");
      made.push(client);
      return client;
    },
    applyProjects: async (_id, list) => list,
    now: () => 1000,
    random: () => 0.5,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const access = (secret: string) => host("https://a", { access: { id: "i", secret } });
  store.sync([access("one")], null);
  store.sync([access("one")], null);
  assert.equal(made.length, 1, "the same credentials keep the client");
  store.sync([access("two")], null);
  assert.equal(made.length, 2, "another access secret is another pairing");
  const relay = (url: string) => host("https://a", { relay: { url, hostId: "h".repeat(22), key: "k".repeat(43) } });
  store.sync([relay("wss://one.example")], null);
  store.sync([relay("wss://two.example")], null);
  assert.equal(made.length, 4, "another relay address is another pairing");
});

test("work queued while no sidebar shows is not started, and a read in progress stops issuing requests", async () => {
  const mac = heldClient("https://a", ["/a", "/b", "/c", "/d"]);
  (mac.client as unknown as StoreClient).chatLists = () => Promise.reject(Object.assign(new Error("404"), { code: "unsupported" }));
  const { store, settle } = setup({ "https://a": mac as unknown as ReturnType<typeof fakeClient> });
  store.sync([host("https://a")], null);
  const hide = store.show();
  await settle();
  mac.release();
  await settle();
  const issued = mac.started.length;
  assert.equal(mac.started.filter((label) => label.startsWith("open ")).length, 3);
  hide();
  mac.release();
  await settle();
  await settle();
  assert.equal(mac.started.length, issued, "the fourth Project's open was queued, and skipped once the sidebar hid");
  // Showing again reads from the start.
  store.show();
  await settle();
  assert.ok(mac.started.length > issued);
});

test("a read the user asks for runs while no sidebar shows", async () => {
  const mac = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  await store.refreshAll();
  await settle();
  assert.equal(mac.calls.recent, 1);
  assert.equal(store.viewOf("https://a")?.copies.size, 2);
});

test("a view change clears the scheduled read, so one read never starts right behind another", async () => {
  const mac = fakeClient("https://a");
  const { store, timers, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  const view = store.register({ visible: true, expandAll: false, isFolded: () => false });
  await settle();
  const scheduled = timers.filter((timer) => timer.live);
  assert.equal(scheduled.length, 1);
  view.update({ visible: true, expandAll: false, isFolded: () => false });
  assert.equal(scheduled[0]!.live, false, "the read the view change started took the timer");
  await settle();
  assert.equal(timers.filter((timer) => timer.live).length, 1, "one timer again once that read ends");
  assert.equal(mac.calls.lists.length, 2);
});

test("a Project that keeps being refused on an older Mac is left alone for five minutes, healthy ones are not", async () => {
  const old = fakeClient("https://old", { batch: false, projects: ["/a", "/bad"] });
  const preview = old.client.preview;
  const asked: string[] = [];
  old.client.preview = async (path: string) => {
    asked.push(path);
    if (path === "/bad") throw Object.assign(new Error("Not allowed"), { status: 403 });
    return preview(path);
  };
  const { store, timers, settle, clock } = setup({ "https://old": old });
  store.sync([host("https://old")], null);
  store.show();
  await settle();
  await settle();
  assert.equal(store.viewOf("https://old")?.errors.get("/bad"), "Not allowed");
  const again = async () => {
    clock.now += 10000;
    timers.at(-1)!.run();
    await settle();
    await settle();
  };
  for (let i = 0; i < 3; i++) await again();
  assert.equal(asked.filter((path) => path === "/bad").length, 1, "asked once, then left alone");
  assert.equal(asked.filter((path) => path === "/a").length, 4, "the healthy Project is read every time");
  clock.now += 5 * 60 * 1000;
  await again();
  assert.equal(asked.filter((path) => path === "/bad").length, 2, "asked again once the wait is over");
});

test("a dropped connection or a busy Mac does not start a Project's wait, a refused open does", async () => {
  const attempts = { x: 0, open: 0 };
  let fail: (() => Error) | null = null;
  const mac = fakeClient("https://old", { batch: false, projects: ["/a", "/x"] });
  const preview = mac.client.preview;
  mac.client.preview = async (path: string) => {
    if (path === "/x") {
      attempts.x++;
      if (fail) throw fail();
    }
    return preview(path);
  };
  const { store, timers, settle, clock } = setup({ "https://old": mac });
  store.sync([host("https://old")], null);
  store.show();
  const again = async () => {
    clock.now += 10000;
    timers.at(-1)!.run();
    await settle();
    await settle();
  };
  fail = () => new Error("Connection lost.");
  await settle();
  await settle();
  await again();
  fail = () => Object.assign(new Error("Your computer is busy right now."), { status: 429 });
  await again();
  assert.equal(attempts.x, 3, "a transient failure is retried at every read");

  const refused = fakeClient("https://open", { batch: false, projects: ["/a", "/x"] });
  const opener = refused.client.call;
  refused.client.call = (async (method: string, args: unknown[]) => {
    if (args[0] === "/x") {
      attempts.open++;
      throw Object.assign(new Error("Not a Project"), { status: 400 });
    }
    return opener(method, args);
  }) as never;
  const second = setup({ "https://open": refused });
  second.store.sync([host("https://open")], null);
  second.store.show();
  await second.settle();
  await second.settle();
  for (let i = 0; i < 3; i++) {
    second.clock.now += 10000;
    second.timers.at(-1)!.run();
    await second.settle();
    await second.settle();
  }
  assert.equal(attempts.open, 1, "a refused open is not retried at every read");
  assert.equal(second.store.viewOf("https://open")?.errors.get("/x"), "Not a Project");
});

test("what leaves a computer's Project list is forgotten, and its errors and wait with it", async () => {
  let listed = ["/a", "/b", "/broken"];
  const mac = fakeClient("https://a", { projects: ["/a", "/b", "/broken"] });
  mac.client.recentScopes = async () => listed.map((path) => ({ path, name: path }));
  const { store, timers, settle, clock } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  store.show();
  await settle();
  await settle();
  const again = async () => {
    clock.now += 61000;
    timers.at(-1)!.run();
    await settle();
    await settle();
  };
  assert.deepEqual([...store.viewOf("https://a")!.copies.keys()].sort(), ["/a", "/broken"]);
  assert.equal(store.viewOf("https://a")!.errors.get("/b"), "Not allowed");
  listed = ["/a", "/broken"];
  await again();
  const after = store.viewOf("https://a")!;
  assert.deepEqual([...after.copies.keys()].sort(), ["/a", "/broken"]);
  assert.equal(after.errors.size, 0, "the error of the Project that left is gone");
  // It comes back: its five-minute wait went with it, so it is asked for at once.
  listed = ["/a", "/b", "/broken"];
  const lists = mac.calls.lists.length;
  await again();
  assert.ok(
    mac.calls.lists.slice(lists).some((paths) => paths.includes("/b")),
    "asked again without waiting out the old cooldown",
  );
  // A Project that left drops its copy too.
  listed = ["/broken"];
  await again();
  assert.deepEqual([...store.viewOf("https://a")!.copies.keys()], ["/broken"]);
});

const folds =
  (...paths: string[]) =>
  (_hostId: string, path: string) =>
    paths.includes(path);
const lastRead = (mac: ReturnType<typeof fakeClient>) => mac.calls.lists.at(-1);

test("Archived opening and closing gives the sidebar back its folded behavior", async () => {
  const mac = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  const sidebar = store.register({ visible: true, expandAll: false, isFolded: folds("/b") });
  await settle();
  assert.deepEqual(lastRead(mac), ["/a"], "the folded group is not read");
  const archived = store.register({ visible: true, expandAll: true, isFolded: () => false });
  await settle();
  assert.deepEqual(lastRead(mac), ["/a", "/b"], "Archived reads every Project");
  archived.release();
  await store.refreshAll();
  assert.deepEqual(lastRead(mac), ["/a"], "once Archived closes the folded group is left alone again");
  sidebar.release();
});

test("two consumers combine: a Project is read unless every shown consumer folds it, and a hidden one adds nothing", async () => {
  const mac = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  const first = store.register({ visible: true, expandAll: false, isFolded: folds("/b") });
  const second = store.register({ visible: true, expandAll: false, isFolded: folds("/a") });
  await settle();
  await store.refreshAll();
  assert.deepEqual(lastRead(mac), ["/a", "/b"]);
  const hidden = store.register({ visible: false, expandAll: true, isFolded: () => false });
  await store.refreshAll();
  assert.deepEqual(lastRead(mac), ["/a", "/b"], "a consumer that is not shown does not widen the read");
  hidden.release();
  first.release();
  await store.refreshAll();
  assert.deepEqual(lastRead(mac), ["/b"], "only what the remaining consumer wants");
  // Releasing twice must not take another consumer's needs with it.
  first.release();
  await store.refreshAll();
  assert.deepEqual(lastRead(mac), ["/b"]);
  second.release();
});

test("a consumer that updates its own needs does not change another's", async () => {
  const mac = fakeClient("https://a");
  const { store, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  const sidebar = store.register({ visible: true, expandAll: false, isFolded: folds("/a", "/b") });
  const other = store.register({ visible: true, expandAll: false, isFolded: folds("/a", "/b") });
  await settle();
  other.update({ visible: true, expandAll: false, isFolded: folds("/b") });
  await settle();
  assert.deepEqual(lastRead(mac), ["/a"]);
  const reads = mac.calls.lists.length;
  other.release();
  await store.refreshAll();
  assert.equal(mac.calls.lists.length, reads, "the sidebar still folds both, so no Project is asked for");
  sidebar.release();
});

test("fresh Chat lists go to the session only for its own computer's live client", async () => {
  const clients = { "https://a": fakeClient("https://a"), "https://b": fakeClient("https://b") };
  const { store, settle } = setup(clients);
  const seeded: { client: StoreClient; path: string }[] = [];
  const current = (client: StoreClient) => ({
    hostId: "https://a",
    client,
    projects: [{ path: "/a", name: "a" }],
    reload: async () => {},
    seed: (source: StoreClient, path: string) => seeded.push({ client: source, path }),
  });
  store.sync([host("https://a"), host("https://b")], current(clients["https://a"].client));
  store.show();
  await settle();
  assert.deepEqual(seeded, [{ client: clients["https://a"].client, path: "/a" }], "only the current computer's read is handed over");
  // A refresh of one Project is handed over too; another computer's never is.
  await store.refreshProject("https://a", "/a");
  assert.equal(seeded.length, 2);
  await store.refreshProject("https://b", "/a");
  assert.equal(seeded.length, 2);
  // Once the session holds another client, the old one's answers are dropped before they could be seeded.
  const replacement = fakeClient("https://a");
  store.sync([host("https://a"), host("https://b")], current(replacement.client));
  await settle();
  assert.ok(
    seeded.slice(2).every((item) => item.client === replacement.client),
    "a retired client is never seeded",
  );
  assert.ok(seeded.length > 2, "the new client's read is handed over");
});

test("Choose projects hides and shows another computer's Project in what its view lists", async () => {
  const clients = { "https://a": fakeClient("https://a"), "https://b": fakeClient("https://b") };
  const { store, settle } = setup(clients);
  store.sync([host("https://a"), host("https://b")], null);
  store.show();
  await settle();
  const before = store.viewOf("https://a");
  store.setProjectHidden("https://b", "/a", true);
  assert.equal(store.viewOf("https://a"), before, "the other computer's view is untouched");
  assert.deepEqual(
    store.viewOf("https://b")?.projects.map((item) => [item.path, !!item.hidden]),
    [
      ["/a", true],
      ["/b", false],
    ],
  );
  const hidden = store.viewOf("https://b");
  store.setProjectHidden("https://b", "/a", true);
  assert.equal(store.viewOf("https://b"), hidden, "setting what is already so publishes nothing");
  store.setProjectHidden("https://b", "/a", false);
  assert.equal(store.viewOf("https://b")?.projects[0]?.hidden, undefined);
});

test("each computer's Chats home is kept apart from its Projects and its Chats read like a Project's", async () => {
  const methods: string[] = [];
  let home: { path: string; exists: boolean } | null = { path: "/chats", exists: false };
  const mac = fakeClient("https://a", { projects: ["/a"] });
  const client = mac.client as unknown as Record<string, unknown>;
  client.chatsHome = async () => {
    methods.push("chats:home");
    return home;
  };
  const recentScopes = client.recentScopes as () => Promise<unknown>;
  client.recentScopes = () => {
    methods.push("project:recent");
    return recentScopes();
  };
  client.call = async (method: string, args: unknown[]) => {
    methods.push(method);
    return { path: method === "chats:ensure" ? "/chats" : String(args[0]) };
  };
  client.chatLists = async (paths: string[]) => {
    mac.calls.lists.push(paths);
    return Object.fromEntries(
      paths.map((path) => [
        path,
        path === "/chats" && !methods.includes("chats:ensure") ? { error: "Open the project before reading its snapshot." } : copy(path),
      ]),
    );
  };
  const old = fakeClient("https://old");
  const { store, timers, settle } = setup({ "https://a": mac, "https://old": old });
  store.sync([host("https://a"), host("https://old")], null);
  store.show();
  await settle();
  await settle();
  assert.deepEqual(store.viewOf("https://a")?.home, { path: "/chats", exists: false });
  assert.deepEqual(methods.slice(0, 2), ["project:recent", "chats:home"], "the home is asked behind the Project list, never in front of it");
  assert.deepEqual(
    store.viewOf("https://a")?.projects.map((item) => item.path),
    ["/a"],
    "the home is never one of the computer's Projects",
  );
  assert.deepEqual(mac.calls.lists, [["/a"]], "a home not made yet has no Chats to read");
  assert.equal(store.viewOf("https://old")?.home, null, "a computer that can't say has no home");

  // Made elsewhere (desktop, MCP), the home is found at the next read of the Project list and read in the batch; it
  // opens with chats:ensure, which leaves the computer's shown Project alone, never project:open.
  home = { path: "/chats", exists: true };
  await store.refreshHosts(["https://a"]);
  await settle();
  await settle();
  await settle();
  assert.deepEqual(store.viewOf("https://a")?.home, { path: "/chats", exists: true });
  assert.ok(methods.includes("chats:ensure"));
  assert.ok(!methods.includes("project:open"));
  assert.ok(store.viewOf("https://a")?.copies.has("/chats"));
  assert.deepEqual(
    store.viewOf("https://a")?.projects.map((item) => item.path),
    ["/a"],
  );
  // Pruning what left the Project list keeps the home's Chats.
  timers.at(-1)?.run();
  await settle();
  assert.ok(store.viewOf("https://a")?.copies.has("/chats"));

  // Making the home from the phone says so at once, without waiting for the next read.
  const fresh = fakeClient("https://b", { projects: [] });
  (fresh.client as unknown as Record<string, unknown>).chatsHome = async () => ({ path: "/b-chats", exists: false });
  const other = setup({ "https://b": fresh });
  other.store.sync([host("https://b")], null);
  other.store.show();
  await other.settle();
  other.store.setHome("https://b", { path: "/b-chats", exists: true });
  assert.deepEqual(other.store.viewOf("https://b")?.home, { path: "/b-chats", exists: true });
});

test("the session's computer says where its Chats home is on the first read, though its Project list came with it", async () => {
  const mac = fakeClient("https://a");
  let asks = 0;
  (mac.client as unknown as Record<string, unknown>).chatsHome = async () => {
    asks++;
    return { path: "/chats", exists: false };
  };
  const { store, timers, settle } = setup({ "https://a": mac });
  // Just paired: the session already read the Project list, so the store has no Project list read of its own due.
  store.sync([host("https://a")], { hostId: "https://a", client: mac.client, projects: [{ path: "/a", name: "a" }], reload: async () => {} });
  store.show();
  await settle();
  await settle();
  assert.deepEqual(store.viewOf("https://a")?.home, { path: "/chats", exists: false }, "No project can be offered at once");
  assert.equal(asks, 1);
  timers.at(-1)!.run();
  await settle();
  await settle();
  assert.equal(asks, 1, "a known home is asked again only with the next Project list");
});

test("a failed Chats home ask neither ends the read nor counts against the computer", async () => {
  const mac = fakeClient("https://a", { projects: ["/a", "/b"] });
  (mac.client as unknown as Record<string, unknown>).chatsHome = async () => {
    throw new Error("Disk error");
  };
  const { store, timers, settle } = setup({ "https://a": mac });
  store.sync([host("https://a")], null);
  store.show();
  await settle();
  await settle();
  assert.deepEqual(mac.calls.lists, [["/a", "/b"]], "the Projects are read all the same");
  assert.equal(store.viewOf("https://a")?.state, "online");
  assert.equal(store.viewOf("https://a")?.home, undefined, "nothing is known about the home yet");
  timers.at(-1)!.run();
  await settle();
  await settle();
  assert.equal(store.viewOf("https://a")?.state, "online");
});

test("after a read, the computer's listed Chats go to the preload, through its request limit", async () => {
  const clients = { "https://a": fakeClient("https://a") };
  const warmed: { url: string; chats: number }[] = [];
  const { store, settle } = setup(clients, {
    warm: async (client, chats, limit) => {
      warmed.push({ url: client.url, chats: chats.length });
      assert.equal(await limit(async () => "read"), "read");
    },
  });
  store.sync([host("https://a")], null);
  const hide = store.show();
  await settle();
  await settle();
  assert.deepEqual(warmed, [{ url: "https://a", chats: 0 }]);
  hide();
});

test("the preload's Chats: every listed one with a summary, archived ones and ones without a summary left out", () => {
  const session = (id: number, extra = {}) => ({ id, summary: { lastAt: id * 100, lastId: id * 10 }, ...extra });
  const copies = new Map([
    ["/a", { project: { path: "/a", state: { sessions: { 1: session(1), 2: session(2, { archived: true }), 3: { id: 3 } } } } }],
    ["/b", { project: { path: "/b", state: { sessions: { 4: session(4) } } } }],
  ]) as never;
  assert.deepEqual(recentChats(copies), [
    { projectPath: "/a", chatId: 1, lastAt: 100, lastId: 10 },
    { projectPath: "/b", chatId: 4, lastAt: 400, lastId: 40 },
  ]);
});

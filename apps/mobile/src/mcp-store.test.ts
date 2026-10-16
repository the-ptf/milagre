import assert from "node:assert/strict";
import test from "node:test";
import { createMcpStore, mcpPendingKey, type McpClient } from "./mcp-store.ts";
import type { LiveOptions } from "./live.ts";

const account = { provider: "claude", accountId: "a", label: "Work" } as const;
const check = { ...account, problem: null, servers: [] };

function fake(handler: (method: string, args: unknown[]) => unknown) {
  const calls: string[] = [];
  let options: LiveOptions | null = null;
  let closed = 0;
  const client: McpClient = {
    url: "http://mac",
    call: async (method, args = []) => {
      calls.push(method);
      return handler(method, args) as never;
    },
    live: (_scope, next) => {
      options = next;
      return { close: () => void closed++ };
    },
  };
  return { client, calls, live: () => options!, closed: () => closed };
}

test("refresh lists the accounts, then checks each one", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const store = createMcpStore(mac.client);
  await store.refresh();
  assert.deepEqual(mac.calls, ["mcp:accounts", "mcp:check"]);
  assert.equal(store.get().error, "");
  assert.equal(store.get().busy, false);
  assert.deepEqual(store.get().entries, [{ account, check }]);
});

test("a 403 reads as an older or demo Mac, any other failure as a lost connection", async () => {
  let failure: unknown = Object.assign(new Error("forbidden"), { status: 403 });
  const mac = fake(() => {
    throw failure;
  });
  const store = createMcpStore(mac.client);
  await store.refresh();
  assert.match(store.get().error, /Not available on this computer/);
  assert.equal(store.get().busy, false);
  failure = new Error("offline");
  await store.refresh();
  assert.match(store.get().error, /Could not reach the computer/);
});

test("a failed check becomes that account's problem and the others still fill in", async () => {
  const other = { provider: "codex", accountId: "b", label: "Home" } as const;
  const mac = fake((method, args) => {
    if (method === "mcp:accounts") return [account, other];
    if (args[0] === "claude") throw new Error("boom");
    return { ...other, problem: null, servers: [] };
  });
  const store = createMcpStore(mac.client);
  await store.refresh();
  const [first, second] = store.get().entries!;
  assert.match(first!.check!.problem ?? "", /Could not check/);
  assert.equal(second!.check!.problem, null);
});

test("a refresh keeps the rows already checked instead of blanking them", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const store = createMcpStore(mac.client);
  await store.refresh();
  const during: unknown[] = [];
  store.subscribe(() => during.push(store.get().entries?.[0]?.check));
  await store.refresh();
  assert.ok(during.length > 0 && during.every((value) => value === check));
});

test("only the newest refresh writes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const mac = fake(async (method) => {
    if (method !== "mcp:accounts") return check;
    if (first) {
      first = false;
      await gate;
      return [{ ...account, accountId: "stale" }];
    }
    return [account];
  });
  const store = createMcpStore(mac.client);
  const stale = store.refresh();
  await store.refresh();
  release();
  await stale;
  assert.equal(store.get().entries![0]!.account.accountId, "a");
});

test("screens share one live subscription, signals refresh, and the last release closes it", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const store = createMcpStore(mac.client);
  const releaseList = store.acquire();
  const releaseDetail = store.acquire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 1);
  mac.live().onSignal("runs");
  mac.live().onSignal("mcp");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 2);
  releaseList();
  assert.equal(mac.closed(), 0);
  releaseDetail();
  releaseDetail();
  assert.equal(mac.closed(), 1);
});

test("a socket that comes back after a drop checks again; the first open does not", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const store = createMcpStore(mac.client);
  store.acquire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const count = () => mac.calls.filter((method) => method === "mcp:accounts").length;
  mac.live().onStatus(true);
  assert.equal(count(), 1);
  mac.live().onStatus(false);
  mac.live().onStatus(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(count(), 2);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const chip = { ...account, scope: "user", state: "connected", tools: 1, error: null } as const;
const withServer = {
  ...account,
  problem: null,
  servers: [{ name: "pencil", transport: "url", scope: "user", state: "connected", tools: 1, error: null, detail: null }],
};

test("writes go through the allowed methods and start a re-check", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : method === "mcp:check" ? check : null));
  const store = createMcpStore(mac.client);
  await store.toggle(chip, "pencil", false);
  await store.remove("pencil", ["everywhere", "claude"]);
  await store.saveUrl({ name: "x", type: "http", url: "https://x.dev", headers: {} }, "claude");
  await tick();
  assert.deepEqual(
    mac.calls.filter((method) => method !== "mcp:accounts" && method !== "mcp:check"),
    ["mcp:toggle", "mcp:remove", "mcp:remove", "mcp:saveUrl"],
  );
  // The toggle re-checks only its account; remove and save refresh everything.
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 2);
});

test("a toggle re-checks only the toggled account, not the whole list", async () => {
  const other = { provider: "codex", accountId: "b", label: "Home" } as const;
  const checked: unknown[][] = [];
  const mac = fake((method, args) => {
    if (method === "mcp:accounts") return [account, other];
    if (method === "mcp:check") {
      checked.push(args);
      return args[0] === "claude" ? withServer : { ...other, problem: null, servers: [] };
    }
    return null;
  });
  const store = createMcpStore(mac.client);
  await store.refresh();
  checked.length = 0;
  const accountsBefore = mac.calls.filter((method) => method === "mcp:accounts").length;
  await store.toggle(chip, "pencil", false);
  await tick();
  assert.deepEqual(checked, [["claude", "a"]]);
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, accountsBefore);
});

test("remove tries every config even when one fails, then reports the failures once", async () => {
  const removed: unknown[][] = [];
  const mac = fake((method, args) => {
    if (method === "mcp:remove") {
      if (args[1] === "claude") throw new Error("claude mcp remove failed");
      removed.push(args);
      return null;
    }
    return method === "mcp:accounts" ? [account] : check;
  });
  const store = createMcpStore(mac.client);
  await assert.rejects(store.remove("pencil", ["everywhere", "claude", "codex"]), /Couldn’t remove pencil from Claude’s config\. claude mcp remove failed/);
  assert.deepEqual(removed, [
    ["pencil", "everywhere"],
    ["pencil", "codex"],
  ]);
  await tick();
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 1, "the list re-checks after a partial failure");
});

test("writes resolve once the Mac took them, before the re-check finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const mac = fake(async (method) => {
    if (method === "mcp:accounts") {
      await gate;
      return [account];
    }
    return method === "mcp:check" ? check : null;
  });
  const store = createMcpStore(mac.client);
  await store.saveUrl({ name: "x", type: "http", url: "https://x.dev", headers: {} }, "everywhere");
  assert.equal(store.get().busy, true);
  release();
  await tick();
  assert.equal(store.get().busy, false);
});

test("a switch shows its new value while the write runs, ignores a second flip, and keeps it after", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const mac = fake(async (method) => {
    if (method === "mcp:toggle") await gate;
    return method === "mcp:accounts" ? [account] : method === "mcp:check" ? withServer : null;
  });
  const store = createMcpStore(mac.client);
  await store.refresh();
  const key = mcpPendingKey(chip, "pencil");
  const first = store.toggle(chip, "pencil", false);
  assert.deepEqual(store.get().pending, { [key]: false });
  await store.toggle(chip, "pencil", true);
  assert.equal(mac.calls.filter((method) => method === "mcp:toggle").length, 1);
  release();
  await first;
  assert.deepEqual(store.get().pending, {});
  // Until the re-check answers, the switch reads as off rather than snapping back.
  assert.equal(store.get().entries![0]!.check!.servers[0]!.state, "disabled");
});

test("a failed write clears the pending value and leaves the switch where it was", async () => {
  const mac = fake((method) => {
    if (method === "mcp:toggle") throw new Error("denied");
    return method === "mcp:accounts" ? [account] : withServer;
  });
  const store = createMcpStore(mac.client);
  await store.refresh();
  await assert.rejects(store.toggle(chip, "pencil", false), /denied/);
  assert.deepEqual(store.get().pending, {});
  assert.equal(store.get().entries![0]!.check!.servers[0]!.state, "connected");
});

test("a new client for the same computer takes over the next refresh and the live socket", async () => {
  const old = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const fresh = fake((method) => (method === "mcp:accounts" ? [account] : check));
  const store = createMcpStore(old.client);
  const release = store.acquire();
  await tick();
  store.setClient(fresh.client);
  await tick();
  assert.equal(old.closed(), 1);
  assert.deepEqual(fresh.calls.slice(0, 2), ["mcp:accounts", "mcp:check"]);
  const before = old.calls.length;
  await store.refresh();
  assert.equal(old.calls.length, before);
  assert.equal(fresh.calls.filter((method) => method === "mcp:accounts").length, 2);
  release();
});

test("one app-state listener serves all screens; background closes the socket and active reopens it", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : check));
  let listener: ((active: boolean) => void) | null = null;
  let subscriptions = 0;
  let removed = 0;
  const store = createMcpStore(mac.client, {
    subscribe(next) {
      subscriptions++;
      listener = next;
      return () => void removed++;
    },
  });
  const a = store.acquire();
  const b = store.acquire();
  assert.equal(subscriptions, 1);
  listener!(false);
  assert.equal(mac.closed(), 1);
  listener!(true);
  await tick();
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 2);
  a();
  assert.equal(removed, 0);
  b();
  assert.equal(removed, 1);
});

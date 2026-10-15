import assert from "node:assert/strict";
import test from "node:test";
import { createMcpStore, type McpClient } from "./mcp-store.ts";
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
  const during: (typeof check | null | undefined)[] = [];
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

test("writes go through the allowed methods and refresh afterwards", async () => {
  const mac = fake((method) => (method === "mcp:accounts" ? [account] : method === "mcp:check" ? check : null));
  const store = createMcpStore(mac.client);
  const chip = { ...account, scope: "user", state: "connected", tools: 1, error: null } as const;
  await store.toggle(chip, "pencil", false);
  await store.remove("pencil", "everywhere");
  await store.saveUrl({ name: "x", type: "http", url: "https://x.dev", headers: {} }, "claude");
  assert.deepEqual(
    mac.calls.filter((method) => method !== "mcp:accounts" && method !== "mcp:check"),
    ["mcp:toggle", "mcp:remove", "mcp:saveUrl"],
  );
  assert.equal(mac.calls.filter((method) => method === "mcp:accounts").length, 3);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { connectDeviceRoutes } from "./route-supervisor.mjs";

test("device connections prefer LAN, then Tailscale, then the saved remote fallback", async () => {
  const dialed = [];
  const result = await connectDeviceRoutes({
    primary: "remote",
    direct: ["lan", "tailscale"],
    probe: async () => true,
    connect: async (endpoint) => {
      dialed.push(endpoint);
      if (endpoint === "lan") throw new Error("gone");
      return endpoint;
    },
  });
  assert.equal(result.connection, "tailscale");
  assert.deepEqual(dialed, ["lan", "tailscale"]);
  const fallback = await connectDeviceRoutes({
    primary: "remote",
    direct: ["lan"],
    probe: async () => false,
    connect: async (endpoint) => endpoint,
  });
  assert.equal(fallback.connection, "remote");
});

test("a rejected pinned identity never retries another route", async () => {
  const refusal = new Error("wrong key");
  const dialed = [];
  await assert.rejects(
    connectDeviceRoutes({
      primary: "remote",
      direct: ["lan", "tailscale"],
      probe: async () => true,
      connect: async (endpoint) => {
        dialed.push(endpoint);
        throw refusal;
      },
      final: (error) => error === refusal,
    }),
    refusal,
  );
  assert.deepEqual(dialed, ["lan"]);
});

test("closing during probes never opens a socket, and private pairing never adds a public route", async () => {
  let cancel = false;
  const dialed = [];
  await assert.rejects(
    connectDeviceRoutes({
      primary: "lan",
      direct: ["lan", "tailscale"],
      probe: async () => {
        cancel = true;
        return true;
      },
      stopped: () => cancel,
      connect: async (endpoint) => dialed.push(endpoint),
    }),
    /cancelled/,
  );
  assert.deepEqual(dialed, []);
  await assert.rejects(
    connectDeviceRoutes({
      primary: "lan",
      direct: ["lan", "tailscale"],
      probe: async () => true,
      connect: async (endpoint) => {
        dialed.push(endpoint);
        throw new Error("offline");
      },
    }),
    /offline/,
  );
  assert.deepEqual(dialed, ["lan", "tailscale"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { lanRouteFromAnswer, validLanRoute } from "./lan-route.ts";

const hostId = "H".repeat(22);
const key = "K".repeat(43);

test("keeps private and tailnet ws endpoints only, at most four", () => {
  const route = validLanRoute({
    hostId,
    key,
    learnedAt: 5,
    endpoints: [
      "ws://192.168.1.20:8798",
      "ws://10.0.0.7:8798",
      "ws://172.31.0.2:8798",
      "ws://172.32.0.2:8798",
      "ws://100.128.0.2:8798",
      "ws://100.63.0.2:8798",
      "wss://192.168.1.20:8798",
      "ws://8.8.8.8:8798",
      "ws://mac.local:8798",
      "ws://100.107.136.115:8798",
      "ws://192.168.1.22:8798",
    ],
  });
  assert.deepEqual(route, {
    hostId,
    key,
    learnedAt: 5,
    endpoints: ["ws://192.168.1.20:8798", "ws://10.0.0.7:8798", "ws://172.31.0.2:8798", "ws://100.107.136.115:8798"],
  });
});

test("no usable endpoint, a bad id or a bad key is no route", () => {
  assert.equal(validLanRoute({ hostId, key, endpoints: [] }), undefined);
  assert.equal(validLanRoute({ hostId: "x", key, endpoints: ["ws://192.168.1.20:8798"] }), undefined);
  assert.equal(validLanRoute({ hostId, key: "y", endpoints: ["ws://192.168.1.20:8798"] }), undefined);
  assert.equal(validLanRoute(null), undefined);
});

test("reads the Mac's phone:routes answer", () => {
  assert.deepEqual(lanRouteFromAnswer({ hostId, key, lan: ["ws://192.168.1.20:8798"] }, 9), {
    hostId,
    key,
    endpoints: ["ws://192.168.1.20:8798"],
    learnedAt: 9,
  });
  assert.equal(lanRouteFromAnswer({ hostId, key, lan: [] }, 9), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_SIZES,
  PILL_AT,
  ROW_SIZES,
  curvePoint,
  fitZoom,
  layoutMachineRows,
  layoutMachineMap,
  machineKindOf,
  matchesMachine,
  mergeTwoWay,
  routeName,
  zoomStep,
  type MapMachine,
} from "./computer-map.ts";

const machine = (id: string, patch: Partial<MapMachine> = {}): MapMachine => ({
  id,
  name: id,
  kind: "laptop",
  state: "active",
  route: "LAN",
  detail: "Online",
  direction: "out",
  ...patch,
});

test("routeName tells Tailscale from LAN by the tailnet range and names the relay by its host", () => {
  assert.equal(routeName("lan", { address: "100.101.4.2" }), "Tailscale");
  assert.equal(routeName("lan", { address: "100.128.0.1" }), "LAN");
  assert.equal(routeName("lan", { address: "192.168.2.209" }), "LAN");
  assert.equal(routeName("relay", { relayHost: "wss://relay.milagre.cloud/v1" }), "relay.milagre.cloud");
  assert.equal(routeName(null, { relayHost: "mac.milagre.cloud" }), "mac.milagre.cloud");
  assert.equal(routeName("relay", {}), "Relay");
});

test("machineKindOf reads the kind from the name", () => {
  assert.equal(machineKindOf("Victor's Mac Studio"), "desktop");
  assert.equal(machineKindOf("MacBook Pro"), "laptop");
  assert.equal(machineKindOf("Victor's iPad"), "tablet");
  assert.equal(machineKindOf("Victor's iPhone"), "phone");
  assert.equal(machineKindOf("Mobile", { phone: true }), "phone");
});

test("a computer that drives the hub joins the driven computer of the same name as one two-way machine", () => {
  const merged = mergeTwoWay(
    [machine("santo", { name: "Santo" }), machine("box", { name: "Box" })],
    [machine("key-1", { name: "santo", direction: "in" }), machine("key-2", { name: "Santo iPhone", kind: "phone", direction: "in" })],
  );
  assert.deepEqual(
    merged.map(({ id, direction }) => [id, direction]),
    [
      ["santo", "both"],
      ["box", "out"],
      ["key-2", "in"],
    ],
  );
});

test("a phone never joins a computer, even under the same name", () => {
  const merged = mergeTwoWay([machine("a", { name: "Pocket" })], [machine("p", { name: "Pocket", kind: "phone", direction: "in" })]);
  assert.deepEqual(
    merged.map(({ id, direction }) => [id, direction]),
    [
      ["a", "out"],
      ["p", "in"],
    ],
  );
});

test("without drivers the hub sits on the left, and every driven machine's line ends at its card", () => {
  const layout = layoutMachineMap([machine("b", { state: "offline" }), machine("a")]);
  assert.equal(layout.hub.x, MAP_SIZES.padding);
  assert.deepEqual(
    layout.machines.map((placed) => placed.id),
    ["a", "b"],
  );
  const [first] = layout.machines;
  const edge = layout.edges.find((candidate) => candidate.id === "a")!;
  assert.ok(edge.path.endsWith(`${first!.rect.x} ${first!.rect.y + first!.rect.height / 2}`));
  const from = { x: layout.hub.x + layout.hub.width, y: layout.hub.y + layout.hub.height / 2 };
  assert.deepEqual(edge.mid, curvePoint(from, { x: first!.rect.x, y: first!.rect.y + first!.rect.height / 2 }, PILL_AT));
  assert.ok(edge.mid.x > (from.x + first!.rect.x) / 2, "the pill sits nearer the machine than the hub");
  assert.equal(layout.width, first!.rect.x + MAP_SIZES.card.width + MAP_SIZES.padding);
});

test("drivers go left of the hub with lines into it; two-way machines carry an arrow at both ends", () => {
  const layout = layoutMachineMap([machine("phone", { direction: "in", kind: "phone" }), machine("box", { direction: "both" })]);
  const phone = layout.machines.find((placed) => placed.id === "phone")!;
  const box = layout.machines.find((placed) => placed.id === "box")!;
  assert.equal(phone.side, "left");
  assert.equal(box.side, "right");
  assert.ok(phone.rect.x < layout.hub.x && layout.hub.x < box.rect.x);
  assert.ok(layout.edges.find((edge) => edge.id === "phone")!.path.endsWith(`${layout.hub.x} ${layout.hub.y + layout.hub.height / 2}`));
  assert.equal(layout.edges.find((edge) => edge.id === "box")!.arrowStart, true);
  assert.equal(layout.edges.find((edge) => edge.id === "phone")!.arrowStart, false);
});

test("the map is as tall as its longest column and centres the hub on it", () => {
  const layout = layoutMachineMap([machine("a"), machine("b"), machine("c")]);
  const column = 3 * MAP_SIZES.card.height + 2 * MAP_SIZES.rowGap;
  assert.equal(layout.height, column + 2 * MAP_SIZES.padding);
  assert.equal(layout.hub.y + layout.hub.height / 2, MAP_SIZES.padding + column / 2);
});

test("search matches every word against name, route and status", () => {
  const box = machine("box", { name: "Box", route: "Tailscale", detail: "Online" });
  assert.equal(matchesMachine(box, ""), true);
  assert.equal(matchesMachine(box, "box tail"), true);
  assert.equal(matchesMachine(box, "box lan"), false);
});

test("curvePoint lands on the curve's ends and its symmetric midpoint", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 40 };
  assert.deepEqual(curvePoint(from, to, 0), from);
  assert.deepEqual(curvePoint(from, to, 1), to);
  assert.deepEqual(curvePoint(from, to, 0.5), { x: 50, y: 20 });
});

test("fit never zooms past 100% and zoom steps stay in range", () => {
  assert.equal(fitZoom({ width: 400, height: 200 }, { width: 800, height: 800 }), 1);
  assert.equal(fitZoom({ width: 800, height: 200 }, { width: 400, height: 800 }), 0.5);
  assert.equal(zoomStep(2, 1), 2);
  assert.equal(zoomStep(0.25, -1), 0.25);
  assert.equal(zoomStep(1, 1), 1.25);
});

test("the phone's rows put the hub across the top and every machine below it, inside the width", () => {
  const layout = layoutMachineRows([machine("b", { state: "offline" }), machine("a")], 360);
  assert.deepEqual(layout.hub, { x: ROW_SIZES.padding, y: ROW_SIZES.padding, width: 360 - 2 * ROW_SIZES.padding, height: ROW_SIZES.hubHeight });
  assert.deepEqual(
    layout.machines.map((placed) => placed.id),
    ["a", "b"],
  );
  for (const placed of layout.machines) assert.equal(placed.rect.x + placed.rect.width, 360 - ROW_SIZES.padding);
  assert.equal(layout.height, layout.machines[1]!.rect.y + ROW_SIZES.cardHeight + ROW_SIZES.padding);
  assert.deepEqual(
    layout.edges.map((edge) => edge.id),
    ["b", "a"],
    "upper rows draw last, over the shared trunk",
  );
  const edge = layout.edges.find((candidate) => candidate.id === "a")!;
  assert.ok(edge.path.endsWith(`${layout.machines[0]!.rect.x} ${edge.mid.y}`));
  assert.equal(edge.mid.y, layout.machines[0]!.rect.y + ROW_SIZES.cardHeight / 2);
});

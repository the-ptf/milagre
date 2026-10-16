import assert from "node:assert/strict";
import test from "node:test";
import type { Subagent, SubagentCommunication } from "@milagre/shared/model";
import {
  MAIN_AGENT,
  canvasAgentName,
  fitAgents,
  initialAgentPosition,
  moveAgentWithCollisions,
  nextCommunicationChange,
  recentCommunications,
  subagentColor,
  subagentPersona,
  type Point,
} from "./subagent-canvas-layout.ts";

test("sequential arrivals keep distinct slots across multiple rings", () => {
  const points = Array.from({ length: 24 }, (_, index) => initialAgentPosition(index));
  for (let a = 0; a < points.length; a++)
    for (let b = a + 1; b < points.length; b++) {
      assert.ok(Math.abs(points[a].x - points[b].x) >= 220 || Math.abs(points[a].y - points[b].y) >= 150, `Agents ${a} and ${b} overlap`);
    }
});

test("biblical names remain unique when the roster exceeds the name list", () => {
  const names = Array.from({ length: 40 }, (_, index) => canvasAgentName(index));
  assert.deepEqual(names.slice(0, 3), ["Moses", "Noah", "Esther"]);
  assert.equal(new Set(names).size, names.length);
});

test("fit keeps all bot bounds inside desktop and compact surfaces", () => {
  const points = [{ x: 0, y: 0 }, ...Array.from({ length: 6 }, (_, index) => initialAgentPosition(index))];
  for (const [width, height] of [
    [1076, 726],
    [366, 426],
  ]) {
    const view = fitAgents(points, width, height);
    assert.ok(view.scale > 0 && view.scale <= 1);
    for (const point of points) {
      assert.ok(view.x + (point.x - 120) * view.scale >= 0);
      assert.ok(view.x + (point.x + 120) * view.scale <= width);
      assert.ok(view.y + (point.y - 100) * view.scale >= 0);
      assert.ok(view.y + (point.y + 110) * view.scale <= height);
    }
  }
});

const now = 50_000;
const message = (id: string, fromId: string | null, toId: string | null, at = now): SubagentCommunication => ({ id, fromId, toId, text: id, at });
const agent = (id: string, communications: SubagentCommunication[] = []): Subagent => ({
  id,
  title: id,
  status: "running",
  startedAt: 0,
  updatedAt: now,
  transcript: [],
  communications,
});

test("activity without an actual exchange creates no communication wire", () => {
  assert.deepEqual(recentCommunications([{ ...agent("review"), latestActivity: "Reading source" }, agent("tests")], now), []);
});

test("communication wires exclude stale, future, missing, and self recipients", () => {
  const valid = message("current", "review", "tests");
  const agents = [
    agent("review", [
      message("stale", "review", "tests", now - 12_001),
      message("future", "review", "tests", now + 1001),
      message("missing-recipient", "review", "archived"),
      message("missing-sender", "archived", "tests"),
      message("self", "review", "review"),
      valid,
    ]),
    agent("tests"),
  ];
  assert.deepEqual(recentCommunications(agents, now), [valid]);
});

test("each direction retains only its newest exchange and supports the main agent", () => {
  const reply = message("reply", "tests", "review", now - 500);
  const latest = message("latest", "review", "tests");
  const main = message("main", null, "review", now - 250);
  const agents = [agent("review", [message("older", "review", "tests", now - 1000), main, latest]), agent("tests", [reply, latest])];
  assert.deepEqual(recentCommunications(agents, now), [reply, main, latest]);
});

test("communication pair identities cannot collide through punctuation", () => {
  const first = message("first", "a:b", "c");
  const second = message("second", "a", "b:c");
  const agents = [agent("a:b", [first]), agent("c"), agent("a", [second]), agent("b:c")];
  assert.deepEqual(recentCommunications(agents, now), [first, second]);
});

test("communication clocks stop when idle and wake at expiry or future eligibility", () => {
  assert.equal(nextCommunicationChange([agent("a"), agent("b")], now), undefined);
  const recent = [agent("a", [message("current", "a", "b", now - 1000)]), agent("b")];
  assert.equal(nextCommunicationChange(recent, now), now + 11_001);
  assert.equal(recentCommunications(recent, now + 11_000).length, 1);
  assert.equal(recentCommunications(recent, now + 11_001).length, 0);
  assert.equal(nextCommunicationChange(recent, now + 11_001), undefined);
  assert.equal(
    nextCommunicationChange([agent("a", [message("older", "a", "b", now - 10_000), message("newer", "a", "b")]), agent("b")], now),
    now + 12_001,
    "Superseded messages do not schedule redundant renders",
  );
  const future = [agent("a", [message("future", "a", "b", now + 2000)]), agent("b")];
  assert.equal(nextCommunicationChange(future, now), now + 1000);
  assert.equal(recentCommunications(future, now + 1000).length, 1);
  assert.equal(nextCommunicationChange([agent("a", [message("missing", "a", "missing"), message("self", "a", "a")])], now), undefined);
});

function assertSeparated(points: Record<string, Point>) {
  const entries = Object.entries(points);
  for (let a = 0; a < entries.length; a++)
    for (let b = a + 1; b < entries.length; b++) {
      const [idA, pointA] = entries[a];
      const [idB, pointB] = entries[b];
      const separation = (idA === MAIN_AGENT ? 56 : 48) + (idB === MAIN_AGENT ? 56 : 48);
      const centerY = pointA.y + (idA === MAIN_AGENT ? 16 : 10) - (pointB.y + (idB === MAIN_AGENT ? 16 : 10));
      assert.ok(Math.hypot(pointA.x - pointB.x, centerY / 1.35) >= separation - 0.00001, `${idA} overlaps ${idB}`);
    }
}

test("dragging preserves the exact target and untouched positions without mutating its input", () => {
  const points = { dragged: { x: 0, y: 0 }, distant: { x: 600, y: -300 } };
  const original = structuredClone(points);
  const target = { x: 20, y: 10 };
  const result = moveAgentWithCollisions(points, "dragged", target);
  assert.deepEqual(result.dragged, target);
  assert.equal(result.distant, points.distant);
  assert.deepEqual(points, original);
  assert.equal(moveAgentWithCollisions(points, "dragged", points.dragged), points);
});

test("dragging into neighbors pushes a chain while the dragged bot stays under the pointer", () => {
  const points = { dragged: { x: 0, y: 0 }, first: { x: 110, y: 0 }, second: { x: 220, y: 0 }, third: { x: 330, y: 0 } };
  const target = { x: 170, y: 0 };
  const result = moveAgentWithCollisions(points, "dragged", target);
  assert.deepEqual(result.dragged, target);
  assert.ok(result.first.x > points.first.x);
  assert.ok(result.second.x > points.second.x);
  assert.ok(result.third.x > points.third.x);
  assertSeparated(result);
});

test("large pointer jumps sweep through neighbors instead of tunneling past them", () => {
  const points = { dragged: { x: 0, y: 0 }, first: { x: 300, y: 0 }, second: { x: 700, y: 0 }, distant: { x: 900, y: 600 } };
  const target = { x: 50_000, y: 0 };
  const result = moveAgentWithCollisions(points, "dragged", target);
  assert.deepEqual(result.dragged, target);
  assert.ok(result.first.x > target.x);
  assert.ok(result.second.x > target.x);
  assert.equal(result.distant, points.distant);
  assertSeparated(result);
});

test("coincident bots separate deterministically and use the drag direction", () => {
  const points = { dragged: { x: 0, y: 0 }, alpha: { x: 0, y: 0 }, beta: { x: 0, y: 0 }, gamma: { x: 0, y: 0 } };
  const target = { x: -200, y: 0 };
  const result = moveAgentWithCollisions(points, "dragged", target);
  assert.deepEqual(result.dragged, target);
  assert.ok(result.alpha.x < target.x);
  assert.ok(result.beta.x < target.x);
  assert.ok(result.gamma.x < target.x);
  assertSeparated(result);
  assert.deepEqual(moveAgentWithCollisions(Object.fromEntries(Object.entries(points).reverse()), "dragged", target), result);
});

test("main and child footprints reserve space for vertically stacked names and statuses", () => {
  const points = { [MAIN_AGENT]: { x: 0, y: 0 }, child: { x: 0, y: 180 }, neighbor: { x: 0, y: 330 } };
  const target = { x: 0, y: 140 };
  const result = moveAgentWithCollisions(points, MAIN_AGENT, target);
  assert.deepEqual(result[MAIN_AGENT], target);
  assert.ok(result.child.y >= target.y + 146);
  assert.ok(result.neighbor.y > points.neighbor.y);
  assertSeparated(result);
});

test("arrivals resolve dense overlaps without moving the fixed new bot", () => {
  const points = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`bot-${index}`, { x: 0, y: 0 }]));
  const result = moveAgentWithCollisions(points, "arrival", { x: 0, y: 0 });
  assert.deepEqual(result.arrival, { x: 0, y: 0 });
  assertSeparated(result);
  assert.ok(Object.values(result).every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test("diagonal pushes stay separated through repeated changes of direction", () => {
  let points: Record<string, Point> = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`bot-${index}`, { x: (index % 4) * 170, y: Math.floor(index / 4) * 180 }]),
  );
  points[MAIN_AGENT] = { x: -200, y: -180 };
  const targets = [
    { x: 510, y: 540 },
    { x: -420, y: 270 },
    { x: 300, y: -350 },
    { x: 350, y: 600 },
    { x: 40, y: 40 },
  ];
  for (const target of targets) {
    points = moveAgentWithCollisions(points, MAIN_AGENT, target);
    assert.deepEqual(points[MAIN_AGENT], target);
    assertSeparated(points);
  }
});

test("a subagent's persona is its name and bot colour by its place among the Chat's subagents, with its task", () => {
  const agent = (id: string, title: string) => ({ id, title, status: "running" as const, startedAt: 0, updatedAt: 0, transcript: [] });
  const crew = [agent("a", "Research"), agent("b", "Design the profile screen")];
  assert.deepEqual(subagentPersona(crew, "b"), { name: "Noah", color: "blue", task: "Design the profile screen" });
  assert.equal(subagentPersona(crew, "missing"), null);
  assert.equal(subagentColor(4), "mint");
});

import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_PANEL, morphRect, planPanelFrame } from "./plan-panel-frame.ts";

const window = { width: 402, height: 874 };
const insets = { top: 62, bottom: 34, left: 0, right: 0 };
const pill = { x: 250, y: 790, width: 54, height: 24 };

test("the panel spans the Chat's width and sits on the pill's bottom edge", () => {
  const { from, to } = planPanelFrame({ window, insets, pill, content: 300 });
  assert.deepEqual(from, { ...pill, radius: 12 });
  assert.equal(to.x, PLAN_PANEL.edge);
  assert.equal(to.width, 402 - 2 * PLAN_PANEL.edge);
  assert.equal(to.y + to.height, pill.y + pill.height, "the bottom edge stays on the pill's");
  assert.equal(to.height, 300, "short content keeps its own height");
  assert.equal(to.radius, PLAN_PANEL.radius);
});

test("tall content stops at 70% of the window and below the header", () => {
  const { to } = planPanelFrame({ window, insets, pill, content: 5000 });
  assert.equal(to.height, Math.round(874 * PLAN_PANEL.share));
  const low = planPanelFrame({ window: { width: 402, height: 500 }, insets, pill: { ...pill, y: 300 }, content: 5000 }).to;
  assert.equal(low.y, insets.top + PLAN_PANEL.top, "a pill high on a short window caps the panel at the header");
});

test("an open keyboard shrinks the share to the window above it", () => {
  const keyboard = 336;
  const above = { ...pill, y: 874 - keyboard - 70 };
  const { to } = planPanelFrame({ window, insets, pill: above, keyboard, content: 5000 });
  assert.equal(to.height, Math.round((874 - keyboard) * PLAN_PANEL.share));
  assert.equal(to.y + to.height, above.y + above.height);
});

test("safe-area sides and the overlay's own origin shift the frame", () => {
  const { from, to } = planPanelFrame({ window, insets: { ...insets, left: 44, right: 30 }, pill, origin: { x: 0, y: 20 }, content: 200 });
  assert.equal(to.x, 44 + PLAN_PANEL.edge);
  assert.equal(to.width, 402 - 44 - 30 - 2 * PLAN_PANEL.edge);
  assert.equal(from.y, pill.y - 20, "rects are relative to the overlay");
  assert.equal(to.y + to.height, pill.y + pill.height - 20);
});

test("beside an iPad's sidebar the panel keeps to the composer's column", () => {
  const ipad = { width: 1180, height: 820 };
  const sidebar = 332;
  const column = { x: sidebar, width: ipad.width - sidebar };
  const right = { x: 1080, y: 700, width: 54, height: 24 };
  const { from, to } = planPanelFrame({ window: ipad, insets, pill: right, room: column, origin: { x: sidebar, y: 0 }, content: 300 });
  assert.equal(to.x, PLAN_PANEL.edge, "the panel starts at the overlay's left edge, not under the sidebar");
  assert.equal(to.width, column.width - 2 * PLAN_PANEL.edge);
  assert.equal(from.x, right.x - sidebar);
  const centred = { x: sidebar + (column.width - 760) / 2, width: 760 };
  const narrow = planPanelFrame({ window: ipad, insets, pill: right, room: centred, origin: { x: sidebar, y: 0 }, content: 300 }).to;
  assert.equal(narrow.x, centred.x + PLAN_PANEL.edge - sidebar, "a reading-width column centres the panel with it");
  assert.equal(narrow.width, 760 - 2 * PLAN_PANEL.edge);
});

test("the panel is never smaller than the pill it grows from", () => {
  const { to } = planPanelFrame({ window: { width: 40, height: 100 }, insets, pill, content: 0 });
  assert.ok(to.width >= pill.width);
  assert.ok(to.height >= pill.height);
});

test("the morph starts on the pill and ends on the panel", () => {
  const { from, to } = planPanelFrame({ window, insets, pill, content: 300 });
  assert.deepEqual(morphRect(from, to, 0), from);
  assert.deepEqual(morphRect(from, to, 1), to);
  const half = morphRect(from, to, 0.5);
  assert.equal(half.width, (from.width + to.width) / 2);
  assert.equal(half.y + half.height, from.y + from.height, "the bottom edge never moves");
});

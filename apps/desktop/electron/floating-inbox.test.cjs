const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");

function fixture(positionFile) {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = {
        send: (...args) => {
          this.sent = args;
        },
      };
      windows.push(this);
    }
    isDestroyed() {
      return !!this.destroyed;
    }
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop(_on, level) {
      this.level = level;
    }
    setIgnoreMouseEvents(value) {
      this.ignoresMouse = value;
    }
    setBounds(bounds) {
      this.bounds = { ...this.bounds, ...bounds };
    }
    getBounds() {
      return this.bounds;
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
      this.activated = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {
      this.activated = true;
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const primary = { id: 1, bounds: { x: 100, y: 0, width: 1200, height: 750 }, workArea: { x: 100, y: 50, width: 1200, height: 700 } };
  const secondary = { id: 2, bounds: { x: 1300, y: 0, width: 1000, height: 850 }, workArea: { x: 1300, y: 50, width: 1000, height: 800 } };
  let cursor = { x: 1275, y: 360 };
  let displays = [primary, secondary];
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => primary,
    getAllDisplays: () => displays,
    getCursorScreenPoint: () => cursor,
    getDisplayMatching: (bounds) => displays.find((item) => bounds.x >= item.workArea.x && bounds.x < item.workArea.x + item.workArea.width) || primary,
  });
  const loaded = [];
  const floating = require("./floating-inbox.cjs").createFloatingInbox({
    BrowserWindow: Window,
    screen,
    preload: "/preload",
    load: (_window, view) => loaded.push(view),
    positionFile,
  });
  return {
    windows,
    floating,
    loaded,
    screen,
    primary,
    cursor: (point) => {
      cursor = point;
    },
    removeSecondary: () => {
      displays = [primary];
      screen.emit("display-removed");
    },
  };
}

test("floating inbox is off by default, opens two isolated surfaces, and destroys both when disabled", () => {
  assert.ok(fs.existsSync(path.join(__dirname, "floating-inbox.cjs")), "floating inbox window controller exists");
  const { windows, floating, loaded } = fixture();
  assert.equal(windows.length, 0);
  floating.setEnabled(true);
  assert.equal(windows.length, 2);
  assert.deepEqual(loaded, ["dock", "inbox"]);
  assert.equal(windows[0].options.alwaysOnTop, true);
  assert.equal(windows[0].options.frame, false);
  assert.ok(
    windows.every((window) => window.options.hasShadow === false),
    "transparent surfaces use only the renderer shadow",
  );
  assert.equal(windows[0].bounds.width, 54, "38 px bar with 8 px shadow clearance on either side");
  assert.equal(windows[0].bounds.x + windows[0].bounds.width <= 1300, true);
  floating.setEnabled(true);
  assert.equal(windows.length, 2, "no duplicate windows");
  floating.toggle();
  assert.equal(windows[1].visible, true);
  assert.equal(windows[1].activated, true, "opening the inbox focuses its own panel");
  if (process.platform === "darwin") assert.equal(windows[1].options.type, "panel");
  windows[1].emit("blur");
  assert.equal(windows[1].visible, false);
  floating.toggle();
  let prevented = false;
  windows[1].emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(windows[1].visible, false);
  floating.toggle();
  assert.equal(windows[1].visible, true, "a system Close leaves the panel ready to reopen");
  floating.setEnabled(false);
  assert.ok(windows.every((window) => window.isDestroyed()));
  assert.equal(floating.owns(windows[0]), false);
});

test("a count or display change during spring return restores the normal window level", async (t) => {
  for (const interrupt of [({ floating }) => floating.setCount(2), ({ screen }) => screen.emit("display-metrics-changed")]) {
    const context = fixture();
    t.after(() => context.floating.dispose());
    context.floating.setEnabled(true);
    context.floating.beginDrag();
    context.cursor({ x: 600, y: 200 });
    context.floating.moveDrag();
    context.floating.endDrag();
    assert.equal(context.windows[0].level, "screen-saver");
    interrupt(context);
    assert.equal(context.windows[0].level, "floating");
    await delay(1200);
    assert.equal(context.windows[0].level, "floating");
  }
});

test("dragging shows every display's targets, accepts only a target, rotates at the bottom and restores its dock", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-floating-position-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "position.json");
  const first = fixture(file);
  first.floating.setEnabled(true);
  const [dock, panel] = first.windows;
  first.floating.beginDrag(true);
  assert.equal(dock.bounds.height, 70, "compact grip can reach the bottom without moving the native frame offscreen");
  assert.equal(first.windows.length, 4);
  for (const overlay of first.windows.slice(2)) {
    overlay.emit("ready-to-show");
    assert.equal(overlay.visible, true);
    assert.equal(overlay.ignoresMouse, true);
  }
  assert.equal(first.floating.overlayState(first.windows[3]).targets.length, 3);
  first.cursor({ x: 1325, y: 450 });
  first.floating.moveDrag();
  first.floating.endDrag();
  assert.ok(first.windows.slice(2).every((window) => !window.visible));
  assert.equal(first.floating.placement(), "left");
  assert.equal(dock.bounds.x, 1300);
  assert.ok(panel.bounds.x > dock.bounds.x, "a bar near the left edge opens its inbox to the right");
  const center = dock.bounds.y + dock.bounds.height / 2;
  first.floating.setCount(7);
  assert.ok(Math.abs(dock.bounds.y + dock.bounds.height / 2 - center) <= 1);
  first.floating.dispose();
  assert.equal(JSON.parse(fs.readFileSync(file)).displayId, 2);
  const second = fixture(file);
  second.floating.setEnabled(true);
  assert.equal(second.windows[0].bounds.x, 1300);
  const bottom = second.windows[0];
  second.cursor({ x: 1325, y: 450 });
  second.floating.beginDrag(true);
  second.cursor({ x: 1800, y: 830 });
  second.floating.moveDrag();
  second.floating.endDrag();
  assert.equal(second.floating.placement(), "bottom");
  assert.ok(bottom.bounds.width > bottom.bounds.height);
  assert.ok(Math.abs(bottom.bounds.x + bottom.bounds.width / 2 - 1800) <= 0.5);
  assert.equal(bottom.bounds.y + bottom.bounds.height, 850);
  assert.ok(second.windows[1].bounds.y + second.windows[1].bounds.height < bottom.bounds.y);
  second.floating.setCount(5);
  assert.ok(Math.abs(bottom.bounds.x + bottom.bounds.width / 2 - 1800) <= 0.5);
  second.floating.beginDrag(true);
  second.cursor({ x: 2275, y: 450 });
  second.floating.moveDrag();
  second.floating.endDrag();
  assert.equal(second.floating.placement(), "right");
  assert.equal(bottom.bounds.width, 54);
  assert.equal(bottom.bounds.x + bottom.bounds.width, 2300);
  const previous = { ...bottom.bounds };
  second.floating.beginDrag();
  second.cursor({ x: 1800, y: 300 });
  second.floating.moveDrag();
  second.floating.endDrag();
  assert.equal(second.floating.placement(), "right", "a missed drop keeps the previous position");
  assert.notEqual(bottom.bounds.x, previous.x, "spring starts from the released position");
  await delay(1200);
  assert.deepEqual(bottom.bounds, previous, "spring returns to the exact previous dock");
  second.floating.beginDrag(true);
  second.cursor({ x: 1800, y: 830 });
  second.floating.moveDrag();
  second.floating.endDrag(true);
  assert.deepEqual(bottom.bounds, previous, "cancel returns even when over a new target");
  second.removeSecondary();
  const bounds = second.windows[0].bounds,
    area = second.primary.workArea;
  assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  assert.ok(second.windows[1].bounds.x >= area.x);
  second.floating.dispose();
});

test("hover previews use a separate mouse-transparent window and disappear when leaving or opening the inbox", async () => {
  const { floating, windows, loaded } = fixture();
  floating.setEnabled(true);
  floating.showPreview("project#2", 90);
  await delay(210);
  assert.deepEqual(loaded, ["dock", "inbox", "preview"]);
  const preview = windows[2];
  preview.emit("ready-to-show");
  assert.equal(preview.visible, true);
  assert.equal(preview.ignoresMouse, true);
  assert.equal(preview.options.hasShadow, false);
  assert.deepEqual(preview.sent, ["floating-inbox:preview", "project#2"]);
  floating.showPreview(null);
  assert.equal(preview.visible, false);
  assert.equal(floating.previewKey(), null);
  floating.showPreview("project#3", 100);
  floating.toggle();
  await delay(210);
  assert.equal(preview.visible, false);
  floating.dispose();
  assert.ok(windows.every((window) => window.destroyed));
});

test("inbox height morphs from the current frame, retargets, and honors reduced motion", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const { floating, windows } = fixture();
  t.after(() => floating.dispose());
  floating.setEnabled(true);
  floating.toggle();
  const panel = windows[1];
  floating.setInboxHeight(280);
  t.mock.timers.tick(48);
  assert.ok(panel.bounds.height > 280 && panel.bounds.height < 540, "visible panel passes through intermediate heights");
  const current = panel.bounds.height;
  floating.setInboxHeight(600);
  assert.equal(panel.bounds.height, current, "a new target starts from the current animated height");
  t.mock.timers.tick(300);
  assert.equal(panel.bounds.height, 600);
  assert.ok(Math.abs(panel.bounds.y - 100) <= 1, "the panel remains centered beside its dock within one rounded pixel");
  floating.setInboxHeight(250, true);
  assert.equal(panel.bounds.height, 250, "reduced motion resizes immediately");
  floating.close();
  floating.setInboxHeight(350);
  assert.equal(panel.bounds.height, 350, "hidden panels adopt their content height before opening");
});

test("hover expands the bar and selecting a dot opens that page without toggling it closed", (t) => {
  const { floating, windows } = fixture();
  t.after(() => floating.dispose());
  floating.setEnabled(true);
  floating.setCount(3);
  const [dock, panel] = windows;
  const collapsed = dock.bounds.height;
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  floating.setDockExpanded(true);
  assert.equal(dock.bounds.height, collapsed, "hover does not jump to its final bounds");
  t.mock.timers.tick(80);
  assert.ok(dock.bounds.height > collapsed && dock.bounds.height < collapsed + 90, "the native frame morphs through intermediate sizes");
  const interrupted = dock.bounds.height;
  floating.setDockExpanded(false);
  assert.equal(dock.bounds.height, interrupted, "leaving retargets from the current frame");
  t.mock.timers.tick(64);
  assert.ok(dock.bounds.height < interrupted && dock.bounds.height > collapsed);
  t.mock.timers.tick(180);
  assert.equal(dock.bounds.height, collapsed);
  floating.setDockExpanded(true, true);
  assert.equal(dock.bounds.height, collapsed + 90, "reduced motion adopts the expanded frame immediately");
  floating.setDockExpanded(false, true);
  assert.equal(dock.bounds.height, collapsed);
  floating.openItem("project#2");
  assert.equal(panel.visible, true);
  assert.deepEqual(panel.sent, ["floating-inbox:selection", "project#2"]);
  assert.equal(floating.selectedKey(), "project#2");
  floating.openItem("project#3");
  assert.equal(panel.visible, true, "another dot keeps the inbox open");
  assert.equal(panel.activated, true, "dot navigation focuses the inbox so arrow keys work immediately");
  assert.equal(floating.isOpen(), true);
  floating.setDockExpanded(false, true);
  assert.equal(dock.bounds.height, collapsed + 90, "an open inbox pins the bar expanded");
  floating.close();
  assert.equal(floating.isOpen(), false);
  floating.setDockExpanded(false, true);
  assert.equal(dock.bounds.height, collapsed);
});

test("crowded dock reserves five dots and one overflow slot", (t) => {
  const { floating, windows } = fixture();
  t.after(() => floating.dispose());
  floating.setEnabled(true);
  floating.setCount(5);
  const five = windows[0].bounds.height;
  floating.setCount(6);
  assert.equal(windows[0].bounds.height, five + 31);
  floating.setCount(20);
  assert.equal(windows[0].bounds.height, five + 31, "additional Chats share the overflow slot");
  floating.setDockExpanded(true, true);
  assert.equal(windows[0].bounds.height, five + 31 + 90);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { APP_ICONS, createAppIconStore, appIconFile, applyAppIcon } = require("./app-icon.cjs");

const PUBLIC = path.join(__dirname, "../app/public");

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-app-icon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "nested", "app-icon.json");
}

test("defaults to the Milagre icon, persists a choice, ignores garbage", (t) => {
  const file = tempFile(t);
  const store = createAppIconStore({ file });
  assert.equal(store.get(), "default");
  assert.equal(store.set("sunset"), "sunset");
  assert.equal(createAppIconStore({ file }).get(), "sunset");
  assert.throws(() => store.set("../logo"), /Unknown app icon/);
  assert.throws(() => store.set(undefined), /Unknown app icon/);
  assert.equal(store.get(), "sunset");
  assert.equal(createAppIconStore({ file }).get(), "sunset");
  fs.writeFileSync(file, '{"icon":"neon"}');
  assert.equal(createAppIconStore({ file }).get(), "default");
  fs.writeFileSync(file, "not json");
  assert.equal(createAppIconStore({ file }).get(), "default");
});

/** Width, height and PNG color type (6 is RGBA) from the IHDR chunk. */
function pngHeader(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG", file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

test("every icon has a pre-shaped square PNG with transparency and a picker thumbnail", () => {
  for (const icon of APP_ICONS) {
    const header = pngHeader(appIconFile(PUBLIC, icon));
    assert.equal(header.width, header.height, icon);
    assert.ok(header.width >= 512, `${icon} is ${header.width} px`);
    // The Dock shows the image as is: a full-bleed square would sit there unrounded.
    assert.equal(header.colorType, 6, `${icon} has no alpha channel`);
    assert.ok(fs.existsSync(path.join(PUBLIC, "app-icons", "thumbs", `${icon}.png`)), `${icon} has no thumbnail`);
  }
  assert.equal(appIconFile(PUBLIC, "default"), path.join(PUBLIC, "logo-milagre-image.png"));
});

function fakes() {
  const calls = { dock: [], windows: [] };
  const window = (destroyed) => ({ isDestroyed: () => destroyed, setIcon: (image) => calls.windows.push([destroyed, image.file]) });
  return {
    calls,
    options: {
      publicDir: PUBLIC,
      createImage: (file) => ({ file, isEmpty: () => !fs.existsSync(file) }),
      setDockIcon: (image) => calls.dock.push(image.file),
      windows: () => [window(false), window(true)],
    },
  };
}

test("macOS sets the Dock icon; Windows and Linux set every open window's icon", () => {
  const mac = fakes();
  assert.equal(applyAppIcon({ ...mac.options, icon: "aurora", platform: "darwin" }), true);
  assert.deepEqual(mac.calls.dock, [appIconFile(PUBLIC, "aurora")]);
  assert.deepEqual(mac.calls.windows, []);
  for (const platform of ["win32", "linux"]) {
    const other = fakes();
    assert.equal(applyAppIcon({ ...other.options, icon: "glass", platform }), true);
    assert.deepEqual(other.calls.dock, []);
    assert.deepEqual(other.calls.windows, [[false, appIconFile(PUBLIC, "glass")]]);
  }
});

test("an unreadable image changes nothing", () => {
  const mac = fakes();
  assert.equal(applyAppIcon({ ...mac.options, publicDir: path.join(os.tmpdir(), "milagre-missing-icons"), icon: "dawn", platform: "darwin" }), false);
  assert.deepEqual(mac.calls.dock, []);
});

test("the renderer's type and picker list the same icons, and main and preload wire the IPC", () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, relative), "utf8");
  const typeLine = read("../app/src/electron.d.ts").match(/export type AppIcon = ([^;]+);/);
  assert.ok(typeLine, "electron.d.ts has no AppIcon type");
  assert.deepEqual(
    [...typeLine[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [...APP_ICONS],
  );
  const picker = read("../app/src/components/settings/AppIconPicker.tsx");
  assert.deepEqual(
    [...picker.matchAll(/\{ id: "([^"]+)", name: "[^"]+" \}/g)].map((match) => match[1]),
    [...APP_ICONS],
  );
  const preload = read("preload.cjs");
  const main = read("main.cjs");
  for (const channel of ["app-icon:get", "app-icon:set"]) {
    assert.ok(preload.includes(`invoke("${channel}"`), `preload has no ${channel}`);
    assert.ok(main.includes(`ipcMain.handle("${channel}"`), `main has no ${channel}`);
  }
});

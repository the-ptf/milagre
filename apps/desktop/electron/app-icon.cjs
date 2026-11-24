// @ts-check
// Settings › Appearance › App icon: the Dock, Finder and notifications on macOS; the taskbar and notifications on Windows and Linux.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const APP_ICONS = /** @type {const} */ (["default", "dawn", "mono-dark", "mono-light", "sunset", "aurora", "glass", "eight-bit"]);
/** @typedef {typeof APP_ICONS[number]} AppIcon */

const isAppIcon = (/** @type {unknown} */ value) => typeof value === "string" && APP_ICONS.includes(/** @type {AppIcon} */ (value));

/**
 * @param {{ file: string }} options
 * @returns {{ get(): AppIcon, set(icon: unknown): AppIcon }}
 */
function createAppIconStore({ file }) {
  /** @type {AppIcon} */
  let icon = "default";
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).icon;
    if (isAppIcon(saved)) icon = saved;
  } catch {}
  return {
    get: () => icon,
    set(next) {
      if (!isAppIcon(next)) throw new Error(`Unknown app icon: ${String(next)}; one of ${APP_ICONS.join(", ")}`);
      const chosen = /** @type {AppIcon} */ (next);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ icon: chosen }));
      fs.renameSync(temporary, file);
      icon = chosen;
      return icon;
    },
  };
}

/**
 * @param {string} publicDir
 * @param {AppIcon} icon
 */
function appIconFile(publicDir, icon) {
  return icon === "default" ? path.join(publicDir, "logo-milagre-image.png") : path.join(publicDir, "app-icons", `${icon}.png`);
}

/**
 * Shows `icon` now: on the Dock on macOS (background mode leaves the Dock alone), on every app window elsewhere.
 * @param {{
 *   icon: AppIcon,
 *   publicDir: string,
 *   platform: NodeJS.Platform,
 *   createImage(file: string): { isEmpty(): boolean },
 *   setDockIcon(image: unknown): void,
 *   windows(): Array<{ isDestroyed(): boolean, setIcon(image: any): void }>,
 * }} options
 * @returns {boolean} false when the image couldn't be read
 */
function applyAppIcon({ icon, publicDir, platform, createImage, setDockIcon, windows }) {
  const image = createImage(appIconFile(publicDir, icon));
  if (image.isEmpty()) return false;
  if (platform === "darwin") setDockIcon(image);
  else for (const window of windows()) if (!window.isDestroyed()) window.setIcon(image);
  return true;
}

// NSWorkspace setIcon writes the custom icon macOS shows for the bundle everywhere, Notification Center included.
const SET_BUNDLE_ICON = `function run(argv) {
  ObjC.import("AppKit");
  const image = argv[1] ? $.NSImage.alloc.initWithContentsOfFile(argv[1]) : $();
  if (argv[1] && image.isNil()) throw new Error("Can't read " + argv[1]);
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0)) throw new Error("Can't change the icon of " + argv[0]);
}`;

/** @param {string} exe */
function macAppBundle(exe) {
  const bundle = path.resolve(exe, "../../..");
  return bundle.endsWith(".app") && path.basename(path.dirname(exe)) === "MacOS" ? bundle : null;
}

/**
 * Gives the app bundle the chosen icon, or takes it off for the default one. An update replaces the bundle and drops
 * the icon, so this runs at every launch and does nothing when the bundle already shows the choice.
 * @param {{
 *   icon: AppIcon,
 *   bundle: string,
 *   publicDir: string,
 *   staging: string,
 *   run(command: string, args: string[]): Promise<unknown>,
 * }} options
 * @returns {Promise<boolean>} whether the bundle changed
 */
async function syncBundleIcon({ icon, bundle, publicDir, staging, run }) {
  const applied = fs.existsSync(path.join(bundle, "Icon\r"));
  const wanted = icon === "default" ? null : fs.readFileSync(appIconFile(publicDir, icon));
  if (!wanted && !applied) return false;
  if (wanted && applied && fs.existsSync(staging) && fs.readFileSync(staging).equals(wanted)) return false;
  // osascript can't read inside app.asar, so the image goes through a plain file.
  if (wanted) {
    fs.mkdirSync(path.dirname(staging), { recursive: true });
    fs.writeFileSync(staging, wanted);
  }
  await run("osascript", ["-l", "JavaScript", "-e", SET_BUNDLE_ICON, bundle, ...(wanted ? [staging] : [])]);
  return true;
}

/**
 * Keeps the chosen icon and shows it on the Dock or windows, on the macOS bundle and in notifications.
 * @param {{
 *   app: Pick<Electron.App, "getPath" | "isPackaged">,
 *   ipcMain: Pick<Electron.IpcMain, "handle">,
 *   nativeImage: Pick<typeof Electron.nativeImage, "createFromPath">,
 *   windows(): Electron.BrowserWindow[],
 *   setDockIcon(image: Electron.NativeImage): void,
 *   publicDir: string,
 *   platform?: NodeJS.Platform,
 *   run?: (command: string, args: string[]) => Promise<unknown>,
 * }} options
 */
function installAppIcon({ app, ipcMain, nativeImage, windows, setDockIcon, publicDir, platform = process.platform, run = promisify(execFile) }) {
  const userData = app.getPath("userData");
  const store = createAppIconStore({ file: path.join(userData, "app-icon.json") });
  const bundle = platform === "darwin" && app.isPackaged ? macAppBundle(app.getPath("exe")) : null;
  function show() {
    const icon = store.get();
    applyAppIcon({ icon, publicDir, platform, createImage: (file) => nativeImage.createFromPath(file), setDockIcon, windows });
    if (bundle)
      syncBundleIcon({ icon, bundle, publicDir, staging: path.join(userData, "app-icon.png"), run }).catch((error) => console.warn("App icon:", error.message));
  }
  ipcMain.handle("app-icon:get", () => store.get());
  ipcMain.handle("app-icon:set", (_event, icon) => {
    const next = store.set(icon);
    show();
    return next;
  });
  return {
    store,
    show,
    // macOS takes the notification icon from the bundle; an icon here would only add a thumbnail beside the text.
    notificationOptions: () => (platform === "darwin" ? {} : { icon: nativeImage.createFromPath(appIconFile(publicDir, store.get())) }),
  };
}

module.exports = { APP_ICONS, createAppIconStore, appIconFile, applyAppIcon, macAppBundle, syncBundleIcon, installAppIcon };

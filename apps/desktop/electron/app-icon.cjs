// @ts-check
// Settings › Appearance › App icon: which icon the Dock (macOS) or the windows' taskbar entry (Windows, Linux) shows.
// Only the running app's icon changes. The bundle keeps its own: rewriting a signed .app's icon breaks its signature.
const fs = require("node:fs");
const path = require("node:path");

const APP_ICONS = /** @type {const} */ (["default", "dawn", "mono-dark", "mono-light", "sunset", "aurora", "glass", "eight-bit"]);
/** @typedef {typeof APP_ICONS[number]} AppIcon */

const isAppIcon = (/** @type {unknown} */ value) => typeof value === "string" && APP_ICONS.includes(/** @type {AppIcon} */ (value));

/**
 * The choice, in its own file in userData: the Dock icon is set before the window loads, so it can't wait on the renderer.
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
 * The PNG for `icon` under app/public: the default is the app's own logo, the others are pre-shaped like it in app-icons/.
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

module.exports = { APP_ICONS, createAppIconStore, appIconFile, applyAppIcon };

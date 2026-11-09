const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { launchOptions } = require("./launch-env.cjs");

const projectRoot = path.resolve(__dirname, "..");
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const electronBinary = require("electron");
const sourceApp = path.resolve(electronBinary, "../../..");
const runtimeRoot = path.join(projectRoot, ".milagre", "runtime");
const appBundle = path.join(runtimeRoot, "Milagre.app");
const appContents = path.join(appBundle, "Contents");
const appMacOS = path.join(appContents, "MacOS");
const appResources = path.join(appContents, "Resources");
const infoPlist = path.join(appContents, "Info.plist");
const iconSource = path.join(desktopRoot, "app", "public", "logo-milagre-image.png");
const iconset = path.join(runtimeRoot, "Milagre.iconset");
const iconFile = path.join(appResources, "Milagre.icns");
const appExecutable = path.join(appMacOS, "Electron");

function run(command, args) {
  execFileSync(command, args, { stdio: "ignore" });
}

function createMacIcon() {
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    run("sips", ["-z", String(size), String(size), iconSource, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    run("sips", ["-z", String(size * 2), String(size * 2), iconSource, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", iconFile]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

async function prepareMacBundle() {
  const needsCopy = !fs.existsSync(appExecutable);
  if (needsCopy) {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
    await fsp.mkdir(runtimeRoot, { recursive: true });
    run("cp", ["-R", sourceApp, appBundle]);
  }

  await fsp.copyFile(iconSource, path.join(appResources, "Milagre.png"));
  run("plutil", ["-replace", "CFBundleDisplayName", "-string", "Milagre", infoPlist]);
  run("plutil", ["-replace", "CFBundleName", "-string", "Milagre", infoPlist]);
  run("plutil", ["-replace", "CFBundleExecutable", "-string", "Electron", infoPlist]);
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", "com.milagre.app", infoPlist]);
  run("plutil", ["-replace", "CFBundleIconFile", "-string", "Milagre.icns", infoPlist]);
  createMacIcon();
  // Renaming the bundle breaks Electron's ad-hoc signature, and macOS drops notifications
  // from an app whose signature doesn't verify, so sign it again when it changed.
  try {
    run("codesign", ["--verify", "--deep", appBundle]);
  } catch {
    run("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
  }
}

async function main() {
  if (process.platform === "darwin") await prepareMacBundle();

  const executable = process.platform === "darwin" ? appExecutable : electronBinary;
  const { args, env } = launchOptions(process.argv.slice(2), process.env);
  const child = spawn(executable, [desktopRoot, ...args], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

main().catch((error) => {
  console.error(`Could not launch Milagre: ${error.message}`);
  process.exitCode = 1;
});

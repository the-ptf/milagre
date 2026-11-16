const { spawn } = require("node:child_process");
const path = require("node:path");
const { once } = require("node:events");
async function check(app, platform) {
  const executable = path.join(app, "Contents/MacOS/Milagre");
  const helper = path.join(app, "Contents/Resources/app.asar.unpacked/node_modules/expo-device-hub/dist/server/cli.mjs");
  const child = spawn(executable, [helper, "--host", "127.0.0.1", "--port", "0", "--require-token", "--platform", platform, "--transport", "webrtc"], {
    cwd: app,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  try {
    await new Promise((resolve, reject) => {
      let output = "",
        finished = false;
      const timeout = setTimeout(() => finish(Error("Packaged simulator helper startup timed out.")), 20000);
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", finish);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onData = (chunk) => {
        output = (output + chunk).slice(-32768);
        if (/http:\/\/(?:localhost|127\.0\.0\.1):\d+\/\?token=[A-Za-z0-9_-]+\s/.test(output)) finish();
      };
      const onExit = (code) =>
        finish(Error(`Packaged ${platform} helper exited ${code}. ${/Cannot find package '[^']+'/.exec(stderr)?.[0] ?? "Check its packaged dependencies."}`));
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", finish);
    });
    console.log(`PASS: packaged ${platform} simulator helper starts with its bundled dependencies`);
  } finally {
    child.stdout.resume();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const kill = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
      await exited;
      clearTimeout(kill);
    }
  }
}
(async () => {
  if (process.platform !== "darwin") throw Error("Run this check on macOS.");
  const app = path.resolve(process.argv[2]);
  for (const platform of ["ios", "android"]) await check(app, platform);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

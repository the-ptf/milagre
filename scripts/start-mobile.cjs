const path = require("node:path");
const { spawn } = require("node:child_process");

function startMetro(env = process.env, args = []) {
  const cwd = path.resolve(__dirname, "../apps/mobile");
  const expo = path.dirname(require.resolve("expo/package.json", { paths: [cwd] }));
  // Expo advertises 127.0.0.1 for --localhost. On macOS, Node otherwise binds
  return spawn(process.execPath, ["--dns-result-order=ipv4first", path.join(expo, "bin/cli"), "start", "--localhost", "--port", "8790", ...args], {
    cwd,
    stdio: "inherit",
    env,
  });
}
if (require.main === module) {
  const metro = startMetro(process.env, process.argv.slice(2));
  process.once("SIGINT", () => metro.kill("SIGINT"));
  process.once("SIGTERM", () => metro.kill("SIGTERM"));
  metro.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  metro.once("exit", (code) => {
    process.exitCode = code || 0;
  });
}
module.exports = { startMetro };

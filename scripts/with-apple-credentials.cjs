const { spawnSync } = require("node:child_process");
const env = { ...process.env };
for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
  if (env[name] !== undefined) env[name] = env[name].trim();
}
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("A command is required.");
  process.exit(1);
}
const result = spawnSync(command, args, { env, stdio: "inherit" });
if (result.error) console.error("Could not start the release command: " + result.error.code);
process.exit(result.status ?? 1);

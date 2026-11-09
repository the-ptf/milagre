// Isolated host + existing mobile development client. No provider account, native build or public tunnel.
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startDemo } = require("./mobile-demo.cjs");
const { startMetro } = require("./start-mobile.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
async function main() {
  const demo = await startDemo({ port: Number(process.env.MILAGRE_MOBILE_PORT || 8789) });
  const client = await connect({ dataDir: demo.dataDir });
  const project = await client.call("project:snapshot", [demo.project]);
  const chat = Object.values(project.state.sessions)[0],
    chatId = `${demo.project}#${chat.id}`;
  await fs.mkdir(path.join(demo.project, "src"));
  await fs.writeFile(path.join(demo.project, "src/login.ts"), 'export const redirect = "/account";\n');
  await fs.writeFile(path.join(demo.project, ".env"), "DEMO_ONLY=excluded\n");
  await client.call("chat:patch", [demo.project, chat.id, { title: "Restore a task checkpoint" }]);
  await client.call("chat:send", [
    { projectPath: demo.project, sessionId: chat.id, body: "Update the login redirect", provider: "codex", model: "demo", permissionMode: "ask" },
  ]);
  let items;
  for (let i = 0; i < 100; i++) {
    items = await client.call("checkpoint:list", [{ chatId }]);
    if (items.length) break;
    await delay(30);
  }
  if (!items?.length) throw new Error("No task checkpoint captured");
  await fs.writeFile(path.join(demo.project, "src/login.ts"), 'export const redirect = "/home";\n');
  for (let i = 0; i < 100; i++) {
    items = await client.call("checkpoint:list", [{ chatId }]);
    if (items[0].completedAt) break;
    await delay(30);
  }
  if (!items[0].completedAt) throw new Error("Task did not finish");
  await fs.writeFile(path.join(demo.project, "src/login.ts"), 'export const redirect = "/my-manual-edit";\n');
  const connection = path.join(demo.root, "connection.json");
  console.log(`Checkpoint fixture: ${connection}\nMetro port: ${process.env.MILAGRE_METRO_PORT || 8892}`);
  const metro = startMetro({ ...process.env, EXPO_PUBLIC_DAEMON_URL: demo.url, EXPO_PUBLIC_DAEMON_TOKEN: demo.token, EXPO_PUBLIC_DEMO: "1" }, [
    "--port",
    process.env.MILAGRE_METRO_PORT || "8892",
  ]);
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      metro.kill("SIGTERM");
      client.close();
      await demo.close();
    })());
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  metro.once("exit", () => void stop());
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

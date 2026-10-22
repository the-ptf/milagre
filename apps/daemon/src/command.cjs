#!/usr/bin/env node
const os = require("node:os");
const path = require("node:path");
const { parseCommandArgs } = require("./command-args.cjs");
const { setTimeout: delay } = require("node:timers/promises");
const metadata = require("../package.json");
const version = metadata.cliVersion ?? metadata.version;
const { COMMANDS, renderHelp } = require("./command-help.cjs");

async function printPairing(client, { output = process.stdout, qr = output.isTTY, timeoutMs = 20000 } = {}) {
  await client.call("phone:set-enabled", [true]);
  await client.call("phone:open-pairing");
  const until = Date.now() + timeoutMs;
  let status;
  for (;;) {
    status = await client.call("phone:status");
    if (status.state === "on" && status.computerLink) break;
    if (status.state === "error") throw new Error(status.error || "Remote access could not start");
    if (Date.now() >= until) throw new Error("Remote access is still starting. Run milagre pair to try again.");
    await delay(100);
  }
  output.write(`\nPairing link for another desktop:\n${status.computerLink}\n`);
  if (status.pairingLink !== status.computerLink) output.write(`\nPhone pairing link:\n${status.pairingLink}\n`);
  if (qr) output.write(await require("qrcode").toString(status.pairingLink, { type: "terminal", small: true }));
  output.write(`\nPairing closes at ${new Date(status.pairingUntil).toISOString()}. Keep these links private.\n`);
  output.write("On desktop, use Settings > Devices > Add computer and paste the link.\nApprove it here with: milagre devices allow KEY\n");
  output.write("Use the same MILAGRE_DATA_DIR or --data-dir for every command.\n");
  return status;
}

async function main(args = process.argv.slice(2)) {
  const { values, positionals, flags } = parseCommandArgs(args);
  if (!positionals.length && flags.length) throw new Error(`Unknown flag: --${flags[0][0]}`);
  if (values.version) return process.stdout.write(`${version}\n`);
  if (values.help || !positionals.length || positionals[0] === "help") {
    const topics = positionals[0] === "help" ? positionals.slice(1) : positionals;
    const topic = topics[0];
    if (topic && (topics.length > 1 || !Object.hasOwn(COMMANDS, topic))) {
      const profile = values["data-dir"] ?? process.env.MILAGRE_DATA_DIR ?? path.join(os.homedir(), ".milagre", "server");
      if (!path.isAbsolute(profile)) throw new Error(`Unknown command or invalid profile: ${topic}. --data-dir must be absolute.`);
      if (!values.chat) {
        const result = await require("./product-commands.cjs").productHelp(null, topics, values);
        return process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n");
      }
      const client = await require("./client.cjs").connect({ dataDir: profile });
      try {
        const result = await require("./product-commands.cjs").productHelp(client, topics, values);
        return process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n");
      } finally {
        client.close();
      }
    }
    return process.stdout.write(renderHelp(topic, { color: Boolean(process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb") }));
  }
  const [command, action, argument] = positionals;
  if (command === "mcp" && action === "serve" && values.stdio && positionals.length === 2) {
    require("@milagre/core/local-mcp-stdio").serveStdio();
    return;
  }
  if (!Object.hasOwn(COMMANDS, command) && positionals.length === 1 && !values.chat) throw new Error(`Unknown command: ${command}. Use milagre help.`);
  const legacyDeviceAction = ["list", "pending", "allow", "deny", "remove"].includes(action);
  const productCommand =
    !Object.hasOwn(COMMANDS, command) || ["command", "desktop", "mcp", "computers"].includes(command) || (command === "devices" && !legacyDeviceAction);
  if (values.chat && !productCommand && command !== "watch")
    throw new Error("--chat selects scoped command or watch operations. Use milagre command run NAME --chat CHAT.");
  if (!productCommand && flags.length) throw new Error(`Unknown flag: --${flags[0][0]}`);
  const dataDir = values["data-dir"] ?? process.env.MILAGRE_DATA_DIR ?? path.join(os.homedir(), ".milagre", "server");
  if (!path.isAbsolute(dataDir)) throw new Error("--data-dir (or MILAGRE_DATA_DIR) must be an absolute path");
  if (command !== "serve" && (values.project || values["no-pair"])) throw new Error("--project and --no-pair are only supported by serve");
  if (!productCommand && !["request", "devices"].includes(command) && positionals.length !== 1) throw new Error(`Unexpected arguments for ${command}`);
  let method,
    callArgs = [];
  if (command === "request") {
    if (!action || positionals.length > 3) throw new Error("Use milagre request METHOD [JSON_ARGS]");
    method = action;
    callArgs = argument ? JSON.parse(argument) : [];
    if (!Array.isArray(callArgs)) throw new Error("JSON_ARGS must be an array");
  } else if (command === "devices" && !productCommand) {
    if (!["list", "pending", "allow", "deny", "remove"].includes(action)) throw new Error("Use milagre devices <list|pending|allow KEY|deny KEY|remove KEY>");
    const needsKey = ["allow", "deny", "remove"].includes(action);
    if (needsKey && (!argument || !/^[A-Za-z0-9_-]{43}$/.test(argument))) throw new Error("Pass a device key from milagre devices pending or list");
    if (positionals.length !== (needsKey ? 3 : 2)) throw new Error("Unexpected devices arguments");
    method = `devices:${action}`;
    callArgs = needsKey ? [argument] : [];
  } else method = `daemon:${command}`;

  const { connect } = require("./client.cjs");
  if (command === "serve") {
    const { startDaemon } = require("./server.cjs");
    const { KeepAwake } = require("@milagre/core/keep-awake");
    const { createPowerBlocker } = require("./power.cjs");
    const daemon = await startDaemon({
      dataDir,
      version,
      runtimeOptions: { cwd: process.cwd(), keepAwake: new KeepAwake({ powerSaveBlocker: createPowerBlocker() }) },
    });
    let client;
    let closing;
    const stop = () =>
      (closing ??= (async () => {
        client?.close();
        await daemon.close();
      })());
    const onSignal = () =>
      void stop().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      client = await connect({ dataDir });
      client.on("event", ({ channel, payload }) => {
        if (channel === "devices:pending")
          for (const device of payload.requests) {
            console.log(
              `Computer ${JSON.stringify(device.name || "Unnamed computer")} is waiting. Approve: milagre devices allow ${device.key} (use this profile)`,
            );
          }
      });
      for (const project of values.project ?? []) await client.call("project:open", [path.resolve(project)]);
      console.log(`Milagre is running (PID ${process.pid}).\nProfile: ${dataDir}`);
      if (!values["no-pair"]) {
        try {
          await printPairing(client, { qr: process.stdout.isTTY && !values["no-qr"] });
        } catch (error) {
          if (!closing) console.error(`Pairing: ${error.message}\nThe server is still running. Use milagre pair to retry.`);
        }
      }
    } catch (error) {
      await stop();
      throw error;
    }
    return;
  }
  const client = await connect({ dataDir });
  if (command === "computers" && action === "add" && !values.json)
    client.on("event", ({ channel }) => {
      if (channel === "computers:pending") process.stderr.write("Waiting for the other computer's owner to approve this connection.\n");
    });
  try {
    if (command === "session") await require("./command-session.cjs").session(client);
    else if (command === "watch") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        await require("./command-watch.cjs").watch(client, { chat: values.chat, channels: values.channel, signal: controller.signal });
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    } else if (productCommand)
      console.log(JSON.stringify(await require("./product-commands.cjs").runProductCommand(client, positionals, { ...values, flags }), null, 2));
    else if (command === "pair") await printPairing(client, { qr: process.stdout.isTTY && !values["no-qr"] });
    else console.log(JSON.stringify(await client.call(method, callArgs), null, 2));
  } finally {
    client.close();
  }
}

module.exports = { main, printPairing };
if (require.main === module)
  main().catch((error) => {
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: { code: error.code ?? "COMMAND_FAILED", message: error.message } }));
    else console.error(error.message);
    process.exitCode = 1;
  });

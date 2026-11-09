#!/usr/bin/env node
const path = require("node:path");
const { parseArgs } = require("node:util");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { version } = require("../package.json");
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { startMobileBridge } = require("./mobile-bridge.cjs");
const { KeepAwake } = require("@milagre/core/keep-awake");
const { createPowerBlocker } = require("./power.cjs");

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      "connection-file": { type: "string" },
      "app-version": { type: "string" },
      cwd: { type: "string" },
      "worktree-root": { type: "string" },
      "chats-home": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "milagre daemon <serve|status|stop|request METHOD [JSON_ARGS]> --data-dir /absolute/path\nmilagre daemon bridge --data-dir /absolute/path --connection-file /absolute/new-file.json [--port 8787]\n\nLocal macOS/Linux/Windows daemon. Use a separate profile and close these Projects in older desktop releases.",
    );
    return;
  }
  const command = positionals[0];
  if (!["serve", "status", "stop", "request", "bridge"].includes(command))
    throw new Error("Choose serve, status, stop, request or bridge. Use --help for usage.");
  if (!values["data-dir"] || !path.isAbsolute(values["data-dir"])) throw new Error("Pass an absolute --data-dir");
  const dataDir = values["data-dir"];
  if (command === "bridge") {
    const file = values["connection-file"];
    if (!file || !path.isAbsolute(file)) throw new Error("Pass an absolute --connection-file that does not exist yet");
    if (positionals.length !== 1) throw new Error("Unexpected bridge arguments");
    const token = randomBytes(32).toString("hex");
    const bridge = await startMobileBridge({ dataDir, port: values.port === undefined ? 8787 : Number(values.port), token });
    try {
      await fs.writeFile(file, JSON.stringify({ url: bridge.url, token }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      await bridge.close();
      throw error;
    }
    console.log(JSON.stringify({ status: "ready", url: bridge.url, connectionFile: file }));
    const stop = () => {
      void bridge.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "serve") {
    if (positionals.length !== 1) throw new Error("Unexpected serve arguments");
    const daemon = await startDaemon({
      dataDir,
      version: values["app-version"] || version,
      runtimeOptions: {
        cwd: values.cwd || process.cwd(),
        worktreeRoot: values["worktree-root"],
        chatsHome: values["chats-home"],
        keepAwake: new KeepAwake({ powerSaveBlocker: createPowerBlocker() }),
      },
    });
    console.log(JSON.stringify({ status: "ready", pid: process.pid, dataDir, socketPath: daemon.socketPath }));
    const stop = () => {
      void daemon.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  const method = command === "request" ? positionals[1] : `daemon:${command}`;
  if (!method) throw new Error("Pass a method after request");
  if (positionals.length > (command === "request" ? 3 : 1)) throw new Error("Unexpected command arguments");
  const args = positionals[2] ? JSON.parse(positionals[2]) : [];
  if (!Array.isArray(args)) throw new Error("JSON_ARGS must be an array");
  const client = await connect({ dataDir });
  try {
    console.log(JSON.stringify(await client.call(method, args), null, 2));
  } finally {
    client.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

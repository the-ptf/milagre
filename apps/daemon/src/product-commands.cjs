const { contractFor, argumentsFor, inputForFlags, fieldsOf, resolve, flagName } = require("@milagre/core/command-input");
const fs = require("node:fs/promises");
const MAX_INPUT = 16 * 1024 * 1024;

async function readInput(value) {
  if (value === undefined) return undefined;
  let text = value;
  if (value === "-") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT) throw new Error("Input exceeds 16 MiB");
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else if (value.startsWith("@")) {
    const file = await fs.open(value.slice(1));
    try {
      if ((await file.stat()).size > MAX_INPUT) throw new Error("Input exceeds 16 MiB");
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
  if (Buffer.byteLength(text) > MAX_INPUT) throw new Error("Input exceeds 16 MiB");
  return JSON.parse(text);
}

async function catalogue(client) {
  const status = await client.call("daemon:status", [{ commands: true }]);
  const definitions = new Map((status.commandDefinitions ?? []).map((definition) => [definition.name, definition]));
  return [
    ...status.methods.map((name) => ({
      name,
      command: name.replaceAll(":", " "),
      transport: "daemon",
      ...(!definitions.has(name) ? contractFor(name) : {}),
      ...definitions.get(name),
    })),
    ...(status.desktopCommands ?? []),
  ];
}

async function runProductCommand(client, positionals, values) {
  const [family, action, name] = positionals;
  const flags = values.flags ?? [];
  if (flags.length && values.input !== undefined) throw new Error("Use named flags or --input, not both");
  const scopedInput = async (toolName) => {
    if (!flags.length) return readInput(values.input);
    const definition = await client.call("command:describe", [{ chatId: values.chat, name: toolName }]);
    return inputForFlags(definition.inputSchema, flags);
  };
  if (values.chat && family !== "command") {
    const result = await client.call("command:run", [{ chatId: values.chat, name: positionals.join("_"), input: await scopedInput(positionals.join("_")) }]);
    if (result.isError) throw Object.assign(new Error(result.text), { code: "COMMAND_FAILED" });
    return result;
  }
  if (family === "computers") {
    let args = await readInput(values.input);
    const computerFlags = flags.filter(([name]) => name !== "name");
    if (flags.some(([name]) => name === "name")) values.name = flags.find(([name]) => name === "name")[1];
    if (computerFlags.length || (flags.length && action !== "add")) {
      if (positionals.length !== 2) throw new Error("Use positional computer aliases or named flags, not both");
      const namedFlags =
        action === "add" ? flags.map(([name, value]) => (name === "name" ? ["options", JSON.stringify({ name: value })] : [name, value])) : flags;
      args = argumentsFor(contractFor(`computers:${action}`), inputForFlags(contractFor(`computers:${action}`).inputSchema, namedFlags));
    }
    let method = `computers:${action}`;
    if (args === undefined) {
      const rest = positionals.slice(2);
      const counts = { list: 0, "vault-status": 0, enable: 0, disable: 0, "cancel-add": 0, "setup-key": 1, add: 1, preview: 1, rename: 2, remove: 1 };
      if (Object.hasOwn(counts, action)) {
        if (rest.length !== counts[action]) throw new Error(`Unexpected arguments for computers ${action}. Use milagre help computers.`);
        if (action === "enable" || action === "disable") {
          method = "computers:set-enabled";
          args = [action === "enable"];
        } else if (action === "setup-key") args = [{ file: rest[0] }];
        else if (action === "add") args = [rest[0], ...(values.name ? [{ name: values.name }] : [])];
        else args = rest;
      }
    }
    const result = await client.call(method, argumentsFor(contractFor(method), args));
    if (result?.ok === false)
      throw Object.assign(new Error(result.message ?? result.error?.message ?? "Computer command failed"), {
        code: result.code ?? result.error?.code ?? "COMMAND_FAILED",
      });
    return result;
  }
  if (family === "command") {
    if (!["list", "describe", "run"].includes(action)) throw new Error("Use milagre command <list|describe NAME|run NAME> [--chat CHAT]");
    if (positionals.length !== (action === "list" ? 2 : 3)) throw new Error("Unexpected command arguments");
    if (flags.length && action !== "run") throw new Error(`Unknown flag: --${flags[0][0]}`);
    if (values.chat) {
      const result = await client.call(`command:${action}`, [{ chatId: values.chat, name, input: await scopedInput(name) }]);
      if (action === "run" && result.isError) throw Object.assign(new Error(result.text), { code: "COMMAND_FAILED" });
      return result;
    }
    if (action === "run") throw new Error("Scoped commands require --chat CHAT. Owner operations use milagre <family> <action> --input JSON.");
    if (flags.length) throw new Error(`Unknown flag: --${flags[0][0]}`);
    const commands = await catalogue(client);
    if (action === "list") return commands;
    const found = commands.find((item) => item.name === name);
    if (!found) throw new Error(`Unknown command: ${name}`);
    return found;
  }
  const parts = [...positionals];
  let input = await readInput(values.input);
  if (input === undefined && parts.length && ["[", "{"].includes(parts.at(-1)[0])) input = JSON.parse(parts.pop());
  const method = parts.join(":");
  if (flags.length && input !== undefined) throw new Error("Use named flags or JSON input, not both");
  const commands = await catalogue(client);
  const definition = commands.find((item) => item.name === method);
  if (!definition) throw new Error(`Unknown command: ${parts.join(" ")}. Use milagre command list.`);
  const contract = definition;
  const args = argumentsFor(contract, flags.length ? inputForFlags(definition.inputSchema, flags) : input);
  if (family === "desktop") return client.call("desktop:invoke", [{ method: parts.slice(1).join(":"), args }]);
  return client.call(method, args);
}

function offlineCatalogue() {
  const { native } = require("@milagre/core/command-input").contractInventory;
  return [
    ...require("@milagre/core/command-input")
      .ownerCommands.filter((name) => !native.includes(name) || ["project:open", "app:version"].includes(name))
      .map((name) => ({ name, command: name.replaceAll(":", " "), ...contractFor(name) })),
    ...native.map((name) => ({
      name: `desktop:${name}`,
      command: `desktop ${name.replaceAll(":", " ")}`,
      requires: ["desktop"],
      ...contractFor(name, { desktop: true }),
    })),
  ];
}
function schemaHelp(definition) {
  const schema = definition.inputSchema;
  const fields = fieldsOf(schema);
  const typeOf = (field) => {
    field = resolve(field, schema);
    if (field.enum) return field.enum.map((v) => JSON.stringify(v)).join("|");
    if (Object.hasOwn(field, "const")) return JSON.stringify(field.const);
    if (field.anyOf) return field.anyOf.map(typeOf).join("|");
    return field.type ?? "JSON";
  };
  return `USAGE\n  milagre ${definition.command ?? definition.name.replaceAll("_", " ")} [flags]\n${definition.requires ? `\nREQUIRES\n  ${definition.requires.join(", ")}${definition.available === false ? " (disconnected)" : ""}\n` : ""}\nFLAGS\n${
    Object.entries(fields)
      .map(
        ([name, field]) =>
          `  --${flagName(name)} ${typeOf(field)}${schema.required?.includes(name) ? " (required)" : ""}${field.description ? `  ${field.description}` : ""}`,
      )
      .join("\n") || "  No command flags."
  }\n\n  --input JSON|@file|-  Supply the complete input as JSON.\n`;
}
async function productHelp(client, parts, values) {
  if (values.chat) {
    const definition = await client.call("command:describe", [{ chatId: values.chat, name: parts.join("_") }]);
    return values.json ? definition : schemaHelp(definition);
  }
  const prefix = parts.join(":");
  const matches = (client ? await catalogue(client) : offlineCatalogue()).filter((item) => item.name === prefix || item.name.startsWith(`${prefix}:`));
  if (!matches.length) throw new Error(`Unknown command: ${parts.join(" ")}. Use milagre command list.`);
  if (values.json) return matches;
  if (matches.length === 1 && matches[0].name === prefix) return schemaHelp(matches[0]);
  return `USAGE\n  milagre ${parts.join(" ")} <command> [flags]\n\nCOMMANDS\n${matches.map((item) => `  milagre ${item.command}`).join("\n")}\n\nUse milagre help <family> <command> for named flags and input types.\n`;
}

module.exports = { readInput, runProductCommand, productHelp, catalogue, schemaHelp, offlineCatalogue };

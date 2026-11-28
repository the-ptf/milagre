#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const USAGE = `Usage:
  milagre-secrets run --with NAME[,NAME...] -- <command> [args...]
  milagre-secrets list

run gives the named secrets to that one command as environment variables (a file secret's variable holds the path of
a temporary copy) and records the use. The values never appear in this command's own output.
list shows the secrets this Chat may use, without their values.`;

function parse(argv) {
  const [action, ...rest] = argv;
  if (action === "list") return { action };
  if (action !== "run") return { action: "help" };
  const names = [];
  let index = 0;
  for (; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "--with" || arg === "-w") names.push(...String(rest[++index] ?? "").split(","));
    else if (arg.startsWith("--with=")) names.push(...arg.slice(7).split(","));
    else break;
  }
  const command = rest.slice(index);
  return { action, names: [...new Set(names.map((name) => name.trim()).filter(Boolean))], command };
}

async function call(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({ error: `Milagre answered ${response.status}.` }));
  if (!response.ok || result.error) throw new Error(result.error ?? `Milagre answered ${response.status}.`);
  return result;
}

function materialize(secrets) {
  let folder = null;
  const env = {};
  for (const secret of secrets) {
    if (secret.kind !== "file") {
      env[secret.name] = secret.value;
      continue;
    }
    folder ??= fs.mkdtempSync(path.join(os.tmpdir(), "milagre-secrets-"));
    fs.chmodSync(folder, 0o700);
    const file = path.join(folder, path.basename(secret.fileName || secret.name));
    fs.writeFileSync(file, secret.value, { mode: 0o600, flag: "wx" });
    env[secret.name] = file;
  }
  return { env, cleanup: () => folder && fs.rmSync(folder, { recursive: true, force: true }) };
}

async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const parsed = parse(argv);
  const url = env.MILAGRE_SECRETS_URL;
  if (parsed.action === "help") {
    out.write(`${USAGE}\n`);
    return argv.length && !["-h", "--help", "help"].includes(argv[0]) ? 2 : 0;
  }
  if (!url) {
    err.write("milagre-secrets: run this from an agent in a Milagre Chat (MILAGRE_SECRETS_URL is not set).\n");
    return 2;
  }
  try {
    if (parsed.action === "list") {
      const { locked, secrets } = await call(url, { action: "list" });
      if (locked) out.write("Secrets are locked on this computer.\n");
      else if (!secrets.length) out.write("No secrets for this Chat.\n");
      for (const secret of secrets) out.write(`${secret.name}${secret.kind === "file" ? " (file)" : ""}${secret.note ? `: ${secret.note}` : ""}\n`);
      return 0;
    }
    if (!parsed.names.length || !parsed.command.length) {
      err.write(`${USAGE}\n`);
      return 2;
    }
    const { secrets } = await call(url, { action: "run", names: parsed.names, command: parsed.command.join(" ") });
    const { env: given, cleanup } = materialize(secrets);
    const childEnv = { ...env, ...given };
    delete childEnv.MILAGRE_SECRETS_URL;
    return await new Promise((resolve) => {
      const child = spawn(parsed.command[0], parsed.command.slice(1), { stdio: "inherit", env: childEnv, shell: process.platform === "win32" });
      const forward = (signal) => child.kill(signal);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
      const done = (code) => {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, forward);
        cleanup();
        resolve(code);
      };
      child.on("error", (error) => {
        err.write(`milagre-secrets: ${error.message}\n`);
        done(127);
      });
      child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1)));
    });
  } catch (error) {
    err.write(`milagre-secrets: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then((code) => process.exit(code));

module.exports = { main, parse };

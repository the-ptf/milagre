const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execCommand } = require("./agents/command.cjs");

// Kiro's credits for the month (docs/adr/0007-kiro-over-acp.md). kiro-cli answers its `/usage` command without a model
// turn, so it costs nothing: "Estimated Usage | resets on 2026-11-01 | KIRO POWER", then "Credits (452.97 of 10000
// covered in plan), 4.5%". It takes a few seconds and leaves a session record behind, so it runs in a folder of its
// own whose records are removed afterwards, at most once every few minutes, and never holds up the other providers.

const WINDOW = { id: "kiro:month", label: "Kiro credits", shortLabel: "mo" };
const READ_TIMEOUT_MS = 30_000;
const FRESH_MS = 5 * 60_000;
// How long a usage read waits for a first answer before it shows the others without Kiro.
const FIRST_WAIT_MS = 3_000;

const number = (text) => Number(String(text).replace(/,/g, ""));
const plain = (value) => Number(value.toFixed(2)).toLocaleString("en-US");

/** The month's window from `/usage`'s text, with "453 of 10,000 credits" as its detail; null when it can't be read. */
function parseKiroUsage(text) {
  const output = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, ""); // oxlint-disable-line no-control-regex -- strips colours
  const credits = /Credits\s*\(\s*([\d.,]+)\s+of\s+([\d.,]+)[^)]*\)\s*,?\s*([\d.]+)\s*%/i.exec(output);
  if (!credits) return null;
  const used = number(credits[1]);
  const total = number(credits[2]);
  const percent = total > 0 ? (used / total) * 100 : number(credits[3]);
  const reset = /resets on (\d{4}-\d{2}-\d{2})/i.exec(output)?.[1];
  const plan = /Estimated Usage[^|\n]*\|[^|\n]*\|\s*([^\n]+)/i.exec(output)?.[1]?.trim();
  return {
    window: {
      ...WINDOW,
      usedPercent: Math.min(100, Math.max(0, percent)),
      resetsAt: reset ? new Date(`${reset}T00:00:00Z`).toISOString() : null,
      detail: `${plain(used)} of ${plain(total)} credits`,
    },
    ...(plan ? { plan } : {}),
  };
}

// Kiro records every chat, `/usage` included, under ~/.kiro/sessions/cli as <id>.json (with its cwd) and <id>.jsonl.
async function removeSessionsIn(folder, home = os.homedir()) {
  const dir = path.join(home, ".kiro", "sessions", "cli");
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = path.join(dir, name);
        const record = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"));
        if (record?.cwd !== folder) return;
        await fs.rm(file, { force: true });
        await fs.rm(file.replace(/\.json$/, ".jsonl"), { force: true });
      }),
  );
}

/** Runs `kiro-cli chat --no-interactive /usage` in a throwaway folder: { output } or { error }. */
async function askUsage({ command, env, execImpl = execCommand, home }) {
  const folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-kiro-usage-")));
  try {
    return await new Promise((resolve) => {
      execImpl(command, ["chat", "--no-interactive", "/usage"], { cwd: folder, env, encoding: "utf8", timeout: READ_TIMEOUT_MS }, (error, stdout, stderr) =>
        resolve(error && !stdout ? { error: String(stderr || error.message) } : { output: String(stdout) }),
      );
    });
  } finally {
    await removeSessionsIn(folder, home).catch(() => {});
    await fs.rm(folder, { recursive: true, force: true });
  }
}

/**
 * A usage reader for Kiro: `read()` answers the last numbers at once and reads again in the background when they are
 * a few minutes old. Before the first answer it waits briefly, then says the numbers are on their way.
 */
function createKiroUsage({ cli, now = Date.now, ask = askUsage, firstWaitMs = FIRST_WAIT_MS, freshMs = FRESH_MS } = {}) {
  let last = null;
  let pending = null;
  const result = (status, windows, message, extra = {}) => ({
    provider: "kiro",
    status,
    windows,
    updatedAt: new Date(now()).toISOString(),
    ...(message ? { message } : {}),
    ...extra,
  });
  const refresh = () => {
    pending ??= Promise.resolve()
      .then(() => cli())
      .then(async (status) => {
        if (!status?.command || status.problem) return result("unavailable", [], "Kiro CLI isn't installed.");
        const answer = await ask({ command: status.command, env: status.env });
        if (/not logged in/i.test(answer.output ?? answer.error ?? "")) return result("unavailable", [], "Kiro CLI isn't signed in.");
        const parsed = parseKiroUsage(answer.output);
        return parsed ? result("ok", [parsed.window]) : result("error", [], "Kiro didn't say how many credits are left.");
      })
      .catch(() => result("error", [], "Couldn't read Kiro's credits."))
      .then((value) => {
        last = { value, at: now() };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async function readKiroUsage() {
    if (last && now() - last.at < freshMs) return last.value;
    const next = refresh();
    if (last) return last.value;
    const waited = await Promise.race([next, new Promise((resolve) => setTimeout(resolve, firstWaitMs, null))]);
    return waited ?? result("unavailable", [], "Reading Kiro's credits…");
  };
}

module.exports = { createKiroUsage, parseKiroUsage, removeSessionsIn };

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { z } = require("zod");
const { assertPrivate, windowsAcl } = require("./private-files.cjs");
const { SECRET_LIMITS, secretNameProblem, secretHint, secretReaches } = require("@milagre/shared/secrets");

const AAD = Buffer.from("milagre:secrets-vault:v1");
const LOG_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const origin = z.string().min(3).max(300);
const recordSchema = z.strictObject({
  kind: z.enum(["text", "file", "login"]),
  login: z.strictObject({ origin: z.string().min(8).max(300), username: z.string().max(500) }).optional(),
  value: z.string(),
  fileName: z.string().max(SECRET_LIMITS.fileNameChars).nullable(),
  projects: z.union([z.literal("all"), z.array(origin).min(1).max(SECRET_LIMITS.projects)]),
  delivery: z.enum(["on-demand", "ambient"]),
  askEachUse: z.boolean().default(false),
  unattended: z.boolean(),
  note: z.string().max(SECRET_LIMITS.noteChars).nullable(),
  version: z.number().int().positive(),
  changedOn: z.string().max(128),
  updatedAt: z.number(),
  from: z.string().max(128).optional(),
});
const tombstoneSchema = z.strictObject({ version: z.number().int().positive(), changedOn: z.string().max(128), updatedAt: z.number() });
const stateSchema = z.strictObject({ secrets: z.record(z.string(), recordSchema), tombstones: z.record(z.string(), tombstoneSchema) });
const inputSchema = z.strictObject({
  name: z.string(),
  value: z.string().min(1),
  kind: z.enum(["text", "file", "login"]).default("text"),
  login: z.strictObject({ origin: z.string().min(8).max(300), username: z.string().max(500) }).optional(),
  fileName: z.string().min(1).max(SECRET_LIMITS.fileNameChars).nullable().default(null),
  projects: z.union([z.literal("all"), z.array(origin).min(1).max(SECRET_LIMITS.projects)]),
  delivery: z.enum(["on-demand", "ambient"]).default("on-demand"),
  askEachUse: z.boolean().default(false),
  unattended: z.boolean().default(false),
  note: z.string().max(SECRET_LIMITS.noteChars).nullable().default(null),
});

const patchSchema = z.strictObject({
  projects: z.union([z.literal("all"), z.array(origin).min(1).max(SECRET_LIMITS.projects)]).optional(),
  delivery: z.enum(["on-demand", "ambient"]).optional(),
  askEachUse: z.boolean().optional(),
  unattended: z.boolean().optional(),
  note: z.string().max(SECRET_LIMITS.noteChars).nullable().optional(),
});
const executableOf = (executable) => {
  const name = typeof executable === "string" ? path.basename(executable.trim().replaceAll("\\", "/")) : "";
  return name ? name.slice(0, 80) : null;
};
const loginOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
};
const AMBIENT_ASKS = "A secret kept in the environment can't ask before each use: every command already has it.";
const lockedError = () =>
  Object.assign(new Error("Secrets are locked: open Milagre on this computer, or set up a computer key for unattended access."), { code: "secrets-locked" });
const sameRevision = (secret, expected) =>
  expected ? Boolean(secret) && secret.version === expected.version && secret.changedOn === expected.changedOn : !secret;
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const inputError = (message) => Object.assign(new Error(message), { code: "secrets-input" });

function validState(value) {
  const state = stateSchema.parse(value);
  for (const [name, secret] of Object.entries(state.secrets)) {
    if (secretNameProblem(name)) throw new Error(`Saved secret ${name} has an invalid name`);
    if (secret.kind === "file" || secret.askEachUse) secret.delivery = "on-demand";
  }
  return state;
}

async function writePrivateFile(file, text) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") windowsAcl(temporary, { mode: "protect" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** The use log: one JSON line per use, kept 30 days, plus the latest use of each name. */
function createUseLog({ dataDir, logFile, now }) {
  const lastUsed = new Map();
  let logLoaded = false;
  async function readLog() {
    let text = "";
    try {
      assertPrivate(logFile);
      text = await fs.readFile(logFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const cutoff = now() - LOG_DAYS * DAY;
    const entries = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.at === "number" && entry.at >= cutoff && Array.isArray(entry.names)) entries.push(entry);
      } catch {}
    }
    return entries;
  }
  async function loadLastUsed() {
    if (logLoaded) return;
    logLoaded = true;
    for (const entry of await readLog()) for (const name of entry.names) lastUsed.set(name, Math.max(lastUsed.get(name) ?? 0, entry.at));
  }
  let appends = 0;
  async function record(entry) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const handle = await fs.open(logFile, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
    } finally {
      await handle.close();
    }
    await loadLastUsed();
    for (const name of entry.names) lastUsed.set(name, entry.at);
    if (++appends % 200 === 0) await writePrivateFile(logFile, (await readLog()).map((kept) => `${JSON.stringify(kept)}\n`).join(""));
  }
  return { readLog, loadLastUsed, record, lastUsed };
}

/**
 * Named secrets, sealed with the computer vault's master key (`masterKey`, null while locked) in their own file and AAD.
 * Values leave only through `deliver` (for one command or an agent's environment) and `values` (redaction).
 */
function createSecretsVault({ dataDir, masterKey, computerId = () => "local", now = Date.now }) {
  const file = path.join(dataDir, "secrets-vault.json");
  const logFile = path.join(dataDir, "secrets-log.jsonl");
  let state;
  let stateKey;
  let chain = Promise.resolve();
  const serial = (run) => {
    const work = chain.then(run);
    chain = work.catch(() => {});
    return work;
  };
  const listeners = new Set();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };

  async function key() {
    const value = await masterKey();
    if (!value) throw lockedError();
    return value;
  }
  async function read() {
    const master = await key();
    if (state && stateKey === master) return state;
    let saved;
    try {
      assertPrivate(file);
      saved = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { secrets: {}, tombstones: {} };
      stateKey = master;
      return state;
    }
    if (saved.v !== 1) throw new Error("Unsupported secrets vault version");
    try {
      const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(saved.nonce, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(saved.tag, "base64"));
      state = validState(JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.sealed, "base64")), decipher.final()]).toString("utf8")));
    } catch {
      throw Object.assign(new Error("Secrets cannot be decrypted with this computer's key"), { code: "secrets-key" });
    }
    stateKey = master;
    return state;
  }
  async function persist(next) {
    const master = await key();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, nonce);
    cipher.setAAD(AAD);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(validState(next)), "utf8"), cipher.final()]);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      file,
      JSON.stringify({ v: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), sealed: sealed.toString("base64") }),
    );
    state = next;
    stateKey = master;
    changed();
  }

  const { readLog, loadLastUsed, record, lastUsed } = createUseLog({ dataDir, logFile, now });

  const summary = (name, secret) => ({
    name,
    kind: secret.kind,
    ...(secret.login ? { login: secret.login } : {}),
    fileName: secret.fileName,
    hint: secretHint(secret.value),
    projects: secret.projects,
    delivery: secret.delivery,
    askEachUse: secret.askEachUse,
    unattended: secret.unattended,
    note: secret.note,
    version: secret.version,
    changedOn: secret.changedOn,
    updatedAt: secret.updatedAt,
    lastUsedAt: lastUsed.get(name) ?? null,
  });

  const unlocked = async () => Boolean(await masterKey());

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async status() {
      return { unlocked: await unlocked() };
    },
    list: () =>
      serial(async () => {
        const current = await read();
        await loadLastUsed();
        return Object.entries(current.secrets)
          .map(([name, secret]) => summary(name, secret))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
    set: (input, { expect, keepPolicy = false } = {}) =>
      serial(async () => {
        const parsed = inputSchema.safeParse(input);
        if (!parsed.success) throw inputError(parsed.error.issues[0]?.message ?? "Invalid secret");
        const { name, ...fields } = parsed.data;
        const problem = secretNameProblem(name);
        if (problem) throw inputError(problem);
        if (Buffer.byteLength(fields.value, "utf8") > SECRET_LIMITS.valueBytes)
          throw inputError(`A secret holds at most ${SECRET_LIMITS.valueBytes / 1024} KB.`);
        if (fields.kind === "file" && !fields.fileName) throw inputError("A file secret needs a file name.");
        if ((fields.kind === "login") !== Boolean(fields.login)) throw inputError("A login has an origin and a username, and only a login has them.");
        if (fields.kind === "login" && (fields.delivery === "ambient" || !loginOrigin(fields.login.origin)))
          throw inputError("A login's origin is an https address (or http on this computer), and a login is never in the environment.");
        if (fields.kind === "file" && fields.delivery === "ambient") throw inputError("A file secret is given per command, not kept in the environment.");
        if (fields.delivery === "ambient" && fields.askEachUse) throw inputError(AMBIENT_ASKS);
        if (fields.fileName && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fields.fileName))
          throw inputError("A file name uses letters, digits, dots, dashes and underscores.");
        const current = await read();
        const previous = current.secrets[name];
        if (expect !== undefined && !sameRevision(previous, expect)) throw inputError(`${name} changed while the card was open.`);
        if (keepPolicy && previous) Object.assign(fields, pick(previous, ["delivery", "askEachUse", "unattended", "note"]));
        if (!previous && Object.keys(current.secrets).length >= SECRET_LIMITS.count) throw inputError(`At most ${SECRET_LIMITS.count} secrets.`);
        const version = Math.max(previous?.version ?? 0, current.tombstones[name]?.version ?? 0) + 1;
        const secret = { ...fields, fileName: fields.kind === "file" ? fields.fileName : null, version, changedOn: computerId(), updatedAt: now() };
        const tombstones = { ...current.tombstones };
        delete tombstones[name];
        await persist({ secrets: { ...current.secrets, [name]: secret }, tombstones });
        await loadLastUsed();
        return summary(name, secret);
      }),
    update: (name, patch) =>
      serial(async () => {
        const parsed = patchSchema.safeParse(patch);
        if (!parsed.success) throw inputError(parsed.error.issues[0]?.message ?? "Invalid change");
        const current = await read();
        const previous = current.secrets[name];
        if (!previous) throw inputError(`No secret named ${name}.`);
        const next = { ...previous, ...parsed.data, version: previous.version + 1, changedOn: computerId(), updatedAt: now() };
        if (next.kind === "file" && next.delivery === "ambient") throw inputError("A file secret is given per command, not kept in the environment.");
        if (next.delivery === "ambient" && next.askEachUse) throw inputError(AMBIENT_ASKS);
        await persist({ ...current, secrets: { ...current.secrets, [name]: next } });
        await loadLastUsed();
        return summary(name, next);
      }),
    remove: (name) =>
      serial(async () => {
        const current = await read();
        const previous = current.secrets[name];
        if (!previous) return { removed: false };
        const secrets = { ...current.secrets };
        delete secrets[name];
        await persist({ secrets, tombstones: { ...current.tombstones, [name]: { version: previous.version + 1, changedOn: computerId(), updatedAt: now() } } });
        return { removed: true };
      }),
    /** Every value, for redaction only. Empty while locked. */
    values: () =>
      serial(async () => {
        if (!(await unlocked())) return [];
        const current = await read();
        return Object.entries(current.secrets).map(([name, secret]) => ({ name, kind: secret.kind, value: secret.value }));
      }),
    /** Summaries of the secrets a Chat may use. */
    reachable: (target) =>
      serial(async () => {
        if (!(await unlocked())) return { locked: true, secrets: [] };
        const current = await read();
        await loadLastUsed();
        return {
          locked: false,
          secrets: Object.entries(current.secrets)
            .filter(([name, secret]) => secretReaches({ name, ...secret }, target))
            .map(([name, secret]) => summary(name, secret)),
        };
      }),
    /**
     * Values for one use. `names` null means every ambient secret in reach (an agent's environment at start). Refuses
     * the whole request if any named secret is missing or out of reach, so a command never runs half-configured.
     */
    deliver: ({ names, target, chatId, command = null, delivery, record: shouldRecord = true, expect = null }) =>
      serial(async () => {
        const current = await read();
        if (expect && Object.entries(expect).some(([name, revision]) => !sameRevision(current.secrets[name], revision)))
          throw Object.assign(new Error("These secrets changed while waiting for approval. Run the command again."), { code: "secrets-changed" });
        const reach = ([name, secret]) => secretReaches({ name, ...secret }, target);
        let chosen;
        if (names === null) chosen = Object.entries(current.secrets).filter((entry) => entry[1].delivery === "ambient" && reach(entry));
        else {
          const missing = [];
          chosen = [];
          for (const name of names) {
            const secret = current.secrets[name];
            if (!secret || !reach([name, secret]) || secret.kind === "login") missing.push(name);
            else chosen.push([name, secret]);
          }
          if (missing.length)
            throw Object.assign(
              new Error(
                `Not available to this Chat: ${missing.join(", ")}.${target.unattended ? " Unattended runs only get secrets that allow them." : ""} Ask the person with request_secret.`,
              ),
              { code: "secrets-missing", missing },
            );
        }
        if (chosen.length && shouldRecord)
          await record({
            at: now(),
            names: chosen.map(([name]) => name),
            chatId,
            computer: computerId(),
            command: executableOf(command),
            delivery,
          });
        return chosen.map(([name, secret]) => ({ name, kind: secret.kind, fileName: secret.fileName, value: secret.value }));
      }),
    /** A login's origin, username and password for the browser to type, if this Chat may use it; the use is logged. */
    login: ({ name, target, chatId }) =>
      serial(async () => {
        const secret = (await read()).secrets[name];
        if (!secret || secret.kind !== "login" || !secretReaches({ name, ...secret }, target))
          throw Object.assign(new Error(`No login named ${name} for this Chat. secrets_list shows the logins it may use.`), { code: "secrets-missing" });
        await record({ at: now(), names: [name], chatId, computer: computerId(), command: null, delivery: "browser" });
        return { origin: secret.login.origin, username: secret.login.username, password: secret.value };
      }),
    /** The ambient secrets a turn may hold and their fingerprint, from one read so the two always agree. */
    ambient: ({ target, chatId, record: shouldRecord }) =>
      serial(async () => {
        const current = await read();
        const chosen = Object.entries(current.secrets)
          .filter(([name, secret]) => secret.delivery === "ambient" && secretReaches({ name, ...secret }, target))
          .sort(([a], [b]) => a.localeCompare(b));
        const fingerprint = createHash("sha256")
          .update(chosen.map(([name, secret]) => `${name}:${secret.version}`).join(","))
          .digest("hex")
          .slice(0, 16);
        if (chosen.length && shouldRecord)
          await record({ at: now(), names: chosen.map(([name]) => name), chatId, computer: computerId(), command: null, delivery: "ambient" });
        return { fingerprint, secrets: chosen.map(([name, secret]) => ({ name, value: secret.value })) };
      }),
    /** Read, change and seal the whole state in one step, for sync. `change` gets a copy and returns the next state, or null. */
    transact: (change) =>
      serial(async () => {
        const next = await change(structuredClone(await read()));
        if (next) await persist(next);
        return next;
      }),
    log: (name) =>
      serial(async () => {
        const entries = await readLog();
        return (name ? entries.filter((entry) => entry.names.includes(name)) : entries).toReversed().slice(0, 500);
      }),
  };
}

module.exports = { createSecretsVault, recordSchema, tombstoneSchema };

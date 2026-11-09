const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  KEYBINDING_COMMANDS,
  addNewDefaults,
  defaultKeybindings,
  defaultRulesFor,
  keybindingCommand,
  readRule,
  readRules,
  withCommandRules,
} = require("@milagre/shared/keybindings");

// Keybindings, the T3 Code way: each computer keeps a keybindings.json in its data directory, a JSON array of
// `{ key, command, when? }` rules. Settings › Keybindings (desktop and phone) edits it through these commands, and a hand
// edit counts the same. A sidecar, keybindings.seen.json, lists the commands this file has already seen, so a command
// the user unbound stays unbound while a command a newer Milagre brings gets its defaults once.

const CHANGED = "keybindings:changed";
const WATCH_DELAY_MS = 150;

/**
 * JSON with `//` and `/* *\/` comments and trailing commas, as someone editing by hand writes it. Strings are left alone.
 * @param {string} text
 */
function lenientJson(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      // A closing bracket takes a comma just before it (outside any string) with it.
      if (char === "]" || char === "}") {
        const trimmed = out.trimEnd();
        if (trimmed.endsWith(",")) out = trimmed.slice(0, -1) + out.slice(trimmed.length);
      }
      out += char;
      index++;
    }
  }
  return out;
}

/** One rule per line, so a hand edit and a diff stay readable. */
function format(rules) {
  if (!rules.length) return "[]\n";
  return `[\n${rules.map((rule) => `  ${JSON.stringify(rule)}`).join(",\n")}\n]\n`;
}

/**
 * @param {{ file: string, emit?: (channel: string, payload: unknown) => void, watch?: boolean }} options
 */
function createKeybindings({ file, emit = () => {}, watch = true }) {
  const seenFile = path.join(path.dirname(file), "keybindings.seen.json");
  let last = "";
  let timer = null;
  let watcher = null;
  let closed = false;

  function writeAtomic(target, text) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, target);
  }
  function readSeen() {
    try {
      const value = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }
  const writeSeen = (seen) => writeAtomic(seenFile, `${JSON.stringify(seen)}\n`);
  const allCommands = () => KEYBINDING_COMMANDS.map((command) => command.id);

  /** The file as it stands: missing is seeded, a broken one reads as the defaults and is left alone. */
  function load() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return {
          path: file,
          rules: defaultKeybindings(),
          issues: [`keybindings.json can't be read: ${error.message}. Milagre uses the defaults until it can.`],
          broken: true,
        };
      }
      const rules = defaultKeybindings();
      writeAtomic(file, format(rules));
      writeSeen(allCommands());
      return { path: file, rules, issues: [], broken: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(lenientJson(text));
    } catch (error) {
      return {
        path: file,
        rules: defaultKeybindings(),
        issues: [`keybindings.json isn't valid JSON: ${error.message}. Milagre uses the defaults until it is fixed.`],
        broken: true,
      };
    }
    const read = readRules(parsed);
    // A file that isn't an array is as unusable as bad JSON: keep it, use the defaults.
    if (!Array.isArray(parsed)) return { path: file, rules: defaultKeybindings(), issues: read.issues, broken: true };
    const seen = readSeen();
    const next = addNewDefaults(read.rules, seen);
    if (read.issues.length) {
      // Rewriting would drop the entries Milagre couldn't read: show the new defaults, leave the file for the user.
      return { path: file, rules: next.rules, issues: read.issues, broken: false };
    }
    if (next.added) writeAtomic(file, format(next.rules));
    if (next.added || next.seen.length !== seen.length) writeSeen(next.seen);
    return { path: file, rules: next.rules, issues: [], broken: false };
  }
  const publicState = ({ path: at, rules, issues }) => ({ path: at, rules, issues });
  function publish(state) {
    const view = publicState(state);
    last = JSON.stringify(view);
    emit(CHANGED, view);
    return view;
  }

  function read() {
    const view = publicState(load());
    last = JSON.stringify(view);
    return view;
  }

  function write(rules, { overwriteBroken = false } = {}) {
    const state = load();
    if (state.broken && !overwriteBroken) throw new Error("keybindings.json has errors; fix or reset it first");
    writeAtomic(file, format(rules));
    writeSeen(allCommands());
    return publish({ path: file, rules, issues: [] });
  }

  function checkCommand(command) {
    if (typeof command !== "string" || !keybindingCommand(command)) throw new Error(`Unknown keybinding command ${JSON.stringify(command)}.`);
  }

  function setCommand(command, rules) {
    checkCommand(command);
    if (!Array.isArray(rules)) throw new Error("Keybinding rules must be a list.");
    const checked = rules.map((rule, index) => {
      const result = readRule({ ...(rule && typeof rule === "object" ? rule : {}), command });
      if (!result.rule) throw new Error(`Keybinding ${index + 1} ${result.error}.`);
      return { key: result.rule.key, ...(result.rule.when ? { when: result.rule.when } : {}) };
    });
    // A file with unreadable entries is rewritten from what Milagre could read, so those entries go with this save.
    const state = load();
    if (state.broken) throw new Error("keybindings.json has errors; fix or reset it first");
    return write(withCommandRules(state.rules, command, checked));
  }

  function resetCommand(command) {
    checkCommand(command);
    return setCommand(
      command,
      defaultRulesFor(command).map(({ key }) => ({ key })),
    );
  }

  const resetAll = () => write(defaultKeybindings(), { overwriteBroken: true });

  function onDisk() {
    timer = null;
    if (closed) return;
    try {
      const view = publicState(load());
      if (JSON.stringify(view) !== last) publish(view);
    } catch {
      /* the file is being replaced; the next change reports it */
    }
  }
  function startWatching() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const name = path.basename(file);
      watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, changed) => {
        if (closed || (changed && changed !== name)) return;
        clearTimeout(timer);
        timer = setTimeout(onDisk, WATCH_DELAY_MS);
        timer.unref?.();
      });
      watcher.on("error", () => {});
      watcher.unref?.();
    } catch {
      watcher = null;
    }
  }
  if (watch) startWatching();

  function close() {
    closed = true;
    clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  }

  return { read, setCommand, resetCommand, resetAll, close, file };
}

module.exports = { createKeybindings, lenientJson };

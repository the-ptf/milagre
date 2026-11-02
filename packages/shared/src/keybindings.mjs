// Keybindings, the T3 Code way: each computer keeps a keybindings.json, a JSON array of `{ key, command, when? }` rules
// (core keybindings.cjs), and Settings › Keybindings edits it on one computer or on all of them. The desktop and the
// iPad read the rules of the computer they run on, and the last rule whose key and `when` both match wins.
// Types: keybindings.d.mts.

/** At most this many rules are read from a file; the rest are left out. */
export const MAX_KEYBINDINGS = 256;
const MAX_KEY_LENGTH = 64;
const MAX_WHEN_LENGTH = 256;

/**
 * Every command a key can run, in the order Settings lists them. `mobile` marks the ones the iPad's hardware keyboard
 * offers too; `forward` the ones the desktop catches before any frame gets the key (app-shortcuts.cjs), so they work with
 * focus in a design, an HTML reply or the simulator. Text editing (⌘Z, Enter to send, Escape), ⌘W and ⌘Q stay fixed and are not here.
 */
export const KEYBINDING_COMMANDS = Object.freeze([
  { id: "commandPalette.toggle", title: "Search commands, Chats and Projects", group: "General", defaults: ["mod+k"], mobile: true },
  { id: "chat.new", title: "New Chat", group: "General", defaults: ["mod+n"], mobile: true },
  { id: "project.add", title: "Add Project", group: "General", defaults: ["mod+o"] },
  { id: "settings.open", title: "Open Settings", group: "General", defaults: ["mod+,"], forward: true, mobile: true },
  { id: "theme.toggle", title: "Switch light and dark", group: "General", defaults: ["mod+shift+t"], forward: true },
  { id: "sidebar.toggle", title: "Show or hide the sidebar", group: "Navigation", defaults: ["mod+b"], mobile: true },
  { id: "canvas.open", title: "Open the canvas", group: "Navigation", defaults: ["mod+shift+l"], forward: true },
  { id: "usage.open", title: "Open token usage", group: "Navigation", defaults: ["mod+shift+u"], forward: true },
  { id: "grid.toggle", title: "Show active Chats as a grid", group: "Navigation", defaults: ["mod+shift+m"], forward: true },
  { id: "grid.focusPrevious", title: "Previous Chat in the grid", group: "Navigation", defaults: ["mod+alt+arrowleft"] },
  { id: "grid.focusNext", title: "Next Chat in the grid", group: "Navigation", defaults: ["mod+alt+arrowright"] },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `chat.jump.${index + 1}`,
    title: `Open Chat ${index + 1}`,
    group: "Navigation",
    defaults: [`mod+${index + 1}`],
    mobile: true,
  })),
  { id: "chat.find", title: "Find in Chat", group: "Chat", defaults: ["mod+f"] },
  // Held or pressed per Settings › Chat › Dictation; the iPad's keyboard only reports the press, so there it starts and stops.
  { id: "dictation.toggle", title: "Dictate", group: "Chat", defaults: ["alt+space"], mobile: true },
  { id: "changes.toggle", title: "Show or hide Changes", group: "Panels", defaults: ["mod+shift+d"], forward: true, mobile: true },
  { id: "terminal.toggle", title: "Show or hide Terminals", group: "Panels", defaults: ["mod+j"] },
  { id: "terminal.new", title: "New Terminal", group: "Panels", defaults: ["mod+t"] },
  { id: "artifacts.toggle", title: "Show or hide artifacts", group: "Panels", defaults: ["mod+shift+a"], forward: true },
  { id: "designs.toggle", title: "Show or hide designs", group: "Panels", defaults: ["mod+shift+e"], forward: true },
  { id: "browser.toggle", title: "Show or hide the browser", group: "Panels", defaults: ["mod+shift+b"], forward: true },
  { id: "simulator.toggle", title: "Show or hide the simulator", group: "Panels", defaults: ["mod+shift+s"], forward: true },
]);

const COMMANDS = new Map(KEYBINDING_COMMANDS.map((command) => [command.id, command]));

/** The context keys a `when` can name. Any other name is false. */
export const WHEN_KEYS = Object.freeze({
  terminalFocus: "A Terminal has the keyboard.",
  editableFocus: "A text field, the composer or another editor has the keyboard.",
  composerFocus: "The composer has the keyboard.",
  chatView: "A Chat is on screen (not Settings, the canvas, Routines or Usage).",
  linkOpen: "A Link's workspace is on screen.",
  gridShown: "Active Chats show as a grid.",
  isMac: "Milagre runs on a Mac.",
  isIpad: "Milagre runs on an iPad.",
});

/** The command's catalog entry, or undefined for an unknown id. */
export function keybindingCommand(id) {
  return COMMANDS.get(id);
}

/** The default rules, in catalog order. */
export function defaultKeybindings() {
  return KEYBINDING_COMMANDS.flatMap((command) => command.defaults.map((key) => ({ key, command: command.id })));
}

/** The default rules of one command. */
export function defaultRulesFor(command) {
  return (COMMANDS.get(command)?.defaults ?? []).map((key) => ({ key, command }));
}

// ---- Keys ----------------------------------------------------------------------------------------------------------

const MODIFIER_ALIASES = {
  mod: "mod",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};
const KEY_ALIASES = {
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  esc: "escape",
  return: "enter",
  del: "delete",
  plus: "+",
  comma: ",",
  period: ".",
  " ": "space",
};
const NAMED_KEYS = new Set([
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "enter",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "home",
  "end",
  "pageup",
  "pagedown",
  ...Array.from({ length: 19 }, (_, index) => `f${index + 1}`),
]);
const CODE_KEYS = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "space",
};

/**
 * A key string such as `mod+shift+d` read into its parts, or null when it isn't one: it needs exactly one key that isn't
 * a modifier. `mod` is ⌘ on a Mac and Ctrl elsewhere.
 */
export function parseKey(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text || text.length > MAX_KEY_LENGTH) return null;
  // "mod++" binds the plus key: the last part may be "+" itself.
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const shortcut = { key: "", mod: false, meta: false, ctrl: false, alt: false, shift: false };
  for (const [index, raw] of parts.entries()) {
    const part = raw.trim();
    const modifier = MODIFIER_ALIASES[part];
    if (modifier && index < parts.length - 1) {
      shortcut[modifier] = true;
      continue;
    }
    if (index !== parts.length - 1 || !part) return null;
    const key = KEY_ALIASES[part] ?? part;
    if (key.length !== 1 && !NAMED_KEYS.has(key)) return null;
    shortcut.key = key;
  }
  return shortcut.key ? shortcut : null;
}

/** The key string for parts, in the order `mod+ctrl+alt+shift+key`. */
export function formatKey(shortcut) {
  const parts = [];
  if (shortcut.mod) parts.push("mod");
  if (shortcut.meta) parts.push("cmd");
  if (shortcut.ctrl) parts.push("ctrl");
  if (shortcut.alt) parts.push("alt");
  if (shortcut.shift) parts.push("shift");
  parts.push(shortcut.key);
  return parts.join("+");
}

/** The same key string every way it can be written (`cmd+K` and `mod+k` on a Mac), for comparing two rules. */
export function canonicalKey(value, mac) {
  const shortcut = parseKey(value);
  if (!shortcut) return null;
  const meta = shortcut.meta || (mac && shortcut.mod);
  const ctrl = shortcut.ctrl || (!mac && shortcut.mod);
  return formatKey({ key: shortcut.key, mod: false, meta, ctrl, alt: shortcut.alt, shift: shortcut.shift });
}

/**
 * The key a keyboard event pressed, in key-string form. Letters and digits come from `key`, so they follow the keyboard
 * layout; with ⌥ or ⇧ held the Mac types another character, so punctuation and those come from the physical `code`.
 */
export function eventKey(event) {
  const key = String(event.key ?? "");
  const lower = key.toLowerCase();
  if (/^[a-z0-9]$/.test(lower)) return lower;
  const code = String(event.code ?? "");
  const letter = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (key === " ") return "space";
  if (NAMED_KEYS.has(lower)) return lower;
  return key.length === 1 ? lower : null;
}

/** Whether a keyboard event is a modifier on its own (nothing to bind yet). */
export function isModifierEvent(event) {
  return ["Meta", "Control", "Alt", "Shift", "OS", "Hyper", "Super", "CapsLock", "Fn"].includes(String(event.key));
}

/** The key string a keyboard event pressed, `mod` standing for ⌘ on a Mac and Ctrl elsewhere; null for a lone modifier. */
export function keyFromEvent(event, mac) {
  if (isModifierEvent(event)) return null;
  const key = eventKey(event);
  if (!key) return null;
  return formatKey({
    key,
    mod: mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey),
    meta: mac ? false : Boolean(event.metaKey),
    ctrl: mac ? Boolean(event.ctrlKey) : false,
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
  });
}

/**
 * Whether a keyboard event presses the shortcut, with exactly its modifiers. `either` lets `mod` be ⌘ or Ctrl on any
 * platform, as the window's shortcuts always took them; an explicit `cmd` or `ctrl` still needs that key.
 */
export function eventMatches(event, shortcut, mac, either = false) {
  if (eventKey(event) !== shortcut.key) return false;
  if (Boolean(event.altKey) !== shortcut.alt || Boolean(event.shiftKey) !== shortcut.shift) return false;
  if (either && shortcut.mod && !shortcut.meta && !shortcut.ctrl) return Boolean(event.metaKey) !== Boolean(event.ctrlKey);
  const meta = shortcut.meta || (mac && shortcut.mod);
  const ctrl = shortcut.ctrl || (!mac && shortcut.mod);
  return Boolean(event.metaKey) === meta && Boolean(event.ctrlKey) === ctrl;
}

/** Whether a key string has ⌘, Ctrl or ⌥, or is a function key: a bare letter would fire while typing. */
export function hasCommandModifier(value) {
  const shortcut = parseKey(value);
  if (!shortcut) return false;
  return shortcut.mod || shortcut.meta || shortcut.ctrl || shortcut.alt || /^f[0-9]+$/.test(shortcut.key);
}

const KEY_GLYPHS = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "↵",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function keyLabel(key) {
  return KEY_GLYPHS[key] ?? key.toUpperCase();
}

/**
 * How a key string reads, the way the app's hints draw it: `⌘⇧D` on a Mac (⌘⌃⌥⇧ order, as the app always drew them), `Ctrl+Shift+D` elsewhere.
 * Null for a string that isn't a key.
 */
export function keyLabelFor(value, mac) {
  const shortcut = parseKey(value);
  if (!shortcut) return null;
  const meta = shortcut.meta || (mac && shortcut.mod);
  const ctrl = shortcut.ctrl || (!mac && shortcut.mod);
  const key = keyLabel(shortcut.key);
  if (mac) return `${meta ? "⌘" : ""}${ctrl ? "⌃" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${key}`;
  return [ctrl && "Ctrl", meta && "Meta", shortcut.alt && "Alt", shortcut.shift && "Shift", key].filter(Boolean).join("+");
}

// ---- When ----------------------------------------------------------------------------------------------------------

/** A `when` expression read into a tree, or null when it doesn't parse. Names, `!`, `&&`, `||` and parentheses. */
export function parseWhen(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_WHEN_LENGTH) return null;
  const tokens = text.match(/[A-Za-z_][A-Za-z0-9_.]*|&&|\|\||!|\(|\)|\S/g) ?? [];
  let at = 0;
  let depth = 0;
  const peek = () => tokens[at];
  function or() {
    let left = and();
    while (left && peek() === "||") {
      at++;
      const right = and();
      if (!right) return null;
      left = { type: "or", left, right };
    }
    return left;
  }
  function and() {
    let left = unary();
    while (left && peek() === "&&") {
      at++;
      const right = unary();
      if (!right) return null;
      left = { type: "and", left, right };
    }
    return left;
  }
  function unary() {
    const token = peek();
    if (token === "!") {
      at++;
      const node = unary();
      return node ? { type: "not", node } : null;
    }
    if (token === "(") {
      if (++depth > 32) return null;
      at++;
      const node = or();
      if (!node || peek() !== ")") return null;
      at++;
      depth--;
      return node;
    }
    if (token && /^[A-Za-z_]/.test(token)) {
      at++;
      return { type: "identifier", name: token };
    }
    return null;
  }
  const tree = or();
  return tree && at === tokens.length ? tree : null;
}

/** Whether a `when` tree holds in `context`; a name the context doesn't set is false. */
export function evaluateWhen(node, context) {
  switch (node.type) {
    case "identifier":
      return context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
    default:
      return false;
  }
}

/** The names a `when` tree uses. */
export function whenNames(node) {
  if (!node) return [];
  if (node.type === "identifier") return [node.name];
  if (node.type === "not") return whenNames(node.node);
  return [...whenNames(node.left), ...whenNames(node.right)];
}

// ---- Rules ---------------------------------------------------------------------------------------------------------

/** A rule from a file's entry, trimmed, or a reason it can't be one. */
export function readRule(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: "is not an object" };
  const { key, command, when } = entry;
  if (typeof command !== "string" || !COMMANDS.has(command)) return { error: `has an unknown command ${JSON.stringify(command)}` };
  if (!parseKey(key)) return { error: `has a key Milagre can't read: ${JSON.stringify(key)}` };
  if (when !== undefined && (typeof when !== "string" || !parseWhen(when))) return { error: `has a when it can't read: ${JSON.stringify(when)}` };
  const rule = { key: key.trim(), command };
  if (typeof when === "string") rule.when = when.trim();
  return { rule };
}

/** The valid rules of a file's parsed contents, and a line per entry left out. */
export function readRules(value) {
  if (!Array.isArray(value)) return { rules: [], issues: ["The file is not a JSON array of rules."] };
  const rules = [];
  const issues = [];
  for (const [index, entry] of value.entries()) {
    if (rules.length >= MAX_KEYBINDINGS) {
      issues.push(`Only the first ${MAX_KEYBINDINGS} rules are read.`);
      break;
    }
    const result = readRule(entry);
    if (result.rule) rules.push(result.rule);
    else issues.push(`Rule ${index + 1} ${result.error}.`);
  }
  return { rules, issues };
}

/** Rules ready to match: each with its parsed key and `when`. */
export function compileRules(rules) {
  return rules.flatMap((rule) => {
    const shortcut = parseKey(rule.key);
    if (!shortcut) return [];
    const whenTree = rule.when ? parseWhen(rule.when) : undefined;
    if (rule.when && !whenTree) return [];
    return [{ ...rule, shortcut, whenTree }];
  });
}

/**
 * The command a keyboard event runs: the last rule whose key and `when` both match, or null. A `mod` key answers to ⌘
 * or Ctrl (see `eventMatches`), but a rule that names the pressed modifier exactly wins over one that only allows it.
 */
export function commandForEvent(compiled, event, context, mac) {
  for (const either of [false, true]) {
    const command = lastMatch(compiled, event, context, mac, either);
    if (command) return command;
  }
  return null;
}

function lastMatch(compiled, event, context, mac, either) {
  for (let index = compiled.length - 1; index >= 0; index--) {
    const rule = compiled[index];
    if (!eventMatches(event, rule.shortcut, mac, either)) continue;
    if (rule.whenTree && !evaluateWhen(rule.whenTree, context)) continue;
    return rule.command;
  }
  return null;
}

/** The key strings a command has, in file order. */
export function keysFor(rules, command) {
  return rules.filter((rule) => rule.command === command).map((rule) => rule.key);
}

/** The first key a command has whose `when` can hold in `context` (all of them without a context), for a hint. */
export function primaryKeyFor(rules, command, context) {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule.command !== command) continue;
    if (context && rule.when) {
      const tree = parseWhen(rule.when);
      if (!tree || !evaluateWhen(tree, context)) continue;
    }
    return rule.key;
  }
  return null;
}

/**
 * The commands other than `command` that a key already runs, ignoring rules whose `when` differs (they may never meet).
 * `when` compares as written.
 */
export function conflictsFor(rules, { key, command, when }, mac) {
  const wanted = canonicalKey(key, mac);
  if (!wanted) return [];
  const others = new Set();
  for (const rule of rules) {
    if (rule.command === command) continue;
    if ((rule.when ?? "") !== (when ?? "")) continue;
    if (canonicalKey(rule.key, mac) === wanted) others.add(rule.command);
  }
  return [...others];
}

/** `rules` with every rule of `command` replaced by `next`, added at the end so they win over earlier ones. */
export function withCommandRules(rules, command, next) {
  return [...rules.filter((rule) => rule.command !== command), ...next.map((rule) => ({ ...rule, command }))];
}

/** Whether a command's rules are exactly its defaults. */
export function isDefault(rules, command) {
  const mine = rules.filter((rule) => rule.command === command);
  const defaults = COMMANDS.get(command)?.defaults ?? [];
  return mine.length === defaults.length && mine.every((rule, index) => !rule.when && rule.key === defaults[index]);
}

/**
 * The file's rules with the defaults of commands it has never seen added at the end (a newer Milagre brought them),
 * and the commands now seen. A command whose rules the user removed stays unbound: it is already seen.
 */
export function addNewDefaults(rules, seen) {
  const known = new Set(seen);
  const added = [];
  for (const command of KEYBINDING_COMMANDS) {
    if (known.has(command.id)) continue;
    known.add(command.id);
    if (rules.some((rule) => rule.command === command.id)) continue;
    added.push(...command.defaults.map((key) => ({ key, command: command.id })));
  }
  return { rules: added.length ? [...rules, ...added] : rules, seen: [...known], added: added.length > 0 };
}

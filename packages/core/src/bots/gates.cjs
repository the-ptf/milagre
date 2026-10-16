const path = require("node:path");
const { insideRoot } = require("../agents/permissions.cjs");

// Gates: the actions a bot always needs the user's sign-off for, matched on the permission request
// its session raises (see permissions.cjs for the request shape). These are guardrails on known
// commands, not a sandbox: a script that runs `gh pr merge` inside itself is not seen here.

const KIND_LABEL = { merge: "Merge", publish: "Publish", post: "Post as you", delete: "Delete", spend: "Spend" };

// Each segment of a command (see splitCommand) is tested from its start, so `echo gh pr merge 1` is not a merge.
// `gh api`, `git push`, `rm -r` and `find -delete` need their arguments read, so they are matched in code below.
// The patterns see a command's own words first: `gh -R x pr merge 1` as `gh pr merge 1 -R x`, `npm -w x publish` as
// `npm publish`, `node --env-file=.env scripts/asc.mjs submit` as `asc.mjs submit`.
// `spend` is reserved: no purchase or payment tools exist yet.
const DEFAULT_GATE_PATTERNS = Object.freeze([
  { kind: "merge", pattern: /^gh pr merge\b/ },
  { kind: "publish", pattern: /^eas (update|submit)\b/ },
  { kind: "publish", pattern: /^eas build\b.*\s--auto-submit\b/ },
  { kind: "publish", pattern: /^eas deploy\b.*\s--prod(uction)?\b/ },
  { kind: "publish", pattern: /^asc\.mjs (submit|release|beta)\b/ },
  { kind: "publish", pattern: /^(npm|pnpm|bun|yarn( npm)?) publish\b/ },
  { kind: "publish", pattern: /^gh release create\b/ },
  { kind: "publish", pattern: /^gh release edit\b.*\s--draft(=| )false\b/ },
  { kind: "publish", pattern: /^vercel\b.*\s(--prod(uction)?\b|--target(=| )production\b)/ },
  { kind: "publish", pattern: /^vercel promote\b/ },
  { kind: "publish", pattern: /^wrangler ((pages )?(deploy|publish)|versions deploy|rollback)\b/ },
  // A workflow by any name that says it ships (`Release.yml`, "Deploy to stores"); one by number can't be told.
  { kind: "publish", pattern: /^gh workflow run\b.*(publish|release|deploy|submit)/i },
  { kind: "post", pattern: /^gh (pr|issue) comment\b/ },
  { kind: "post", pattern: /^gh pr review\b/ },
  { kind: "post", pattern: /^curl\b.*(hooks\.slack\.com|discord(app)?\.com\/api\/webhooks)/ },
  { kind: "delete", pattern: /^gh (repo|release|issue) delete\b/ },
  { kind: "delete", pattern: /^rsync\b.*\s--(del\b|delete|remove-source-files\b)/ },
]);

// MCP tools, by name (`mcp__<server>__<tool>`). Milagre's own tools only touch the Chat and never gate.
const MCP_PATTERNS = Object.freeze([
  { kind: "merge", pattern: /^mcp__(?!milagre__).*__\w*merge/i },
  { kind: "delete", pattern: /^mcp__(?!milagre__).*__\w*(delete|destroy)/i },
  { kind: "post", pattern: /^mcp__(?!milagre__).*(slack|gmail|discord|linear).*(send|post|create|reply|comment)/i },
]);

// A command whose program or subcommand only shows when it runs (`$G pr merge 1`, `curl … | sh`) asks too. No gate
// kind names "anything", so it asks as a delete, the kind with the widest reach; no grant ever covers it.
const UNCHECKED_TITLE = "Run a command Milagre can't check";

// Stands in for what a command substitution or a variable makes of a word: its text isn't known before it runs.
const DYN = "\u0001";

// --- Reading a command line -------------------------------------------------------------------------------------

const ANSI_C = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

// `$'…'` from just after its opening quote: the text with its escapes read, and the index of its closing quote.
function ansiC(text, start) {
  let value = "";
  let index = start;
  for (; index < text.length && text[index] !== "'"; index++) {
    if (text[index] !== "\\") {
      value += text[index];
      continue;
    }
    const c = text[++index];
    const rest = text.slice(index + 1);
    let match;
    if (c !== undefined && Object.hasOwn(ANSI_C, c)) value += ANSI_C[c];
    else if ((match = /^[0-7]{1,3}/.exec(text.slice(index)))) {
      value += String.fromCharCode(parseInt(match[0], 8));
      index += match[0].length - 1;
    } else if ((match = (c === "x" ? /^[0-9a-fA-F]{1,2}/ : c === "u" ? /^[0-9a-fA-F]{1,4}/ : c === "U" ? /^[0-9a-fA-F]{1,8}/ : null)?.exec(rest))) {
      value += String.fromCodePoint(Math.min(parseInt(match[0], 16), 0x10ffff));
      index += match[0].length;
    } else if (c === "c" && rest) {
      value += String.fromCharCode(rest.charCodeAt(0) & 31);
      index++;
    } else if (c !== undefined) value += `\\${c}`;
  }
  return { value, end: index };
}

// The index of the `)` that closes `depth` parentheses opened before `start`, or the text's length.
function closeParen(text, start, depth = 1) {
  for (let index = start; index < text.length; index++) {
    const c = text[index];
    if (c === "\\") index++;
    else if (c === "'") {
      index = text.indexOf("'", index + 1);
      if (index < 0) return text.length;
    } else if (c === '"') index = closeQuote(text, index + 1);
    else if (c === "`") index = closeBacktick(text, index + 1);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return index;
  }
  return text.length;
}
function closeQuote(text, start) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index;
    else if (text[index] === "$" && text[index + 1] === "(") index = closeParen(text, index + 2);
    else if (text[index] === "`") index = closeBacktick(text, index + 1);
  }
  return text.length;
}
function closeBacktick(text, start) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "`") return index;
  }
  return text.length;
}
const backticked = (text) => text.replace(/\\([\\`$])/g, "$1");

// The command substitutions in text that is otherwise not commands (an unquoted here-document's body).
function substitutionsIn(text, out) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "$" && text[index + 1] === "(") {
      const end = closeParen(text, index + 2);
      scan(text.slice(index + 2, end), out);
      index = end;
    } else if (text[index] === "`") {
      const end = closeBacktick(text, index + 1);
      scan(backticked(text.slice(index + 1, end)), out);
      index = end;
    }
  }
}

// The here-documents whose bodies start after the newline at `index`: skipped (an unquoted one's substitutions
// still run), so a quote in their text can't hide the lines after them. Returns the index of the last body's end.
function skipHeredocs(text, index, docs, out) {
  for (const doc of docs) {
    let lineStart = index + 1;
    for (;;) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? text.length : newline;
      const line = text.slice(lineStart, lineEnd);
      const closes = (doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter;
      // Without its delimiter line, the rest of the command is the body.
      if (closes || newline < 0) {
        if (!doc.quoted) substitutionsIn(text.slice(index + 1, closes ? lineStart : lineEnd), out);
        index = lineEnd;
        break;
      }
      lineStart = newline + 1;
    }
  }
  return index;
}

// A command line -> its simple commands, each a list of words with the quotes taken off, into `out`. Splits on
// `&&`, `||`, `;`, `|`, `&`, newlines and subshells outside quotes. Redirections and here-documents are left out;
// command substitutions (`$(…)`, backticks, `<(…)`, also inside double quotes) are read as commands of their own,
// after the command they sit in, and leave DYN in its word.
function scan(text, out) {
  let words = [];
  let word = null;
  let quote = null;
  // The word being read had quotes or escapes (a here-document's delimiter, a `2>` that is a word).
  let quoted = false;
  // The next word is a redirection's target, or a here-document's delimiter.
  let target = null;
  const inner = [];
  const heredocs = [];
  const append = (value) => (word = (word ?? "") + value);
  const endWord = () => {
    if (word !== null) {
      if (target?.heredoc) heredocs.push({ delimiter: word, strip: target.strip, quoted });
      else if (!target) words.push(word);
      target = null;
    }
    word = null;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    target = null;
    if (words.length) out.push(words);
    words = [];
    out.push(...inner.splice(0));
  };
  const substitution = (body) => {
    scan(body, inner);
    append(DYN);
  };
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    const next = text[index + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
        if (next !== "\n") word += next;
        index++;
      } else if (c === "$" && next === "(") {
        const end = closeParen(text, index + 2);
        substitution(text.slice(index + 2, end));
        index = end;
      } else if (c === "`") {
        const end = closeBacktick(text, index + 1);
        substitution(backticked(text.slice(index + 1, end)));
        index = end;
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
      word ??= "";
    } else if (c === "$" && next === "'") {
      const { value, end } = ansiC(text, index + 2);
      append(value);
      quoted = true;
      index = end;
    } else if (c === "$" && next === '"') {
      quote = '"';
      quoted = true;
      word ??= "";
      index++;
    } else if (c === "\\") {
      if (next !== "\n" && next !== undefined) {
        append(next);
        quoted = true;
      }
      index++;
    } else if (c === " " || c === "\t") endWord();
    else if (c === "#" && word === null) {
      while (index + 1 < text.length && text[index + 1] !== "\n") index++;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const end = closeParen(text, index + 2);
      substitution(text.slice(index + 2, end));
      index = end;
    } else if (c === "`") {
      const end = closeBacktick(text, index + 1);
      substitution(backticked(text.slice(index + 1, end)));
      index = end;
    } else if (c === "(" && next === "(" && word === null) {
      // `(( … ))`: arithmetic, or nested subshells when it isn't. Read as commands, on its own, either way.
      const end = closeParen(text, index + 2, 2);
      endSegment();
      scan(text.slice(index + 2, end), out);
      index = end;
    } else if (c === "<" || c === ">") {
      // A redirection: `2>` names a descriptor, not a word of the command.
      if (word !== null && !quoted && /^\d+$/.test(word)) word = null;
      else endWord();
      let operator = c;
      if (next === c) {
        operator += text[++index];
        if (c === "<" && text[index + 1] === "<") operator += text[++index];
      } else if (next === "&" || (c === ">" && next === "|") || (c === "<" && next === ">")) operator += text[++index];
      const strip = operator === "<<" && text[index + 1] === "-";
      if (strip) index++;
      target = operator === "<<" ? { heredoc: true, strip } : {};
    } else if (c === "\n") {
      endSegment();
      index = skipHeredocs(text, index, heredocs.splice(0), out);
    } else if (";&|()".includes(c)) endSegment();
    else append(c);
  }
  endSegment();
}

function parse(command) {
  const out = [];
  scan(String(command ?? ""), out);
  return out;
}

// --- The command that runs ---------------------------------------------------------------------------------------

// Words that only shape the command after them. `for`, `select` and `case` lines name no command.
const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "coproc"]);
const HEADERS = new Set(["for", "select", "case"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

// Words that run the command after them, with the options that take a value, the words before the command
// (`timeout 600`) and the options that change its folder.
const WRAPPERS = new Map(
  Object.entries({
    env: { values: ["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"], moves: ["-C", "--chdir"], split: true },
    sudo: {
      values: [
        "-u",
        "--user",
        "-g",
        "--group",
        "-p",
        "--prompt",
        "-C",
        "--close-from",
        "-D",
        "--chdir",
        "-r",
        "--role",
        "-t",
        "--type",
        "-T",
        "--command-timeout",
        "-U",
        "--other-user",
      ],
      moves: ["-D", "--chdir"],
    },
    doas: { values: ["-u", "-C"] },
    command: {},
    builtin: {},
    exec: { values: ["-a"] },
    time: { values: ["-f", "--format", "-o", "--output"] },
    nohup: {},
    nice: { values: ["-n", "--adjustment"] },
    ionice: { values: ["-c", "--class", "-n", "--classdata"] },
    timeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
    gtimeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
    stdbuf: { values: ["-i", "--input", "-o", "--output", "-e", "--error"] },
    caffeinate: { values: ["-t", "-w"] },
    arch: { values: ["-arch", "-e", "-d"] },
    chronic: {},
    unbuffer: {},
    setsid: {},
  }),
);
const XARGS_VALUES = [
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "-E",
  "-d",
  "-a",
  "-J",
  "-R",
  "-S",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--delimiter",
  "--arg-file",
  "--eof",
];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);
const SHELL_VALUES = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);

// A word Milagre can't read as a program: a variable, a substitution, a glob or a brace expansion.
const dynamic = (word) =>
  word.includes("$") || word.includes(DYN) || (/[*?[]/.test(word) && word !== "[" && word !== "[[") || /\{[^}]*(,|\.\.)[^}]*\}/.test(word);

function unchecked(words) {
  return Object.assign([...words], { unchecked: true });
}

// `wrapper [options] [positional…] command…` -> the command's words. env's `-S 'a b'` splits into words.
function unwrap(words, { values = [], moves = [], positional = 0, split = false }, context) {
  let index = 1;
  while (index < words.length && words[index].startsWith("-") && words[index] !== "-") {
    const word = words[index];
    if (word === "--") {
      index++;
      break;
    }
    const flag = word.startsWith("--") ? word.split("=")[0] : word.slice(0, 2);
    if (moves.includes(flag)) context.moved = true;
    if (split && (flag === "-S" || flag === "--split-string")) {
      const attached = word === flag ? null : word.startsWith("--") ? word.slice(flag.length + 1) : word.slice(2);
      const after = words.slice(index + (attached === null ? 2 : 1));
      return [...(parse(attached ?? words[index + 1] ?? "")[0] ?? []), ...after];
    }
    index += values.includes(word) ? 2 : 1;
  }
  return words.slice(index + positional);
}

// A shell's command strings (`-c`, fish's `--command` and `-C`), [] when it runs a script file, or null when it
// reads its commands from stdin (`curl … | sh`, `bash -s`, `bash <<< …`).
function shellScripts(words) {
  const scripts = [];
  let command = false;
  let stdin = false;
  let index = 1;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word === "-" || word === "--") {
      index++;
      break;
    }
    if (SHELL_VALUES.has(word)) index++;
    else if (word === "--command" || word === "--init-command" || (word === "-C" && words[0] === "fish")) scripts.push(words[++index] ?? "");
    else if (word.startsWith("--command=") || word.startsWith("--init-command=")) scripts.push(word.slice(word.indexOf("=") + 1));
    else if (word === "--version" || word === "--help") return [];
    else if (word.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word[0] === "-") {
        command ||= word.includes("c");
        stdin ||= word.includes("s");
      }
    } else break;
  }
  if (command && words[index] !== undefined) scripts.push(words[index]);
  if (command || scripts.length) return scripts;
  return stdin || words[index] === undefined ? null : [];
}

// `script [options] [file [command…]]`, or Linux's `script -c command`. Without one, its shell reads stdin.
function scriptCommand(words) {
  const valued = new Set(["-T", "-I", "-O", "-B", "-E", "-m", "--log-io", "--log-in", "--log-out", "--log-timing", "--echo", "--logging-format"]);
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    const word = words[index];
    if (word === "--") {
      index++;
      break;
    }
    if (word === "-c" || word === "--command") return { script: words[index + 1] ?? "" };
    if (word.startsWith("--command=")) return { script: word.slice("--command=".length) };
    index += valued.has(word) || (word === "-t" && /^\d+$/.test(words[index + 1] ?? "")) ? 2 : 1;
  }
  const command = words.slice(index + 1);
  return command.length ? { words: command } : { stdin: true };
}

// `find paths… expression`: its start paths, the commands its `-exec`s run (`{}` read as something under a start
// path) and whether it deletes what it finds.
function findParts(words) {
  const paths = [];
  let index = 1;
  while (index < words.length && /^-([HLPEXsx]|D|O\d*|f)$/.test(words[index])) {
    if (words[index] === "-f") paths.push(words[index + 1] ?? ".");
    index += words[index] === "-D" || words[index] === "-f" ? 2 : 1;
  }
  while (index < words.length && !/^[-(!),]/.test(words[index])) paths.push(words[index++]);
  if (!paths.length) paths.push(".");
  const found = paths.map((start) => path.join(start, "{}"));
  const commands = [];
  let deletes = false;
  for (; index < words.length; index++) {
    if (words[index] === "-delete") deletes = true;
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[index])) continue;
    let end = words.findIndex((word, at) => at > index && (word === ";" || word === "+"));
    if (end < 0) end = words.length;
    commands.push(words.slice(index + 1, end).flatMap((word) => (word === "{}" ? found : [word.replaceAll("{}", found.join(" "))])));
    index = end;
  }
  return { paths, found, commands, deletes };
}

// `npx -y pkg@1 …`, `pnpm dlx`, `npm exec --`: the package's command, or the script of `-c`.
function runnerCommand(words) {
  let index = 0;
  while (index < words.length && words[index].startsWith("-")) {
    const word = words[index];
    if (word === "--") {
      index++;
      break;
    }
    if (word === "-c" || word === "--call") return { script: words[index + 1] ?? "" };
    if (word.startsWith("--call=")) return { script: word.slice("--call=".length) };
    index += word === "-p" || word === "--package" ? 2 : 1;
  }
  const rest = words.slice(index);
  // `wrangler@4.147.0` -> `wrangler`, `@scope/pkg@1` -> `@scope/pkg`; eas-cli runs as `eas`.
  if (rest.length) rest[0] = rest[0].replace(/(.)@[^/]*$/, "$1");
  if (rest[0] === "eas-cli") rest[0] = "eas";
  return { words: rest };
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_VALUES = new Set([
  "-w",
  "--workspace",
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--registry",
  "--loglevel",
  "--userconfig",
  "--include",
  "--exclude",
  "--from",
]);
const PACKAGE_MANAGER_MOVES = new Set(["-C", "--dir", "--prefix", "--cwd"]);
const PACKAGE_EXEC = { npm: ["exec", "x"], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], bun: ["x"] };
// Programs `pnpm <bin>`, `yarn <bin>` and `bun <bin>` run from the package's dependencies.
const PACKAGE_BINS = new Set(["eas", "eas-cli", "vercel", "wrangler", "gh", "node", "curl"]);

// `npm -w x publish`, `pnpm --filter x -r publish`, `yarn workspace x npm publish`: the subcommand and its words.
function packageArgs(words) {
  let index = 1;
  let moved = false;
  for (;;) {
    while (index < words.length && words[index].startsWith("-")) {
      if (PACKAGE_MANAGER_MOVES.has(words[index].split("=")[0])) moved = true;
      index += PACKAGE_MANAGER_VALUES.has(words[index]) ? 2 : 1;
    }
    if (words[0] === "yarn" && words[index] === "workspace") index += 2;
    else if (words[0] === "yarn" && words[index] === "workspaces" && words[index + 1] === "foreach") index += 2;
    else break;
  }
  return { sub: words[index], args: words.slice(index + 1), moved };
}

// One simple command's words -> the commands that actually run: without leading keywords, assignments and wrappers,
// with `npx -y pkg@1` as `pkg` and a program's path as its name. A shell's `-c` script (and `eval`, `trap`) is
// parsed again, an exec-style wrapper (`xargs`, `find -exec`, `watch`) gives the command it runs, so the result is
// a list. A command Milagre can't read comes back marked `unchecked`. `context.moved` records a change of folder.
function normalize(words, context = {}) {
  let rest = [...words];
  const again = (script) => parse(script).flatMap((next) => normalize(next, context));
  for (;;) {
    while (rest.length && (RESERVED.has(rest[0]) || ASSIGNMENT.test(rest[0]) || rest[0] === "function")) rest.splice(0, rest[0] === "function" ? 2 : 1);
    if (!rest.length || HEADERS.has(rest[0])) return [];
    if (dynamic(rest[0])) return [unchecked(rest)];
    const name = path.basename(rest[0]);
    rest[0] = name;
    if (name === "command" && /^-[a-zA-Z]*[vV]/.test(rest[1] ?? "")) return [];
    const wrapper = WRAPPERS.get(name);
    if (wrapper) {
      rest = unwrap(rest, wrapper, context);
      continue;
    }
    if (SHELLS.has(name)) {
      const scripts = shellScripts(rest);
      if (scripts === null) return [unchecked(rest)];
      return scripts.length ? scripts.flatMap(again) : [rest];
    }
    if (name === "eval") return again(rest.slice(1).join(" "));
    if (name === "trap") return rest[1] && !rest[1].startsWith("-") ? again(rest[1]) : [];
    if (name === "alias") return rest.slice(1).flatMap((word) => (word.includes("=") ? again(word.slice(word.indexOf("=") + 1)) : []));
    if ((name === "source" || name === ".") && (rest[1] === undefined || rest[1] === "-" || rest[1] === "/dev/stdin" || rest[1].includes(DYN)))
      return [unchecked(rest)];
    if (name === "xargs") {
      // What it reads from stdin becomes more of the command's words.
      const command = unwrap(rest, { values: XARGS_VALUES }, context);
      rest = [...(command.length ? command : ["echo"]), DYN];
      continue;
    }
    if (name === "find") return [rest, ...findParts(rest).commands.flatMap((command) => normalize(command, context))];
    if (name === "watch") {
      const exec = rest.some((word) => word === "-x" || word === "--exec");
      const command = unwrap(rest, { values: ["-n", "--interval"] }, context);
      if (exec) {
        rest = command;
        continue;
      }
      return again(command.join(" "));
    }
    if (name === "script") {
      const run = scriptCommand(rest);
      if (run.stdin) return [unchecked(rest)];
      if (run.script !== undefined) return again(run.script);
      rest = run.words;
      continue;
    }
    if (PACKAGE_RUNNERS.has(name)) {
      const run = runnerCommand(rest.slice(1));
      if (run.script !== undefined) return again(run.script);
      rest = run.words;
      continue;
    }
    if (PACKAGE_MANAGERS.has(name)) {
      const { sub, args, moved } = packageArgs(rest);
      if (moved) context.moved = true;
      if (PACKAGE_EXEC[name].includes(sub)) {
        const run = runnerCommand(args);
        if (run.script !== undefined) return again(run.script);
        rest = run.words;
        continue;
      }
      if (name !== "npm" && PACKAGE_BINS.has(sub)) {
        rest = [sub, ...args];
        continue;
      }
      if ((name === "yarn" || name === "bun") && sub === "run" && PACKAGE_BINS.has(args[0])) {
        rest = args;
        continue;
      }
    }
    return [rest];
  }
}

const readable = (words) => words.map((word) => word.replaceAll(DYN, "…")).join(" ");

/** A command line -> the simple commands it runs, normalized and joined by single spaces. */
function splitCommand(command) {
  return parse(command)
    .flatMap((words) => normalize(words))
    .map((words) =>
      words
        .map((word) => word.replaceAll(DYN, ""))
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
}

// --- gh and git ---------------------------------------------------------------------------------------------------

// Before its command, gh (cobra) reads every flag but --help and --version as taking the next word, unless the value
// is attached (`--repo=x`, `-Rx`). So `gh -R x pr merge 1` and `gh pr --repo x merge 1` are merges.
const GH_BOOLEAN = new Set(["--help", "-h", "--version"]);

// gh's words -> its command (`pr merge`, `api`), the words after it, and `words` as gh's patterns read them:
// `gh pr merge …` with the flags written before the command moved to the end.
function ghCommand(words) {
  const command = [];
  const before = [];
  let index = 1;
  while (index < words.length && command.length < (command[0] === "api" ? 1 : 2)) {
    const word = words[index];
    if (word === "--") break;
    if (word.startsWith("-") && word !== "-") {
      const takesValue = !GH_BOOLEAN.has(word) && !word.includes("=") && (word.startsWith("--") || word.length === 2);
      const count = takesValue ? 2 : 1;
      before.push(...words.slice(index, index + count));
      index += count;
      continue;
    }
    command.push(word);
    index++;
  }
  const args = words.slice(index);
  return { command, args, words: ["gh", ...command, ...args, ...before] };
}

// `git -C dir -c k=v push …` -> the words after `git`'s own options, whether they change its folder, and whether
// they define an alias (`-c alias.p=…`), whose command Milagre doesn't read.
const GIT_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
function gitArgs(words) {
  let index = 1;
  let moved = false;
  let alias = false;
  while (index < words.length && words[index].startsWith("-")) {
    const word = words[index];
    const flag = word.split("=")[0];
    if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") moved = true;
    const value = GIT_VALUES.has(word) ? (words[index + 1] ?? "") : word.slice(flag.length + 1);
    if ((flag === "-c" || flag === "--config-env") && /^alias\./i.test(value)) alias = true;
    index += GIT_VALUES.has(word) ? 2 : 1;
  }
  return { args: words.slice(index), moved, alias };
}

const DEFAULT_BRANCHES = new Set(["main", "master"]);

const GIT_PUSH_VALUES = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"]);

// `git push`: a force push, a mirror, a prune or a branch deletion is a delete, a push to main or master is a merge.
function gitPushGate(args) {
  if (args[0] !== "push") return null;
  const flags = [];
  const positional = [];
  let repo = false;
  for (let index = 1; index < args.length; index++) {
    const word = args[index];
    if (word === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (word === "--repo" || word.startsWith("--repo=")) repo = true;
    if (GIT_PUSH_VALUES.has(word)) index++;
    else if (word.startsWith("-")) flags.push(word);
    else positional.push(word);
  }
  // Given --repo, git still reads the first word as the repository when there is one: any word may be a refspec.
  const refspecs = repo ? positional : positional.slice(1);
  const force = flags.some((flag) => /^(--force(-with-lease)?(=.*)?|--delete|--mirror|--prune|-[a-zA-Z]*[fd][a-zA-Z]*)$/.test(flag));
  if (force || refspecs.some((spec) => spec.startsWith("+") || spec.startsWith(":"))) return { kind: "delete" };
  const branch = refspecs
    .map((spec) =>
      spec
        .split(":")
        .at(-1)
        .replace(/^refs\/heads\//, ""),
    )
    .find((name) => DEFAULT_BRANCHES.has(name));
  return branch ? { kind: "merge", title: `Push to ${branch}` } : null;
}

// Whether a path a command deletes is outside the working folder. The folder itself counts as outside, and so does
// any relative path once the command changed folder (`cd`, `pushd`, `-C`), or one only known when it runs.
function outsideFolder(target, { cwd, moved }) {
  if (target.includes(DYN) || target.startsWith("~") || target.includes("$")) return true;
  if (moved && !path.isAbsolute(target)) return true;
  if (!cwd) return path.isAbsolute(target) || target.split("/").includes("..");
  return !insideRoot(cwd, [path.resolve(cwd, target)]);
}

// `rm -r` on anything that isn't strictly inside the working folder.
function rmGate(words, options) {
  if (words[0] !== "rm") return null;
  const end = words.indexOf("--");
  const flags = words.slice(1, end < 0 ? undefined : end).filter((word) => word.startsWith("-"));
  if (!flags.some((flag) => flag === "--recursive" || /^-[a-zA-Z]*[rR]/.test(flag))) return null;
  const targets = words.slice(1).filter((word, index) => (end >= 0 && index + 1 > end) || !word.startsWith("-"));
  return targets.some((target) => outsideFolder(target, options)) ? { kind: "delete" } : null;
}

// `find … -delete` under a start path outside the working folder (its commands are matched on their own).
function findGate(words, options) {
  if (words[0] !== "find") return null;
  const { found, deletes } = findParts(words);
  return deletes && found.some((target) => outsideFolder(target, options)) ? { kind: "delete" } : null;
}

const UNCHECKED = Object.freeze({ kind: "delete", title: UNCHECKED_TITLE, uncoverable: true });
const API_VALUES = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);
const API_FIELDS = new Set(["-f", "--raw-field", "-F", "--field"]);
const SHIPS = /publish|release|deploy|submit/i;

// GraphQL through `gh api graphql`: queries read, mutations gate by what they do. A query Milagre can't see (from a
// file, a variable) or a mutation it doesn't know asks as one it can't check.
function graphqlGate(fields) {
  const query = fields.find((field) => field.startsWith("query="))?.slice("query=".length);
  if (query === undefined || query.startsWith("@") || query.includes(DYN) || query.includes("${") || !query.includes("{")) return UNCHECKED;
  if (!/\bmutation\b/.test(query)) return null;
  // The repository is named by node ids, not in the command: no grant can cover these.
  if (/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(query)) return { kind: "merge", uncoverable: true };
  if (/\bdelete[A-Z]\w*\s*\(/.test(query)) return { kind: "delete", uncoverable: true };
  if (
    /\b(add(Comment|DiscussionComment|PullRequestReview\w*)|submitPullRequestReview|update(IssueComment|PullRequestReviewComment|DiscussionComment)|create(Issue|Discussion))\b/.test(
      query,
    )
  )
    return { kind: "post", uncoverable: true };
  return UNCHECKED;
}

// `gh api [flags] endpoint`: reads pass. Writes gate by what they reach; one Milagre doesn't know asks as one it
// can't check. The endpoint's `repos/owner/name` is the target.
function ghApiGate(args) {
  let method = null;
  let endpoint = null;
  let input = false;
  let host = false;
  const fields = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!word.startsWith("-") || word === "-") {
      endpoint ??= word;
      continue;
    }
    let flag = word;
    let value = "";
    if (word.startsWith("--") && word.includes("=")) {
      flag = word.slice(0, word.indexOf("="));
      value = word.slice(word.indexOf("=") + 1);
    } else if (!word.startsWith("--") && word.length > 2 && API_VALUES.has(word.slice(0, 2))) {
      flag = word.slice(0, 2);
      value = word.slice(2);
    } else if (API_VALUES.has(word)) value = args[++index] ?? "";
    if (flag === "-X" || flag === "--method") method = value.toUpperCase();
    else if (API_FIELDS.has(flag)) fields.push(value);
    else if (flag === "--input") input = true;
    else if (flag === "--hostname") host = true;
  }
  // gh sends fields with POST unless told otherwise.
  method ??= fields.length || input ? "POST" : "GET";
  const route = String(endpoint ?? "")
    .replace(/^\//, "")
    .replace(/[?#].*$/, "");
  const repo = /^repos\/([^/{}]+)\/([^/{}]+)/.exec(route);
  const where = host ? { uncoverable: true } : repo ? { target: `${repo[1]}/${repo[2]}` } : {};
  const gate = (kind, title) => ({ kind, ...(title ? { title } : {}), ...where });
  if (route === "graphql") return input && !fields.some((field) => field.startsWith("query=")) ? UNCHECKED : graphqlGate(fields);
  if (method === "GET" || method === "HEAD") return null;
  if (method === "DELETE") return gate("delete");
  if (/(^|\/)(pulls\/\d+\/merge|merges)$/.test(route))
    return gate("merge", /pulls\/(\d+)\/merge$/.test(route) ? `Merge PR #${/pulls\/(\d+)/.exec(route)[1]}` : null);
  const ref = /\/git\/refs\/heads\/(main|master)$/.exec(route);
  if (ref) return gate("merge", `Push to ${ref[1]}`);
  if (/\/(comments|reviews)(\/|$)/.test(route)) return gate("post");
  if (/\/releases(\/\d+)?$/.test(route)) return gate("publish");
  const workflow = /\/actions\/workflows\/([^/]+)\/dispatches$/.exec(route);
  if (workflow && SHIPS.test(workflow[1])) return gate("publish");
  return UNCHECKED;
}

// What gh's own commands need read: `api`, an alias that runs a gated command, a workflow known only by number.
function ghGate(gh, options) {
  const [group, action] = gh.command;
  if (group === "api") return ghApiGate(gh.words.slice(2));
  const positional = gh.args.filter((word) => !word.startsWith("-"));
  if (group === "workflow" && action === "run" && /^\d+$/.test(positional[0] ?? "")) return UNCHECKED;
  if (group === "alias" && action === "import") return UNCHECKED;
  if (group === "alias" && action === "set") {
    const expansion = positional[1];
    if (expansion === undefined || expansion === "-") return UNCHECKED;
    const shell = gh.args.includes("--shell") || gh.args.includes("-s") || expansion.startsWith("!");
    const command = shell ? expansion.replace(/^!/, "") : `gh ${expansion}`;
    for (const words of parse(command).flatMap((segment) => normalize(segment))) {
      const gate = segmentGate(words, options);
      if (gate) return { kind: gate.kind, uncoverable: true };
    }
  }
  return null;
}

// gh flags whose value is text, so a value that looks like a flag (`--body "-Rx"`) isn't read as one.
const GH_TEXT_VALUES = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--title",
  "--subject",
  "-A",
  "--author-email",
  "--match-head-commit",
  "-f",
  "--raw-field",
  "--field",
  "-H",
  "--header",
  "-q",
  "--jq",
  "--template",
]);

// gh's grant target: the repo it acts on, by its last `-R`/`--repo` or a github.com PR URL, or none named. Two
// different ones or another host leave it uncertain.
function ghTarget(gh) {
  const repos = new Set();
  let last = null;
  let host = false;
  const words = gh.words.slice(1 + gh.command.length);
  const add = (repo) => {
    repos.add(repo);
    last = repo;
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "-R" || word === "--repo") add(words[++index] ?? "");
    else if (word.startsWith("--repo=")) add(word.slice("--repo=".length));
    else if (/^-R./.test(word)) add(word.slice(2));
    else if (word === "--hostname" || word.startsWith("--hostname=")) host = true;
    else if (GH_TEXT_VALUES.has(word)) index++;
    else {
      const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(pull|issues)\/\d+/.exec(word);
      if (url?.[1] === "github.com") add(`${url[2]}/${url[3]}`);
      else if (url) host = true;
    }
  }
  return host || repos.size > 1 ? { uncoverable: true } : last ? { target: last } : {};
}

function prTitle(words) {
  const after = words.slice(words.indexOf("merge") + 1);
  for (const word of after) {
    const number = /^#?(\d+)$/.exec(word)?.[1] ?? /\/pull\/(\d+)\b/.exec(word)?.[1];
    if (number) return `Merge PR #${number}`;
  }
  return null;
}

const RUNTIMES = new Set(["node", "bun", "deno", "tsx"]);
const RUNTIME_VALUES = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--input-type",
  "--title",
]);
const WRANGLER_VALUES = new Set(["-c", "--config", "-e", "--env", "--env-file", "--cwd"]);

// A command as the patterns read it: its program, then its own command words (see DEFAULT_GATE_PATTERNS).
function readWords(words) {
  let read = words;
  if (words[0] === "gh") read = ghCommand(words).words;
  if (PACKAGE_MANAGERS.has(words[0])) {
    const { sub, args } = packageArgs(words);
    if (sub !== undefined) read = [words[0], sub, ...args];
  }
  if (words[0] === "wrangler") {
    let index = 1;
    while (index < words.length && words[index].startsWith("-")) index += WRANGLER_VALUES.has(words[index]) ? 2 : 1;
    read = ["wrangler", ...words.slice(index)];
  }
  if (RUNTIMES.has(read[0])) {
    let index = (read[0] === "bun" || read[0] === "deno") && read[1] === "run" ? 2 : 1;
    while (index < read.length && read[index].startsWith("-")) index += RUNTIME_VALUES.has(read[index]) ? 2 : 1;
    if (read[index] !== undefined && path.basename(read[index]) === "asc.mjs") read = ["asc.mjs", ...read.slice(index + 1)];
  }
  return read;
}

// Whether a command moves to another folder, so what it does later is no longer about the Chat's own.
function changesFolder(words) {
  if (["cd", "pushd", "popd"].includes(words[0])) return true;
  if (words[0] === "git") return gitArgs(words).moved;
  if (PACKAGE_MANAGERS.has(words[0])) return packageArgs(words).moved;
  return false;
}

function segmentGate(words, options) {
  if (words.unchecked) return UNCHECKED;
  // A program named with spaces is a quoted argument read as one (`time git commit -m "gh pr merge 1"`).
  if (/\s/.test(words[0])) return null;
  const segment = readable(words);
  let where = {};
  if (words[0] === "gh") {
    const gh = ghCommand(words);
    if (gh.command.some(dynamic) || (!gh.command.length && gh.args.some(dynamic))) return UNCHECKED;
    const special = ghGate(gh, options);
    if (special) return { ...special, segment };
    where = ghTarget(gh);
  }
  if (words[0] === "git") {
    const git = gitArgs(words);
    if (git.alias || (git.args[0] !== undefined && dynamic(git.args[0]))) return UNCHECKED;
    const push = gitPushGate(git.args);
    if (push) return { ...push, segment };
  }
  const special = rmGate(words, options) ?? findGate(words, options);
  if (special) return { ...special, segment };
  const read = readWords(words);
  const text = read.join(" ");
  const found = DEFAULT_GATE_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (found) return { kind: found.kind, title: found.kind === "merge" && read[1] === "pr" ? prTitle(read) : null, segment, ...where };
  const added = (options.extra ?? []).find(({ prefix }) => {
    const wanted = splitCommand(prefix)[0];
    return wanted && (segment === wanted || segment.startsWith(`${wanted} `));
  });
  return added ? { kind: added.kind, segment } : null;
}

// Claude's card shows an MCP tool by its display name ("Send Message"): its own name is `toolName`. Codex names an MCP
// tool only in its card's title: `Allow the slack MCP server to run tool "send_message"?`.
function mcpToolName(request) {
  if (request.toolName?.startsWith("mcp__")) return request.toolName;
  if (request.tool?.startsWith("mcp__")) return request.tool;
  const server = /^MCP: (.+)$/.exec(request.tool ?? "")?.[1];
  const tool = /run tool "([^"]+)"/.exec(request.title ?? "")?.[1];
  return server && tool ? `mcp__${server}__${tool}` : null;
}

/**
 * The gate a permission request falls under, or null. `extra` adds a template's own command prefixes.
 * The target is the repo the command names (`-R`, a PR URL, a `gh api` endpoint), or null for the caller to fill in
 * with the Chat's Project. When Milagre can't be sure what the command acts on (two repos, GH_REPO, another host, a
 * `cd` or `-C` before a command that names none), the gate is `uncoverable`: its target is null and no grant covers it.
 */
function matchGate(request, { extra = [] } = {}) {
  const mcp = mcpToolName(request);
  if (mcp) {
    const found = MCP_PATTERNS.find(({ pattern }) => pattern.test(mcp));
    return found ? { kind: found.kind, title: `${KIND_LABEL[found.kind]}: ${mcp}`, command: mcp, target: null } : null;
  }
  if (typeof request.command !== "string") return null;
  const context = { moved: /\bGIT_(DIR|WORK_TREE)=/.test(request.command) };
  const segments = parse(request.command).flatMap((segment) => normalize(segment, context));
  const options = { cwd: request.cwd, moved: context.moved || segments.some(changesFolder), extra };
  const ghEnv = /\bGH_(REPO|HOST)=/.test(request.command);
  for (const words of segments) {
    const gate = segmentGate(words, options);
    if (!gate) continue;
    const uncoverable = Boolean(gate.uncoverable) || (gate.target == null && options.moved) || (words[0] === "gh" && ghEnv);
    return {
      kind: gate.kind,
      title: gate.title ?? `${KIND_LABEL[gate.kind]}: ${gate.segment}`,
      command: request.command,
      target: uncoverable ? null : (gate.target ?? null),
      ...(uncoverable ? { uncoverable: true } : {}),
    };
  }
  return null;
}

module.exports = { DEFAULT_GATE_PATTERNS, matchGate, splitCommand };

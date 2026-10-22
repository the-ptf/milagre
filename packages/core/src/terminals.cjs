// A Terminal is an interactive shell the user opened in a Chat (see GLOSSARY.md and ADR-0008). The host owns its
// PTY, so it outlives the desktop window and a paired phone can use it too. Output stays in memory only: the newest
// lines, enough for a viewer that opens it later. Every viewer may type; the PTY takes the size of whichever viewer
// typed or resized last.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const TERMINAL_ID = /^[0-9a-f-]{36}$/;
const MAX_BUFFER_CHARS = 1024 * 1024;
const MAX_BUFFER_LINES = 10_000;
const MAX_INPUT = 64 * 1024;
const READ_WAIT_MS = 8000;
// The smallest read limit a viewer may ask for: below it a flood would take a round trip per screenful.
const MIN_READ_LIMIT = 4096;
const TITLE_POLL_MS = 1500;
const MAX_PER_CHAT = 12;
const MAX_TOTAL = 64;
const UNIX_SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish"]);
// Variables that describe the host process, not a shell the user opens: Electron in Node mode would make every
// Electron app the user starts from the Terminal run as plain Node.
const HOST_ONLY = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "MILAGRE_BUNDLED_BIN_DIR", "PWD", "OLDPWD", "SHLVL", "_"]);

/**
 * On Linux, prefer installed zsh; otherwise use the account's login shell, then $SHELL (which the host may have
 * inherited from whatever started it). On Windows, PowerShell 7, then Windows PowerShell, then cmd.
 */
function terminalShell({ platform = process.platform, env = process.env, exists = executableFile, userShell } = {}) {
  if (platform === "win32") {
    const folders = (env.Path || env.PATH || "").split(";").filter(Boolean);
    const onPath = (name) => folders.map((folder) => path.win32.join(folder, name)).find((file) => exists(file));
    const root = env.SystemRoot || "C:\\Windows";
    const candidates = [
      onPath("pwsh.exe"),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
      path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ];
    const found = candidates.find((file) => file && exists(file));
    return { file: found || env.ComSpec || path.win32.join(root, "System32", "cmd.exe"), args: [] };
  }
  let account = null;
  try {
    account = userShell ? userShell() : os.userInfo().shell;
  } catch {
    account = null;
  }
  const usable = (file) => typeof file === "string" && path.isAbsolute(file) && UNIX_SHELLS.has(path.basename(file)) && exists(file);
  let zsh = null;
  if (platform === "linux") {
    const onPath = (env.PATH || "")
      .split(":")
      .filter((folder) => path.isAbsolute(folder))
      .map((folder) => path.join(folder, "zsh"));
    zsh = [account, env.SHELL, ...onPath, "/usr/local/bin/zsh", "/usr/bin/zsh", "/bin/zsh"].find((file) => usable(file) && path.basename(file) === "zsh");
  }
  const file = zsh || [account, env.SHELL].find(usable) || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // A login shell reads the same profile files as a new window of the user's terminal app.
  return { file, args: ["-l"] };
}

function terminalEnvironment(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) if (!HOST_ONLY.has(key) && typeof value === "string") result[key] = value;
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  result.TERM_PROGRAM = "Milagre";
  if (!result.LANG && process.platform !== "win32") result.LANG = "en_US.UTF-8";
  return result;
}

function executableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Discover installed shells without running them. Symlink aliases are listed once. */
function terminalShells({
  platform = process.platform,
  env = process.env,
  exists = executableFile,
  userShell,
  readShells = () => fs.readFileSync("/etc/shells", "utf8"),
  realpath = fs.realpathSync,
} = {}) {
  const options = { platform, env, exists, userShell };
  const preferred = terminalShell(options).file;
  let candidates = [preferred];
  if (platform === "win32") {
    const folders = (env.Path || env.PATH || "").split(";").filter(Boolean);
    const root = env.SystemRoot || "C:\\Windows";
    candidates.push(
      ...folders.flatMap((folder) => ["pwsh.exe", "powershell.exe", "cmd.exe"].map((name) => path.win32.join(folder, name))),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
      path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      env.ComSpec || path.win32.join(root, "System32", "cmd.exe"),
    );
  } else {
    try {
      candidates.push(
        ...readShells()
          .split(/\r?\n/)
          .map((line) => line.split("#")[0].trim()),
      );
    } catch {
      // Some installations have no /etc/shells. Known shells on PATH still work.
    }
    candidates.push(env.SHELL);
    const folders = [...(env.PATH || "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"];
    candidates.push(...folders.filter((folder) => path.isAbsolute(folder)).flatMap((folder) => [...UNIX_SHELLS].map((name) => path.join(folder, name))));
  }
  const paths = platform === "win32" ? path.win32 : path;
  const seen = new Set();
  return candidates
    .filter((file) => {
      if (typeof file !== "string" || !paths.isAbsolute(file) || !exists(file)) return false;
      let canonical = file;
      try {
        canonical = realpath(file);
      } catch {
        /* Tests or unavailable realpath. */
      }
      if (platform === "win32") canonical = canonical.toLowerCase();
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    })
    .map((file) => ({ file, label: paths.basename(file).replace(/\.exe$/i, "") }));
}

// A cut never splits a surrogate pair: the head stops before a lone high half, the tail starts after a lone low half.
function headEnd(data, limit) {
  const code = data.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}
function tailStart(data, limit) {
  const start = data.length - limit;
  const code = data.charCodeAt(start);
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}
const lineCount = (text) => {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
};

/**
 * `resolveChat(chatId)` resolves with the Chat's Worktrees as [{ path, label }], or rejects when the Chat can't
 * have Terminals (it doesn't exist or is archived). `onChange(chatId)` fires when a Chat's Terminals open, close or
 * change title; `onShellsChanged()` when the set of running shells changed.
 */
function createTerminals(options = {}) {
  const {
    resolveChat,
    spawn = (file, args, spawnOptions) => require("node-pty").spawn(file, args, spawnOptions),
    shell = () => terminalShell(),
    availableShells = () => terminalShells(),
    settingsFile,
    environment = () => terminalEnvironment(),
    onChange = () => {},
    onShellsChanged = () => {},
    onPreferencesChanged = () => {},
    maxBufferChars = MAX_BUFFER_CHARS,
    maxBufferLines = MAX_BUFFER_LINES,
    readWaitMs = READ_WAIT_MS,
    titlePollMs = TITLE_POLL_MS,
    maxPerChat = MAX_PER_CHAT,
    maxTotal = MAX_TOTAL,
    now = Date.now,
  } = options;
  if (typeof resolveChat !== "function") throw new Error("Terminals need a way to resolve a Chat's Worktrees.");
  let selectedShell = null;
  if (settingsFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (typeof saved?.shell === "string") selectedShell = saved.shell;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  const terminals = new Map();
  let closed = false;
  let titleTimer = null;

  const shellName = (terminal) =>
    path
      .basename(terminal.shell)
      .replace(/\.exe$/i, "")
      .toLowerCase();
  // A shell waiting at its prompt is in front of its own Terminal. It may report another shell's name (macOS's /bin/sh
  // runs bash), and a shell started inside the Terminal is a prompt too, not a command to warn about.
  const idle = (terminal, name) => {
    const plain = name.replace(/\.exe$/i, "").toLowerCase();
    return plain === shellName(terminal) || UNIX_SHELLS.has(plain) || ["pwsh", "powershell", "cmd"].includes(plain);
  };
  function foreground(terminal) {
    let name = "";
    try {
      name = terminal.pty.process || "";
    } catch {
      name = "";
    }
    name = path.basename(name).replace(/^-/, "");
    return name || shellName(terminal);
  }
  function info(terminal) {
    const title = terminal.exited ? terminal.title : foreground(terminal);
    const busy = !terminal.exited && !idle(terminal, title);
    return {
      id: terminal.id,
      chatId: terminal.chatId,
      title,
      cwd: terminal.cwd,
      label: terminal.label,
      busy,
      cols: terminal.cols,
      rows: terminal.rows,
      createdAt: terminal.createdAt,
    };
  }
  function requireChatId(request) {
    if (typeof request?.chatId !== "string" || !request.chatId) throw new Error("A Chat is required.");
    return request.chatId;
  }
  function find(request) {
    if (closed) throw new Error("Terminals are closed.");
    const id = request?.terminalId;
    const terminal = typeof id === "string" && TERMINAL_ID.test(id) ? terminals.get(id) : null;
    if (!terminal) throw new Error("This Terminal has ended.");
    return terminal;
  }
  function wake(terminal) {
    const waiters = terminal.waiters;
    terminal.waiters = new Set();
    for (const resolve of waiters) resolve();
  }
  function append(terminal, text) {
    if (!text) return;
    terminal.chunks.push({ start: terminal.end, text, lines: lineCount(text) });
    terminal.end += text.length;
    terminal.chars += text.length;
    terminal.lines += terminal.chunks.at(-1).lines;
    while (terminal.chunks.length > 1 && (terminal.chars > maxBufferChars || terminal.lines > maxBufferLines)) {
      const first = terminal.chunks.shift();
      terminal.chars -= first.text.length;
      terminal.lines -= first.lines;
    }
    // One chunk larger than the whole buffer keeps only its tail.
    const only = terminal.chunks[0];
    if (terminal.chunks.length === 1 && only.text.length > maxBufferChars) {
      const cut = only.text.length - maxBufferChars;
      only.text = only.text.slice(cut);
      only.start += cut;
      only.lines = lineCount(only.text);
      terminal.chars = only.text.length;
      terminal.lines = only.lines;
    }
    wake(terminal);
  }
  function start(terminal) {
    return terminal.chunks.length ? terminal.chunks[0].start : terminal.end;
  }
  function since(terminal, after) {
    if (after < start(terminal) || after > terminal.end) return { reset: true, data: terminal.chunks.map((chunk) => chunk.text).join("") };
    let data = "";
    for (const chunk of terminal.chunks) {
      if (chunk.start + chunk.text.length <= after) continue;
      data += chunk.start >= after ? chunk.text : chunk.text.slice(after - chunk.start);
    }
    return { reset: false, data };
  }
  function pollTitles() {
    if (titleTimer || closed || !terminals.size) return;
    titleTimer = setTimeout(() => {
      titleTimer = null;
      const changed = new Set();
      for (const terminal of terminals.values()) {
        if (terminal.exited) continue;
        const title = foreground(terminal);
        if (title !== terminal.title) {
          terminal.title = title;
          changed.add(terminal.chatId);
          wake(terminal);
        }
      }
      for (const chatId of changed) onChange(chatId);
      pollTitles();
    }, titlePollMs);
    titleTimer.unref?.();
  }
  function finish(terminal) {
    if (!terminals.has(terminal.id)) return;
    terminals.delete(terminal.id);
    wake(terminal);
    onChange(terminal.chatId);
    onShellsChanged();
  }
  function kill(terminal) {
    if (terminal.exited) return;
    terminal.exited = true;
    try {
      terminal.pty.kill();
    } catch {
      /* Already gone. */
    }
    finish(terminal);
  }

  function profiles() {
    const shells = availableShells();
    return { shells, defaultShell: shell().file, selectedShell: shells.some((item) => item.file === selectedShell) ? selectedShell : null };
  }

  return {
    async profiles() {
      return profiles();
    },
    async setShell(request) {
      if (closed) throw new Error("Terminals are closed.");
      const file = request?.shell;
      if (file !== null && (typeof file !== "string" || !availableShells().some((item) => item.file === file))) throw new Error("Choose an installed shell.");
      if (settingsFile) {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
        const temporary = `${settingsFile}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ shell: file }), { mode: 0o600 });
          fs.renameSync(temporary, settingsFile);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
      selectedShell = file;
      onPreferencesChanged();
      return profiles();
    },
    async list(request) {
      const chatId = requireChatId(request);
      if (closed) throw new Error("Terminals are closed.");
      return { terminals: [...terminals.values()].filter((terminal) => terminal.chatId === chatId).map(info) };
    },
    /** Opens a Terminal in one of the Chat's Worktrees: `cwd` when given and it is one of them, otherwise the first. */
    async open(request) {
      const chatId = requireChatId(request);
      if (closed) throw new Error("Terminals are closed.");
      const worktrees = await resolveChat(chatId);
      if (!Array.isArray(worktrees) || !worktrees.length) throw new Error("This Chat has no Worktree to open a Terminal in.");
      const chosen = request.cwd == null ? worktrees[0] : worktrees.find((worktree) => worktree.path === request.cwd);
      if (!chosen) throw new Error("Choose one of this Chat's Worktrees.");
      if (!fs.existsSync(chosen.path)) throw new Error(`${chosen.path} no longer exists.`);
      const mine = [...terminals.values()].filter((terminal) => terminal.chatId === chatId).length;
      if (mine >= maxPerChat) throw new Error(`A Chat can have at most ${maxPerChat} Terminals. Close one first.`);
      if (terminals.size >= maxTotal) throw new Error("Too many Terminals are open on this computer. Close one first.");
      const cols = Number.isSafeInteger(request.cols) && request.cols >= 2 && request.cols <= 1000 ? request.cols : 80;
      const rows = Number.isSafeInteger(request.rows) && request.rows >= 1 && request.rows <= 500 ? request.rows : 24;
      const chosenShell = selectedShell && availableShells().find((item) => item.file === selectedShell);
      const { file, args } = chosenShell
        ? { file: chosenShell.file, args: /\.exe$/i.test(chosenShell.file) || path.basename(chosenShell.file) === "elvish" ? [] : ["-l"] }
        : shell();
      const env = { ...environment() };
      if (!/\.exe$/i.test(file)) env.SHELL = file;
      const pty = spawn(file, args, { name: "xterm-256color", cols, rows, cwd: chosen.path, env });
      const terminal = {
        id: randomUUID(),
        chatId,
        pty,
        shell: file,
        cwd: chosen.path,
        label: chosen.label ?? path.basename(chosen.path),
        cols,
        rows,
        createdAt: now(),
        chunks: [],
        end: 0,
        chars: 0,
        lines: 0,
        waiters: new Set(),
        exited: false,
        title: "",
      };
      terminal.title = foreground(terminal);
      terminals.set(terminal.id, terminal);
      pty.onData((data) => append(terminal, data));
      pty.onExit(() => {
        terminal.exited = true;
        finish(terminal);
      });
      pollTitles();
      onChange(chatId);
      onShellsChanged();
      return info(terminal);
    },
    /**
     * Long-polls for output after `after`, the offset a viewer already has. `reset` means the viewer fell behind the
     * kept output (or is new) and gets all of it; it replaces what the viewer shows. `ended` means the shell exited.
     * `limit` caps the characters one read returns: the oldest part of what follows `after`, or the newest of a reset.
     */
    async read(request) {
      const after = request?.after;
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid Terminal read.");
      const limit = request?.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < MIN_READ_LIMIT)) throw new Error("Invalid Terminal read.");
      const id = request?.terminalId;
      let terminal = typeof id === "string" && TERMINAL_ID.test(id) ? terminals.get(id) : null;
      if (!terminal || closed) return { offset: after, data: "", reset: false, ended: true };
      if (after === terminal.end && !terminal.exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, readWaitMs);
          timer.unref?.();
          function done() {
            clearTimeout(timer);
            terminal.waiters.delete(done);
            resolve();
          }
          terminal.waiters.add(done);
        });
      }
      const { reset, data } = since(terminal, after);
      const ended = terminal.exited || !terminals.has(terminal.id);
      if (limit && data.length > limit) {
        if (reset) return { offset: terminal.end, data: data.slice(tailStart(data, limit)), reset, ended, terminal: info(terminal) };
        const cut = headEnd(data, limit);
        // More is waiting, so the shell hasn't ended for this viewer yet.
        return { offset: after + cut, data: data.slice(0, cut), reset, ended: false, terminal: info(terminal) };
      }
      return { offset: terminal.end, data, reset, ended, terminal: info(terminal) };
    },
    async input(request) {
      const terminal = find(request);
      if (typeof request.data !== "string" || request.data.length > MAX_INPUT) throw new Error("Invalid Terminal input.");
      if (terminal.exited) return { accepted: false };
      terminal.pty.write(request.data);
      return { accepted: true };
    },
    async resize(request) {
      const terminal = find(request);
      const { cols, rows } = request;
      if (!Number.isSafeInteger(cols) || cols < 2 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 500)
        throw new Error("Invalid Terminal size.");
      if (terminal.exited || (cols === terminal.cols && rows === terminal.rows)) return null;
      terminal.cols = cols;
      terminal.rows = rows;
      try {
        terminal.pty.resize(cols, rows);
      } catch {
        /* The shell is exiting. */
      }
      return null;
    },
    async close(request) {
      kill(find(request));
      return null;
    },
    /** Ends every Terminal of a Chat, when it is archived. */
    closeChat(chatId) {
      for (const terminal of Array.from(terminals.values())) if (terminal.chatId === chatId) kill(terminal);
    },
    /** Each Chat's running shell pids, so ports their commands open count as the Chat's. */
    shells() {
      const result = new Map();
      for (const terminal of terminals.values()) {
        if (terminal.exited || !terminal.pty.pid) continue;
        if (!result.has(terminal.chatId)) result.set(terminal.chatId, []);
        result.get(terminal.chatId).push(terminal.pty.pid);
      }
      return result;
    },
    get size() {
      return terminals.size;
    },
    async dispose() {
      if (closed) return;
      for (const terminal of Array.from(terminals.values())) kill(terminal);
      closed = true;
      clearTimeout(titleTimer);
      titleTimer = null;
    },
  };
}

module.exports = { createTerminals, terminalEnvironment, terminalShell, terminalShells };

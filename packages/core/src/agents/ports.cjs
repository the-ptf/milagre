const { powershell, powershellEnvironment } = require("../private-files.cjs");
const { killWindowsTree } = require("./process-tree.cjs");
// The TCP ports each chat's agent has opened: dev servers, Metro, a database it started.
// A port belongs to a chat when the process listening on it was started by one of the agent's
// command shells. The agent CLI's other children (MCP servers) share its process group, while
// each command shell leads its own, so only a child that is a shell or leads its own group
// counts. A server that outlived its shell (`server &`) keeps the shell's group, so a chat
// remembers the groups it has seen and keeps showing their ports after the shell exits, and
// after the agent's session closes, until nothing in them runs any more. An unobserved orphan
// has no proven Chat owner. Sharing a working directory never grants ownership.
const { execFile } = require("node:child_process");

const POLL_MS = 3000;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "sandbox-exec"]);

const basename = (command) => command.split("/").pop().replace(/^-/, "");

/** `ps -axo pid=,ppid=,pgid=,comm=` as rows of { pid, ppid, pgid, command }. */
function parsePs(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const windows = /^@(\d+) (.*)$/.exec(match[4].trim());
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: windows ? windows[2] : match[4].trim(),
        ...(windows ? { startedAt: windows[1] } : {}),
      },
    ];
  });
}

/** `lsof -F pcn` listing TCP listeners, as rows of { pid, command, port, address }, one per pid and port. */
function parseLsof(output) {
  const rows = [];
  const seen = new Set();
  let pid = 0;
  let command = "";
  for (const line of output.split(/\r?\n/)) {
    const value = line.slice(1);
    if (line[0] === "p") pid = Number(value);
    else if (line[0] === "c") command = value;
    else if (line[0] === "n") {
      const match = /^(.*):(\d+)$/.exec(value);
      if (!match || !pid) continue;
      const port = Number(match[2]);
      if (seen.has(`${pid}:${port}`)) continue;
      seen.add(`${pid}:${port}`);
      rows.push({ pid, command, port, address: match[1].replace(/^\[|\]$/g, "") });
    }
  }
  return rows;
}

/**
 * The pids that belong to each chat's commands. `roots` maps a chat id to its agent's { pid, cwd } and its Terminals' `shells`
 * (absent once its session closed); `groups` maps a chat id to the process groups it has seen, and is
 * updated in place.
 */
function chatProcesses(processes, roots, groups) {
  const children = new Map();
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  for (const row of processes) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const result = new Map();
  const chats = new Set([...roots.keys(), ...groups.keys()]);
  for (const chatId of chats) {
    const known = groups.get(chatId) ?? new Set();
    const pids = new Set();
    const add = (row) => {
      const stack = [row];
      while (stack.length) {
        const next = stack.pop();
        if (pids.has(next.pid)) continue;
        pids.add(next.pid);
        stack.push(...(children.get(next.pid) ?? []));
      }
    };
    const root = byPid.get(roots.get(chatId)?.pid);
    if (root) {
      for (const child of children.get(root.pid) ?? []) {
        if (SHELLS.has(basename(child.command)) || child.pgid !== root.pgid) add(child);
      }
    }
    // A Terminal's shell and everything it started belong to its Chat.
    for (const pid of roots.get(chatId)?.shells ?? []) if (byPid.has(pid)) add(byPid.get(pid));
    for (const row of processes) if (known.has(row.pgid) && row.pgid !== root?.pgid) add(row);
    const live = new Set();
    for (const pid of pids) live.add(byPid.get(pid).pgid);
    // A group is forgotten once nothing in it runs.
    if (live.size) groups.set(chatId, live);
    else groups.delete(chatId);
    if (pids.size) result.set(chatId, pids);
  }
  return result;
}

/** Each chat's ports, sorted, from the listeners and each chat's pids. Chats with no ports are left out. */
function chatPorts(listeners, processesByChat) {
  const result = {};
  for (const [chatId, pids] of processesByChat) {
    const ports = new Map();
    for (const row of listeners) {
      if (!pids.has(row.pid) || ports.has(row.port)) continue;
      ports.set(row.port, { port: row.port, pid: row.pid, command: row.command, address: row.address });
    }
    if (ports.size) result[chatId] = [...ports.values()].sort((a, b) => a.port - b.port);
  }
  return result;
}

// ps runs every poll; lsof (the costly one) only when a chat's pids changed, or this often, to notice a
// listener that a long-lived process opened later.
const LSOF_MAX_AGE_MS = 10_000;

function samePorts(a, b) {
  const chats = Object.keys(a);
  if (chats.length !== Object.keys(b).length) return false;
  return chats.every((chatId) => {
    const left = a[chatId];
    const right = b[chatId];
    return (
      right &&
      left.length === right.length &&
      left.every(
        (port, index) =>
          port.port === right[index].port && port.pid === right[index].pid && port.command === right[index].command && port.address === right[index].address,
      )
    );
  });
}

const run = (command, args) =>
  new Promise((resolve) => {
    if (process.platform === "win32") {
      let script;
      if (command === "ps")
        script =
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {0} @{2} {3}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks,$_.Name }";
      else if (command === "lsof" && args.includes("-iTCP")) {
        const key = args[args.indexOf("-p") + 1];
        if (!/^\d+(,\d+)*$/.test(key)) return resolve("");
        script = `$wanted = @(${key}); Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $wanted -contains $_.OwningProcess } | ForEach-Object { 'p' + $_.OwningProcess; 'c' + (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; 'n' + $_.LocalAddress + ':' + $_.LocalPort }`;
      } else return resolve("");
      command = powershell();
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    }
    execFile(
      command,
      args,
      { ...(process.platform === "win32" ? { env: powershellEnvironment() } : {}), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
      (_error, stdout) => resolve(stdout ?? ""),
    );
  });

/**
 * Polls while any chat has an agent running or a group it has seen. `roots()` returns a Map of chat id
 * to its agent's { pid, cwd }; `publish(ports)` gets every chat's ports, { [chatId]: [{ port, pid, command, address }] },
 * whenever they change.
 */
class PortWatcher {
  constructor({
    platform = process.platform,
    stopWindowsTree = killWindowsTree,
    roots,
    publish,
    pollMs = POLL_MS,
    idlePollMs = 15_000,
    isRunning = () => true,
    exec = run,
    kill = (pid, signal) => process.kill(pid, signal),
    graceMs = 2000,
    now = Date.now,
    lsofMaxAgeMs = LSOF_MAX_AGE_MS,
  }) {
    Object.assign(this, { platform, stopWindowsTree, roots, publish, pollMs, idlePollMs, isRunning, exec, kill, graceMs, now, lsofMaxAgeMs });
    this.listeners = { key: null, at: -Infinity, rows: [] };
    this.groups = new Map();
    this.processes = new Map();
    this.windowsIdentities = new Map();
    this.ports = {};
    this.timer = null;
    // The poll under way, if any.
    this.polling = null;
  }

  /** Every chat's ports now. */
  snapshot() {
    return this.ports;
  }

  /** Starts polling, if it isn't already; call when an agent's turn starts. */
  wake() {
    if (this.closed || this.polling) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), 0);
    this.timer.unref?.();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Stops what listens on one of a chat's ports: the whole command it belongs to (its process group,
   * so `npm run dev` goes with its server), or the process alone when its group is the agent's own.
   * Only a pid the chat's list shows is stopped. SIGTERM first, SIGKILL if it is still there after
   * the grace period. Resolves with whether there was something to stop.
   */
  async stopPort(chatId, pid) {
    if (!this.ports[chatId]?.some((port) => port.pid === pid)) return false;
    if (this.platform === "win32") {
      await this.poll({ fresh: true });
      if (!this.ports[chatId]?.some((port) => port.pid === pid)) return false;
      const owned = this.groups.get(chatId);
      const agentPid = this.roots().get(chatId)?.pid;
      let target = this.processes.get(pid);
      if (!target || !owned?.has(pid) || target.startedAt !== this.windowsIdentities.get(pid)) return false;
      const seen = new Set([pid]);
      while (true) {
        const parent = this.processes.get(target.ppid);
        if (!parent || parent.pid === agentPid || !owned.has(parent.pid) || seen.has(parent.pid) || parent.startedAt !== this.windowsIdentities.get(parent.pid))
          break;
        seen.add(parent.pid);
        target = parent;
      }
      if (!target.startedAt) return false;
      await this.stopWindowsTree(target.pid, undefined, { expectedStartTime: target.startedAt });
      await this.poll({ fresh: true });
      return true;
    }
    const pgid = this.processes.get(pid)?.pgid;
    // A Terminal's shell leads its own group: stopping a port there must leave the Terminal open.
    const shellGroups = new Set((this.roots().get(chatId)?.shells ?? []).map((shell) => this.processes.get(shell)?.pgid));
    const target = pgid && this.groups.get(chatId)?.has(pgid) && !shellGroups.has(pgid) ? -pgid : pid;
    const signal = (name) => {
      try {
        this.kill(target, name);
        return true;
      } catch {
        return false;
      }
    };
    if (!signal("SIGTERM")) return false;
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline && signal(0)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (signal(0)) signal("SIGKILL");
    await this.poll({ fresh: true });
    return true;
  }

  /**
   * `fresh` re-reads listeners even if the chats' pids are unchanged, e.g. after stopping one. A fresh read asked for
   * while a poll runs waits for it and reads again: that poll may have read the processes before the change.
   */
  async poll({ fresh = false } = {}) {
    if (this.closed) return;
    if (this.polling) {
      if (!fresh) return;
      await this.polling;
      return this.poll({ fresh });
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.polling = this.read(fresh).finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** One read of the processes and their listeners; schedules the next poll. */
  async read(fresh) {
    const roots = this.roots();
    if (roots.size || this.groups.size) {
      const processes = parsePs(await this.exec("ps", ["-axo", "pid=,ppid=,pgid=,comm="]));
      if (this.platform === "win32") {
        const stillRunning = this.roots();
        for (const [chatId, root] of roots) if (stillRunning.get(chatId)?.pid !== root.pid) roots.delete(chatId);
        const current = new Map(processes.map((row) => [row.pid, row.startedAt]));
        for (const known of this.groups.values())
          for (const pid of known) {
            if (!current.get(pid) || current.get(pid) !== this.windowsIdentities.get(pid)) known.delete(pid);
          }
        this.windowsIdentities = current;
      }
      this.processes = new Map(processes.map((row) => [row.pid, row]));
      const byChat = chatProcesses(processes, roots, this.groups);
      const pids = [...new Set([...byChat.values()].flatMap((set) => [...set]))];
      this.set(chatPorts(await this.listenersOf(pids, fresh), byChat));
    } else this.set({});
    if (!this.closed && (this.roots().size || this.groups.size)) {
      this.timer = setTimeout(() => void this.poll(), this.isRunning() ? this.pollMs : this.idlePollMs);
      this.timer.unref?.();
    }
  }

  async listenersOf(pids, fresh) {
    if (!pids.length) {
      this.listeners = { key: null, at: -Infinity, rows: [] };
      return [];
    }
    const key = pids.sort((a, b) => a - b).join(",");
    if (!fresh && key === this.listeners.key && this.now() - this.listeners.at < this.lsofMaxAgeMs) return this.listeners.rows;
    const rows = parseLsof(await this.exec("lsof", ["-nP", "-a", "-p", key, "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]));
    this.listeners = { key, at: this.now(), rows };
    return rows;
  }

  set(ports) {
    if (this.closed) return;
    if (samePorts(ports, this.ports)) return;
    this.ports = ports;
    this.publish(ports);
  }
}

module.exports = { PortWatcher, chatPorts, chatProcesses, parseLsof, parsePs };

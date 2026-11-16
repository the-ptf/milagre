const { closeWindowsJob } = require("./windows-job.cjs");
const { execFile } = require("node:child_process");
const { powershell, powershellEnvironment } = require("../private-files.cjs");
// `descendants` also stops every process below the child that left its group (Antigravity's
// signalled, since an orphan's parent becomes launchd or init.
const POLL_MS = 50;

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function descendantsOf(pid, execFileImpl = execFile) {
  const stdout = await new Promise((resolve) => execFileImpl("ps", ["-A", "-o", "pid=,ppid=,pgid="], (error, out) => resolve(error ? "" : String(out))));
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const [child, parent, pgid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent) || !Number.isInteger(pgid)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ pid: child, pgid });
  }
  const found = [];
  const queue = [pid];
  while (queue.length) {
    for (const entry of children.get(queue.shift()) ?? []) {
      if (entry.pid === pid || found.some((other) => other.pid === entry.pid)) continue;
      found.push(entry);
      queue.push(entry.pid);
    }
  }
  return found;
}

async function killTree(child, { graceMs = 2000, platform = process.platform, execFileImpl = execFile, descendants = false } = {}) {
  if (platform === "win32" && (await closeWindowsJob(child))) return;
  const pid = child?.pid;
  if (!pid) return;
  if (platform === "win32") {
    const current = () => child.exitCode == null && child.signalCode == null && !child.killed;
    if (!current()) return;
    return killWindowsTree(pid, execFileImpl, { isRootCurrent: current });
  }
  const exited = () => child.exitCode !== null || child.signalCode != null;
  const others = descendants ? (await descendantsOf(pid, execFileImpl)).filter((entry) => entry.pgid !== pid) : [];
  const leaders = new Set(others.filter((entry) => entry.pgid === entry.pid).map((entry) => entry.pid));
  const othersAlive = () => others.some((entry) => (leaders.has(entry.pgid) ? groupAlive(entry.pgid) : isAlive(entry.pid)));
  const alive = () => groupAlive(pid) || !exited() || othersAlive();
  const signalOthers = (name) => {
    for (const entry of others) {
      try {
        process.kill(leaders.has(entry.pgid) ? -entry.pgid : entry.pid, name);
      } catch {}
    }
  };
  const signal = (name) => {
    signalOthers(name);
    try {
      process.kill(-pid, name);
      return;
    } catch (error) {
      if (error.code === "ESRCH" && exited()) return;
    }
    try {
      child.kill(name);
    } catch {}
  };
  if (!alive()) return;
  signal("SIGTERM");
  if (await waitForExit(alive, graceMs)) return;
  signal("SIGKILL");
  await waitForExit(alive, graceMs);
}

function waitForExit(alive, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const check = () => {
      if (!alive()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}

function killWindowsTree(pid, execFileImpl = execFile, { expectedStartTime, isRootCurrent = () => true } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error("Invalid process ID"));
  if (expectedStartTime !== undefined && !/^\d+$/.test(String(expectedStartTime))) return Promise.reject(new Error("Invalid process creation time"));
  const script = `$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process)
$seen = [Collections.Generic.HashSet[int]]::new()
$held = [Collections.Generic.List[System.Diagnostics.Process]]::new()
function Capture([int]$id, [long]$minimumStart) {
 if (-not $seen.Add($id)) { return }
 $row = $rows | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1
 if (-not $row) { return }
 $created = $row.CreationDate.ToUniversalTime().Ticks
 if ($created -lt $minimumStart) { return }
 $p = Get-Process -Id $id -ErrorAction SilentlyContinue
 if (-not $p) { return }
 try {
  [void]$p.Handle
   $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id)
  if ($p.HasExited -or -not $current -or $current.CreationDate.ToUniversalTime().Ticks -ne $created) { $p.Dispose(); return }
  ${expectedStartTime === undefined ? "" : `if ($id -eq ${pid} -and $created -ne [long]'${expectedStartTime}') { $p.Dispose(); return }`}
 } catch { $p.Dispose(); return }
 [void]$held.Add($p)
 foreach ($rowChild in $rows) { if ([int]$rowChild.ParentProcessId -eq $id) { Capture ([int]$rowChild.ProcessId) $created } }
}
try {
 Capture ${pid} 0
 if ($held.Count -eq 0) { [Console]::WriteLine('NOT_CURRENT'); exit 0 }
 [Console]::WriteLine('PINNED')
 if ([Console]::ReadLine() -ne 'STOP') { exit 0 }
 for ($i = $held.Count - 1; $i -ge 0; $i--) {
  $p = $held[$i]
  if (-not $p.HasExited) { try { $p.Kill(); [void]$p.WaitForExit(5000) } catch { if (-not $p.HasExited) { throw } } }
 }
} finally { foreach ($p in $held) { $p.Dispose() } }`;
  return new Promise((resolve, reject) => {
    let output = "";
    let approved = false;
    let allowed = false;
    const controller = execFileImpl(
      powershell(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: powershellEnvironment(), timeout: 15000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(allowed && String(stdout).includes("PINNED"))),
    );
    controller?.stdin?.on("error", () => {});
    controller?.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (!approved && output.includes("PINNED")) {
        approved = true;
        allowed = isRootCurrent();
        controller.stdin.end(allowed ? "STOP\n" : "ABORT\n");
      }
    });
  });
}
module.exports = { killTree, killWindowsTree };

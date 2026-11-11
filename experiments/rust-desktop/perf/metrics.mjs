/** macOS ps TIME: [[days-]hours:]minutes:seconds, with fractional seconds. */
export function cpuSeconds(value) {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(value);
  if (!match) throw new Error(`Unrecognized CPU time: ${value}`);
  const parts = match[2].split(":").map(Number);
  return Number(match[1] || 0) * 86400 + parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseProcesses(output) {
  const rows = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) throw new Error("Unexpected ps output; process measurements were not collected");
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKiB: Number(match[3]),
      cpuSeconds: cpuSeconds(match[4]),
      started: match[5],
      executable: match[6],
    });
  }
  return rows;
}

export function descendants(rows, root) {
  const found = new Set(root ? [root] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (found.has(row.parentPid) && !found.has(row.pid)) {
        found.add(row.pid);
        changed = true;
      }
  }
  return found;
}

export function summarize(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return { status: "unmeasured", count: 0, median: null, min: null, max: null };
  const middle = Math.floor(ordered.length / 2);
  return {
    status: "measured",
    count: ordered.length,
    median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    min: ordered[0],
    max: ordered.at(-1),
  };
}

const identity = (row) => `${row.pid}|${row.started}|${row.executable}`;
export function intervalCpu(previous, current, elapsedSeconds) {
  if (!previous || !current || elapsedSeconds <= 0) return { value: null, reason: "No preceding sample" };
  const before = new Map(previous.map((row) => [identity(row), row]));
  if (before.size !== current.length || current.some((row) => !before.has(identity(row))))
    return { value: null, reason: "Process membership changed during interval" };
  const delta = current.reduce((sum, row) => sum + row.cpuSeconds - before.get(identity(row)).cpuSeconds, 0);
  if (delta < 0) return { value: null, reason: "CPU counter decreased" };
  return { value: (delta / elapsedSeconds) * 100, reason: null };
}

export function selectProcessGroups(rows, { electronPid, rustPid, daemonPid, electronHelpers = [], rustHelpers = [], observerPid = null }) {
  const observerTree = descendants(rows, observerPid);
  rows = rows.filter((row) => !observerTree.has(row.pid));
  const daemonTree = descendants(rows, daemonPid);
  const rustTree = descendants(rows, rustPid);
  const electronTree = descendants(rows, electronPid);
  const electronOwnsDaemon = electronPid !== daemonPid && electronTree.has(daemonPid);
  const daemonOwnsElectron = electronPid !== daemonPid && daemonTree.has(electronPid);
  const electronHelperSet = new Set(electronHelpers);
  const rustHelperSet = new Set(rustHelpers);
  return {
    electronShell: rows.filter(
      (row) =>
        electronPid !== daemonPid &&
        (electronTree.has(row.pid) || electronHelperSet.has(row.pid)) &&
        !(electronOwnsDaemon && daemonTree.has(row.pid)) &&
        !rustTree.has(row.pid) &&
        !rustHelperSet.has(row.pid),
    ),
    rustShell: rows.filter((row) => rustTree.has(row.pid) || rustHelperSet.has(row.pid)),
    sharedDaemon: rows.filter((row) => row.pid === daemonPid),
    sharedDaemonChildren: rows.filter(
      (row) =>
        daemonTree.has(row.pid) &&
        row.pid !== daemonPid &&
        !(daemonOwnsElectron && electronTree.has(row.pid)) &&
        !electronHelperSet.has(row.pid) &&
        !rustTree.has(row.pid) &&
        !rustHelperSet.has(row.pid),
    ),
  };
}

// Read-only observation labels. A difference never identifies its writer.
export function installedApplications(listing) {
  const result = [];
  for (const line of listing.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    if (!match || !/\/Milagre(?: Rust)?\.app\/Contents\/MacOS\/[^/]+$/.test(match[4])) continue;
    result.push({ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3], executable: match[4] });
    if (result.length === 16) break;
  }
  return result;
}
export function preferenceObservation(before, after, processesBefore, processesAfter) {
  const content = (rows) => rows.map(({ path, absent, bytes, sha256 }) => ({ path, absent, bytes, sha256 }));
  const contentUnchanged = JSON.stringify(content(before)) === JSON.stringify(content(after));
  const metadataUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const readStable = [...before, ...after].every((row) => row.absent || row.readStable === true);
  const noisy = !contentUnchanged || !metadataUnchanged || !readStable;
  return {
    status: noisy ? "environment-noisy" : "no-change-observed",
    contentUnchanged,
    metadataUnchanged,
    readStable,
    attribution: "unattributed",
    isolationClaim: false,
    liveApplicationsObserved: processesBefore.applications.length > 0 || processesAfter.applications.length > 0,
    processMetadataAvailable: !processesBefore.error && !processesAfter.error,
    scope: "two preference files only; concurrent writers and other filesystem locations are not attributed",
  };
}

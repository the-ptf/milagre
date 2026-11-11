// Read-only observation labels. A difference never identifies its writer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

// File operations are injectable only for deterministic concurrent-writer tests.
export async function preferenceFingerprint(path, files = { lstat, readFile }) {
  try {
    const info = await files.lstat(path);
    assert.ok(info.isFile() && info.size <= 1024 * 1024, "Preference observation bound");
    const bytes = await files.readFile(path);
    const after = await files.lstat(path);
    return {
      path,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      device: info.dev,
      inode: info.ino,
      readStable:
        info.dev === after.dev &&
        info.ino === after.ino &&
        info.mtimeMs === after.mtimeMs &&
        info.ctimeMs === after.ctimeMs &&
        info.size === after.size &&
        bytes.length === info.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path, absent: true };
    throw error;
  }
}
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
export function fixtureFailure(entry) {
  const failed = entry.report?.stages?.find((stage) => stage.passed !== true || stage.captureError);
  const reason = entry.timedOut
    ? "external observer timeout; shell was signalled, orderly completion is not proven"
    : failed?.error || failed?.captureError || entry.report?.ownerStop?.error?.code || entry.status?.error || "native report did not pass";
  return {
    reason: String(reason).slice(0, 512),
    phase: failed?.phase ?? null,
    stage: failed?.send?.stage ?? failed?.nativeDocumentProbe?.sendProbe?.stage ?? null,
    exitCode: entry.status?.code ?? null,
    signal: entry.status?.signal ?? null,
    timedOut: entry.timedOut === true,
  };
}

export type DiffLine = { kind: "context" | "add" | "remove"; text: string; oldNumber?: number; newNumber?: number };
export type DiffHunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses one file's unified patch. File headers, binary notices and "\ No newline" markers are dropped. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const rows = patch.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  for (const raw of rows) {
    const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = HUNK_HEADER.exec(row);
    // Counts decide where a hunk ends, so a removed line that reads "-- x" is not mistaken for a "---" file header.
    const open = hunk !== undefined && (oldLeft > 0 || newLeft > 0);
    if (match && !open) {
      oldNumber = Number(match[1]);
      newNumber = Number(match[3]);
      oldLeft = match[2] === undefined ? 1 : Number(match[2]);
      newLeft = match[4] === undefined ? 1 : Number(match[4]);
      hunk = { header: row, oldStart: oldNumber, oldLines: oldLeft, newStart: newNumber, newLines: newLeft, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || !open || row.startsWith("\\")) continue;
    const marker = row[0];
    const text = row.slice(1);
    if (marker === "+" && newLeft > 0) {
      hunk.lines.push({ kind: "add", text, newNumber: newNumber++ });
      newLeft--;
    } else if (marker === "-" && oldLeft > 0) {
      hunk.lines.push({ kind: "remove", text, oldNumber: oldNumber++ });
      oldLeft--;
    } else if ((marker === " " || row === "") && oldLeft > 0 && newLeft > 0) {
      // Some tools strip the single space of an empty context line.
      hunk.lines.push({ kind: "context", text, oldNumber: oldNumber++, newNumber: newNumber++ });
      oldLeft--;
      newLeft--;
    }
  }
  return hunks;
}

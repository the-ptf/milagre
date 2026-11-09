/** A user message cut into plain text and the fenced code blocks in it. */
export type MessagePart = { kind: "text"; text: string } | { kind: "code"; fence: string; code: string };

// A fence opens at the start of a line and closes on a line of its own; an unclosed one stays text.
const FENCE = /^```([^\n`]*)\n([\s\S]*?)\n```[ \t]*$/gm;

export function splitFences(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of body.matchAll(FENCE)) {
    const start = match.index ?? 0;
    // The newlines around a fence belong to the block, not to the text beside it.
    const before = body.slice(last, start).replace(/\n$/, "");
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "code", fence: (match[1] ?? "").trim(), code: match[2] ?? "" });
    last = start + match[0].length;
    if (body[last] === "\n") last += 1;
  }
  const rest = body.slice(last);
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}

/** Diff rows (`+`, `-` or ` ` then the code) when every line has a marker and something changed, else null. */
export function diffRows(code: string): { kind: "add" | "remove" | "context"; text: string }[] | null {
  const lines = code.split("\n");
  if (!lines.every((line) => /^[+\- ]/.test(line)) || !lines.some((line) => /^[+-]/.test(line))) return null;
  return lines.map((line) => ({ kind: line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context", text: line.slice(1) }));
}

import type { PromptPart } from "@milagre/shared/prompt-parts";
import { splitProvisional, type Selection } from "@milagre/shared/voice-dictation";

/**
 * The prompt editor's text model. The draft is a plain string; the editor's DOM is text nodes, `<br>` for line breaks
 * and atomic chips (`<span contenteditable="false" data-chip data-text="/frontend-design">`) that count as their
 * `data-text`. A `<br>` that closes its block (the editor always ends in one, so an empty last line can hold the caret)
 * counts as nothing; blocks a browser leaves behind count as line breaks. Pure over the few node fields it reads, so it
 * runs without a DOM.
 */
export interface EditorNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<EditorNode>;
  readonly parentNode: EditorNode | null;
  getAttribute?(name: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** Rendered after a chip that ends its line so the caret has a text position there; never part of the draft. */
export const FILLER = "\u200B";

// Filler text nodes are known by identity, not by character: a U+200B the user typed or pasted is text like any other.
const fillers = new WeakSet<EditorNode>();

/** Registers a text node the editor rendered as a filler. Its leading U+200B counts nothing. */
export function markFiller(node: EditorNode) {
  fillers.add(node);
}

// How many leading characters of a text node are the filler's (anything a browser typed into it stays).
function fillerWidth(node: EditorNode, raw: string) {
  return fillers.has(node) && raw.startsWith(FILLER) ? 1 : 0;
}

const BLOCKS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);

/** A chip's source text, or null for anything else. */
function chipSource(node: EditorNode): string | null {
  return node.nodeType === ELEMENT_NODE ? (node.getAttribute?.("data-text") ?? null) : null;
}

function isBlock(node: EditorNode) {
  return node.nodeType === ELEMENT_NODE && BLOCKS.has(node.nodeName);
}

// The break that ends its block, or comes right before a block, renders no line of its own.
function isClosingBreak(node: EditorNode, parent: EditorNode, parentIsBlock: boolean) {
  const siblings = parent.childNodes;
  let index = Array.prototype.indexOf.call(siblings, node) as number;
  for (index += 1; index < siblings.length; index++) {
    const next = siblings[index];
    if (!next) continue;
    if (next.nodeType === TEXT_NODE && !next.nodeValue) continue;
    return isBlock(next);
  }
  return parentIsBlock;
}

function contains(ancestor: EditorNode, node: EditorNode | null) {
  for (let current = node; current; current = current.parentNode) if (current === ancestor) return true;
  return false;
}

type Point = { node: EditorNode; offset: number };

class Stop extends Error {}

/** The text of `root`, or of its start up to `stop`. */
function serialize(root: EditorNode, stop?: Point): string {
  let out = "";
  // Whether anything came before (an empty line counts), and whether a block just ended so inline content starts a line.
  let started = false;
  let pendingLine = false;
  const flush = () => {
    if (pendingLine) out += "\n";
    pendingLine = false;
    started = true;
  };
  const visit = (container: EditorNode, containerIsBlock: boolean) => {
    const children = container.childNodes;
    for (let index = 0; index <= children.length; index++) {
      if (stop && stop.node === container && stop.offset === index) throw new Stop();
      if (index === children.length) break;
      const node = children[index];
      if (!node) continue;
      if (node.nodeType === TEXT_NODE) {
        const raw = node.nodeValue ?? "";
        if (raw) flush();
        if (stop && stop.node === node) {
          const skip = fillerWidth(node, raw);
          out += raw.slice(skip, Math.max(skip, Math.min(stop.offset, raw.length)));
          throw new Stop();
        }
        out += raw.slice(fillerWidth(node, raw));
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const source = chipSource(node);
      if (source !== null) {
        flush();
        out += source;
        if (stop && contains(node, stop.node)) throw new Stop();
        continue;
      }
      if (node.nodeName === "BR") {
        flush();
        if (!isClosingBreak(node, container, containerIsBlock)) out += "\n";
        continue;
      }
      if (isBlock(node)) {
        if (started) out += "\n";
        pendingLine = false;
        started = true;
        visit(node, true);
        pendingLine = true;
        continue;
      }
      visit(node, false);
    }
  };
  try {
    visit(root, true);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return out;
}

/** The draft text the DOM under `root` spells. */
export function textOf(root: EditorNode): string {
  return serialize(root);
}

/** A DOM position (as a Selection reports it) as an offset into the draft. Inside a chip counts as just past it. */
export function domOffsetToText(root: EditorNode, node: EditorNode, offset: number): number {
  if (!contains(root, node)) return serialize(root).length;
  return serialize(root, { node, offset }).length;
}

/** The DOM position for an offset into the draft: in a text node where there is one, else between nodes, never in a chip. */
export function textOffsetToDom(root: EditorNode, offset: number): Point {
  let position = 0;
  let started = false;
  let pendingLine = false;
  let found: Point | null = null;
  const flush = () => {
    if (pendingLine) position += 1;
    pendingLine = false;
    started = true;
  };
  const visit = (container: EditorNode, containerIsBlock: boolean): boolean => {
    const children = container.childNodes;
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      if (!node) continue;
      if (node.nodeType === TEXT_NODE) {
        const raw = node.nodeValue ?? "";
        if (!raw) continue;
        const skip = fillerWidth(node, raw);
        const length = raw.length - skip;
        flush();
        if (offset <= position + length) {
          found = { node, offset: skip + Math.max(0, offset - position) };
          return true;
        }
        position += length;
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue;
      const source = chipSource(node);
      if (source !== null) {
        flush();
        if (offset <= position) {
          found = { node: container, offset: index };
          return true;
        }
        position += source.length;
        // Right after the chip: in the text that follows it when there is some (the filler), else between nodes.
        const next = children[index + 1];
        if (offset <= position && !(offset === position && next?.nodeType === TEXT_NODE && next.nodeValue)) {
          found = { node: container, offset: index + 1 };
          return true;
        }
        continue;
      }
      if (node.nodeName === "BR") {
        flush();
        if (offset <= position) {
          found = { node: container, offset: index };
          return true;
        }
        if (!isClosingBreak(node, container, containerIsBlock)) position += 1;
        continue;
      }
      if (isBlock(node)) {
        if (started) position += 1;
        pendingLine = false;
        started = true;
        if (visit(node, true)) return true;
        pendingLine = true;
        continue;
      }
      if (visit(node, false)) return true;
    }
    return false;
  };
  visit(root, true);
  return found ?? { node: root, offset: root.childNodes.length };
}

export type EditorPiece =
  | { kind: "text"; text: string; provisional?: boolean }
  | { kind: "break" }
  | { kind: "filler" }
  | { kind: "chip"; part: Exclude<PromptPart, { kind: "text" }> };

/**
 * What the editor renders for `value`: its parts, split at line breaks, a filler after each chip that ends a line, and
 * the closing break. `provisional` is the range a dictation take may still rewrite; its text is cut into pieces of its
 * own so the editor can tint it without changing a character of the draft.
 */
export function editorLayout(value: string, parts: readonly PromptPart[], provisional: Selection | null = null): EditorPiece[] {
  const usable = parts.map((part) => part.text).join("") === value ? parts : [{ kind: "text" as const, text: value }];
  const pieces: EditorPiece[] = [];
  for (const piece of splitProvisional(usable, provisional)) {
    const part = piece.part;
    if (part.kind !== "text") {
      pieces.push({ kind: "chip", part });
      continue;
    }
    piece.text.split("\n").forEach((line, index) => {
      if (index > 0) pieces.push({ kind: "break" });
      if (line) pieces.push(piece.provisional ? { kind: "text", text: line, provisional: true } : { kind: "text", text: line });
    });
  }
  pieces.push({ kind: "break" });
  // A caret after a non-editable chip at the end of a line has no text position, and Chrome moves it to the line's start.
  return pieces.flatMap((piece, index) => (piece.kind === "chip" && pieces[index + 1]?.kind !== "text" ? [piece, { kind: "filler" as const }] : [piece]));
}

type Range = { start: number; end: number };

function chipRanges(parts: readonly PromptPart[]): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  for (const part of parts) {
    if (part.kind !== "text") ranges.push({ start: offset, end: offset + part.text.length });
    offset += part.text.length;
  }
  return ranges;
}

/** Widens a range so it takes whole chips; `chip` says whether it touches one. */
function snap(parts: readonly PromptPart[], start: number, end: number): Range & { chip: boolean } {
  let chip = false;
  for (const range of chipRanges(parts)) {
    if (start < range.end && end > range.start) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
      chip = true;
    }
  }
  return { start, end, chip };
}

export type EditResult = { value: string; caret: number; chip: boolean };

/** Puts `text` in place of the range, taking whole chips the range cuts into. */
export function replaceRange(value: string, parts: readonly PromptPart[], start: number, end: number, text: string): EditResult {
  const range = snap(parts, Math.min(start, end), Math.max(start, end));
  return { value: value.slice(0, range.start) + text + value.slice(range.end), caret: range.start + text.length, chip: range.chip };
}

/** Backspace: the selection, else the chip that ends at the caret, else one character. Null when there's nothing to delete. */
export function deleteBackward(value: string, parts: readonly PromptPart[], start: number, end: number): EditResult | null {
  if (start !== end) return replaceRange(value, parts, start, end, "");
  if (start <= 0) return null;
  const chip = chipRanges(parts).find((range) => range.end === start || (range.start < start && start < range.end));
  if (chip) return replaceRange(value, parts, chip.start, chip.end, "");
  const code = value.charCodeAt(start - 1);
  const width = code >= 0xdc00 && code <= 0xdfff && start >= 2 ? 2 : 1;
  return replaceRange(value, parts, start - width, start, "");
}

/** Delete: the selection, else the chip that starts at the caret, else one character. */
export function deleteForward(value: string, parts: readonly PromptPart[], start: number, end: number): EditResult | null {
  if (start !== end) return replaceRange(value, parts, start, end, "");
  if (start >= value.length) return null;
  const chip = chipRanges(parts).find((range) => range.start === start || (range.start < start && start < range.end));
  if (chip) return replaceRange(value, parts, chip.start, chip.end, "");
  const code = value.charCodeAt(start);
  const width = code >= 0xd800 && code <= 0xdbff && start + 1 < value.length ? 2 : 1;
  return replaceRange(value, parts, start, start + width, "");
}

/** Where Left (-1) or Right (+1) takes a collapsed caret: over a whole chip, or one character (a surrogate pair is one). */
export function caretStep(value: string, parts: readonly PromptPart[], caret: number, direction: -1 | 1): number {
  const chip = chipRanges(parts).find((range) => (direction < 0 ? range.end === caret : range.start === caret));
  if (chip) return direction < 0 ? chip.start : chip.end;
  if (direction < 0) {
    if (caret <= 0) return 0;
    const code = value.charCodeAt(caret - 1);
    return caret - (code >= 0xdc00 && code <= 0xdfff && caret >= 2 ? 2 : 1);
  }
  if (caret >= value.length) return value.length;
  const code = value.charCodeAt(caret);
  return caret + (code >= 0xd800 && code <= 0xdbff && caret + 1 < value.length ? 2 : 1);
}

export type EditorState = { value: string; caret: number };
export type EditKind = "type" | "delete" | "chip" | "paste" | "other";

const COALESCE_MS = 500;

/** The editor's own undo stack: typing (or deleting) within 500 ms of the last keystroke joins one step; everything else is a step. */
export function createEditHistory(now: () => number = Date.now) {
  let undo: EditorState[] = [];
  let redo: EditorState[] = [];
  let last: { kind: EditKind; at: number } | null = null;
  return {
    /** Call before applying an edit, with the state it replaces. */
    record(before: EditorState, kind: EditKind) {
      const at = now();
      const joins = last && last.kind === kind && (kind === "type" || kind === "delete") && at - last.at < COALESCE_MS;
      if (!joins) undo.push(before);
      if (undo.length > 200) undo = undo.slice(-200);
      redo = [];
      last = { kind, at };
    },
    undo(current: EditorState): EditorState | null {
      const previous = undo.pop();
      if (!previous) return null;
      redo.push(current);
      last = null;
      return previous;
    },
    redo(current: EditorState): EditorState | null {
      const next = redo.pop();
      if (!next) return null;
      undo.push(current);
      last = null;
      return next;
    },
    clear() {
      undo = [];
      redo = [];
      last = null;
    },
  };
}

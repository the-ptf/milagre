import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, Ref } from "react";
import { createPortal } from "react-dom";
import type { PromptPart } from "@milagre/shared/prompt-parts";
import {
  caretStep,
  createEditHistory,
  deleteBackward,
  deleteForward,
  domOffsetToText,
  editorLayout,
  FILLER,
  markFiller,
  replaceRange,
  textOf,
  textOffsetToDom,
  type EditKind,
  type EditResult,
} from "../lib/editor-model";
import { useChatMentions } from "./ChatMentions";
import { ChatChip, FileChip, ImageChip, SkillChip } from "./PromptChip";

export type PromptEditorHandle = {
  focus(): void;
  setSelection(start: number, end?: number): void;
  getSelection(): { start: number; end: number };
  isCaretOnFirstLine(): boolean;
  isCaretOnLastLine(): boolean;
  /** The editable element, for measuring. */
  readonly root: HTMLDivElement | null;
};

interface PromptEditorProps {
  value: string;
  onChange(value: string, caret: number): void;
  /** `value` split into text, skills and files; chips render for the skills and files. Parts that don't spell `value` are ignored. */
  parts: PromptPart[];
  placeholder: string;
  suggestion?: string;
  disabled: boolean;
  maxHeight: number;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  /** Runs first; when it calls preventDefault (an image or file paste) the editor inserts nothing. */
  onPaste(event: ClipboardEvent<HTMLDivElement>): void;
  onSelect(caret: number): void;
  /** Skill name (lowercase) to description, shown when hovering a skill chip. */
  skillDescriptions: ReadonlyMap<string, string>;
  /** Opens the attached image an image chip (1-based) stands for. */
  onOpenImage?(index: number): void;
  /** The Chat the draft belongs to; a new key starts a new undo history. */
  resetKey?: string;
  /** The range a dictation take may still rewrite. Its text is tinted; the draft itself is untouched. */
  provisional?: { start: number; end: number } | null;
  label?: string;
  className?: string;
  placeholderClassName?: string;
  ref?: Ref<PromptEditorHandle>;
}

type Selection = { start: number; end: number };
type Chip = { key: string; host: HTMLSpanElement; part: Exclude<PromptPart, { kind: "text" }> };

const DELETE_RANGE_TYPES = new Set([
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteEntireSoftLine",
  "deleteContent",
  "deleteByCut",
]);

/** Text from a paste or drop: plain text, else the text of the HTML; line endings normalized. */
function plainText(data: DataTransfer | null): string {
  if (!data) return "";
  let text = data.getData("text/plain");
  if (!text) {
    const html = data.getData("text/html");
    // An inert document: nothing in it runs or loads.
    if (html) text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  }
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The composer's prompt field: a contenteditable that shows skills and files as atomic chips while the draft stays a
 * plain string. Every edit goes through `beforeinput` against the string and the DOM is rendered again from it, so the
 * two never drift; only an IME composition edits the DOM directly, and it is read back once when it ends. Undo is the
 * editor's own (the browser's would undo the re-rendering, not the edit).
 */
export function PromptEditor({
  value,
  onChange,
  parts,
  placeholder,
  suggestion,
  disabled,
  maxHeight,
  onKeyDown,
  onPaste,
  onSelect,
  skillDescriptions,
  onOpenImage,
  resetKey,
  provisional = null,
  label = "Prompt",
  className = "",
  placeholderClassName = "",
  ref,
}: PromptEditorProps) {
  const mentions = useChatMentions();
  const rootRef = useRef<HTMLDivElement>(null);
  const [history] = useState(() => createEditHistory());
  const [chips, setChips] = useState<Chip[]>([]);
  const [composing, setComposing] = useState(false);
  // Bumped to render the DOM again from the draft, after a composition or an edit made behind the editor's back.
  const [renders, setRenders] = useState(0);

  // The latest props, for listeners that live as long as the element.
  const live = useRef({ value, parts, onChange, onSelect, disabled });
  live.current = { value, parts, onChange, onSelect, disabled };
  // The draft this editor last handed to onChange; any other new value came from outside (a pick, history, a restore).
  const emitted = useRef<string | null>(null);
  const shown = useRef(value);
  const selection = useRef<Selection>({ start: value.length, end: value.length });
  // Where the caret goes once the DOM shows the next draft.
  const pending = useRef<Selection | null>({ start: value.length, end: value.length });
  const composition = useRef<{ value: string; range: Selection } | null>(null);
  const dragged = useRef<Selection | null>(null);
  const pointerDown = useRef(false);
  // The selection this editor last put in the DOM; its own selectionchange isn't the user moving the caret.
  const placed = useRef<Selection | null>(null);
  const hosts = useRef(new Map<string, HTMLSpanElement>());

  const layout = useMemo(() => editorLayout(value, parts, provisional), [value, parts, provisional]);
  // Re-render only when what is shown changes, not on every new `parts` array (that would reset a drag selection).
  const signature = JSON.stringify(layout);

  function focused() {
    return document.activeElement === rootRef.current;
  }

  function readSelection(): Selection {
    const root = rootRef.current;
    const current = window.getSelection();
    if (!root || !current || current.rangeCount === 0 || !current.anchorNode || !root.contains(current.anchorNode)) return selection.current;
    const anchor = domOffsetToText(root, current.anchorNode, current.anchorOffset);
    const focus = current.focusNode ? domOffsetToText(root, current.focusNode, current.focusOffset) : anchor;
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  function placeSelection(next: Selection) {
    const root = rootRef.current;
    const length = live.current.value.length;
    const clamped = { start: Math.max(0, Math.min(next.start, length)), end: Math.max(0, Math.min(next.end, length)) };
    selection.current = clamped;
    if (!root || !focused()) return;
    placed.current = clamped;
    const start = textOffsetToDom(root, clamped.start);
    const end = clamped.end === clamped.start ? start : textOffsetToDom(root, clamped.end);
    const range = document.createRange();
    range.setStart(start.node as Node, start.offset);
    range.setEnd(end.node as Node, end.offset);
    const current = window.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
    revealCaret(root, range);
  }

  function emit(next: string, caret: number) {
    pending.current = { start: caret, end: caret };
    selection.current = { start: caret, end: caret };
    if (next === live.current.value) {
      placeSelection(pending.current);
      pending.current = null;
      return;
    }
    emitted.current = next;
    live.current.onChange(next, caret);
  }

  function commit(result: EditResult | null, kind: EditKind, before: Selection) {
    if (!result || live.current.disabled) return;
    history.record({ value: live.current.value, caret: before.start }, result.chip ? "chip" : kind);
    emit(result.value, result.caret);
  }

  function step(direction: "undo" | "redo") {
    const current = { value: live.current.value, caret: readSelection().start };
    const next = direction === "undo" ? history.undo(current) : history.redo(current);
    if (next) emit(next.value, next.caret);
  }

  // A new draft from outside is one undo step; an emptied draft (sent, cleared) starts over. The caret goes to the end,
  // as a textarea's does, unless the composer places it.
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = value;
    if (previous === value) return;
    if (emitted.current === value) {
      emitted.current = null;
      return;
    }
    emitted.current = null;
    if (value) history.record({ value: previous, caret: selection.current.start }, "chip");
    else history.clear();
    pending.current ??= { start: value.length, end: value.length };
  }, [value, history]);

  // Undo never reaches into another Chat's draft. Runs after the effect above, which recorded the switch itself.
  const historyKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (historyKey.current === resetKey) return;
    historyKey.current = resetKey;
    history.clear();
    // A Chat switch restores its draft even when it has the same text as the previous Chat.
    emitted.current = null;
    pending.current = { start: value.length, end: value.length };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a Chat switch resets the caret.
  }, [resetKey, history]);

  // Render the DOM from the draft, then put the caret back.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composition.current) return;
    const restore = pending.current ?? (focused() ? readSelection() : selection.current);
    pending.current = null;
    const reuse = hosts.current;
    const nextHosts = new Map<string, HTMLSpanElement>();
    const nextChips: Chip[] = [];
    const seen = new Map<string, number>();
    const nodes = layout.map((piece) => {
      if (piece.kind === "text") {
        const text = document.createTextNode(piece.text);
        // A dictation take's revisable tail: an inline span, so the draft's text offsets are exactly what they were.
        if (!piece.provisional) return text;
        const tail = document.createElement("span");
        tail.dataset.provisional = "";
        tail.className = "rounded-inline bg-hover text-ink-2";
        tail.append(text);
        return tail;
      }
      if (piece.kind === "break") return document.createElement("br");
      if (piece.kind === "filler") {
        const filler = document.createTextNode(FILLER);
        markFiller(filler);
        return filler;
      }
      const base = `${piece.part.kind}:${piece.part.text}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const key = `${base}#${count}`;
      let host = reuse.get(key);
      if (!host) {
        host = document.createElement("span");
        host.contentEditable = "false";
        host.dataset.chip = "";
        host.dataset.text = piece.part.text;
      }
      nextHosts.set(key, host);
      nextChips.push({ key, host, part: piece.part });
      return host;
    });
    hosts.current = nextHosts;
    root.replaceChildren(...nodes);
    setChips((current) => (current.length === nextChips.length && current.every((chip, index) => chip.host === nextChips[index]?.host) ? current : nextChips));
    placeSelection(restore);
    // An unfocused restored draft also opens on its last line, ready for the next click.
    if (restore.start === value.length && restore.end === value.length) root.scrollTop = root.scrollHeight;
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for `layout`.
  }, [signature, renders, resetKey]);

  // Expanding the composer changes its text metrics after the draft was restored. Reveal the end at its final size.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const end = live.current.value.length;
    if (root && selection.current.start === end && selection.current.end === end) root.scrollTop = root.scrollHeight;
  }, [className, maxHeight]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const beforeInput = (event: InputEvent) => {
      // A composition edits the DOM itself; it is read back when it ends.
      if (event.isComposing || event.inputType === "insertCompositionText" || composition.current) return;
      event.preventDefault();
      if (live.current.disabled) return;
      const { value: draft, parts: current } = live.current;
      const before = readSelection();
      const target = event.getTargetRanges()[0];
      const targetRange = target
        ? {
            start: domOffsetToText(root, target.startContainer, target.startOffset),
            end: domOffsetToText(root, target.endContainer, target.endOffset),
          }
        : before;
      const type = event.inputType;
      if (type === "insertText") return commit(replaceRange(draft, current, before.start, before.end, event.data ?? ""), "type", before);
      if (type === "insertReplacementText") {
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        return commit(replaceRange(draft, current, targetRange.start, targetRange.end, text), "other", before);
      }
      if (type === "insertLineBreak" || type === "insertParagraph") return commit(replaceRange(draft, current, before.start, before.end, "\n"), "type", before);
      if (type === "insertFromPaste" || type === "insertFromYank" || type === "insertFromPasteAsQuotation")
        return commit(replaceRange(draft, current, before.start, before.end, plainText(event.dataTransfer)), "paste", before);
      if (type === "deleteByDrag") {
        dragged.current = targetRange.start === targetRange.end ? before : targetRange;
        return;
      }
      if (type === "insertFromDrop") {
        const text = plainText(event.dataTransfer);
        const source = dragged.current;
        dragged.current = null;
        if (!text) return;
        let at = targetRange.start;
        let base = draft;
        let baseParts = current;
        if (source && source.start !== source.end && (at <= source.start || at >= source.end)) {
          // Moving text within the field: take it out, then put it in where it was dropped.
          const removed = replaceRange(draft, current, source.start, source.end, "");
          if (at >= source.end) at -= draft.length - removed.value.length;
          base = removed.value;
          baseParts = [{ kind: "text", text: base }];
        }
        return commit(replaceRange(base, baseParts, at, at, text), "paste", before);
      }
      if (type === "deleteContentBackward") return commit(deleteBackward(draft, current, before.start, before.end), "delete", before);
      if (type === "deleteContentForward") return commit(deleteForward(draft, current, before.start, before.end), "delete", before);
      if (DELETE_RANGE_TYPES.has(type)) {
        const range = before.start !== before.end ? before : targetRange;
        if (range.start === range.end) return;
        return commit(replaceRange(draft, current, range.start, range.end, ""), "delete", before);
      }
      if (type === "historyUndo") return step("undo");
      if (type === "historyRedo") return step("redo");
      // Formatting and anything else: the draft is plain text.
    };
    const compositionStart = () => {
      composition.current = { value: live.current.value, range: readSelection() };
      setComposing(true);
    };
    const compositionEnd = (event: CompositionEvent) => {
      const started = composition.current;
      composition.current = null;
      setComposing(false);
      if (!started) return;
      let next = textOf(root);
      let caret = readSelection().start;
      // The composed text was not put in the field (a synthetic or abandoned composition): insert what it committed.
      if (next === started.value && event.data) {
        const result = replaceRange(started.value, live.current.parts, started.range.start, started.range.end, event.data);
        next = result.value;
        caret = result.caret;
      }
      if (next !== started.value && !live.current.disabled) {
        history.record({ value: started.value, caret: started.range.start }, "type");
        emit(next, caret);
      } else pending.current = started.range;
      setRenders((count) => count + 1);
    };
    // An edit no beforeinput handler took (execCommand, an extension): read the field back.
    const input = (event: Event) => {
      if (composition.current || (event as InputEvent).inputType === "insertCompositionText") return;
      const next = textOf(root);
      if (next !== live.current.value && !live.current.disabled) {
        history.record({ value: live.current.value, caret: selection.current.start }, "other");
        emit(next, readSelection().start);
      }
      setRenders((count) => count + 1);
    };
    const selectionChange = () => {
      // Until the DOM shows a draft this editor handed out, the DOM's selection is about the old one.
      if (composition.current || !focused() || emitted.current !== null) return;
      const next = readSelection();
      const own = placed.current;
      placed.current = null;
      // A caret the editor placed (after a draft set from outside) isn't the user moving it: a restored "/undo" must
      // not open the slash menu, as a textarea's value change doesn't.
      if (own && own.start === next.start && own.end === next.end) return;
      pending.current = null;
      if (next.start === selection.current.start && next.end === selection.current.end) return;
      selection.current = next;
      live.current.onSelect(next.start);
    };
    // Tools that drive a textarea read and set `.value`; the field answers the same way.
    Object.defineProperty(root, "value", {
      configurable: true,
      get: () => live.current.value,
      set: (next: unknown) => {
        if (live.current.disabled) return;
        const text = String(next ?? "");
        history.record({ value: live.current.value, caret: selection.current.start }, "other");
        emit(text, text.length);
      },
    });
    root.addEventListener("beforeinput", beforeInput);
    root.addEventListener("compositionstart", compositionStart);
    root.addEventListener("compositionend", compositionEnd);
    root.addEventListener("input", input);
    document.addEventListener("selectionchange", selectionChange);
    return () => {
      root.removeEventListener("beforeinput", beforeInput);
      root.removeEventListener("compositionstart", compositionStart);
      root.removeEventListener("compositionend", compositionEnd);
      root.removeEventListener("input", input);
      document.removeEventListener("selectionchange", selectionChange);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads the latest props through `live`.
  }, [history]);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        rootRef.current?.focus();
        placeSelection(selection.current);
      },
      setSelection(start: number, end = start) {
        pending.current = { start, end };
        placeSelection({ start, end });
      },
      getSelection: readSelection,
      isCaretOnFirstLine() {
        const { start, end } = readSelection();
        return start === end && !live.current.value.slice(0, start).includes("\n");
      },
      isCaretOnLastLine() {
        const { start, end } = readSelection();
        return start === end && !live.current.value.slice(end).includes("\n");
      },
      get root() {
        return rootRef.current;
      },
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the handle reads refs only.
    [],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || composition.current) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      step(event.shiftKey ? "redo" : "undo");
    } else if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      step("redo");
    } else if (!mod && !event.altKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      // Over a chip in one press, and past the filler after it without a press of its own.
      event.preventDefault();
      const { start, end } = readSelection();
      const left = event.key === "ArrowLeft";
      const caret = start !== end ? (left ? start : end) : caretStep(live.current.value, live.current.parts, start, left ? -1 : 1);
      placeSelection({ start: caret, end: caret });
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    onPaste(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    const text = plainText(event.clipboardData);
    if (!text) return;
    const before = readSelection();
    commit(replaceRange(live.current.value, live.current.parts, before.start, before.end, text), "paste", before);
  }

  function copySelection(event: ClipboardEvent<HTMLDivElement>, cut: boolean) {
    const before = readSelection();
    if (before.start === before.end) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", live.current.value.slice(before.start, before.end));
    if (cut) commit(replaceRange(live.current.value, live.current.parts, before.start, before.end, ""), "other", before);
  }

  return (
    <div className="relative min-w-0 w-full">
      <div
        ref={rootRef}
        data-prompt-editor
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-placeholder={suggestion ? `Suggested: ${suggestion}. Tab to use it.` : placeholder}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        spellCheck
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        onPointerDown={() => {
          pointerDown.current = true;
        }}
        onFocus={() => {
          // Focus from code (a shortcut, a closed find bar) comes back to the caret; a click places its own.
          if (!pointerDown.current) placeSelection(selection.current);
          pointerDown.current = false;
        }}
        onBlur={() => {
          pointerDown.current = false;
        }}
        onPaste={handlePaste}
        onCopy={(event) => copySelection(event, false)}
        onCut={(event) => copySelection(event, true)}
        // A text field scrolls itself like the textarea it replaces (caret into view, no edge fade over the text), so not ScrollArea.
        style={{ maxHeight, overflowY: "auto" }}
        className={`${className} relative block min-w-0 w-full whitespace-pre-wrap text-ink caret-ink outline-none [overflow-wrap:anywhere]`}
      />
      {!value && !composing && (
        <div
          data-prompt-suggestion={suggestion ? "" : undefined}
          aria-hidden
          className={`${className} ${placeholderClassName} pointer-events-none absolute inset-0 overflow-hidden text-ink-3`}
        >
          {suggestion ?? placeholder}
        </div>
      )}
      {chips.map((chip) =>
        createPortal(
          chip.part.kind === "skill" ? (
            <SkillChip name={chip.part.name} description={skillDescriptions.get(chip.part.name.toLowerCase())} />
          ) : chip.part.kind === "chat" ? (
            <ChatChip title={mentions.chats.find((chat) => chat.id === (chip.part.kind === "chat" ? chip.part.id : 0))?.title ?? "Chat"} />
          ) : chip.part.kind === "image" ? (
            <ImageChip index={chip.part.index} onOpen={onOpenImage?.bind(null, chip.part.index)} />
          ) : (
            <FileChip path={chip.part.path} />
          ),
          chip.host,
          chip.key,
        ),
      )}
    </div>
  );
}

// Programmatic selection doesn't scroll a capped field; keep the caret in view.
function revealCaret(root: HTMLElement, range: Range) {
  if (root.scrollHeight <= root.clientHeight) return;
  let rect = range.getClientRects()[0];
  // On an empty line the caret sits before a BR, and Chromium gives that collapsed range no rectangle.
  // The BR measures this line; its container would measure the whole field and leave the caret offscreen.
  if (!rect && range.collapsed && range.startContainer instanceof Element) {
    const next = range.startContainer.childNodes[range.startOffset];
    if (next instanceof HTMLBRElement) rect = next.getBoundingClientRect();
  }
  if (!rect) return;
  const box = root.getBoundingClientRect();
  if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom;
  else if (rect.top < box.top) root.scrollTop -= box.top - rect.top;
}

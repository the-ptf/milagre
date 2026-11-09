import { useLayoutEffect, useRef, useState } from "react";
import { trimmedEllipsis } from "../../lib/trimmed-ellipsis";

/**
 * Animate a replacement, never the initial render or a remounted sidebar row. The title truncates with CSS; when the cut
 * would leave a space before the ellipsis, the shown text drops that space (measured on a hidden copy, only when the
 * title or the row's width changes).
 */
export function ChatTitle({ label }: { label: string }) {
  const previous = useRef(label);
  const current = useRef<HTMLSpanElement>(null);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  // The trimmed text, with the title it was measured for, so a renamed Chat never shows the old one.
  const [shown, setShown] = useState<{ label: string; text: string } | null>(null);
  const trimmedText = shown?.label === label ? shown.text : null;
  const probe = useRef<HTMLSpanElement>(null);
  const ellipsis = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (previous.current === label) return;
    setOutgoing(previous.current);
    previous.current = label;
    const timer = window.setTimeout(() => setOutgoing(null), 240);
    return () => window.clearTimeout(timer);
  }, [label]);
  // Measuring runs with the full title on screen: then the title's block spans all the room it has (the title overflows
  // it), while the trimmed text would shrink it to fit and mislead a second measure. So the row's own size changes
  // (and the UI font finishing loading) put the full title back and bump `epoch`, and only that measures again.
  const [epoch, setEpoch] = useState(0);
  useLayoutEffect(() => {
    const element = current.current;
    const row = element?.closest<HTMLElement>("button, [data-row]") ?? element?.parentElement;
    if (!row) return;
    let width = row.offsetWidth;
    const again = () => {
      setShown(null);
      setEpoch((value) => value + 1);
    };
    const observer = new ResizeObserver(() => {
      const next = row.offsetWidth;
      if (next === width) return;
      width = next;
      again();
    });
    observer.observe(row);
    let live = true;
    const fontsDone = () => live && again();
    void document.fonts?.ready.then(fontsDone);
    document.fonts?.addEventListener("loadingdone", fontsDone);
    return () => {
      live = false;
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", fontsDone);
    };
  }, [label]);
  useLayoutEffect(() => {
    const element = current.current;
    const text = probe.current?.firstChild;
    if (trimmedText !== null || !element || !(text instanceof Text)) return;
    const room = element.clientWidth;
    // Rects come out scaled while the row or the app animates in (a transform); clientWidth doesn't. Undo the scale.
    const scale = room > 0 ? element.getBoundingClientRect().width / room || 1 : 1;
    const range = document.createRange();
    const prefix = (value: string) => {
      if (value === label) return probe.current!.getBoundingClientRect().width / scale;
      if (value === "…") return (ellipsis.current?.getBoundingClientRect().width ?? 0) / scale;
      range.setStart(text, 0);
      range.setEnd(text, value.length);
      return range.getBoundingClientRect().width / scale;
    };
    const trimmed = trimmedEllipsis(label, room, prefix);
    if (trimmed) setShown({ label, text: trimmed });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `trimmedText` is read only to skip the trimmed state
  }, [label, epoch]);
  return (
    <span className="chat-title" data-chat-title data-changing={outgoing !== null ? "true" : undefined}>
      <span className="sr-only">{label}</span>
      {outgoing !== null && (
        <span key={`old-${label}`} className="chat-title-outgoing" aria-hidden>
          {outgoing}
        </span>
      )}
      <span ref={current} key={label} className="chat-title-current" aria-hidden>
        {trimmedText ?? label}
      </span>
      {/* Hidden, out of flow: the measuring copy. Its text isn't read or found (aria-hidden, visibility hidden). */}
      <span aria-hidden className="pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap">
        <span ref={probe}>{label}</span>
        <span ref={ellipsis}>…</span>
      </span>
    </span>
  );
}

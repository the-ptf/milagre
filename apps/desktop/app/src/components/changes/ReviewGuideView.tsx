import { useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowLeft02Icon, ArrowRight02Icon, EyeIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { GuideAttention, GuideExcerpt, PullRequestDetail, ReviewGuide } from "@milagre/shared/pull-request-review";
import { EASE_OUT, SPRING_LAYOUT } from "../../lib/ease";
import { ScrollArea } from "../primitives/ScrollArea";

// The PR's review guide in the main column, one stop at a time; the panel beside it lists the stops.

const ATTENTION: Record<GuideAttention, string> = {
  risk: "A risk to judge",
  tradeoff: "A tradeoff to weigh",
  contract: "A contract change",
  product: "A product call",
  accessibility: "An accessibility check",
};

const NOTE_TONES = ["bg-orange text-page", "bg-accent text-white", "bg-green text-page"];

function Excerpt({ excerpt, onOpenFile }: { excerpt: GuideExcerpt; onOpenFile: (path: string) => void }) {
  const notes = new Map(excerpt.notes.map((note, index) => [note.line, { ...note, tone: NOTE_TONES[index % NOTE_TONES.length] }]));
  return (
    <div data-guide-excerpt={excerpt.path} className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex h-9 items-center gap-2 border-b border-line px-3 text-[12.5px]">
        <span className="min-w-0 flex-1 truncate text-left text-ink" dir="rtl">
          <bdi>
            {excerpt.path}{" "}
            <span className="text-ink-3">
              · L{excerpt.startLine}–{excerpt.endLine}
            </span>
          </bdi>
        </span>
        <button
          type="button"
          data-guide-open-diff
          onClick={() => onOpenFile(excerpt.path)}
          className="shrink-0 text-[12px] font-medium text-accent-ink hover:underline"
        >
          Open diff
        </button>
      </div>
      <div className="overflow-x-auto py-1 font-mono text-[length:var(--code-size)] leading-5">
        {excerpt.lines.map((line) => {
          const note = notes.get(line.number);
          return (
            <div key={line.number} className={`flex min-h-5 items-center pr-2 ${line.added ? "bg-[var(--diff-add)]" : ""}`}>
              <span className="w-11 shrink-0 select-none pr-2 text-right text-ink-3 tabular-nums">{line.number}</span>
              <span className="min-w-0 flex-1 whitespace-pre text-ink">{line.text || "​"}</span>
              {note && (
                <span className={`ml-2 flex size-[18px] shrink-0 items-center justify-center rounded-full font-sans text-[10px] font-bold ${note.tone}`}>
                  {note.letter}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReviewGuideView({
  pr,
  guide,
  stop,
  onStop,
  onOpenFile,
  onAsk,
}: {
  pr: PullRequestDetail;
  guide: ReviewGuide;
  stop: number;
  onStop: (stop: number) => void;
  onOpenFile: (path: string) => void;
  onAsk: (stop: number) => void;
}) {
  const reduced = useReducedMotion();
  const index = Math.min(Math.max(stop, 0), guide.stops.length - 1);
  const current = guide.stops[index]!;
  const next = guide.stops[index + 1];
  const notes = current.excerpts.flatMap((excerpt) => excerpt.notes);

  // j / k move between stops, as T3's guide and most review tools do, unless a field has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, [contenteditable=true]")) return;
      if (event.key === "j" && index < guide.stops.length - 1) onStop(index + 1);
      else if (event.key === "k" && index > 0) onStop(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, guide.stops.length, onStop]);

  return (
    // Absolute, so the diff sliding out beside it doesn't squeeze it into half the column.
    <motion.div
      className="absolute inset-0 pr-3 pb-3"
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      transition={reduced ? { duration: 0 } : { x: SPRING_LAYOUT, opacity: { duration: 0.2, ease: EASE_OUT } }}
    >
      <ScrollArea data-guide-view className="mt-[var(--window-chrome-height)] h-[calc(100%-var(--window-chrome-height))] px-3 pb-6">
        <article key={index} className="mx-auto flex max-w-[var(--chat-width,760px)] flex-col gap-5 px-6 pt-4">
          <div className="flex items-center gap-2.5">
            <span data-guide-position className="text-[11px] font-bold tracking-wide text-accent-ink uppercase">
              Stop {index + 1} of {guide.stops.length}
            </span>
            {current.attention && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-tint px-2 py-0.5 text-[11px] font-semibold text-orange">
                <HugeiconsIcon icon={EyeIcon} size={11} strokeWidth={2} color="currentColor" />
                Look closely
              </span>
            )}
            <span className="flex-1" />
            <span className="text-[11px] text-ink-3">J / K to move</span>
          </div>
          <h1 data-guide-title className="text-[24px] leading-tight font-semibold text-ink">
            {current.title}
          </h1>
          <p data-guide-summary className="text-[15px] leading-[1.55] text-ink-2">
            {current.summary}
          </p>
          {current.attention && (
            <div data-guide-attention={current.attention.kind} className="flex gap-3 rounded-card border border-orange/30 bg-orange-tint p-3.5">
              <span className="mt-0.5 flex shrink-0 text-orange">
                <HugeiconsIcon icon={AlertCircleIcon} size={17} strokeWidth={1.8} color="currentColor" />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-[13px] font-semibold text-orange">{ATTENTION[current.attention.kind]}</p>
                <p className="text-[14px] leading-[1.5] text-ink">{current.attention.text}</p>
              </div>
            </div>
          )}
          {current.excerpts.map((excerpt, at) => (
            <Excerpt key={`${excerpt.path}-${at}`} excerpt={excerpt} onOpenFile={onOpenFile} />
          ))}
          {notes.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {notes.map((note, at) => (
                <div key={note.letter} data-guide-note={note.letter} className="flex gap-2.5 rounded-card bg-surface p-3">
                  <span
                    className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${NOTE_TONES[at % NOTE_TONES.length]}`}
                  >
                    {note.letter}
                  </span>
                  <p className="text-[13px] leading-[1.5] text-ink-2">{note.text}</p>
                </div>
              ))}
            </div>
          )}
          {current.files.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[13px] font-semibold text-ink">Also in this stop</p>
              {current.files.map((file) => (
                <button key={file.path} type="button" onClick={() => onOpenFile(file.path)} className="flex flex-col items-start text-left">
                  <span className="font-mono text-[12px] text-accent-ink hover:underline">{file.path}</span>
                  {file.note && <span className="text-[12px] text-ink-3">{file.note}</span>}
                </button>
              ))}
            </div>
          )}
          {current.questions.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-semibold text-ink">Questions to consider</p>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] text-ink-2">
                {current.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2.5 pt-1">
            <div className="min-w-0 flex-1">
              {index > 0 && (
                <button
                  type="button"
                  data-guide-prev
                  onClick={() => onStop(index - 1)}
                  className="inline-flex max-w-full items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink"
                >
                  <HugeiconsIcon icon={ArrowLeft02Icon} size={14} strokeWidth={1.8} color="currentColor" />
                  <span className="truncate">{guide.stops[index - 1]?.title}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              data-guide-ask
              onClick={() => onAsk(index)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-line px-3 text-[13px] font-medium text-ink transition-colors hover:bg-hover"
            >
              <HugeiconsIcon icon={SparklesIcon} size={14} strokeWidth={1.8} color="currentColor" className="text-accent-ink" />
              Ask in Chat
            </button>
            <button
              type="button"
              data-guide-next
              onClick={() => onStop(next ? index + 1 : guide.stops.length)}
              className="inline-flex h-9 max-w-[320px] min-w-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              <span className="truncate">{next ? `Next: ${next.title}` : "Finish review"}</span>
              <HugeiconsIcon icon={ArrowRight02Icon} size={14} strokeWidth={1.8} color="currentColor" />
            </button>
          </div>
          <p className="text-[11px] text-ink-3">
            {pr.changedFiles} files in #{pr.number}; this tour covers {guide.stops.length} stops.
          </p>
        </article>
      </ScrollArea>
    </motion.div>
  );
}

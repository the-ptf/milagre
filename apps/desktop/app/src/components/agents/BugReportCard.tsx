import { ScrollArea } from "../primitives/ScrollArea";
import { Fragment, useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bug01Icon, PencilEdit02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { reportSegments } from "@milagre/shared/bug-report";
import { SPRING_SWAP } from "../../lib/ease";
import type { QuestionAnswers, QuestionRequest } from "../../model";

const TITLE_LIMIT = 160;

/** The report's text with each placeholder Milagre put in marked, so the user sees what was replaced. */
export function MarkedReport({ text }: { text: string }) {
  return (
    <>
      {reportSegments(text).map((segment, index) =>
        segment.placeholder ? (
          <mark key={index} className="rounded-inline bg-hover px-1 text-ink-2" title="Replaced by Milagre">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A Milagre bug report waiting for the user (bug-reports.cjs): the exact title and text that will go to Milagre's public
 * tracker, placeholders marked, editable before it is posted. Nothing goes out until Post; an edit with more private
 * details comes back from the host redacted, as a new card. "card" sits above the composer like QuestionCard; "inline"
 * goes inside an inbox card, which brings its own frame.
 */
export function BugReportCard({
  request,
  busy,
  onAnswer,
  variant = "card",
}: {
  request: QuestionRequest;
  busy: boolean;
  onAnswer: (answers: QuestionAnswers | null) => void;
  variant?: "card" | "inline";
}) {
  const reduce = useReducedMotion();
  const report = request.bugReport!;
  const [title, setTitle] = useState(report.title);
  const [body, setBody] = useState(report.body);
  const [editing, setEditing] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const replaced = report.redactions ?? 0;
  const ready = !busy && title.trim().length > 0 && title.length <= TITLE_LIMIT && body.trim().length > 0;
  const card = variant === "card";
  return (
    <motion.form
      aria-label="Milagre bug report"
      aria-busy={busy}
      initial={!card || reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduce ? { duration: 0 } : SPRING_SWAP}
      className={`grid gap-3 ${card ? "rounded-card border border-line bg-surface p-4 shadow-overlay" : "mt-4"}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onAnswer({ title: [title.trim()], body: [body] });
      }}
    >
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <HugeiconsIcon icon={Bug01Icon} size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
          <h3 className="min-w-0 flex-1 text-15 font-semibold text-ink">Report a Milagre bug</h3>
          <span className="shrink-0 pt-0.5 text-12 text-ink-3">{report.repo}</span>
        </div>
        <p className={`text-13 leading-5 ${report.recheck ? "text-orange-ink" : "text-ink-2"}`}>
          {report.recheck
            ? "Your edit had more private details. Milagre replaced them; check the text again."
            : `This exact text goes to Milagre's public tracker under your GitHub account. ${
                replaced === 1 ? "1 private detail was" : `${replaced} private details were`
              } replaced with placeholders.`}
        </p>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={titleId} className="text-12 font-medium text-ink-2">
          Title
        </label>
        <input
          id={titleId}
          value={title}
          maxLength={TITLE_LIMIT}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => setTitle(event.target.value)}
          className="h-9 w-full min-w-0 rounded-control border border-line bg-field px-3 text-13 text-ink outline-none transition-colors disabled:opacity-40"
        />
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={bodyId} className="text-12 font-medium text-ink-2">
            Report
          </label>
          <button
            type="button"
            disabled={busy}
            aria-pressed={editing}
            onClick={() => setEditing((current) => !current)}
            className="flex h-7 items-center gap-1.5 rounded-control px-2 text-12 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <HugeiconsIcon icon={editing ? ViewIcon : PencilEdit02Icon} size={14} strokeWidth={1.8} aria-hidden />
            {editing ? "Preview" : "Edit"}
          </button>
        </div>
        {editing ? (
          <textarea
            id={bodyId}
            value={body}
            disabled={busy}
            spellCheck={false}
            rows={12}
            onChange={(event) => setBody(event.target.value)}
            className="max-h-72 w-full min-w-0 resize-none rounded-control border border-line bg-field px-3 py-2 font-mono text-12 leading-5 text-ink outline-none disabled:opacity-40"
          />
        ) : (
          <ScrollArea chainScroll className="max-h-72 rounded-control border border-line bg-field">
            <p id={bodyId} className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-12 leading-5 text-ink">
              <MarkedReport text={body} />
            </p>
          </ScrollArea>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer(null)}
          className="h-9 rounded-control px-3 text-13 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready}
          className="h-9 rounded-control bg-ink px-4 text-13 font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
        >
          {busy ? "Posting…" : "Post to GitHub"}
        </button>
      </div>
    </motion.form>
  );
}

import { ScrollArea } from "../primitives/ScrollArea";
import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon, LockKeyIcon, ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { formatCountdown } from "@milagre/shared/display-clock";
import { useDisplayNow } from "../../lib/display-clock";
import { SPRING_SWAP } from "../../lib/ease";
import type { QuestionAnswers, QuestionRequest } from "../../model";

/** The last minute reads in the attention tone, so a running-out request is noticed before it closes. */
const URGENT_MS = 60_000;

/**
 * Secret drafts stay in this mounted form, outside the inbox's retained answer drafts.
 * "card" sits above the composer like QuestionCard; "inline" goes inside an inbox card, which brings its own frame.
 */
export function SecretCard({
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
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();
  const deadline = request.secretRequest?.expiresAt;
  const description = request.secretRequest?.description.trim();
  const now = useDisplayNow(1000, deadline !== undefined && !busy);
  const expired = deadline !== undefined && now >= deadline;
  const urgent = deadline !== undefined && deadline - now <= URGENT_MS;
  if (expired && value) setValue("");
  if (expired && revealed) setRevealed(false);
  const submit = (answers: QuestionAnswers | null) => {
    setValue("");
    setRevealed(false);
    onAnswer(answers);
  };
  const card = variant === "card";
  return (
    <motion.form
      aria-label="Secret request"
      aria-busy={busy}
      initial={!card || reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduce ? { duration: 0 } : SPRING_SWAP}
      className={`grid gap-3 ${card ? "rounded-card border border-line bg-surface p-4 shadow-overlay" : "mt-4"}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && value.trim() && (deadline === undefined || Date.now() < deadline)) submit({ secret: [value] });
      }}
    >
      <div className="grid gap-1">
        <div className="flex items-start gap-2">
          <HugeiconsIcon icon={LockKeyIcon} size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
          <label htmlFor={inputId} className="min-w-0 break-words text-15 font-semibold text-ink">
            {request.questions[0]?.question}
          </label>
        </div>
        {description && (
          <ScrollArea chainScroll className="max-h-40">
            <p className="whitespace-pre-wrap break-words text-13 leading-5 text-ink-2">{description}</p>
          </ScrollArea>
        )}
      </div>
      {/* The field takes the row; the buttons wrap below it, right-aligned, when the card is narrow. */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-3">
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="relative">
            <input
              id={inputId}
              type={revealed ? "text" : "password"}
              aria-label="Secret"
              aria-describedby={deadline === undefined ? undefined : `${inputId}-countdown`}
              placeholder="Paste or type the secret"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={10000}
              value={value}
              disabled={busy || expired}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setRevealed(false)}
              onKeyDown={(event) => {
                // Escape clears what was typed first; on an empty field it reaches the window, which declines.
                if (event.key === "Escape" && !event.nativeEvent.isComposing && value) {
                  event.preventDefault();
                  setValue("");
                  setRevealed(false);
                }
              }}
              className="h-9 w-full min-w-0 rounded-control border border-line bg-field pl-3 pr-10 text-13 text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent disabled:opacity-40"
            />
            <button
              type="button"
              aria-label={revealed ? "Hide secret" : "Show secret"}
              aria-pressed={revealed}
              title={revealed ? "Hide" : "Show"}
              disabled={busy || expired || !value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setRevealed((current) => !current)}
              className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 disabled:pointer-events-none disabled:opacity-40"
            >
              <HugeiconsIcon icon={revealed ? ViewOffIcon : ViewIcon} size={16} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
          {deadline !== undefined && (
            <div
              id={`${inputId}-countdown`}
              role="timer"
              className={`mt-1.5 flex items-center gap-1.5 text-12 transition-colors ${urgent ? "text-orange-ink" : "text-ink-3"}`}
            >
              <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={1.8} aria-hidden />
              <span className="tabular-nums">{expired ? "Request expired" : `${formatCountdown(deadline - now)} left to enter`}</span>
            </div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(null)}
            className="h-9 rounded-control px-3 text-13 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            Decline
          </button>
          <button
            type="submit"
            disabled={busy || expired || !value.trim()}
            className="h-9 rounded-control bg-ink px-4 text-13 font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save securely"}
          </button>
        </div>
      </div>
    </motion.form>
  );
}

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { BtwState } from "@milagre/shared/model";
import { Markdown, StreamingMarkdown } from "./markdown/Markdown";
import { Button, IconButton } from "./primitives/Button";
import { InlineError } from "./primitives/InlineError";
import { ScrollArea } from "./primitives/ScrollArea";
import { ShortcutKeys } from "./primitives/ShortcutKeys";
import { SpinnerRing } from "./primitives/SpinnerRing";

export function BtwOverlay({ state, onStop, onBringBack, onDismiss }: { state: BtwState; onStop: () => void; onBringBack: () => void; onDismiss: () => void }) {
  const running = state.status === "running";
  const hasAnswer = Boolean(state.text.trim());
  const tool = state.steps.findLast((step) => step.status === "running")?.title;
  return (
    <div
      data-btw-overlay={state.status}
      role="region"
      aria-label="Side question"
      className="promptbar-surface mb-1.5 flex max-h-[min(340px,48vh)] flex-col overflow-hidden rounded-window border border-line-strong text-13 text-ink"
      style={{ animation: "fade-up var(--duration-base) var(--ease-enter) backwards" }}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 text-12 text-ink-2">
        <span className="shrink-0 rounded-inline bg-hover px-1.5 py-0.5 font-mono text-11 font-medium text-ink">/btw</span>
        <span className="min-w-0 flex-1 break-words font-medium text-ink">{state.question}</span>
        {running && (
          <span className="flex shrink-0 items-center gap-1.5 text-11 text-ink-3">
            <SpinnerRing size={12} />
            {tool && <span className="max-w-[160px] truncate">{tool}</span>}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {running && (
            <Button variant="secondary" size={24} onClick={onStop}>
              Stop
            </Button>
          )}
          {hasAnswer && !running && (
            <Button variant="secondary" size={24} data-btw-bring-back onClick={onBringBack}>
              Bring back
            </Button>
          )}
          <span className="hidden items-center gap-1 text-11 text-ink-3 sm:flex">
            <ShortcutKeys shortcut="Esc" compact />
          </span>
          <IconButton icon={Cancel01Icon} size={24} iconSize={14} label="Dismiss side answer" onClick={onDismiss} />
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1 px-3 py-2.5">
        <div className="flex flex-col gap-2 text-[length:var(--chat-size)] leading-[1.6] text-ink">
          {hasAnswer ? (
            <div data-btw-answer>{running ? <StreamingMarkdown text={state.text} /> : <Markdown text={state.text} />}</div>
          ) : running ? (
            <span className="text-12 text-ink-3">{tool ? `Running ${tool}…` : "Thinking…"}</span>
          ) : null}
          {state.error && <InlineError size={12}>{state.error}</InlineError>}
        </div>
      </ScrollArea>
    </div>
  );
}

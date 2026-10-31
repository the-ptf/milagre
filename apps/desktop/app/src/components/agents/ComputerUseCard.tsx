import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { Cancel01Icon, CircleIcon, ComputerIcon, Loading03Icon, ArrowExpand01Icon, ArrowShrink01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { desktopStepApps, desktopStepLabel, frameFitsSteps } from "@milagre/shared/desktop-steps";
import type { ComputerUseApi, ComputerUseFrame } from "@milagre/shared/computer-use";
import type { ChatStep } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useReplyChatId } from "./ArtifactCard";

const Icon = ({ icon, size = 14, className }: { icon: IconSvgElement; size?: number; className?: string }) => (
  <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" className={className} />
);

const VISIBLE_STEPS = 8;

const seconds = (steps: ChatStep[]) => {
  const start = steps[0]?.startedAt;
  const end = Math.max(...steps.map((step) => step.endedAt ?? step.startedAt ?? 0));
  return start && end > start ? `${Math.max(1, Math.round((end - start) / 1000))} s` : null;
};

/**
 * The Chat's live screen: long-polls the host for the next frame while its agent works, and keeps the last one. Starts
 * again whenever the reply gets a new desktop step, since that step is what restarts the host's capture.
 */
function useScreen(chatId: string | null, stepCount: number) {
  const [frame, setFrame] = useState<ComputerUseFrame | null>(null);
  useEffect(() => {
    if (!chatId) return;
    // A test bridge or an older paired host may not offer it.
    const api = bridgeForKey(chatId).computerUse as ComputerUseApi | undefined;
    if (!api?.frame) return;
    const state = { disposed: false };
    void (async () => {
      let after = 0;
      while (!state.disposed) {
        const next = await api.frame({ chatId, after }).catch(() => null);
        if (state.disposed || !next) return;
        if (next.seq !== after || !next.live) setFrame(next);
        after = next.seq;
        if (!next.live) return;
      }
    })();
    return () => {
      state.disposed = true;
    };
  }, [chatId, stepCount]);
  return frame;
}

/**
 * A reply's computer use (design B): its desktop steps numbered on the left, the app's window live on the right, in one
 * card instead of tool rows. The picture keeps the last frame once the agent stops.
 */
export function ComputerUseCard({ steps }: { steps: ChatStep[] }) {
  const chatId = useReplyChatId();
  const frame = useScreen(chatId, steps.length);
  const [large, setLarge] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  // The newest steps beside the screen; earlier ones behind a button, so a long run doesn't stretch the card.
  const hidden = allSteps ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = frame && frameFitsSteps(frame.at, steps) ? frame : null;
  // The host keeps capturing for a while after the last step, then says the feed is no longer live.
  const live = !!shown?.live;
  const apps = desktopStepApps(steps);
  const summary = [`${steps.length} ${steps.length === 1 ? "step" : "steps"}`, apps.join(", "), seconds(steps)].filter(Boolean).join(" · ");
  const screen = (
    <div className="relative flex min-h-[200px] items-center justify-center bg-field">
      {shown?.image ? (
        <img
          src={`data:${shown.mime ?? "image/png"};base64,${shown.image}`}
          alt={shown.title ? `${shown.app} · ${shown.title}` : (shown.app ?? "The app's window")}
          className="block max-h-[420px] w-full object-contain p-3"
          draggable={false}
        />
      ) : (
        <p className="max-w-[240px] px-4 py-10 text-center text-12 text-ink-3">
          {shown?.error === "screen-recording"
            ? "Turn on Screen Recording for Milagre in Settings › Experimental › Computer use to see the screen here."
            : "The screen shows here while the agent works in an app."}
        </p>
      )}
    </div>
  );
  return (
    <div data-computer-use-card className="w-full overflow-hidden rounded-window border border-line bg-surface">
      <div className="flex h-10 items-center gap-2 px-3">
        <Icon icon={ComputerIcon} className="shrink-0 text-ink-2" />
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-ink-2">{summary}</span>
        {live && (
          <span data-computer-use-live className="flex shrink-0 items-center gap-1.5 text-12 font-semibold text-green-ink">
            <span className="size-2 rounded-full bg-green" />
            Live
          </span>
        )}
        <button
          type="button"
          aria-label={large ? "Show the steps beside the screen" : "Make the screen larger"}
          onClick={() => setLarge((value) => !value)}
          className="flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <Icon icon={large ? ArrowShrink01Icon : ArrowExpand01Icon} />
        </button>
      </div>
      {large ? (
        <div className="border-t border-line">{screen}</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] border-t border-line">
          <ol className="grid content-start gap-2.5 border-r border-line p-3.5">
            {hidden > 0 && (
              <li>
                <button type="button" onClick={() => setAllSteps(true)} className="text-12 text-ink-3 transition-colors hover:text-ink">
                  {hidden} earlier {hidden === 1 ? "step" : "steps"}
                </button>
              </li>
            )}
            {steps.slice(hidden).map((step) => (
              <Step key={step.id} step={step} />
            ))}
          </ol>
          {screen}
        </div>
      )}
    </div>
  );
}

function Step({ step }: { step: ChatStep }) {
  const running = step.status === "running";
  const failed = step.status === "failed";
  return (
    <li data-computer-use-step={step.status} className="flex min-w-0 items-center gap-2" title={failed ? (step.error ?? undefined) : undefined}>
      {running ? (
        <Icon icon={Loading03Icon} className="shrink-0 animate-spin text-ink motion-reduce:animate-none" />
      ) : failed ? (
        <Icon icon={Cancel01Icon} className="shrink-0 text-red-ink" />
      ) : step.status === "done" ? (
        <Icon icon={Tick02Icon} className="shrink-0 text-green-ink" />
      ) : (
        <Icon icon={CircleIcon} className="shrink-0 text-ink-3" />
      )}
      <span className={`min-w-0 truncate text-12 ${running ? "font-semibold text-ink" : failed ? "text-red-ink" : "text-ink-2"}`}>
        {desktopStepLabel(step)}
      </span>
    </li>
  );
}

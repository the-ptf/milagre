import { useState } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  DashedLineCircleIcon,
  HistoryIcon,
  MinusSignIcon,
  PlayIcon,
  RefreshIcon,
  StopCircleIcon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import {
  VALIDATION_RESULT_WORDS,
  formatValidationDuration,
  validationExit,
  validationFixPrompt,
  validationMeta,
  validationStaleText,
  validationTitle,
  type ValidationContext,
  type ValidationResult,
} from "@milagre/shared/validation";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SpinnerRing } from "../primitives/SpinnerRing";

const RUN_ICONS: Record<string, { icon: IconSvgElement; className: string }> = {
  passed: { icon: CheckmarkCircle02Icon, className: "text-green" },
  failed: { icon: CancelCircleIcon, className: "text-red" },
  "not-run": { icon: DashedLineCircleIcon, className: "text-ink-4" },
  interrupted: { icon: StopCircleIcon, className: "text-ink-3" },
};
const RESULT_ICONS: Record<string, { icon: IconSvgElement; className: string }> = {
  passed: { icon: Tick02Icon, className: "text-green" },
  failed: { icon: Cancel01Icon, className: "text-red" },
  interrupted: { icon: StopIcon, className: "text-ink-3" },
  "not-run": { icon: MinusSignIcon, className: "text-ink-4" },
  queued: { icon: MinusSignIcon, className: "text-ink-4" },
};

function StatusMark({ status, run }: { status: string; run?: boolean }) {
  if (status === "running") return <SpinnerRing size={run ? 16 : 12} />;
  const look = (run ? RUN_ICONS : RESULT_ICONS)[status] ?? { icon: MinusSignIcon, className: "text-ink-4" };
  return <Icon icon={look.icon} size={run ? 16 : 14} className={`shrink-0 ${look.className}`} />;
}

function ResultRow({
  result,
  open,
  onToggle,
  log,
  onFullLog,
}: {
  result: ValidationResult;
  open: boolean;
  onToggle: () => void;
  log?: string;
  onFullLog?: () => void;
}) {
  const output = log ?? result.tail;
  const openable = Boolean(output) || Boolean(result.reason);
  return (
    <div data-validation-result={result.status} className={open ? "border-y border-line bg-inset first:border-t-0 last:border-b-0" : ""}>
      <button
        type="button"
        aria-expanded={openable ? open : undefined}
        disabled={!openable}
        onClick={onToggle}
        title={VALIDATION_RESULT_WORDS[result.status]}
        className="grid h-8 w-full grid-cols-[20px_92px_minmax(0,1fr)_auto_48px_16px] items-center gap-2 px-3 text-left transition-colors enabled:hover:bg-hover disabled:cursor-default"
      >
        <StatusMark status={result.status} />
        <span className="truncate font-medium text-ink">{result.name}</span>
        <span className="truncate font-mono text-12 text-ink-2">{result.command}</span>
        <span className="font-mono text-11 text-ink-3">{validationExit(result)}</span>
        <span className="text-right text-11 text-ink-3">{result.durationMs !== undefined ? formatValidationDuration(result.durationMs) : ""}</span>
        {openable ? <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} className="text-ink-4" /> : <span />}
      </button>
      {open && (
        <div className="px-3 pb-2 pl-10">
          {result.cwd && <p className="mb-1 font-mono text-11 text-ink-3">in {result.cwd}</p>}
          {result.reason && <p className="mb-1 text-12 text-ink-2">{result.reason}</p>}
          {output && <pre className="max-h-60 overflow-auto font-mono text-11 leading-4 whitespace-pre-wrap text-ink-2">{output}</pre>}
          {result.hasLog && log === undefined && onFullLog && (
            <div className="flex justify-end">
              <Button variant="link" size={24} onClick={onFullLog}>
                Open full log
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A validation run Milagre recorded in the Chat: what each command returned, never what an agent said about it. */
export function ValidationCard({ context, chatId, onAskToFix }: { context: ValidationContext; chatId: string | null; onAskToFix?: (text: string) => void }) {
  const [opened, setOpened] = useState<number | null>(null);
  const [logs, setLogs] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstFailure = context.results.findIndex((result) => result.status === "failed");
  const openIndex = opened ?? (firstFailure >= 0 ? firstFailure : null);
  const bridge = chatId ? bridgeForKey(chatId).validation : null;

  function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    work()
      .catch((failure) => setError(ipcErrorMessage(failure)))
      .finally(() => setBusy(false));
  }
  const run = bridge && chatId ? () => act(() => bridge.run({ chatId })) : undefined;
  const stop = bridge && chatId ? () => act(() => bridge.stop({ chatId, runId: context.runId })) : undefined;
  const fullLog = (index: number) =>
    bridge && chatId ? () => act(async () => setLogs({ ...logs, [index]: (await bridge.log({ chatId, runId: context.runId, index })).text })) : undefined;

  return (
    <div data-validation-card={context.status} className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <StatusMark status={context.status} run />
        <span className="shrink-0 text-13 font-semibold text-ink">{validationTitle(context)}</span>
        <span className="min-w-0 truncate text-12 text-ink-3">{validationMeta(context)}</span>
        <span className="flex-1" />
        {context.status === "running" ? (
          stop && (
            <Button variant="danger-ghost" size={28} disabled={busy} onClick={stop}>
              Stop
            </Button>
          )
        ) : context.status === "not-run" ? (
          run && (
            <Button size={28} disabled={busy} onClick={run}>
              <Icon icon={PlayIcon} size={14} />
              Run validation
            </Button>
          )
        ) : (
          <>
            {run && (
              <Button variant="quiet" size={28} disabled={busy} onClick={run}>
                <Icon icon={RefreshIcon} size={14} />
                Run again
              </Button>
            )}
            {context.status === "failed" && onAskToFix && (
              <Button variant="secondary" size={28} onClick={() => onAskToFix(validationFixPrompt(context))}>
                Ask to fix
              </Button>
            )}
          </>
        )}
      </div>
      {context.stale && (
        <div data-validation-stale className="mx-3 mb-2.5 flex items-center gap-1.5 rounded-control bg-field px-2.5 py-1.5 text-12 text-ink-2">
          <Icon icon={HistoryIcon} size={14} className="shrink-0" />
          <span className="min-w-0">{validationStaleText(context.stale)}</span>
        </div>
      )}
      {error && (
        <div className="mx-3 mb-2.5">
          <InlineError>{error}</InlineError>
        </div>
      )}
      {context.results.length > 0 && (
        <div className="border-t border-line">
          {context.results.map((result, index) => (
            <ResultRow
              key={`${result.name}-${index}`}
              result={result}
              open={openIndex === index}
              onToggle={() => setOpened(openIndex === index ? -1 : index)}
              log={logs[index]}
              onFullLog={fullLog(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

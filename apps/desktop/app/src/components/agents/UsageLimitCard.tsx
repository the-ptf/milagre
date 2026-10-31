import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { limitChoices, limitHeadline, limitResumeLabel, switchedText } from "@milagre/shared/usage-limit";
import type { ProjectAccountsSnapshot, UsageLimitContext, LimitResume } from "../../model";
import { isRemoteKey, useBridge, useScope } from "../../lib/computer-bridge";

/**
 * Under a reply the plan's usage limit stopped: when it resets, and the Project's other accounts for the provider.
 * Picking one moves the Project there and continues the Chat. Only the Chat's last message offers them, and only while no turn runs.
 */
export function UsageLimitCard({
  limit,
  sessionId,
  interactive,
  onOpenAccounts,
  pending,
  sourceMessageId,
  resumeAvailable = false,
  resumeBlocked = false,
}: {
  limit: UsageLimitContext;
  sessionId: number;
  interactive: boolean;
  onOpenAccounts?: () => void;
  pending?: LimitResume;
  sourceMessageId: number;
  resumeAvailable?: boolean;
  resumeBlocked?: boolean;
}) {
  const bridge = useBridge();
  const scope = useScope();
  // Another computer's Chat keeps the accounts its own Mac chose.
  const live = interactive && Boolean(scope) && !isRemoteKey(scope);
  const { title, detail } = limitHeadline(limit);
  const [snapshot, setSnapshot] = useState<ProjectAccountsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [resumeSupported, setResumeSupported] = useState(false);
  useEffect(() => {
    let stale = false;
    if (interactive)
      void Promise.resolve()
        .then(() => bridge.readLimitResumeAtReset())
        .then(
          (value) => {
            if (!stale) setResumeSupported(typeof value?.resumeAtReset === "boolean");
            return null;
          },
          () => {
            if (!stale) setResumeSupported(false);
          },
        );
    return () => {
      stale = true;
    };
  }, [bridge, interactive]);
  useEffect(() => {
    if (!live || !scope) return;
    let stale = false;
    async function load() {
      try {
        const next = await bridge.getProjectAccounts(scope!);
        if (!stale) setSnapshot(next);
      } catch (reason) {
        if (!stale) setError(ipcErrorMessage(reason));
      }
    }
    void load();
    // An account added or signed in from Settings shows up here without reopening the Chat.
    const off = window.milagre.onAccountsChanged?.(() => void load());
    return () => {
      stale = true;
      off?.();
    };
  }, [bridge, live, scope]);

  async function choose(accountId: string) {
    if (!scope || busy) return;
    setBusy(accountId);
    setError("");
    try {
      setResult(switchedText(await bridge.switchAccountAfterLimit(scope, sessionId, limit.provider, accountId)));
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  const choices = live && snapshot?.scopeKey === scope ? limitChoices(snapshot, limit) : null;
  const resumeLabel = limitResumeLabel(pending, limit);
  async function changeResume() {
    if (!scope || busy) return;
    setBusy("resume");
    setError("");
    try {
      const changed = pending
        ? await bridge.cancelLimitResume(scope, sessionId, pending.sendId)
        : await bridge.scheduleLimitResume(scope, sessionId, sourceMessageId);
      if (!changed && !pending) setError("This Chat can no longer continue at this reset time.");
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div
      data-slot="usage-limit"
      data-provider={limit.provider}
      className="mt-2.5 flex w-full max-w-md flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]"
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon icon={Clock01Icon} size={16} className="mt-px shrink-0 text-orange-ink" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="text-[12px] text-ink-3">{detail}</p>
        </div>
      </div>
      {resumeLabel && !result && (
        <div className="flex items-center gap-2" data-limit-resume>
          {pending && (
            <p role="status" className="text-12 text-ink-2">
              {resumeLabel}
            </p>
          )}
          {interactive && resumeSupported && resumeAvailable && !resumeBlocked && (
            <button
              type="button"
              data-limit-resume-action
              disabled={busy !== null}
              onClick={() => void changeResume()}
              className="rounded-control border border-line px-2.5 py-1.5 text-12 font-medium text-ink hover:bg-hover disabled:opacity-50"
            >
              {pending ? "Cancel" : resumeLabel}
            </button>
          )}
        </div>
      )}
      {result ? (
        <p data-usage-limit-result role="status" className="text-[12px] text-ink-2">
          {result}
        </p>
      ) : (
        choices && (
          <>
            {choices.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {choices.map((choice) => (
                  <li key={choice.id}>
                    <button
                      type="button"
                      data-account={choice.id}
                      disabled={choice.disabled || busy !== null}
                      onClick={() => void choose(choice.id)}
                      className="flex w-full items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-left text-[12px] transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-transparent"
                    >
                      {busy === choice.id && <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-ink border-t-transparent" />}
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">Switch to {choice.label}</span>
                      {choice.detail && <span className="shrink-0 text-ink-3">{choice.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              onOpenAccounts && (
                <button
                  type="button"
                  data-usage-limit-add
                  onClick={onOpenAccounts}
                  className="self-start rounded-control border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover"
                >
                  Add account
                </button>
              )
            )}
            {choices.length > 0 && choices.every((choice) => choice.disabled) && onOpenAccounts && (
              <button type="button" data-usage-limit-manage onClick={onOpenAccounts} className="self-start text-[12px] text-ink-3 hover:text-ink">
                Manage accounts
              </button>
            )}
          </>
        )
      )}
      {error && (
        <p role="alert" data-usage-limit-error className="text-[12px] text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

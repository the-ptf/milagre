import { useEffect, useState } from "react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { limitChoices, limitHeadline, switchedText } from "@milagre/shared/usage-limit";
import type { ProjectAccountsSnapshot, UsageLimitContext } from "../../model";
import { isRemoteKey, useBridge, useScope } from "../../lib/computer-bridge";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SpinnerRing } from "../primitives/SpinnerRing";

/**
 * Under a reply the plan's usage limit stopped: when it resets, and the Project's other accounts for the provider.
 * Picking one moves the Project there and continues the Chat. Only the Chat's last message offers them, and only while no turn runs.
 */
export function UsageLimitCard({
  limit,
  sessionId,
  interactive,
  onOpenAccounts,
}: {
  limit: UsageLimitContext;
  sessionId: number;
  interactive: boolean;
  onOpenAccounts?: () => void;
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
  return (
    <div
      data-slot="usage-limit"
      data-provider={limit.provider}
      className="mt-3 flex w-full max-w-md flex-col gap-2 rounded-card border border-line bg-surface px-3 py-2 text-13"
    >
      <div className="flex items-start gap-2">
        <Icon icon={Clock01Icon} size={16} className="mt-px shrink-0 text-orange-ink" />
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="text-12 text-ink-3">{detail}</p>
        </div>
      </div>
      {result ? (
        <p data-usage-limit-result role="status" className="text-12 text-ink-2">
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
                      className="flex h-8 w-full items-center gap-2 rounded-control border border-line px-2.5 text-left text-12 transition-colors duration-fast hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-transparent"
                    >
                      {busy === choice.id && <SpinnerRing size={12} />}
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">Switch to {choice.label}</span>
                      {choice.detail && <span className="shrink-0 text-ink-3">{choice.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              onOpenAccounts && (
                <Button variant="secondary" size={28} data-usage-limit-add onClick={onOpenAccounts} className="self-start">
                  Add account
                </Button>
              )
            )}
            {choices.length > 0 && choices.every((choice) => choice.disabled) && onOpenAccounts && (
              <Button variant="quiet" size={24} data-usage-limit-manage onClick={onOpenAccounts} className="-ml-2 self-start">
                Manage accounts
              </Button>
            )}
          </>
        )
      )}
      <InlineError data-usage-limit-error size={12}>
        {error}
      </InlineError>
    </div>
  );
}

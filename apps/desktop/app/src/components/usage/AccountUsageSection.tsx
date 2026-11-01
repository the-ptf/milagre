import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { ModelProvider } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  accountUsageGroups,
  formatPercent,
  formatResetsAt,
  formatUpdatedAgo,
  overviewUpdatedAt,
  shownPercent,
  shownSuffix,
  usageTone,
} from "@milagre/shared/usage";
import { useAccountUsage } from "@milagre/shared/use-account-usage";
import { bridgeFor } from "../../lib/computer-bridge";
import { updateSettings, useSettings } from "../../lib/settings";
import { useDisplayNow } from "../../lib/display-clock";
import { ProviderLogo } from "../ProviderLogo";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import Tooltip from "../primitives/Tooltip";
import { UsageBar } from "./UsageBar";

const percentInk = { normal: "text-ink", warning: "text-orange-ink", critical: "text-red-ink" };

export function AccountUsageSection({
  computerId,
  computerName,
  onManageAccounts,
}: {
  computerId: string;
  computerName: string;
  onManageAccounts?: () => void;
}) {
  const source = useMemo(() => {
    const bridge = bridgeFor(computerId);
    return {
      read: () => bridge.readAccountUsage(),
      cached: () => bridge.getCachedAccountUsage(),
      isActive: () => document.visibilityState === "visible",
      subscribe: (usageChanged: () => void, accountsChanged: () => void) => {
        const usage = bridge.onUsageChanged?.(usageChanged);
        const accounts = bridge.onAccountsChanged?.(accountsChanged);
        return () => {
          usage?.();
          accounts?.();
        };
      },
    };
  }, [computerId]);
  const usage = useAccountUsage(source);
  const groups = accountUsageGroups(usage.snapshot);
  const { usageDisplay } = useSettings();
  const now = useDisplayNow(30_000);
  const updatedAt = overviewUpdatedAt(usage.snapshot);
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ModelProvider, string>>>({});
  async function setDefault(provider: ModelProvider, id: string) {
    if (pending || computerId !== LOCAL_COMPUTER) return;
    setPending(`${provider}:${id}`);
    setErrors((before) => ({ ...before, [provider]: "" }));
    try {
      await bridgeFor(computerId).accountAction("select", provider, id);
      await usage.refreshAccounts();
    } catch (error) {
      setErrors((before) => ({ ...before, [provider]: ipcErrorMessage(error) }));
    } finally {
      setPending(null);
    }
  }
  return (
    <section aria-label="Plan usage" data-account-usage className="flex min-w-0 flex-col gap-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-15 font-semibold text-ink">Plan usage</h2>
        <div className="flex items-center gap-2">
          <Select
            label="Plan usage display"
            value={usageDisplay}
            compact
            width={128}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
            onChange={(value) => updateSettings({ usageDisplay: value })}
          />
          <button
            type="button"
            aria-label="Refresh plan usage"
            disabled={usage.loading}
            onClick={() => void usage.refresh()}
            className="flex size-8 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover disabled:opacity-40"
          >
            <HugeiconsIcon icon={RefreshIcon} size={16} className={usage.loading ? "animate-spin" : undefined} />
          </button>
        </div>
      </div>
      {groups.map((group) => (
        <div key={group.provider} data-usage-provider={group.provider} className="flex min-w-0 flex-col">
          <h3
            aria-label={`${providerName(group.provider)}, ${group.accounts.length} ${group.accounts.length === 1 ? "account" : "accounts"}`}
            className="flex items-center gap-2 border-b border-line pb-3 text-15 font-semibold text-ink"
          >
            <ProviderLogo provider={group.provider} size={16} />
            {providerName(group.provider)}
            <span className="text-12 font-medium text-ink-3">{group.accounts.length}</span>
          </h3>
          {errors[group.provider] ? (
            <p role="alert" className="pt-2 text-12 text-orange-ink">
              {errors[group.provider]}
            </p>
          ) : null}
          <div className="divide-y divide-line">
            {group.accounts.map((entry) => {
              const identity = entry.account!;
              const stale = entry.status === "error" && entry.windows.length > 0;
              const action = computerId === LOCAL_COMPUTER && identity.state === "ready" && !identity.default;
              return (
                <div key={identity.id} data-usage-account={identity.id} className="group flex min-w-0 flex-col gap-4 py-4 lg:flex-row lg:gap-8">
                  <div className="min-w-0 lg:w-[302px] lg:shrink-0">
                    <div className="flex min-h-6 items-center gap-2">
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <p className="min-w-0 break-words text-13 font-semibold text-ink">{identity.label}</p>
                        {identity.default ? (
                          <span aria-label={`Computer default for ${providerName(group.provider)}`} className="shrink-0 text-11 text-ink-2">
                            Default
                          </span>
                        ) : null}
                      </div>
                      {action ? (
                        <div className="h-6 w-28 shrink-0">
                          <Tooltip label={`Computer default on ${computerName}. Project and Link choices stay.`} wrap align="end">
                            <button
                              type="button"
                              disabled={pending !== null}
                              aria-busy={pending === `${group.provider}:${identity.id}`}
                              aria-label={`Set ${identity.label} as the ${providerName(group.provider)} default on this computer`}
                              onClick={() => void setDefault(group.provider, identity.id)}
                              className="h-6 w-28 rounded-control border border-line px-2 text-12 font-medium text-ink opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-hover disabled:group-hover:opacity-40 disabled:group-focus-within:opacity-40"
                            >
                              Set as default
                            </button>
                          </Tooltip>
                        </div>
                      ) : null}
                    </div>
                    {identity.email ? <p className="mt-1 break-words text-12 text-ink-3">{identity.email}</p> : null}
                    {stale ? <p className="mt-1 text-11 text-ink-3">Last known · {formatUpdatedAgo(entry.updatedAt, now)}</p> : null}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-x-8 gap-y-4">
                      {entry.windows.map((window) => (
                        <div key={window.id} className="flex min-w-0 flex-col gap-2">
                          <p className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-11 text-ink-3">
                            <span>{window.label}</span>
                            <span className={`text-13 font-semibold tabular-nums ${percentInk[usageTone(window.usedPercent)]}`}>
                              {formatPercent(shownPercent(window.usedPercent, usageDisplay))} {shownSuffix(usageDisplay)}
                            </span>
                          </p>
                          <UsageBar
                            usedPercent={window.usedPercent}
                            display={usageDisplay}
                            tone={stale ? "stale" : usageTone(window.usedPercent)}
                            className="h-1 w-full"
                          />
                          <p className="text-11 text-ink-3">{[window.detail, formatResetsAt(window.resetsAt, now)].filter(Boolean).join(" · ")}</p>
                        </div>
                      ))}
                    </div>
                    {entry.bankedResets ? <p className="text-12 text-ink-2">Banked resets: {entry.bankedResets} left</p> : null}
                    {!entry.windows.length ? (
                      <p className="flex items-center gap-2 text-13 text-ink-2">
                        <HugeiconsIcon icon={AlertCircleIcon} size={16} className="shrink-0 text-orange-ink" />
                        Usage unavailable
                      </p>
                    ) : null}
                    {entry.message ? (
                      <p
                        role={entry.status === "error" ? "alert" : undefined}
                        className={`text-12 ${entry.status === "error" ? "text-orange-ink" : "text-ink-3"}`}
                      >
                        {entry.message}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!groups.length && !usage.error ? (
        <div className="flex items-center gap-2 text-13 text-ink-3">
          {usage.loading ? <SpinnerRing size={16} /> : null}
          <p>{usage.loading ? "Checking account usage…" : "No connected accounts. Sign in to a provider in Accounts to see its plan usage."}</p>
        </div>
      ) : null}
      {usage.error ? (
        <p role="alert" className="text-12 text-orange-ink">
          {usage.error}
        </p>
      ) : null}
      {updatedAt || (computerId === LOCAL_COMPUTER && onManageAccounts) ? (
        <div className="flex items-center justify-between gap-4 text-11 text-ink-3">
          <span>{updatedAt ? formatUpdatedAgo(updatedAt, now) : ""}</span>
          {computerId === LOCAL_COMPUTER && onManageAccounts ? (
            <button type="button" onClick={onManageAccounts} className="min-h-6 rounded-control px-2 text-12 transition-colors hover:bg-hover hover:text-ink">
              Manage accounts
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

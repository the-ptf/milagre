import { useMemo } from "react";
import { useProviderUpdates } from "@milagre/shared/use-provider-updates";
import { providerName } from "@milagre/shared/providers";
import { ProviderLogo } from "./ProviderLogo";

export function ProviderUpdateNotice({ onSettings, onUpdated }: { onSettings: () => void; onUpdated?: () => void }) {
  const transport = useMemo(
    () => ({
      read: () => window.milagre.getProviderUpdates(),
      install: async (update: import("@milagre/shared/model").ProviderUpdate) => {
        const result = await window.milagre.updateCli(update.provider, update.version);
        if (result.ok) onUpdated?.();
        return result;
      },
    }),
    [onUpdated],
  );
  const updates = useProviderUpdates(transport);
  const { current, working, error } = updates;
  if (!current) return null;
  const name = providerName(current.provider);
  const button =
    "cursor-pointer rounded-control border border-line bg-surface px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-40";
  return (
    <section
      data-provider-update
      role="status"
      aria-live="polite"
      className="relative w-[360px] max-w-full rounded-card border border-line bg-surface p-4 text-ink shadow-overlay"
    >
      <button
        type="button"
        aria-label={`Dismiss ${name} update`}
        disabled={working}
        onClick={updates.dismiss}
        className="absolute right-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-full text-ink-3 hover:bg-hover disabled:cursor-default disabled:opacity-40"
      >
        <span aria-hidden="true">×</span>
      </button>
      <div className="flex items-center gap-2 pr-5 text-[14px] font-medium">
        <span className="relative">
          <ProviderLogo provider={current.provider} size={19} />
          <span aria-hidden="true" className="absolute -bottom-1 -right-1 rounded-full bg-surface text-[11px] leading-none text-green-ink">
            ↓
          </span>
        </span>
        <span>
          Update available: {name} v{current.version}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">Install the update now or review provider settings.</p>
      {error && (
        <p role="alert" className="mt-2 break-words text-[12px] text-red-ink">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={button} onClick={onSettings}>
          Settings
        </button>
        <button type="button" className={button} disabled={working} onClick={() => void updates.install()}>
          {working ? "Updating…" : error ? "Retry" : "Update"}
        </button>
      </div>
    </section>
  );
}

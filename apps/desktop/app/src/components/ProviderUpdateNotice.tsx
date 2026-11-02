import { useMemo } from "react";
import { useProviderUpdates } from "@milagre/shared/use-provider-updates";
import { providerName } from "@milagre/shared/providers";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { ProviderLogo } from "./ProviderLogo";
import { Button, IconButton } from "./primitives/Button";
import { InlineError } from "./primitives/InlineError";

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
  return (
    <section
      data-provider-update
      role="status"
      aria-live="polite"
      className="relative w-[360px] max-w-full rounded-card bg-surface p-4 text-ink shadow-overlay"
    >
      {/* A wrapper takes the position: IconButton is `relative` for its hit area. */}
      <span className="absolute top-2 right-2 flex">
        <IconButton label={`Dismiss ${name} update`} icon={Cancel01Icon} size={28} disabled={working} onClick={updates.dismiss} />
      </span>
      <div className="flex items-center gap-2 pr-6 text-15 font-semibold">
        <span className="relative">
          <ProviderLogo provider={current.provider} size={18} />
          <span aria-hidden="true" className="absolute -bottom-1 -right-1 rounded-full bg-surface text-11 leading-none text-green-ink">
            ↓
          </span>
        </span>
        <span>
          Update available: {name} v{current.version}
        </span>
      </div>
      <p className="mt-2 text-13 text-ink-3">Install the update now or review provider settings.</p>
      <InlineError size={12} className="mt-2">
        {error}
      </InlineError>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onSettings}>
          Settings
        </Button>
        <Button disabled={working} onClick={() => void updates.install()}>
          {working ? "Updating…" : error ? "Retry" : "Update"}
        </Button>
      </div>
    </section>
  );
}

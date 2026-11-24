import { providerName } from "@milagre/shared/providers";
import { downloadPercent, installedLine, progressLine, type ProviderUpdateItem } from "@milagre/shared/provider-update-view";
import { CheckmarkCircle02Icon, Copy01Icon, GiftIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ModelProvider } from "../model";
import { useCopied } from "../lib/use-copied";
import { ProviderLogo } from "./ProviderLogo";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ProgressBar } from "./primitives/ProgressBar";
import { SpinnerRing } from "./primitives/SpinnerRing";

export function updateTitle(item: ProviderUpdateItem) {
  const name = providerName(item.provider);
  if (item.status === "updating") return `Updating ${name}`;
  if (item.status === "done") return `${name} ${item.version} installed`;
  if (item.status === "failed") return `${name} update failed`;
  return `${name} ${item.version}`;
}

export function UpdateMark({ item, size = 18 }: { item: ProviderUpdateItem; size?: 14 | 18 }) {
  if (item.status === "done") return <Icon icon={CheckmarkCircle02Icon} size={size} className="text-green" />;
  return <ProviderLogo provider={item.provider} size={size} />;
}

export function UpdateLogos({ providers, app, size }: { providers: ModelProvider[]; app: boolean; size: 14 | 18 }) {
  return (
    <span className="flex items-center">
      {app && <Icon icon={GiftIcon} size={size} />}
      {providers.map((provider, index) => (
        <span key={provider} className={`flex rounded-full bg-surface shadow-[0_0_0_2px_var(--surface)] ${index || app ? "-ml-1" : ""}`}>
          <ProviderLogo provider={provider} size={size} />
        </span>
      ))}
    </span>
  );
}

function UpdateProgress({ item }: { item: ProviderUpdateItem }) {
  const percent = downloadPercent(item.progress);
  const line = progressLine(item.progress);
  return (
    <>
      <div className="flex items-center gap-3">
        <ProgressBar
          value={(percent ?? 0) / 100}
          indeterminate={percent === null}
          size={6}
          label={`${providerName(item.provider)} update`}
          valueText={line}
          className="flex-1"
        />
        {percent !== null && <span className="w-9 text-right text-12 tabular-nums text-ink-2">{percent}%</span>}
      </div>
      <p className="mt-2 text-12 tabular-nums text-ink-3">{line}</p>
      {item.command && <p className="mt-1.5 font-mono text-11 text-ink-3">$ {item.command}</p>}
    </>
  );
}

function CopyCommand({ command }: { command: string }) {
  const { copied, copy } = useCopied(command);
  return (
    <Button variant="secondary" className="flex-1" onClick={copy}>
      <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      {copied ? "Copied" : "Copy command"}
    </Button>
  );
}

/** The card for a single CLI update: what you have, then the download, then the result. */
export function ProviderUpdateBody({ item, computer, onInstall }: { item: ProviderUpdateItem; computer?: string; onInstall: () => void }) {
  return (
    <>
      <div id="update-description" className="mt-3 text-13 text-ink-2" aria-live="polite">
        {item.status === "available" && <p>{installedLine(item, computer)}</p>}
        {item.status === "updating" && <UpdateProgress item={item} />}
        {item.status === "done" && <p>New Chats start on {item.version}.</p>}
        {item.status === "failed" && (
          <>
            <InlineError>{item.error}</InlineError>
            {item.log && (
              <pre className="mt-2.5 max-h-26 overflow-auto rounded-control bg-inset px-3 py-2.5 font-mono text-11 leading-4 whitespace-pre-wrap text-ink-2 shadow-[inset_0_0_0_1px_var(--line)]">
                {item.log}
              </pre>
            )}
          </>
        )}
      </div>
      {(item.status === "available" || item.status === "failed") && (
        <div className="mt-5 flex gap-2">
          {item.status === "failed" && item.command && <CopyCommand command={item.command} />}
          <Button className="flex-1" onClick={onInstall}>
            {item.status === "failed" ? "Try again" : "Update"}
          </Button>
        </div>
      )}
    </>
  );
}

/** One row of the card that lists several updates. */
export function ProviderUpdateRow({ item, locked, onInstall }: { item: ProviderUpdateItem; locked: boolean; onInstall: () => void }) {
  const percent = downloadPercent(item.progress);
  return (
    <li className="flex items-center gap-2.5 rounded-control px-2 py-2 hover:bg-hover">
      <ProviderLogo provider={item.provider} size={18} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 font-medium">
          {providerName(item.provider)} {item.version}
        </span>
        {item.status === "failed" ? (
          <span className="truncate text-12 text-red-ink">{item.error}</span>
        ) : (
          <span className="truncate text-12 text-ink-3">
            {item.installedVersion} → {item.version}
          </span>
        )}
      </div>
      {(item.status === "available" || item.status === "failed") && (
        <Button variant="secondary" size={24} disabled={locked} onClick={onInstall}>
          {item.status === "failed" ? "Retry" : "Update"}
        </Button>
      )}
      {item.status === "updating" && (
        <span className="flex items-center gap-1.5 text-12 tabular-nums text-ink-3">
          <SpinnerRing size={12} />
          {percent === null ? "Installing" : `${percent}%`}
        </span>
      )}
      {item.status === "done" && (
        <span className="flex items-center gap-1 text-12 text-green-ink">
          <Icon icon={Tick02Icon} size={14} />
          Updated
        </span>
      )}
    </li>
  );
}

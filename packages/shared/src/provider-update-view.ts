import type { ModelProvider } from "./model.ts";
import { providerName } from "./providers.mjs";

/** Where a CLI came from, which decides the version it can update to and the command that updates it. Older hosts send none. */
export type ProviderUpdateChannel = "homebrew-cask" | "homebrew-formula" | "npm" | "installer" | "milagre" | "other";
/** Sent while the host installs an update. */
export type ProviderUpdateProgress = { phase: "download"; received: number; total: number } | { phase: "install" | "extract" | "validate" | "done" };
export interface ProviderUpdate {
  provider: ModelProvider;
  installedVersion: string;
  version: string;
  channel?: ProviderUpdateChannel;
  command?: string | null;
  progress?: ProviderUpdateProgress;
}

export type ProviderUpdateStatus = "available" | "updating" | "done" | "failed";
export interface ProviderUpdateItem extends ProviderUpdate {
  status: ProviderUpdateStatus;
  error?: string;
  /** The last lines the failed command printed. */
  log?: string;
}

const CHANNEL_LABELS: Partial<Record<ProviderUpdateChannel, string>> = {
  "homebrew-cask": "Homebrew",
  "homebrew-formula": "Homebrew",
  npm: "npm",
  installer: "the official installer",
};
export const channelLabel = (channel: ProviderUpdateChannel | undefined) => (channel ? (CHANNEL_LABELS[channel] ?? null) : null);

/** Whole percent of a download whose size is known; null while installing or when the size isn't known. */
export function downloadPercent(progress: ProviderUpdateProgress | undefined): number | null {
  if (progress?.phase !== "download" || !(progress.total > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.received / progress.total) * 100)));
}

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);
/** "Downloading · 14.2 of 38.4 MB", or "Installing…" once the download is done or has no known size. */
export function progressLine(progress: ProviderUpdateProgress | undefined) {
  if (progress?.phase === "download" && progress.total > 0) return `Downloading · ${megabytes(progress.received)} of ${megabytes(progress.total)} MB`;
  return "Installing…";
}

/** One line under the card title: the version you have and how it was installed. */
export function installedLine(item: ProviderUpdate, computer?: string) {
  const via = channelLabel(item.channel);
  return `You have ${item.installedVersion}${via ? `, installed with ${via}` : ""}${computer ? ` on ${computer}` : ""}.`;
}

export type UpdatePill =
  | { kind: "updating"; provider: ModelProvider; label: string; percent: number | null }
  | { kind: "failed"; provider: ModelProvider; label: string }
  | { kind: "done"; label: string }
  | { kind: "available"; providers: ModelProvider[]; label: string };

/** What the collapsed pill says for a set of CLI updates. `extra` counts other updates shown with them (Milagre's). */
export function updatePill(items: ProviderUpdateItem[], extra = 0): UpdatePill | null {
  if (!items.length) return null;
  const updating = items.find((item) => item.status === "updating");
  if (updating) {
    const percent = downloadPercent(updating.progress);
    const name = providerName(updating.provider);
    return { kind: "updating", provider: updating.provider, percent, label: percent === null ? `Installing ${name}…` : `Updating ${name}` };
  }
  const failed = items.find((item) => item.status === "failed");
  if (failed) return { kind: "failed", provider: failed.provider, label: `${providerName(failed.provider)} update failed` };
  const pending = items.filter((item) => item.status !== "done");
  const [first] = items;
  if (!pending.length && !extra)
    return {
      kind: "done",
      label: items.length === 1 && first ? `${providerName(first.provider)} ${first.version} installed` : `${items.length} updates installed`,
    };
  const [only] = pending;
  if (only && pending.length === 1 && !extra) return { kind: "available", providers: [only.provider], label: `${providerName(only.provider)} ${only.version}` };
  const count = pending.length + extra;
  return { kind: "available", providers: pending.map((item) => item.provider), label: `${count} updates` };
}

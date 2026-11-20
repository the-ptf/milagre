import type { DesignPageShare } from "@milagre/shared/artifact";
import { Button } from "../primitives/Button";
import { showToast } from "../../lib/toast";

export const olderLinksNotice = (count = 0) =>
  count ? `${count === 1 ? "An older link" : `${count} older links`} could not be revoked yet. Stop sharing it in Settings > Published pages.` : "";

async function copyLink(url: string, onError: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied.");
  } catch {
    onError("Could not copy the link. Select it and copy it.");
  }
}

export function ShareLinkRow({ share, onError }: { share: DesignPageShare; onError: (message: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-control bg-field p-1.5 pl-2 ring-1 ring-line">
      <a
        href={share.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open link for ${share.title}`}
        className="min-w-0 flex-1 select-text truncate px-1 text-12 text-ink-2 hover:underline"
      >
        {share.url}
      </a>
      <Button variant="secondary" size={28} onClick={() => void copyLink(share.url, onError)}>
        Copy link
      </Button>
    </div>
  );
}

/** Stop sharing, behind a confirmation that says copies may stay online. */
export function StopSharing({
  confirming,
  busy,
  disabled,
  onAsk,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  busy: boolean;
  disabled: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming)
    return (
      <Button variant="danger-ghost" size={24} data-slot="design-page-revoke" disabled={disabled} onClick={onAsk}>
        Stop sharing
      </Button>
    );
  return (
    <div className="w-full space-y-2">
      <p className="text-12 text-ink-2">Take this link down? Copies may remain online.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size={28} disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" size={28} data-slot="design-page-revoke-confirm" disabled={disabled} onClick={onConfirm}>
          {busy ? "Stopping…" : "Stop sharing"}
        </Button>
      </div>
    </div>
  );
}

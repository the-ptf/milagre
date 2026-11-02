import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Attachment01Icon, Cancel01Icon, Clock01Icon, Image01Icon, LaptopIcon } from "@hugeicons/core-free-icons";
import { canCancelOutbox, type OutboxItem } from "@milagre/shared/outbox";
import { outbox, outboxChat, useOutbox } from "../lib/outbox";
import Tooltip from "./primitives/Tooltip";

/** Whether the composer of this Chat (a New Chat when `sessionId` is null) has anything to show above it. */
export function useOfflineTray(owner: string | undefined, sessionId: number | null, offline: boolean) {
  const snapshot = useOutbox();
  const items = owner ? snapshot.items.filter((item) => item.owner === owner && outboxChat(item) === sessionId && item.status !== "sent") : [];
  return { items, error: snapshot.error, loaded: snapshot.loaded, shown: offline || items.length > 0 || Boolean(snapshot.error && owner) };
}

/**
 * Messages saved on this Mac for a computer that can't take them yet, inside the composer's tray (design
 * offline-inline-desktop v7): one row each, oldest first, then the computer's chip while it is offline. They live in the
 * Chat they were written in; there is no other list.
 */
export function OfflineTray({
  owner,
  sessionId,
  computerName,
  offline,
  chip = true,
  detail,
}: {
  owner: string;
  sessionId: number | null;
  computerName: string;
  offline: boolean;
  /** A new Chat's tray already names its computer. */
  chip?: boolean;
  /** The chip's tooltip: when the computer was last seen. */
  detail?: string;
}) {
  const { items, error: storageError, loaded } = useOfflineTray(owner, sessionId, offline);
  const [error, setError] = useState("");
  const act = (work: Promise<unknown>) => {
    setError("");
    void work.catch((failure: Error) => setError(failure.message));
  };
  // A message the computer saved is in the transcript now: its copy here goes.
  const delivered = useOutbox().items.filter((item) => item.owner === owner && item.status === "sent" && outboxChat(item) === sessionId);
  useEffect(() => {
    for (const item of delivered) void outbox.remove(item.id).catch(() => {});
  }, [delivered.map((item) => item.id).join()]);
  const message = storageError || error;
  return (
    <div data-offline-tray className="flex flex-col">
      {message && (
        <p role="alert" className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-12 text-orange-ink">
          <span className="min-w-0 flex-1">{message}</span>
          {storageError && loaded && (
            <button type="button" onClick={() => act(outbox.retryStorage())} className="shrink-0 rounded-control px-2 py-0.5 font-medium hover:bg-hover-2">
              Retry saving
            </button>
          )}
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col pt-0.5" aria-label={`Waiting for ${computerName}`}>
          {items.map((item) => (
            <TrayRow key={item.id} item={item} onAct={act} />
          ))}
        </ul>
      )}
      {offline && chip && (
        <div className="flex px-1 pt-0.5 pb-1.5">
          <Tooltip label={detail ?? `${computerName} is offline`} side="top" align="start" wrap>
            <span data-offline-chip className="flex h-6 max-w-full items-center gap-1.5 rounded-chip bg-field px-2 text-12">
              <HugeiconsIcon icon={LaptopIcon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-2" />
              <span className="truncate font-medium text-ink">{computerName}</span>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ink-4" />
              <span className="shrink-0 text-ink-3">offline</span>
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function TrayRow({ item, onAct }: { item: OutboxItem; onAct: (work: Promise<unknown>) => void }) {
  const failed = item.status === "failed";
  const images = item.attachments.filter((file) => file.imageId);
  const files = item.attachments.filter((file) => !file.imageId);
  const attachment = images.length ? images : files;
  // Waiting needs no word: the clock says it. Only sending and failures do.
  const status = failed ? item.error : item.status === "sending" ? "Sending…" : "";
  // A send that may have reached the computer is checked before it goes again; a Worktree that may exist can't be redone.
  const retry = failed && item.phase !== "creating" ? (item.phase === "dispatching" ? "Check delivery" : "Retry") : null;
  return (
    <li data-offline-message={item.id} data-outbox-state={item.status} className="group flex items-start gap-2.5 rounded-card px-2.5 py-2 hover:bg-hover">
      <span className="flex h-[18px] shrink-0 items-center text-orange-ink">
        <HugeiconsIcon icon={failed ? AlertCircleIcon : Clock01Icon} size={14} strokeWidth={2} color="currentColor" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-13 leading-[18px] break-words whitespace-pre-wrap text-ink">{item.request.body.trim() || "Attachments"}</p>
        {(attachment.length > 0 || status) && (
          <p className={`mt-0.5 flex min-w-0 items-center gap-1 text-12 leading-4 ${failed ? "text-orange-ink" : "text-ink-3"}`}>
            {attachment.length > 0 && (
              <>
                <HugeiconsIcon icon={images.length ? Image01Icon : Attachment01Icon} size={12} strokeWidth={1.8} color="currentColor" className="shrink-0" />
                <span className="min-w-0 truncate">
                  {attachment.length === 1 ? attachment[0]!.name : `${attachment.length} ${images.length ? "images" : "files"}`}
                  {images.length && files.length ? ` + ${files.length} file${files.length === 1 ? "" : "s"}` : ""}
                </span>
                {status && <span className="shrink-0">·</span>}
              </>
            )}
            {status && <span className={failed ? "min-w-0" : "shrink-0"}>{status}</span>}
          </p>
        )}
      </div>
      {retry && (
        <button
          type="button"
          data-offline-retry={item.id}
          onClick={() => onAct(outbox.retry(item.id))}
          className="-my-0.5 shrink-0 rounded-control px-2 py-0.5 text-12 font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
        >
          {retry}
        </button>
      )}
      {canCancelOutbox(item) && (
        <Tooltip label="Cancel message" side="top" align="end">
          <button
            type="button"
            aria-label="Cancel message"
            data-offline-cancel={item.id}
            onClick={() => onAct(outbox.remove(item.id))}
            className="-my-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

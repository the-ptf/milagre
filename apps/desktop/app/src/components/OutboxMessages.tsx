import { useState } from "react";
import { canCancelOutbox, outboxStatus } from "@milagre/shared/outbox";
import { outbox, useOutbox } from "../lib/outbox";
import { ScrollArea } from "./primitives/ScrollArea";

/** Local messages stay visible independently of the computer's cached transcript. */
export function OutboxMessages({
  owner,
  sessionId,
  worktreeId,
  onOpen,
}: {
  owner?: string;
  sessionId?: number;
  worktreeId?: number;
  onOpen?: (id: number) => void;
}) {
  const snapshot = useOutbox();
  const [error, setError] = useState("");
  const items = snapshot.items.filter((item) => !owner || item.owner === owner);
  const act = (work: Promise<unknown>) => {
    setError("");
    void work.catch((error: Error) => setError(error.message));
  };
  if (!items.length && !snapshot.error && !error) return null;
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pt-3" data-outbox>
      <div className="rounded-card border border-line bg-surface px-3 py-2 text-12">
        <p className="font-semibold text-orange-ink">Messages on this device</p>
        <p className="text-ink-3">Delivery resumes while Milagre is open. Sent means the computer saved the message.</p>
        {(snapshot.error || error) && (
          <p role="alert" className="text-red-ink">
            {snapshot.error || error}
          </p>
        )}
        {snapshot.error && snapshot.loaded && <button onClick={() => act(outbox.retryStorage())}>Retry saving</button>}
        <ScrollArea className="max-h-48">
          {items.map((item) => (
            <div key={item.id} className="border-t border-line py-2" data-outbox-state={item.status}>
              <p className="text-ink-2">
                {item.computerName} · {(item.sessionId ?? item.request.sessionId) ? `Chat #${item.sessionId ?? item.request.sessionId}` : "New Chat"} ·{" "}
                {outboxStatus(item)}
              </p>
              <p className="line-clamp-2 whitespace-pre-wrap text-ink">{item.request.body || "Attachments"}</p>
              {item.attachments.length > 0 && <p className="text-ink-3">{item.attachments.map((file) => file.name).join(", ")}</p>}
              {item.error && <p className="text-orange-ink">{item.error}</p>}
              <div className="flex flex-wrap gap-3 pt-1">
                {item.status !== "sending" && item.status !== "sent" && item.phase !== "creating" && (
                  <button onClick={() => act(outbox.retry(item.id))}>{item.phase === "dispatching" ? "Check delivery" : "Retry"}</button>
                )}
                {item.status === "failed" && canCancelOutbox(item) && sessionId != null && worktreeId != null && (
                  <button onClick={() => act(outbox.recover(item.id, { sessionId, worktreeId }))}>Recover to this Chat</button>
                )}
                {onOpen && item.status === "sent" && item.sessionId && <button onClick={() => onOpen(item.sessionId!)}>Open Chat</button>}
                {canCancelOutbox(item) && <button onClick={() => act(outbox.remove(item.id))}>{item.status === "sent" ? "Dismiss" : "Cancel message"}</button>}
              </div>
            </div>
          ))}
        </ScrollArea>
      </div>
    </div>
  );
}

/** Always reachable after a restart, even when a computer or its Project is no longer listed. */
export function OutboxInbox() {
  const snapshot = useOutbox();
  const [open, setOpen] = useState(false);
  if (!snapshot.items.length && !snapshot.error) return null;
  return (
    <>
      <button
        data-outbox-inbox
        className="fixed top-2 left-1/2 z-50 -translate-x-1/2 rounded-control border border-line bg-surface px-3 py-1 text-11 text-orange-ink shadow-overlay [-webkit-app-region:no-drag]"
        onClick={() => setOpen(true)}
      >
        Messages on this device ({snapshot.items.filter((item) => item.status !== "sent").length})
      </button>
      {open && (
        <dialog
          aria-label="Messages on this device"
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onClose={() => setOpen(false)}
          className="m-auto w-full max-w-xl rounded-card border border-line bg-surface p-4 text-ink backdrop:bg-black/40 backdrop:backdrop-blur-overlay"
        >
          <div className="flex justify-between text-15 font-semibold">
            <span>Messages on this device</span>
            <button aria-label="Close device queue" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <OutboxMessages />
        </dialog>
      )}
    </>
  );
}

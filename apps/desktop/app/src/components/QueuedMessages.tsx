import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { AgentSession, QueuedMessage } from "../model";
import type { MilagreBridge } from "../electron";
import { queueStatus } from "@milagre/shared/queued-messages";
import { ipcErrorMessage } from "@milagre/shared/result";
import Tooltip from "./primitives/Tooltip";

export interface QueueControls {
  items: QueuedMessage[];
  /** Stop (or a failure) ended the turn they waited on: they wait for Send now. */
  held: boolean;
  running: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * Messages waiting for the running turn of an agent that can't be steered (chat-host.cjs queues them). They sit above
 * the composer, oldest first, each with Send now and Remove; the line above says when they go.
 */
export function QueuedMessages({ items, held, running, onSendNow, onRemove, disabled }: QueueControls & { disabled?: boolean }) {
  if (!items.length) return null;
  return (
    <div
      data-queued-messages
      className="mb-2 w-full rounded-[12px] border border-line bg-surface px-1.5 py-1.5 text-[13px] text-ink shadow-overlay"
      style={{ animation: "fade-up 250ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <p className="px-2 pt-0.5 pb-1 text-[12px] text-ink-3">
        <span className="font-medium text-ink-2">Queued</span> · {queueStatus({ count: items.length, held, running })}
      </p>
      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.id} data-queued-message={item.id} className="group flex items-center gap-2 rounded-[8px] px-2 py-1.5 hover:bg-hover">
            <span className="min-w-0 flex-1 truncate">
              {item.body.trim() || "Attachments"}
              {attachmentNote(item) && <span className="text-ink-3"> · {attachmentNote(item)}</span>}
            </span>
            <button
              type="button"
              data-queued-send={item.id}
              disabled={disabled}
              onClick={() => onSendNow(item.id)}
              className="shrink-0 rounded-control px-2 py-0.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink disabled:cursor-default disabled:opacity-40"
            >
              {running ? "Stop and send" : "Send now"}
            </button>
            <Tooltip label="Remove from queue" side="top" align="end">
              <button
                type="button"
                aria-label="Remove from queue"
                data-queued-remove={item.id}
                disabled={disabled}
                onClick={() => onRemove(item.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink disabled:cursor-default disabled:opacity-40"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The queue controls of a Chat on screen, or undefined when nothing waits in it. */
export function queueControls(
  bridge: Pick<MilagreBridge, "sendQueuedNow" | "removeQueued">,
  chatId: string,
  session: Pick<AgentSession, "queued" | "queueHeld"> | undefined,
  running: boolean,
  onError: (message: string) => void,
): QueueControls | undefined {
  if (!session?.queued?.length) return undefined;
  const report = (verb: string) => (error: unknown) => onError(`Couldn't ${verb} the queued message: ${ipcErrorMessage(error)}`);
  return {
    items: session.queued,
    held: Boolean(session.queueHeld),
    running,
    onSendNow: (id) => void bridge.sendQueuedNow(chatId, id).catch(report("send")),
    onRemove: (id) => void bridge.removeQueued(chatId, id).catch(report("remove")),
  };
}

function attachmentNote(item: QueuedMessage) {
  const images = item.images?.length ?? 0;
  const files = item.files?.length ?? 0;
  return [images ? `${images} image${images === 1 ? "" : "s"}` : "", files ? `${files} file${files === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
}

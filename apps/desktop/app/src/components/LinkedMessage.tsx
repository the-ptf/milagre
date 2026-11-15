import { useState } from "react";
import { ArrowRight01Icon, Link04Icon } from "@hugeicons/core-free-icons";
import { exchangeText, linkedContext, linkedHeading, linkedLine, type LinkedExchange } from "@milagre/shared/linked-message";
import type { ChatMessage, LinkedContext } from "../model";
import { Attachments } from "./Attachments";
import { HandoffBriefDialog } from "./Handover";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

export { linkedContext, linkedLine };

/** The sender line over a message another Chat sent: who it's from, and a way to open that Chat. */
export function LinkedMessageHeader({ context, onOpenChat }: { context: LinkedContext; onOpenChat?: (chatKey: string) => void }) {
  const { text, chat } = linkedHeading(context);
  const label = (
    <>
      <Icon icon={Link04Icon} size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
  return chat && onOpenChat ? (
    <button
      type="button"
      data-linked-from={chat}
      onClick={() => onOpenChat(chat)}
      className="relative flex max-w-full items-center gap-1.5 text-11 font-medium text-accent-ink before:absolute before:-inset-x-1 before:-inset-y-1 hover:underline"
    >
      {label}
    </button>
  ) : (
    <div className="flex max-w-full items-center gap-1.5 text-11 font-medium text-ink-3">{label}</div>
  );
}

/**
 * A message another Chat's agent sent (chat_start, or a Delegation), as a line in the transcript the way a model switch
 * is one: "Message from Fix login". A click opens the whole message, with its sender and a way to open that Chat.
 */
export function LinkedMessageLine({
  message,
  line,
  onOpenChat,
}: {
  message: Pick<ChatMessage, "id" | "body" | "images" | "files">;
  line: NonNullable<ReturnType<typeof linkedLine>>;
  onOpenChat?: (chatKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const attached = (message.images?.length ?? 0) + (message.files?.length ?? 0);
  const chat = line.chat;
  const openChat =
    chat && onOpenChat
      ? () => {
          setOpen(false);
          onOpenChat(chat);
        }
      : undefined;
  return (
    <TranscriptDivider data-linked-message-line={String(message.id)} label={`${line.verb} ${line.label}`}>
      {/* The visible text names the button; the ::before brings its hit area to 24px without growing the hairline row. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={line.label}
        className="group/line relative -mx-2 flex min-w-0 items-center gap-1.5 rounded-control px-2 py-0.5 transition-colors duration-fast before:absolute before:-inset-y-1 before:inset-x-0 hover:bg-hover hover:text-ink"
      >
        <Icon icon={Link04Icon} size={12} className="shrink-0" />
        <span className="shrink-0">{line.verb}</span>
        <span className="min-w-0 truncate font-medium text-ink-2 group-hover/line:text-ink">{line.name}</span>
        {attached > 0 && <span className="shrink-0">· {attached === 1 ? "1 attachment" : `${attached} attachments`}</span>}
        <Icon icon={ArrowRight01Icon} size={12} className="shrink-0" />
      </button>
      {open && (
        <HandoffBriefDialog
          title={`${line.verb} ${line.name}`}
          description={line.label !== line.name ? line.label : undefined}
          brief={message.body}
          onClose={() => setOpen(false)}
          action={
            openChat && (
              <Button variant="ghost" data-linked-open-chat={line.chat} onClick={openChat}>
                Open Chat
              </Button>
            )
          }
        >
          {attached > 0 && (
            <div className="mt-3">
              <Attachments images={message.images} files={message.files} />
            </div>
          )}
        </HandoffBriefDialog>
      )}
    </TranscriptDivider>
  );
}

/**
 * A back-and-forth with one other Chat as one line ("4 messages with Fix login"); the latest reply stays under it in the
 * transcript. A click opens the whole exchange, each message under who wrote it.
 */
export function LinkedExchangeLine({ exchange, onOpenChat }: { exchange: LinkedExchange; onOpenChat?: (chatKey: string) => void }) {
  const [open, setOpen] = useState(false);
  const { line } = exchange;
  const chat = line.chat;
  const openChat =
    chat && onOpenChat
      ? () => {
          setOpen(false);
          onOpenChat(chat);
        }
      : undefined;
  return (
    <TranscriptDivider data-linked-exchange={String(exchange.items[0]?.message.id ?? "")} label={`${exchange.count} messages with ${line.label}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={line.label}
        className="group/line relative -mx-2 flex min-w-0 items-center gap-1.5 rounded-control px-2 py-0.5 transition-colors duration-fast before:absolute before:-inset-y-1 before:inset-x-0 hover:bg-hover hover:text-ink"
      >
        <Icon icon={Link04Icon} size={12} className="shrink-0" />
        <span className="shrink-0">{exchange.count} messages with</span>
        <span className="min-w-0 truncate font-medium text-ink-2 group-hover/line:text-ink">{line.name}</span>
        <Icon icon={ArrowRight01Icon} size={12} className="shrink-0" />
      </button>
      {open && (
        <HandoffBriefDialog
          title={`Messages with ${line.name}`}
          description={line.label !== line.name ? line.label : undefined}
          brief={exchangeText(exchange)}
          onClose={() => setOpen(false)}
          action={
            openChat && (
              <Button variant="ghost" data-linked-open-chat={chat} onClick={openChat}>
                Open Chat
              </Button>
            )
          }
        />
      )}
    </TranscriptDivider>
  );
}

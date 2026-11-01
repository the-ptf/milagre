import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, CornerDownRightIcon } from "@hugeicons/core-free-icons";
import type { SubchatKind } from "@milagre/shared/subchat-states";
import { Markdown } from "./markdown/Markdown";

const INK: Partial<Record<SubchatKind, string>> = { failed: "text-red-ink" };

/**
 * What a Subchat's finished report stands for in the transcript: one grey line ("Fix the login finished"), whose name
 * opens that Chat and whose chevron shows the report's text in place.
 */
export function DelegationReportLine({
  marker,
  body,
  chat,
  onOpenChat,
}: {
  marker: { text: string; kind: SubchatKind };
  body: string;
  /** The Chat that sent it, when there is one to open. */
  chat: string | null;
  onOpenChat?: (chatKey: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const ink = INK[marker.kind] ?? "text-ink-3";
  const text = <span className="min-w-0 truncate">{marker.text}</span>;
  return (
    <div data-slot="delegation-report" data-kind={marker.kind} data-open={shown || undefined} className="flex min-w-0 max-w-full flex-col gap-1.5">
      <div className={`flex min-w-0 max-w-full items-center gap-1.5 text-12 ${ink}`}>
        <HugeiconsIcon icon={CornerDownRightIcon} size={12} strokeWidth={1.6} className="shrink-0" aria-hidden />
        {chat && onOpenChat ? (
          <button
            type="button"
            data-linked-from={chat}
            onClick={() => onOpenChat(chat)}
            className="flex min-w-0 items-center rounded-inline hover:underline focus-visible:outline-2"
          >
            {text}
          </button>
        ) : (
          text
        )}
        {body.trim() && (
          <button
            type="button"
            aria-expanded={shown}
            aria-label={shown ? "Hide the report" : "Show the report"}
            onClick={() => setShown(!shown)}
            className="flex size-5 shrink-0 items-center justify-center rounded-inline text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.6} className={`transition-transform ${shown ? "" : "-rotate-90"}`} aria-hidden />
          </button>
        )}
      </div>
      {shown && (
        <div
          data-slot="delegation-report-body"
          className="min-w-0 max-w-full rounded-control border border-line px-3 py-2 text-[length:var(--chat-size)] leading-[1.55] text-ink"
        >
          <div data-slot="message-content">
            <Markdown text={body} />
          </div>
        </div>
      )}
    </div>
  );
}

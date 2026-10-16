import { HugeiconsIcon } from "@hugeicons/react";
import { Link04Icon } from "@hugeicons/core-free-icons";
import type { ChatMessage, LinkedContext } from "../model";

/** The message's Link context when another Chat (or Milagre, for a Link) wrote it rather than the user or the agent. */
export function linkedContext({ context }: Pick<ChatMessage, "context">): LinkedContext | null {
  return typeof context === "object" &&
    context !== null &&
    context.kind !== "git-action" &&
    context.kind !== "handoff" &&
    context.kind !== "worktree-linked" &&
    context.kind !== "advisor-result" &&
    context.kind !== "pr-action" &&
    context.kind !== "linear-issue" &&
    context.kind !== "compaction" &&
    context.kind !== "limit" &&
    context.kind !== "account-switch" &&
    context.kind !== "reload" &&
    context.kind !== "bot-gate-expired"
    ? context
    : null;
}

const ENDED = { cancelled: "stopped", failed: "failed" } as const;

function heading(context: LinkedContext): { text: string; chat: string | null } {
  switch (context.kind) {
    case "delegation":
      return {
        text: `Delegation from ${context.fromLabel}${context.negotiation ? ` · Negotiation round ${context.negotiation.round}` : ""}`,
        chat: context.from,
      };
    case "delegation-report": {
      const ended = context.status === "done" ? "" : ` · ${ENDED[context.status]}`;
      return {
        text: `Delegation report from ${context.fromLabel}${ended}${context.negotiation ? ` · Negotiation round ${context.negotiation.round}` : ""}`,
        chat: context.from,
      };
    }
    case "negotiation-agreement":
      return { text: `Negotiation agreement with ${context.with}`, chat: null };
    case "linked-notice":
      return { text: context.with ? `Negotiation with ${context.with}` : "Link", chat: null };
  }
}

/** The sender line over a message another Chat sent: who it's from, and a way to open that Chat. */
export function LinkedMessageHeader({ context, onOpenChat }: { context: LinkedContext; onOpenChat?: (chatKey: string) => void }) {
  const { text, chat } = heading(context);
  const label = (
    <>
      <HugeiconsIcon icon={Link04Icon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
  return chat && onOpenChat ? (
    <button
      type="button"
      data-linked-from={chat}
      onClick={() => onOpenChat(chat)}
      className="flex max-w-full items-center gap-1.5 text-[11px] font-medium text-accent-ink hover:underline"
    >
      {label}
    </button>
  ) : (
    <div className="flex max-w-full items-center gap-1.5 text-[11px] font-medium text-ink-3">{label}</div>
  );
}

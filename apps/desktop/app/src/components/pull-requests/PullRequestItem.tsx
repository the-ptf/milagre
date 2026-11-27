import { findingsLabel, type ReviewCounts } from "@milagre/shared/pr-review";
import type { IconSvgElement } from "@hugeicons/react";
import { BubbleChatIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { pullRequestReviewBadge, type PullRequestRow } from "@milagre/shared/pull-request-list";
import { age } from "../../lib/pull-request-view";
import { Avatar } from "../changes/pr/Properties";
import { Counts } from "../changes/DiffIndicators";
import { Icon } from "../primitives/Icon";
import { Mascot } from "../orchestrator/Mascot";
import { ChecksHover } from "./ChecksHover";

export function stateGlyph(row: Pick<PullRequestRow, "state" | "isDraft">): { icon: IconSvgElement; className: string; label: string } {
  if (row.state === "MERGED") return { icon: GitMergeIcon, className: "text-purple", label: "Merged" };
  if (row.state === "CLOSED") return { icon: GitPullRequestClosedIcon, className: "text-red", label: "Closed" };
  if (row.isDraft) return { icon: GitPullRequestDraftIcon, className: "text-ink-4", label: "Draft" };
  return { icon: GitPullRequestIcon, className: "text-green", label: "Open" };
}

const BADGE_TONE = {
  green: "bg-green-tint text-green-ink",
  red: "bg-red-tint text-red-ink",
  orange: "bg-orange-tint text-orange-ink",
  purple: "bg-purple-tint text-purple-ink",
  neutral: "bg-field text-ink-2",
} as const;

export type ReviewForMe = { color: string; reviewing: boolean; busyLabel: string; onReview: (from: HTMLElement) => void };

function ReviewForMeButton({ review }: { review: ReviewForMe }) {
  if (review.reviewing)
    return (
      <span
        data-pr-reviewing
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-field pr-2.5 pl-1 text-12 font-medium whitespace-nowrap text-ink-2"
      >
        <Mascot size={16} color={review.color} still />
        {review.busyLabel}
      </span>
    );
  return (
    <button
      type="button"
      data-pr-review-for-me
      onClick={(event) => {
        event.stopPropagation();
        review.onReview(event.currentTarget);
      }}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface pr-2.5 pl-1 text-12 font-medium whitespace-nowrap text-ink shadow-btn transition-[color,background-color,scale] hover:bg-hover active:scale-press"
    >
      <Mascot size={16} color={review.color} still />
      Review for me
    </button>
  );
}

export type ItemComputer = { name: string; offline: boolean } | null;

/** One PR in the list: state, title and number, where it lives, then checks, review and size. */
export function PullRequestItem({
  row,
  findings,
  selected,
  narrow,
  computer,
  review,
  now,
  onSelect,
  onOpenChat,
}: {
  row: PullRequestRow;
  findings?: ReviewCounts;
  selected: boolean;
  narrow: boolean;
  computer: ItemComputer;
  review: ReviewForMe | null;
  now: number;
  onSelect: () => void;
  onOpenChat: (chat: PullRequestRow["chats"][number]) => void;
}) {
  const glyph = stateGlyph(row);
  const badge = pullRequestReviewBadge(row);
  const chat = row.chats[0];
  const updated = age(row.updatedAt, now);
  return (
    <div
      data-pr-row={row.url}
      data-selected={selected || undefined}
      data-offline={row.offline || undefined}
      onClick={onSelect}
      className={`flex h-12 cursor-pointer items-center gap-3 px-4 transition-colors ${selected ? "bg-hover-2" : "hover:bg-hover"} ${row.offline ? "opacity-60" : ""}`}
    >
      <span className={`flex shrink-0 ${glyph.className}`} title={glyph.label}>
        <Icon icon={glyph.icon} size={16} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="flex min-w-0 items-baseline gap-1.5 text-left text-13 focus-visible:-outline-offset-2"
        >
          <span className="truncate font-medium text-ink">{row.title}</span>
          <span className="shrink-0 text-ink-3 tabular-nums">#{row.number}</span>
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-12 whitespace-nowrap text-ink-3">
          <span className="truncate">{row.repo}</span>
          {row.author && (
            <>
              <span aria-hidden>·</span>
              <Avatar login={row.author.login} size={16} />
              <span className="truncate">{row.author.login}</span>
            </>
          )}
          {Boolean(findings?.open) && <span className={findings?.high ? "text-red-ink" : "text-ink-2"}>{findingsLabel(findings!.open)}</span>}
          {chat && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                data-pr-row-chat
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenChat(chat);
                }}
                className="flex min-w-0 items-center gap-1 rounded-chip text-ink-2 transition-colors hover:text-ink"
              >
                <Icon icon={BubbleChatIcon} size={12} className="shrink-0" />
                <span className="truncate">{chat.title || "Chat"}</span>
              </button>
            </>
          )}
          {computer && (
            <>
              <span aria-hidden>·</span>
              <span data-pr-row-computer className="truncate">
                {computer.offline ? `${computer.name} (offline)` : computer.name}
              </span>
            </>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <ChecksHover row={row} />
        {review ? (
          <ReviewForMeButton review={review} />
        ) : (
          <span
            data-pr-row-review={badge.label}
            className={`inline-flex h-5 items-center rounded-full px-2 text-11 font-semibold whitespace-nowrap ${BADGE_TONE[badge.tone]}`}
          >
            {badge.label}
          </span>
        )}
        {!narrow && (
          <>
            <Counts added={row.additions} removed={row.deletions} className="w-20 justify-end" />
            <span className="w-8 text-right text-11 text-ink-3 tabular-nums">{updated}</span>
          </>
        )}
      </span>
    </div>
  );
}

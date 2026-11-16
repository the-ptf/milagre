import { issueChipLabel, LINK_PR_HINT } from "@milagre/shared/linear";
import { LinearLogo } from "../ProviderLogo";
import { type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { EthernetPortIcon, FileEditIcon, Folder01Icon, GitBranchIcon, Link04Icon, Pulse01Icon } from "@hugeicons/core-free-icons";
import type { LinkedEnd } from "./SidebarLinks";
import { folderName, formatLineCount } from "@/lib/chat-list";
import { portComputer, portUrl, unreachablePortReason } from "@/lib/ports";
import { prLook } from "@/lib/pr-look";
import { ScrollArea } from "../primitives/ScrollArea";
import { chatMarkTone, markToneClass, HugeIcon, markLabel, ChatMarkDotInline } from "./ChatMarks";
import type { SidebarRecent } from "./ChatRow";
import { HOVER_CARD_WIDTH } from "./chat-row-parts";

export function ChatHoverCard({
  item,
  linked,
  position,
  onPointerEnter,
  onPointerLeave,
  onOpenLink,
}: {
  item: SidebarRecent;
  linked: LinkedEnd[];
  position: { top: number; left: number; flip: boolean };
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onOpenLink: () => void;
}) {
  const { details = {} } = item;
  const mark = item.mark ?? "idle";
  const status =
    mark !== "idle"
      ? {
          label: markLabel(mark, item.background),
          tone: markToneClass[chatMarkTone(mark)],
        }
      : details.failed
        ? { label: "Last turn failed", tone: "text-red-ink" }
        : null;
  return (
    <div
      data-chat-hover-card
      aria-label={item.label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="fixed z-[60] rounded-card bg-surface p-3 shadow-raised"
      style={{
        left: position.left,
        width: HOVER_CARD_WIDTH,
        ...(position.flip ? { bottom: position.top } : { top: position.top }),
        animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) backwards",
        transformOrigin: position.flip ? "bottom left" : "top left",
      }}
    >
      <div className="line-clamp-3 text-13 font-semibold text-ink">{item.label}</div>
      <div className="mt-2 flex flex-col gap-1.5 text-12 text-ink-2">
        {status && (
          <CardLine
            icon={
              <span className="flex size-4 items-center justify-center">
                <ChatMarkDotInline mark={mark} failed={Boolean(details.failed)} background={item.background} />
              </span>
            }
          >
            <span className={status.tone}>{status.label}</span>
          </CardLine>
        )}
        {item.heartbeat && (
          <CardLine icon={<HugeiconsIcon icon={Pulse01Icon} size={14} strokeWidth={1.8} color="currentColor" />}>
            <span data-chat-card-heartbeat className="min-w-0 truncate">
              {item.heartbeat}
            </span>
          </CardLine>
        )}
        {details.pullRequests?.length ? (
          <ScrollArea data-chat-card-prs className="-mx-1 flex max-h-[148px] flex-col gap-0.5">
            {details.pullRequests.map((pr) => {
              const look = prLook(pr);
              return (
                <a
                  key={pr.url}
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-chat-card-pr
                  onClick={onOpenLink}
                  className="flex min-w-0 items-center gap-2 rounded-chip px-1 py-0.5 text-ink-2 no-underline transition-colors duration-fast hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className={`flex size-4 shrink-0 items-center justify-center ${look.toneClass}`}>
                    <HugeIcon icon={look.glyph} size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="tabular-nums">#{pr.number}</span>
                    {pr.title ? ` · ${pr.title}` : ""}
                  </span>
                  {look.label && <span className={`shrink-0 ${look.labelClass}`}>{look.ready ? "Ready to merge" : look.label}</span>}
                </a>
              );
            })}
          </ScrollArea>
        ) : null}
        {details.ports?.length ? (
          <div data-chat-card-ports className="flex min-w-0 items-start gap-2">
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink-3">
              <HugeIcon icon={EthernetPortIcon} size={14} />
            </span>
            <span className="flex min-w-0 flex-wrap gap-1">
              {details.ports.map((port) => {
                const computer = portComputer(port);
                const url = portUrl(port);
                const chip = "rounded-chip bg-hover px-1.5 py-0.5 font-mono text-11 tabular-nums text-ink-2";
                return computer && !url ? (
                  <span
                    key={port.port}
                    data-chat-card-port
                    data-port-remote
                    title={`${port.command} · ${unreachablePortReason(port, computer)}`}
                    className={chip}
                  >
                    :{port.port} <span className="font-sans text-ink-3">on {computer}</span>
                  </span>
                ) : (
                  <a
                    key={port.port}
                    href={url ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-chat-card-port
                    {...(computer ? { "data-port-remote": true } : {})}
                    title={`${port.command} · open ${url}`}
                    onClick={onOpenLink}
                    className={`${chip} no-underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
                  >
                    :{port.port}
                    {computer ? <span className="font-sans text-ink-3"> on {computer}</span> : null}
                  </a>
                );
              })}
            </span>
          </div>
        ) : null}
        {details.diff && (
          <CardLine icon={<HugeIcon icon={FileEditIcon} size={14} />}>
            {details.diff.added === 0 && details.diff.removed === 0 ? (
              <span className="text-ink-3">No changes</span>
            ) : (
              <span className="tabular-nums">
                <span className="text-diff-add">+{formatLineCount(details.diff.added)}</span>{" "}
                <span className="text-diff-remove">−{formatLineCount(details.diff.removed)}</span>
              </span>
            )}
          </CardLine>
        )}
        {details.branch && (
          <CardLine icon={<HugeIcon icon={GitBranchIcon} size={14} />}>
            <span className="truncate">{details.branch}</span>
          </CardLine>
        )}
        {details.linearIssue && (
          <CardLine icon={<LinearLogo size={13} />}>
            <a
              href={details.linearIssue.url}
              target="_blank"
              rel="noopener noreferrer"
              data-chat-card-linear-issue
              onClick={onOpenLink}
              className="min-w-0 truncate text-ink-2 no-underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {issueChipLabel(details.linearIssue)} · {details.linearIssue.title}
            </a>
          </CardLine>
        )}
        {details.linearKey && !(details.branch ?? "").toLowerCase().includes(details.linearKey.toLowerCase()) && (
          <CardLine icon={<LinearLogo size={13} />}>
            <span data-chat-card-link-hint className="min-w-0 whitespace-normal text-12 text-ink-3">
              {LINK_PR_HINT(details.linearKey)}
            </span>
          </CardLine>
        )}
        {details.path && (
          <CardLine icon={<HugeIcon icon={Folder01Icon} size={14} />}>
            <span className="truncate">{folderName(details.path)}</span>
          </CardLine>
        )}
        {linked.length > 0 && (
          <div data-chat-card-links className="flex min-w-0 items-start gap-2">
            <span className="flex h-[18px] w-4 shrink-0 items-center justify-center text-ink-3">
              <HugeIcon icon={Link04Icon} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-11 text-ink-3">Linked with</span>
              {linked.map((end) => (
                <span key={end.linkId} data-chat-card-link className="truncate leading-snug">
                  {end.label}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CardLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon}</span>
      <span className="flex min-w-0 flex-1">{children}</span>
    </div>
  );
}

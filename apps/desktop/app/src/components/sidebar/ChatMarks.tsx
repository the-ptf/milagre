import { SpinnerRing } from "../primitives/SpinnerRing";
import { HugeiconsIcon } from "@hugeicons/react";
import { BubbleChatQuestionIcon, Link04Icon, ShieldAlertIcon } from "@hugeicons/core-free-icons";
import { type ChatMark } from "@/lib/chat-list";
import { chatMarkTone as sharedMarkTone } from "@milagre/shared/chats";
import { backgroundLabel } from "@milagre/shared/chat-activity";

export function chatMarkTone(mark: ChatMark): "accent" | "orange" | "red" | "ink3" {
  if (mark === "question") return "orange";
  if (mark === "running" || mark === "background" || mark === "delegated") return "ink3";
  return sharedMarkTone(mark);
}

export const markToneClass = {
  accent: "text-accent",
  orange: "text-orange-ink",
  red: "text-red-ink",
  ink3: "text-ink-3",
} as const;

export type HugeIconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

export function HugeIcon({ icon, size = 16 }: { icon: HugeIconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

const MARK_LABEL: Record<Exclude<ChatMark, "idle">, string> = {
  interrupted: "Interrupted",
  question: "Asking you",
  waiting: "Waiting for you",
  delegated: "Working on a Delegation",
  running: "Running",
  background: "Working in the background",
  unread: "Unread",
};

export const markLabel = (mark: Exclude<ChatMark, "idle">, background = 0) =>
  mark === "background" && background ? `${backgroundLabel(background)} running` : MARK_LABEL[mark];

function BackgroundMark({ count = 0 }: { count?: number }) {
  return (
    <span className="flex size-4 items-center justify-center rounded-full border-[1.5px] border-ink-3 text-10 font-semibold leading-none tabular-nums text-ink-3">
      {count > 9 ? "9+" : count || ""}
    </span>
  );
}

export const MARK_ICON = {
  question: { icon: BubbleChatQuestionIcon },
  waiting: { icon: ShieldAlertIcon },
  delegated: { icon: Link04Icon },
} satisfies Partial<Record<ChatMark, { icon: HugeIconData }>>;

export function MarkIcon({ mark, size = 13 }: { mark: keyof typeof MARK_ICON; size?: number }) {
  return (
    <span className={`flex ${markToneClass[chatMarkTone(mark)]}`}>
      <HugeiconsIcon icon={MARK_ICON[mark].icon} size={size} strokeWidth={size > 13 ? 1.8 : 2} color="currentColor" />
    </span>
  );
}

export function ChatMarkDot({
  mark,
  failed = false,
  background,
  topAligned = false,
}: {
  mark: ChatMark;
  failed?: boolean;
  background?: number;
  topAligned?: boolean;
}) {
  const failure = mark === "idle" && failed;
  const label = failure ? "Failed" : mark === "idle" ? "" : markLabel(mark, background);
  const dot = failure ? "size-2 bg-red" : mark === "unread" ? "size-2 bg-accent" : "size-1.5 bg-ink-3 opacity-40";
  return (
    <span className={`sidebar-copy mr-2 flex size-3 shrink-0 items-center justify-center ${topAligned ? "mt-1" : ""}`}>
      <span
        data-slot="chat-mark"
        data-mark={failure ? "failed" : mark}
        {...(label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })}
        className={mark === "running" || mark === "background" ? "flex" : mark in MARK_ICON ? "flex" : `rounded-full ${dot}`}
      >
        {mark === "running" && <SpinnerRing size={12} />}
        {mark === "background" && <BackgroundMark count={background} />}
        {mark in MARK_ICON && <MarkIcon mark={mark as keyof typeof MARK_ICON} />}
      </span>
    </span>
  );
}

export function railDotTone(mark: ChatMark) {
  const tone = chatMarkTone(mark);
  return tone === "orange" ? "bg-orange" : tone === "red" ? "bg-red" : tone === "ink3" ? "bg-ink-3" : "bg-accent";
}

export function ChatMarkDotInline({ mark, failed, background }: { mark: ChatMark; failed: boolean; background?: number }) {
  if (mark === "running") return <SpinnerRing size={12} />;
  if (mark === "background") return <BackgroundMark count={background} />;
  if (mark in MARK_ICON) return <MarkIcon mark={mark as keyof typeof MARK_ICON} />;
  return <span aria-hidden className={`size-2 rounded-full ${mark === "idle" && failed ? "bg-red" : "bg-accent"}`} />;
}

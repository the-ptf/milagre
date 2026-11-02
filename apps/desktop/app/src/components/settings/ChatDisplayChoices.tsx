import type { ReactNode } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Mic01Icon,
  CommandLineIcon,
  File01Icon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { TOOL_CALL_DISPLAYS, type ChatList, type ToolCallDisplay } from "@milagre/shared/chat-display";
import { DICTATION_ACTION_OPTIONS, type DictationActionPreference } from "@milagre/shared/voice-dictation";
import { DICTATION_SHORTCUT_MODES, type DictationShortcutMode } from "@milagre/shared/dictation";

type Choice<T extends string> = { id: T; label: string; description: string; preview: ReactNode };

/**
 * Two side-by-side cards for one setting, each a small picture of what it does, its name and one line. A radio group:
 * arrow keys move between the cards, and the chosen one carries the accent ring and a filled check.
 */
function ChoiceCards<T extends string>({
  label,
  value,
  onChange,
  choices,
  compact = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  choices: Choice<T>[];
  compact?: boolean;
}) {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      orientation="horizontal"
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="grid grid-cols-2 gap-3"
    >
      {choices.map((choice) => {
        const selected = choice.id === value;
        return (
          <RadioGroupPrimitive.Item
            key={choice.id}
            value={choice.id}
            aria-label={choice.label}
            data-choice-card={choice.id}
            className={`flex flex-col gap-2.5 rounded-[12px] bg-surface p-3 text-left shadow-card outline-none transition-[box-shadow,background-color] hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3 ${selected ? "ring-2 ring-accent" : ""}`}
          >
            <span aria-hidden className={`flex w-full flex-col overflow-hidden rounded-control bg-inset ${compact ? "h-16 gap-1 p-2" : "h-[112px] gap-2 p-3"}`}>
              {choice.preview}
            </span>
            <span className="flex items-center gap-2">
              {selected ? (
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent text-white">
                  <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2.6} color="currentColor" />
                </span>
              ) : (
                <span className="size-[18px] shrink-0 rounded-full border-[1.5px] border-ink-3" />
              )}
              <span className="truncate text-[13.5px] font-semibold text-ink">{choice.label}</span>
            </span>
            <span className="text-[12px] leading-snug text-ink-3">{choice.description}</span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

function DictationPreview({ sent }: { sent: boolean }) {
  return (
    <span className="mx-auto flex h-full w-full max-w-48 flex-col justify-center gap-1">
      <span className="h-2.5 w-3/5 shrink-0 self-end rounded-chip bg-line" />
      {sent && <span className="h-2.5 w-[72%] shrink-0 self-end rounded-chip bg-ink-4" />}
      <span className={`flex shrink-0 items-center gap-1 rounded-full border border-line-strong bg-surface px-1.5 ${sent ? "h-[18px]" : "h-[26px]"}`}>
        {sent ? (
          <HugeiconsIcon icon={Mic01Icon} size={12} className="ml-auto text-ink-3" />
        ) : (
          <>
            <span className="h-1 flex-1 rounded-full bg-ink-4" />
            <span className="h-3.5 w-0.5 bg-accent" />
            <span className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-ink text-surface">
              <HugeiconsIcon icon={ArrowUp01Icon} size={12} />
            </span>
          </>
        )}
      </span>
    </span>
  );
}

export function DictationActionChoice({ value, onChange }: { value: DictationActionPreference; onChange: (value: DictationActionPreference) => void }) {
  return (
    <ChoiceCards
      compact
      label="When dictation finishes"
      value={value}
      onChange={onChange}
      choices={DICTATION_ACTION_OPTIONS.map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description,
        preview: <DictationPreview sent={option.value === "send"} />,
      }))}
    />
  );
}

const Bar = ({ width, soft = false, thin = false }: { width: string; soft?: boolean; thin?: boolean }) => (
  <span className={`block shrink-0 rounded-full ${thin ? "h-1" : "h-1.5"} ${soft ? "bg-line" : "bg-line-strong"}`} style={{ width }} />
);

const Avatar = ({ color, size = 6 }: { color: string; size?: number }) => (
  <span className="block shrink-0 rounded-[2px]" style={{ width: size, height: size, background: color }} />
);

const AVATARS = ["#565f89", "#9e7b5a", "#bb9af7"];

/** A line of small type with an icon, the way a reply's activity row reads. */
function Line({ icon, text, chevron }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; text: string; chevron?: "right" | "down" }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] leading-3 text-ink-3">
      <HugeiconsIcon icon={icon} size={11} strokeWidth={1.8} color="currentColor" />
      <span className="truncate">{text}</span>
      {chevron && <HugeiconsIcon icon={chevron === "right" ? ArrowRight01Icon : ArrowDown01Icon} size={10} strokeWidth={1.8} color="currentColor" />}
    </span>
  );
}

const ONE_LIST_ROWS = [
  { id: "a", avatar: AVATARS[0]!, project: "34%", title: "85%", meta: "62%" },
  { id: "b", avatar: AVATARS[1]!, project: "28%", title: "74%", meta: "54%" },
  { id: "c", avatar: AVATARS[2]!, project: "24%", title: "90%", meta: "50%" },
];

function OneListPreview() {
  return (
    <>
      {ONE_LIST_ROWS.map((row) => (
        <span key={row.id} className="flex flex-col gap-[3px] pb-1">
          <span className="flex items-center gap-1">
            <Avatar color={row.avatar} size={5} />
            <Bar width={row.project} soft thin />
          </span>
          <Bar width={row.title} />
          <Bar width={row.meta} soft thin />
        </span>
      ))}
    </>
  );
}

const GroupHeader = ({ color, width }: { color: string; width: string }) => (
  <span className="flex items-center gap-1.5">
    <Avatar color={color} size={8} />
    <Bar width={width} />
  </span>
);

const GroupChat = ({ title, meta }: { title: string; meta: string }) => (
  <span className="flex flex-col gap-[3px] pl-3.5">
    <Bar width={title} soft />
    <Bar width={meta} soft thin />
  </span>
);

function GroupedPreview() {
  return (
    <span className="flex flex-col gap-[5px]">
      <GroupHeader color={AVATARS[0]!} width="40%" />
      <GroupChat title="72%" meta="44%" />
      <GroupChat title="62%" meta="38%" />
      <GroupHeader color={AVATARS[1]!} width="34%" />
      <GroupChat title="68%" meta="36%" />
      <GroupHeader color={AVATARS[2]!} width="30%" />
    </span>
  );
}

/** The reply under the work: full-width bars, the last one short. */
function AnswerBars({ lines }: { lines: number }) {
  return (
    <>
      {ANSWER_WIDTHS.slice(0, lines - 1).map((width) => (
        <Bar key={width} width={width} />
      ))}
      <Bar width="56%" />
    </>
  );
}

const ANSWER_WIDTHS = ["96%", "84%", "90%"];

function FoldedReasoningPreview() {
  return (
    <>
      <Line icon={AiBrain01Icon} text="Thought for 12s" chevron="right" />
      <AnswerBars lines={4} />
    </>
  );
}

function ExpandedReasoningPreview() {
  return (
    <>
      <Line icon={AiBrain01Icon} text="Thinking" chevron="down" />
      <span className="flex gap-1.5 pl-1">
        <span className="block w-0.5 shrink-0 rounded-full bg-line-strong" />
        <span className="flex flex-1 flex-col gap-[5px] py-0.5">
          <Bar width="92%" soft thin />
          <Bar width="80%" soft thin />
          <Bar width="60%" soft thin />
        </span>
      </span>
      <AnswerBars lines={2} />
    </>
  );
}

function CompactToolsPreview() {
  return (
    <>
      <Line icon={Wrench01Icon} text="Read 4 files, ran 2" chevron="right" />
      <AnswerBars lines={4} />
    </>
  );
}

function FullToolsPreview() {
  return (
    <>
      <Line icon={File01Icon} text="Read chat.tsx" />
      <Line icon={Search01Icon} text="Searched" />
      <Line icon={CommandLineIcon} text="Ran npm test" />
      <AnswerBars lines={2} />
    </>
  );
}

// The phone's Settings › Chat names these the same way.
const CHAT_LIST_CHOICES: Choice<ChatList>[] = [
  { id: "list", label: "One list", description: "Newest first, Project on each row.", preview: <OneListPreview /> },
  { id: "grouped", label: "By Project", description: "A group per Project that folds.", preview: <GroupedPreview /> },
];

const REASONING_CHOICES: Choice<"folded" | "expanded">[] = [
  { id: "folded", label: "Folded", description: "Thinking stays in its row until you open it.", preview: <FoldedReasoningPreview /> },
  { id: "expanded", label: "Expanded", description: "Thinking shows open above each answer.", preview: <ExpandedReasoningPreview /> },
];

const TOOL_CALL_PREVIEWS: Record<ToolCallDisplay, ReactNode> = { compact: <CompactToolsPreview />, full: <FullToolsPreview /> };
const TOOL_CALL_CHOICES: Choice<ToolCallDisplay>[] = TOOL_CALL_DISPLAYS.map(({ id, label, description }) => ({
  id,
  label,
  description,
  preview: TOOL_CALL_PREVIEWS[id],
}));

export function ChatListChoice({ value, onChange }: { value: ChatList; onChange: (value: ChatList) => void }) {
  return <ChoiceCards label="Chat list" value={value} onChange={onChange} choices={CHAT_LIST_CHOICES} />;
}

/** Folded or Expanded: the `expandReasoning` setting as two cards. */
export function ReasoningChoice({ expanded, onChange }: { expanded: boolean; onChange: (expanded: boolean) => void }) {
  return (
    <ChoiceCards label="Reasoning" value={expanded ? "expanded" : "folded"} onChange={(value) => onChange(value === "expanded")} choices={REASONING_CHOICES} />
  );
}

export function ToolCallChoice({ value, onChange }: { value: ToolCallDisplay; onChange: (value: ToolCallDisplay) => void }) {
  return <ChoiceCards label="Tool calls" value={value} onChange={onChange} choices={TOOL_CALL_CHOICES} />;
}

/** How the Dictate shortcut works: held while talking, or pressed to start and again to stop. */
export function DictationShortcutModeChoice({
  value,
  onChange,
  shortcut,
}: {
  value: DictationShortcutMode;
  onChange: (value: DictationShortcutMode) => void;
  shortcut: string;
}) {
  return (
    <ChoiceCards
      compact
      label="How the shortcut works"
      value={value}
      onChange={onChange}
      choices={DICTATION_SHORTCUT_MODES.map((mode) => ({
        id: mode.value,
        label: mode.label,
        description: mode.description,
        preview: <ShortcutPreview hold={mode.value === "hold"} shortcut={shortcut} />,
      }))}
    />
  );
}

/** A key cap held down under a long wave, or pressed twice around a short one. */
function ShortcutPreview({ hold, shortcut }: { hold: boolean; shortcut: string }) {
  const cap = (pressed: boolean) => (
    <span
      className={`flex h-6 w-12 shrink-0 items-center justify-center rounded-control border border-line-strong text-11 font-semibold text-ink-2 ${pressed ? "translate-y-px bg-line shadow-none" : "bg-surface shadow-xs"}`}
    >
      {shortcut}
    </span>
  );
  const wave = (width: string) => <span className="h-1.5 shrink rounded-full bg-accent/50" style={{ width }} />;
  return (
    <span className="mx-auto flex h-full w-full max-w-56 items-center justify-center gap-2">
      {hold ? (
        <>
          {cap(true)}
          {wave("60%")}
        </>
      ) : (
        <>
          {cap(false)}
          {wave("40%")}
          {cap(false)}
        </>
      )}
    </span>
  );
}

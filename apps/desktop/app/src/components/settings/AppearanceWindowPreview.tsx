import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckListIcon,
  ComputerTerminal01Icon,
  FilterHorizontalIcon,
  FolderAddIcon,
  FrameIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Globe02Icon,
  Link04Icon,
  RepeatIcon,
  Search01Icon,
  SecurityCheckIcon,
  Settings01Icon,
  SidebarLeft01Icon,
} from "@hugeicons/core-free-icons";
import { CHAT_WIDTHS, clampChatWidth } from "@milagre/shared/appearance";
import { EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { useSettings } from "../../lib/settings";
import { FileChip, FileKindIcon, SkillChip } from "../PromptChip";
import { ProviderLogo } from "../ProviderLogo";

/** The part of the window a setting changes. `ui` is the interface font: everything but code. */
export type PreviewArea = "sidebar" | "chat" | "code" | "width" | "diff" | "ui" | "usage";

// The miniature is drawn at a real window's size, at the real CSS variables, then scaled down to the card.
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
// How long the Changes panel stays open when Panel animations replays it: long enough to finish opening at Normal.
const PANEL_HOLD_MS = 1400;

const HighlightContext = createContext<PreviewArea | null>(null);

/**
 * One piece of the miniature. `keep`: the areas it belongs to; while another area is highlighted it drops to 40%.
 * Without `keep` it never dims (a container whose children dim themselves). `area` names it for `data-preview-area`;
 * it is outlined while `outline` (default: its area) holds the highlighted area.
 */
function Part({
  area,
  keep,
  outline = area ? [area] : [],
  tight = false,
  inline = false,
  className = "",
  style,
  children,
  ...rest
}: {
  area?: PreviewArea;
  keep?: readonly PreviewArea[];
  outline?: readonly PreviewArea[];
  /** A small piece (a change count): a thinner outline, closer in. */
  tight?: boolean;
  inline?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  const highlight = useContext(HighlightContext);
  const dim = highlight !== null && keep !== undefined && !keep.includes(highlight);
  const outlined = highlight !== null && outline.includes(highlight);
  const Tag = inline ? "span" : "div";
  return (
    <Tag
      data-preview-area={area}
      data-highlighted={outlined || undefined}
      className={`transition-[opacity,outline-color] duration-200 ease-out ${tight ? "outline-[3px] outline-offset-[3px]" : "outline-4 outline-offset-[6px]"} ${outlined ? "outline-accent" : "outline-transparent"} ${className}`}
      style={{ ...style, opacity: dim ? 0.4 : 1 }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

function Icon({ icon, size = 16 }: { icon: IconSvgElement; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" className="shrink-0" />;
}

/** `+12 −3` in the diff colors, mono, as the sidebar, canvas and changes panel draw it. */
function Counts({ added, removed, className = "" }: { added: number; removed: number; className?: string }) {
  return (
    <Part inline area="diff" keep={["sidebar", "diff"]} tight className={`shrink-0 rounded-[3px] font-mono tabular-nums ${className}`}>
      <span className="text-diff-add">+{added}</span> <span className="text-diff-remove">−{removed}</span>
    </Part>
  );
}

const SIDEBAR_CHATS = [
  { title: "Appearance mini preview", added: 248, removed: 31, ago: "2m", active: true, mark: "running" },
  { title: "Skill and file chips", added: 96, removed: 12, ago: "1h", mark: "unread" },
  { title: "Fix the flaky surface test", added: 4, removed: 9, ago: "3h" },
] as const;

const PREVIEW_USAGE = [
  {
    provider: "claude" as const,
    name: "Claude",
    windows: [
      { label: "5h", percent: 18 },
      { label: "wk", percent: 64 },
    ],
    peak: 64,
  },
  {
    provider: "codex" as const,
    name: "Codex",
    windows: [
      { label: "5h", percent: 32 },
      { label: "wk", percent: 48 },
    ],
    peak: 48,
  },
  {
    provider: "antigravity" as const,
    name: "Antigravity",
    windows: [
      { label: "5h", percent: 9 },
      { label: "wk", percent: 25 },
    ],
    peak: 25,
  },
] as const;

function SidebarMark({ mark }: { mark?: "running" | "unread" }) {
  if (mark === "running")
    return <span className="size-3 rounded-full border-[1.5px] border-accent border-r-transparent" style={{ transform: "rotate(45deg)" }} />;
  if (mark === "unread") return <span className="size-2 rounded-full bg-accent" />;
  return <span className="size-1.5 rounded-full bg-ink-3 opacity-50" />;
}

function ProjectRow({ initial, color, name, current = false }: { initial: string; color: string; name: string; current?: boolean }) {
  return (
    <Part keep={["sidebar", "ui"]} className="mx-2 flex h-8 items-center gap-2 px-2">
      <span className="flex size-5 items-center justify-center rounded-[5px] text-[11px] font-bold text-white" style={{ background: color }}>
        {initial}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] ${current ? "font-medium text-ink" : "text-ink-2"}`}>{name}</span>
      {current && (
        <span className="text-ink-3">
          <Icon icon={Add01Icon} size={14} />
        </span>
      )}
    </Part>
  );
}

function SidebarUsagePreview({ compact }: { compact: boolean }) {
  return (
    <Part
      area="usage"
      keep={["sidebar", "ui", "usage"]}
      tight
      data-preview-usage={compact ? "compact" : "expanded"}
      className="mx-2 mt-auto border-t border-line pt-1.5"
    >
      <div data-usage-compact={compact || undefined} className="sidebar-usage flex flex-col gap-0.5">
        {PREVIEW_USAGE.map((item) => (
          <div
            key={item.provider}
            className="sidebar-usage-row relative flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[8px] px-2 text-[12px] tabular-nums text-ink-2"
          >
            <span className="flex shrink-0 items-center justify-center">
              <ProviderLogo provider={item.provider} size={13} />
            </span>
            <span className="sidebar-copy min-w-0 truncate text-ink-2">{item.name}</span>
            <span className="sidebar-copy ml-auto flex w-[104px] shrink-0 items-center gap-2">
              {item.windows.map((entry) => (
                <span key={entry.label} className="flex min-w-0 flex-1 flex-col items-end gap-[3px]">
                  <span className="flex items-baseline gap-[3px] whitespace-nowrap leading-none">
                    <span className="text-ink">{entry.percent}%</span>
                    <span className="text-ink-3">{entry.label}</span>
                  </span>
                  <span className="relative block h-[2px] w-full shrink-0 overflow-hidden rounded-full bg-line-strong">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-ink-3" style={{ width: `${entry.percent}%` }} />
                  </span>
                </span>
              ))}
            </span>
            <span aria-hidden className="sidebar-usage-rail absolute bottom-[3px] left-1/2 -translate-x-1/2">
              <span className="relative block h-[2px] w-4 shrink-0 overflow-hidden rounded-full bg-line-strong">
                <span className="absolute inset-y-0 left-0 rounded-full bg-ink-3" style={{ width: `${item.peak}%` }} />
              </span>
            </span>
          </div>
        ))}
      </div>
    </Part>
  );
}

function Sidebar({ compactUsage }: { compactUsage: boolean }) {
  return (
    <Part area="sidebar" outline={["sidebar"]} className="flex w-[272px] shrink-0 flex-col rounded-window bg-surface pt-2 shadow-card">
      <Part keep={["sidebar", "ui"]} className="mx-2 mb-3 flex items-center gap-1 text-[13px] text-ink-3">
        <span className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2">
          <Icon icon={FrameIcon} />
          Canvas
        </span>
        <span className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2">
          <Icon icon={Search01Icon} />
          Search
        </span>
        <span className="flex size-8 items-center justify-center">
          <Icon icon={RepeatIcon} />
        </span>
        <span className="flex size-8 items-center justify-center">
          <Icon icon={FilterHorizontalIcon} />
        </span>
      </Part>
      <ProjectRow initial="m" color="#3b6cf6" name="milagre" current />
      <div className="grid gap-0.5">
        {SIDEBAR_CHATS.map((chat) => (
          <div
            key={chat.title}
            className={`relative mx-2 flex h-[46px] items-start rounded-[8px] px-2 pt-1.5 ${"active" in chat && chat.active ? "bg-hover-2" : ""}`}
          >
            <Part keep={["sidebar", "ui"]} className="flex min-w-0 flex-1 items-center">
              <span className="mr-2 flex size-3 shrink-0 items-center justify-center">
                <SidebarMark mark={"mark" in chat ? chat.mark : undefined} />
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[length:calc(14px+var(--sidebar-delta))] ${"active" in chat && chat.active ? "font-medium text-ink" : "text-ink-2"}`}
              >
                {chat.title}
              </span>
            </Part>
            <div className="absolute bottom-1 left-9 flex items-center gap-2 text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-3">
              <Counts added={chat.added} removed={chat.removed} className="text-[length:calc(11px+var(--sidebar-delta))]" />
              <Part inline keep={["sidebar", "ui"]} className="tabular-nums">
                {chat.ago}
              </Part>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <ProjectRow initial="r" color="#16a34a" name="relay" />
      </div>
      <div className="mx-2 flex h-8 items-center rounded-[8px] px-2">
        <Part keep={["sidebar", "ui"]} className="flex min-w-0 flex-1 items-center">
          <span className="mr-2 flex size-3 shrink-0 items-center justify-center">
            <SidebarMark />
          </span>
          <span className="min-w-0 flex-1 truncate text-[length:calc(14px+var(--sidebar-delta))] text-ink-2">Rate-limit pairing attempts</span>
        </Part>
      </div>
      <SidebarUsagePreview compact={compactUsage} />
      <Part keep={["sidebar", "ui"]} className="mx-2 mt-1.5 mb-2 flex items-center gap-1 border-t border-line pt-2 text-ink-3">
        {[
          { key: "add-project", icon: FolderAddIcon },
          { key: "tasks", icon: CheckListIcon },
          { key: "link", icon: Link04Icon },
        ].map(({ key, icon }) => (
          <span key={key} className="flex size-9 items-center justify-center">
            <Icon icon={icon} size={18} />
          </span>
        ))}
        <span className="ml-auto flex size-9 items-center justify-center">
          <Icon icon={Settings01Icon} size={18} />
        </span>
      </Part>
    </Part>
  );
}

const DIFF_BEFORE = "export function AppearanceSettings() {";
const DIFF_REMOVED = ["  return <AppearancePreview />;"];
const DIFF_ADDED = ["  const [area, setArea] = useState<PreviewArea | null>(null);", "  return <AppearanceWindowPreview highlight={area} />;"];
const DIFF_AFTER = "}";

function DiffLine({ kind, text }: { kind: "add" | "remove" | "context"; text: string }) {
  const marker = kind === "add" ? "+" : kind === "remove" ? "−" : " ";
  const tint = kind === "add" ? "bg-[var(--diff-add)]" : kind === "remove" ? "bg-[var(--diff-remove)]" : "";
  const color = kind === "add" ? "text-diff-add" : kind === "remove" ? "text-diff-remove" : "";
  return (
    <span data-diff-line={kind} className={`flex pr-3 ${tint}`}>
      <span aria-hidden className={`w-6 shrink-0 text-center ${color}`}>
        {marker}
      </span>
      <span className="whitespace-pre">{text}</span>
    </span>
  );
}

function CodeBlock() {
  return (
    <Part area="code" keep={["code", "diff", "width"]} className="my-2 rounded-control">
      <div className="overflow-hidden rounded-control border border-line bg-inset">
        <Part keep={["code", "width"]} className="flex h-7 items-center border-b border-line px-2.5 font-mono text-[11px] text-ink-3">
          diff
        </Part>
        <pre data-preview-diff className="py-1.5 font-mono text-[length:var(--code-size)] leading-[1.6] text-ink">
          <code className="block">
            <Part inline keep={["code", "width"]} className="block">
              <DiffLine kind="context" text={DIFF_BEFORE} />
            </Part>
            <Part inline area="diff" keep={["code", "diff", "width"]} tight className="block">
              {DIFF_REMOVED.map((line) => (
                <DiffLine key={line} kind="remove" text={line} />
              ))}
              {DIFF_ADDED.map((line) => (
                <DiffLine key={line} kind="add" text={line} />
              ))}
            </Part>
            <Part inline keep={["code", "width"]} className="block">
              <DiffLine kind="context" text={DIFF_AFTER} />
            </Part>
          </code>
        </pre>
      </div>
    </Part>
  );
}

function Pill({ icon, label }: { icon: IconSvgElement; label: string }) {
  return (
    <span className="status-pill flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] whitespace-nowrap text-ink-2">
      <Icon icon={icon} size={13} />
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

function Composer() {
  return (
    <Part area="chat" keep={["chat", "ui", "width"]} className="promptbar-surface relative flex items-end gap-1 rounded-[14px] border border-line p-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center text-ink-3">
        <Icon icon={Add01Icon} />
      </span>
      <span data-preview-composer className="min-h-7 min-w-0 flex-1 truncate px-1 py-[5px] text-[length:var(--chat-size)] leading-[18px] text-ink-3">
        Prompt or mention a file with @
      </span>
      <span className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2">
        <ProviderLogo provider="claude" size={14} />
        Opus 5.5 · High
        <span className="text-ink-3">
          <Icon icon={ArrowDown01Icon} size={12} />
        </span>
      </span>
      <span className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-green">
        <Icon icon={SecurityCheckIcon} size={14} />
        Auto
      </span>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface">
        <Icon icon={ArrowUp01Icon} />
      </span>
    </Part>
  );
}

/** Edge markers and a dimension line across the chat column, with its width; a width wider than the miniature says it fills it. */
function WidthMarkers({ px }: { px: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [fills, setFills] = useState(false);
  useLayoutEffect(() => setFills(px !== null && (box.current?.offsetWidth ?? 0) < px), [px]);
  const label = px === null ? "Full" : fills ? `${px} px · fills the window` : `${px} px`;
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute inset-y-0 left-0 border-l-2 border-dashed border-accent" />
      <div className="absolute inset-y-0 right-0 border-r-2 border-dashed border-accent" />
      <div className="absolute inset-x-0 top-5 flex items-center">
        <span className="h-4 w-0.5 bg-accent" />
        <span className="h-0.5 flex-1 bg-accent" />
        <span className="mx-3 rounded-full bg-accent px-4 py-1.5 text-[26px] leading-none font-semibold tabular-nums text-white shadow-card">{label}</span>
        <span className="h-0.5 flex-1 bg-accent" />
        <span className="h-4 w-0.5 bg-accent" />
      </div>
    </div>
  );
}

function ChatColumn({ widthPx }: { widthPx: number | null }) {
  const highlight = useContext(HighlightContext);
  const chatText = ["chat", "ui", "width"] as const;
  return (
    <Part area="width" className="relative mx-auto flex h-full w-full max-w-[var(--chat-width)] flex-col rounded-[6px] px-3 pt-16 pb-3">
      {highlight === "width" && <WidthMarkers px={widthPx} />}
      <Part area="chat" className="flex flex-col gap-3 rounded-[10px]">
        <div className="flex w-full flex-col items-end pl-12">
          <Part keep={chatText} className="rounded-xl bg-field px-3 py-1.5">
            <p data-preview-text className="text-[length:var(--chat-size)] leading-[1.55] text-ink">
              Use <SkillChip name="frontend-design" /> to give Appearance a live preview. Start from{" "}
              <FileChip path="apps/desktop/app/src/components/Settings.tsx" /> and drop <FileChip path="src/styles.css" /> overrides.
            </p>
          </Part>
        </div>
        <Part keep={chatText} className="text-[length:var(--chat-size)] leading-[1.55] text-ink">
          <p>The preview sits above Typography and follows every setting as you change it.</p>
          <ul className="mt-1.5 list-disc pl-5 marker:text-ink-3">
            <li>Hovering a row outlines the part of the window it changes.</li>
            <li>Everything else dims, so the change is easy to spot.</li>
          </ul>
        </Part>
      </Part>
      <CodeBlock />
      <Part keep={chatText} className="text-[length:var(--chat-size)] leading-[1.55] text-ink">
        <p>Typecheck and the Electron check pass.</p>
      </Part>
      <div className="flex-1" />
      <Part keep={["ui", "width"]} className="mb-2 flex items-center justify-end gap-2">
        <Pill icon={Globe02Icon} label=":5173" />
        <Pill icon={CheckListIcon} label="3/5" />
      </Part>
      <Composer />
    </Part>
  );
}

const PANEL_FILES = [
  { path: "src/components/settings/AppearanceWindowPreview.tsx", added: 212, removed: 0 },
  { path: "src/components/Settings.tsx", added: 34, removed: 6 },
  { path: "src/components/settings/AppearancePreview.tsx", added: 0, removed: 25 },
  { path: "src/styles.css", added: 2, removed: 0 },
] as const;

/** The Changes panel, opening and closing as the real one does at the chosen Panel animations speed. */
function ChangesPanel({ open }: { open: boolean }) {
  const scale = useMotionScale();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="changes-panel"
          data-preview-panel
          className="relative -ml-3 flex min-h-0 shrink-0 overflow-hidden"
          initial={{ width: 0 }}
          animate={{ width: "auto" }}
          exit={{ width: 0 }}
          transition={scaledSpring(SPRING_LAYOUT, scale)}
        >
          <motion.div
            className="flex min-h-0 pr-3 pb-1"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: scaled(0.24, scale), ease: EASE_OUT }}
          >
            <div className="flex w-[340px] flex-col rounded-window bg-surface shadow-card">
              <Part keep={["ui"]} className="flex h-11 items-center justify-between border-b border-line px-3.5 text-[13px] font-medium text-ink">
                Changes
                <span className="text-[12px] font-normal text-ink-3">4 files</span>
              </Part>
              <div className="grid gap-0.5 p-1.5">
                {PANEL_FILES.map((file) => (
                  <div key={file.path} className="flex h-8 items-center gap-2 rounded-[7px] px-2 text-[12.5px]">
                    <Part inline keep={["ui"]} className="flex min-w-0 flex-1 items-center gap-1.5 text-ink">
                      <FileKindIcon path={file.path} />
                      <span className="truncate">{file.path.split("/").at(-1)}</span>
                    </Part>
                    <Counts added={file.added} removed={file.removed} className="text-[11px]" />
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The chat width in px, or null for Full. */
function chatWidthPx(chatWidth: string, customPx: number) {
  if (chatWidth === "custom") return clampChatWidth(customPx);
  return CHAT_WIDTHS.find((width) => width.id === chatWidth)?.px ?? null;
}

/**
 * A live miniature of the app window at the current Appearance settings: the sidebar, a chat with chips, a code
 * block with a diff, the pill row and the composer. It is drawn at a real 1440x900 window with the real CSS variables,
 * then scaled to the card's width. `highlight` outlines the area a setting changes and dims the rest; each increment of
 * `playMotion` opens and closes the Changes panel at the chosen Panel animations speed.
 */
export function AppearanceWindowPreview({ highlight, playMotion }: { highlight: PreviewArea | null; playMotion: number }) {
  const { appearance } = useSettings();
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const [panel, setPanel] = useState(false);

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    // Fits the card's width, but never takes more than 45% of the window's height so the sticky preview leaves room for the rows.
    const fit = () => setScale(Math.min(node.clientWidth / WINDOW_WIDTH, (0.45 * window.innerHeight) / WINDOW_HEIGHT));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    if (playMotion === 0) return;
    setPanel(true);
    // Closes once it has finished opening and been seen for a moment.
    const timer = window.setTimeout(() => setPanel(false), PANEL_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [playMotion]);

  return (
    <div ref={frame} className="flex w-full justify-center">
      <div
        data-slot="appearance-window-preview"
        role="img"
        aria-label="Preview of the app window with these settings"
        className="relative overflow-hidden rounded-[12px] shadow-card"
        style={{ width: WINDOW_WIDTH * scale, height: WINDOW_HEIGHT * scale }}
      >
        <HighlightContext.Provider value={highlight}>
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 font-sans text-ink select-none"
            style={{
              width: WINDOW_WIDTH,
              height: WINDOW_HEIGHT,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              backgroundColor: "var(--stripe-bg)",
              backgroundImage: "repeating-linear-gradient(-45deg, transparent 0, transparent 7px, var(--stripe) 7px, var(--stripe) 8px)",
            }}
          >
            <Part area="ui" className="absolute inset-0 flex rounded-[12px] outline-offset-[-8px]!">
              {/* The title bar: traffic lights and the sidebar toggle over the sidebar, terminal and changes at the right. */}
              <Part keep={["ui"]} className="absolute top-0 right-0 left-0 flex h-11 items-center px-5 text-ink-3">
                <span className="flex gap-2">
                  <span className="size-3 rounded-full bg-[#ff5f57]" />
                  <span className="size-3 rounded-full bg-[#febc2e]" />
                  <span className="size-3 rounded-full bg-[#28c840]" />
                </span>
                <span className="ml-[54px] flex">
                  <Icon icon={SidebarLeft01Icon} size={18} />
                </span>
                <span className="ml-auto flex items-center gap-4">
                  <Icon icon={ComputerTerminal01Icon} size={18} />
                  <Icon icon={GitPullRequestIcon} size={18} />
                  <Icon icon={GitBranchIcon} size={18} />
                </span>
              </Part>
              <div className="flex h-full w-full gap-3 pt-11 pb-2 pl-2">
                <Sidebar compactUsage={appearance.sidebarUsage === "compact"} />
                <div className="relative -mt-11 flex min-w-0 flex-1 flex-col pr-3 pb-1">
                  <ChatColumn widthPx={chatWidthPx(appearance.chatWidth, appearance.chatWidthPx)} />
                </div>
                <ChangesPanel open={panel} />
              </div>
            </Part>
          </div>
        </HighlightContext.Provider>
      </div>
    </div>
  );
}

import { cliName, pickerProviders, providerName } from "@milagre/shared/providers";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon, Attachment01Icon, ClipboardPasteIcon, FlashIcon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import type { AgentCliStatus, ContextUsage, EffortLevel, ModelCapability, ModelOption, ModelProvider, PermissionMode } from "../model";
import { effortCopy, PERMISSION_MODES } from "../model";
import { cliNotice, messageParts } from "../lib/cli-status";
import type { ImageDraft } from "./usePastedImages";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { ModelPicker } from "./ModelPicker";
import { UltracodeFatality } from "./UltracodeFatality";
import { useDismiss } from "../lib/use-dismiss";
import { composerLayout, type CompactOverflow } from "../lib/composer-layout";
import { useSettings } from "../lib/settings";
import { ProviderLogo } from "./ProviderLogo";
import { Attachments } from "./Attachments";
import { useProjectFiles } from "./useProjectFiles";
import { promptToken, fileMentionPath, insertPromptToken } from "../lib/file-mentions";
import { formatFileMention, promptParts } from "@milagre/shared/prompt-parts";
import { useSkills } from "./useSkills";
import { ScrollArea } from "./primitives/ScrollArea";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { useKnownFiles } from "./useKnownFiles";
import { ContextRing } from "./ContextRing";
import { offlinePlaceholder } from "../lib/computers";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 15 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

type MenuRow = { key: string; name: string; desc: string; group?: string; source?: string; path?: string };

type Source = { key: string; name: string; desc: string; icon: IconData };

const SOURCES: Source[] = [
  { key: "attach", name: "Add files", desc: "Choose files from your computer", icon: Attachment01Icon },
  { key: "paste", name: "Paste image", desc: "Attach an image from the clipboard", icon: ClipboardPasteIcon },
];

const UNDO_COMMAND = { key: "undo", name: "/undo", desc: "Undo a task's file changes" };

const COMMANDS = [
  { key: "summarize", name: "/summarize", desc: "Digest the thread so far" },
  { key: "blockers", name: "/blockers", desc: "Find blockers across worktrees" },
  { key: "plan", name: "/plan", desc: "Draft the next steps" },
  { key: "review", name: "/review", desc: "Review the current agent output" },
];

interface PromptComposerProps {
  /** The chat's computer is away: the field is disabled and its placeholder says so. */
  offlineName?: string | null;
  imageDraft: ImageDraft;
  projectPath: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Prompts sent in this chat, oldest first; Up and Down at the field's first or last line step through them. */
  history?: string[];
  onSend: () => void;
  onStop?: () => void;
  sendBlocked: boolean;
  /** A turn is running in this chat; a message sent now steers it. */
  running?: boolean;
  /** Sends `/compact` to the chat (Claude only); the context card offers it as Compact now. */
  onCompact?: () => void;
  /** The models each agent offers, or the maintained list until it reports them. */
  models: ModelOption[];
  /** How each agent's CLI stands; a problem is flagged on its tab and in a notice above the models. */
  cliStatus: AgentCliStatus | null;
  /** The model picker was opened; the status is checked again. */
  onModelPickerOpen: () => void;
  onUpdateCli?: (provider: ModelProvider) => void;
  updatingCli?: ModelProvider | null;
  selectedModel: ModelOption;
  onModelChange: (model: ModelOption) => void;
  capability: ModelCapability;
  effort?: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  ultracode: boolean;
  onUltracodeChange: (on: boolean) => void;
  fastMode: boolean;
  onFastModeChange: (on: boolean) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Keep the tall layout (input above the controls) even while the draft is empty. */
  alwaysExpanded?: boolean;
  /** How full the agent's context window is, shown as a ring beside Send. */
  contextUsage?: ContextUsage;
  /** The Chat is saved: `/undo` is offered, and sending it opens Undo changes instead of reaching the agent. */
  canUndo?: boolean;
}

const NO_HISTORY: string[] = [];

const POPOVER_GAP = 12;
// In the tall layout the controls sit on the composer's bottom row, so a popover opens just above its own button.
const POPOVER_BUTTON_GAP = 8;
// Popovers stay clear of the window-drag strip across the top of the window.
const POPOVER_TOP_INSET = 48;
const POPOVER_BOTTOM_INSET = 16;
// Smallest room below a tall composer that still fits a usable list.
const POPOVER_MIN_BELOW = 220;

/** Rising bars, one per level the model offers; the filled ones show how hard the agent will think. */
function EffortMeter({ level, total }: { level: number; total: number }) {
  return (
    <span aria-hidden className="flex h-3 items-end gap-[2px]">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className="w-[2.5px] rounded-full transition-[background-color,height] duration-200 ease-out motion-reduce:transition-none"
          style={{ height: `${4 + (index * 8) / Math.max(1, total - 1)}px`, background: index <= level ? "currentColor" : "var(--line-strong)" }}
        />
      ))}
    </span>
  );
}

export function PromptComposer({
  offlineName,
  imageDraft,
  projectPath,
  draft,
  onDraftChange,
  history = NO_HISTORY,
  onSend,
  onStop,
  sendBlocked,
  running = false,
  onCompact,
  models,
  cliStatus,
  onModelPickerOpen,
  onUpdateCli,
  updatingCli,
  selectedModel,
  onModelChange,
  capability,
  effort,
  onEffortChange,
  ultracode,
  onUltracodeChange,
  fastMode,
  onFastModeChange,
  permissionMode,
  onPermissionModeChange,
  alwaysExpanded = false,
  contextUsage,
  canUndo = false,
}: PromptComposerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  // Bumped each time Ultracode turns on; the Fatality overlay plays once per bump (Settings › Experimental).
  const [fatality, setFatality] = useState(0);
  const { ultracodeFatality, appearance } = useSettings();
  const chatSize = appearance.chatSize;
  const effortLevels = capability.efforts;
  const effortIndex = Math.max(0, effortLevels.indexOf(effort ?? ""));
  const effortName = effort ? effortCopy(effort).name : "";
  // Ultracode (Claude) and Codex's ultra level both hand work to parallel agents: they share Ultracode's purple.
  const orchestrating = ultracode || effort === "ultra";
  // With Ultracode on, the composer itself turns purple.
  const ultracodeOn = capability.ultracode && ultracode;
  const effortLabel = ultracode ? "Ultra" : effortName;
  const canUseFastMode = capability.fastMode;
  const [provider, setProvider] = useState<ModelProvider>(selectedModel.provider);
  // The provider tab follows the selected model, which follows the open chat.
  useEffect(() => {
    setProvider(selectedModel.provider);
  }, [selectedModel.provider]);
  useEffect(() => {
    if (modelOpen) {
      setProvider(selectedModel.provider);
      onModelPickerOpen();
    }
  }, [modelOpen]);
  const [query, setQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<PromptEditorHandle>(null);
  const compactWidthRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overflowRef = useRef<CompactOverflow>(null);
  const popoverRootRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; below: boolean; alignRight: boolean }>({
    left: 0,
    maxHeight: 480,
    below: false,
    alignRight: true,
  });
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);

  // Where Up/Down stands in `history`, and the draft to restore past its newest entry.
  const browsing = useRef<{ index: number; stash: string } | null>(null);
  useEffect(() => {
    browsing.current = null;
  }, [history]);

  const [caret, setCaret] = useState(draft.length);
  const token = dismissed ? null : promptToken(draft, Math.min(caret, draft.length));
  const menu: "at" | "slash" | null = plusOpen ? "at" : (token?.kind ?? null);
  const tokenQuery = plusOpen ? "" : (token?.query ?? "");
  const fileSearch = useProjectFiles(projectPath, tokenQuery, menu === "at" && !plusOpen);
  const { skills, warnings: skillWarnings, loading: skillsLoading } = useSkills(projectPath, menu === "slash" || /(^|\s)\//.test(draft));
  const skillRows = ["bundled", "workspace", "user"].flatMap((scope) =>
    skills
      .filter((skill) => skill.scope === scope)
      .map((skill) => ({
        key: `skill:${skill.name}`,
        name: `/${skill.name}`,
        desc: skill.description,
        group: scope === "bundled" ? "Milagre skills" : scope === "workspace" ? "Workspace skills" : "User skills",
        source: skill.provider,
        path: skill.path,
      })),
  );
  const commands: MenuRow[] = [
    ...[...(canUndo ? [UNDO_COMMAND] : []), ...COMMANDS]
      .filter((command) => !skills.some((skill) => skill.name.toLowerCase() === command.key))
      .map((command) => ({
        ...command,
        group: "Milagre skills",
      })),
    ...skillRows,
  ];
  const skillNames = commands.map((command) => command.name.slice(1));
  const skillKey = skillNames.join("\n");
  const skillDescriptions = useMemo(
    () => new Map(commands.map((command) => [command.name.slice(1).toLowerCase(), command.desc])),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `commands` is rebuilt each render; its names and descriptions are what count.
    [commands.map((command) => `${command.name}\t${command.desc}`).join("\n")],
  );
  // The mention being typed is the @ menu's search; the rest are looked up so they show as chips.
  const typing = token?.kind === "at" ? draft.slice(token.start + 1, token.end) : null;
  const { known, version: knownVersion, markKnown } = useKnownFiles(projectPath, draft, typing);
  const parts = useMemo(
    () => promptParts(draft, { skills: skillKey ? skillKey.split("\n") : [], files: (path) => known.has(path) }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `known` is a Set that grows in place; `knownVersion` counts its growth.
    [draft, skillKey, known, knownVersion],
  );
  // The @ menu searched the mention being typed: an exact match is a file too.
  const typedFound = typing !== null && fileSearch.files.includes(typing) ? typing : null;
  useEffect(() => {
    if (typedFound) markKnown(typedFound);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `markKnown` is rebuilt each render.
  }, [typedFound, projectPath]);
  // Files attached because a chip mentions them; deleting the chip detaches them (and undoing that attaches them again).
  const mentionAttached = useRef(new Set<string>());
  const chipFiles = useRef<string[]>([]);
  const chipKey = [...new Set(parts.flatMap((part) => (part.kind === "file" ? [fileMentionPath(projectPath, part.path) ?? ""] : [])).filter(Boolean))].join(
    "\n",
  );
  useEffect(() => {
    const now = chipKey ? chipKey.split("\n") : [];
    const before = chipFiles.current;
    chipFiles.current = now;
    for (const path of now) {
      if (before.includes(path) || imageDraft.files.includes(path)) continue;
      mentionAttached.current.add(path);
      imageDraft.attachPath(path);
    }
    for (const path of before) {
      if (now.includes(path) || !mentionAttached.current.has(path)) continue;
      mentionAttached.current.delete(path);
      imageDraft.removeFile(path);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the chips change, not when attachments do.
  }, [chipKey]);
  const inputTextClass = expanded
    ? "min-h-[68px] px-2 py-2 text-[length:calc(var(--chat-size)+1px)] leading-5"
    : "min-h-7 px-1 py-[5px] text-[length:var(--chat-size)] leading-[18px]";
  const rows: MenuRow[] =
    menu === "at"
      ? plusOpen
        ? SOURCES
        : fileSearch.files.map((path) => ({ key: `file:${path}`, name: path.split("/").at(-1) || path, desc: path, path }))
      : menu === "slash"
        ? commands.filter((command) => `${command.name.slice(1)} ${command.desc}`.toLowerCase().includes(tokenQuery))
        : [];
  const providerNotice = cliNotice(cliStatus?.[provider]);
  const providerTabs = pickerProviders(cliStatus, selectedModel.provider, provider);
  const modelRows = models.filter((model) => model.provider === provider && `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  const canStop = running && Boolean(onStop);
  const canSend = draft.trim().length > 0 || imageDraft.images.length > 0 || imageDraft.files.length > 0;

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, tokenQuery, projectPath, skills]);

  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target && engaged) target.scrollIntoView({ block: "nearest" });
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [active, engaged, menu, tokenQuery, rows.length]);

  useLayoutEffect(() => {
    const input = inputRef.current?.root;
    if (!input) return;
    const contentHeight = input.scrollHeight;
    if (!expanded) compactWidthRef.current = input.clientWidth;
    const next = composerLayout({
      draft,
      expanded,
      alwaysExpanded,
      contentHeight,
      compactWidth: compactWidthRef.current,
      overflow: overflowRef.current,
      measure: (text) => {
        const context = (canvasRef.current ??= document.createElement("canvas")).getContext("2d");
        if (!context) return null;
        context.font = `${getComputedStyle(document.documentElement).getPropertyValue("--chat-size").trim() || "13px"} ${getComputedStyle(input).fontFamily}`;
        return context.measureText(text).width;
      },
    });
    overflowRef.current = next.overflow;
    if (next.expanded !== expanded) setExpanded(next.expanded);
  }, [draft, expanded, selectedModel.name, effortLabel, fastMode, alwaysExpanded, chatSize]);

  // Any press outside the open picker closes it, including the prompt field and the rest of the composer.
  useDismiss(
    modelOpen || plusOpen || permissionOpen,
    () => {
      setModelOpen(false);
      setPlusOpen(false);
      setPermissionOpen(false);
    },
    (target) => !!target.closest("[data-picker-panel], [data-promptbar] button[aria-expanded]"),
    () => {
      if (lastAnchor.current) anchorTo(...lastAnchor.current);
    },
  );
  const lastAnchor = useRef<[HTMLElement, number] | null>(null);

  // Right-align the popover with its trigger, or left-align when that would leave the composer. It opens above the
  // composer, or, in the tall layout, right above its button; below the button when there's more room there.
  function anchorTo(trigger: HTMLElement, width: number) {
    lastAnchor.current = [trigger, width];
    const root = popoverRootRef.current?.getBoundingClientRect();
    if (!root) return;
    const button = trigger.getBoundingClientRect();
    const alignRight = button.right - width >= root.left;
    const left = Math.max(0, Math.min((alignRight ? button.right - width : button.left) - root.left, root.width - width));
    const roomBelow = window.innerHeight - button.bottom - POPOVER_BUTTON_GAP - POPOVER_BOTTOM_INSET;
    const below = expanded && roomBelow >= POPOVER_MIN_BELOW;
    const edge = expanded ? button.top - POPOVER_BUTTON_GAP : root.top - POPOVER_GAP;
    setAnchor(
      below
        ? { left, alignRight, below, top: button.bottom + POPOVER_BUTTON_GAP - root.top, maxHeight: roomBelow }
        : { left, alignRight, below, bottom: root.bottom - edge, maxHeight: edge - POPOVER_TOP_INSET },
    );
  }

  const anchorStyle = {
    left: anchor.left,
    top: anchor.top,
    bottom: anchor.bottom,
    maxHeight: anchor.maxHeight,
    transformOrigin: `${anchor.below ? "top" : "bottom"} ${anchor.alignRight ? "right" : "left"}`,
  };

  // Sending moves on from whatever was being picked, and the composer's layout may change under an open popover.
  function send() {
    browsing.current = null;
    setModelOpen(false);
    setPermissionOpen(false);
    setPlusOpen(false);
    onSend();
  }

  // The picker stays open after a pick: effort, fast mode and Ultracode sit beside the models.
  function chooseModel(model: ModelOption) {
    onModelChange(model);
    setProvider(model.provider);
  }

  function pick(row: MenuRow) {
    const source = SOURCES.find((item) => item.key === row.key);
    if (source?.key === "attach") {
      fileInputRef.current?.click();
    } else if (source?.key === "paste") {
      void imageDraft.pasteImage();
    } else if (menu === "at") {
      if (token && row.path) {
        const path = fileMentionPath(projectPath, row.path);
        if (!path) return;
        markKnown(row.path);
        if (!imageDraft.files.includes(path)) mentionAttached.current.add(path);
        imageDraft.attachPath(path);
        const mention = formatFileMention(row.path);
        onDraftChange(insertPromptToken(draft, token, mention));
        inputRef.current?.setSelection(token.start + mention.length + 1);
      }
    } else {
      onDraftChange(token ? insertPromptToken(draft, token, row.name) : `${draft}${row.name} `);
      inputRef.current?.setSelection(token ? token.start + row.name.length + 1 : draft.length + row.name.length + 1);
    }
    setPlusOpen(false);
    setDismissed(true);
    inputRef.current?.focus();
  }

  // Escape closes the slash/@ menu or an open picker, from the prompt or a picker's search field.
  // Only then is it consumed: with nothing open it reaches the window and stops the running turn.
  function handleEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !(menu || modelOpen || permissionOpen)) return;
    event.preventDefault();
    setDismissed(true);
    setPlusOpen(false);
    setModelOpen(false);
    setPermissionOpen(false);
    setQuery("");
    inputRef.current?.focus();
  }

  // Up on the first line steps back through sent prompts, Down on the last line steps forward and finally restores
  // the draft that was there before, like a shell or VS Code's chat.
  function recall(event: KeyboardEvent<HTMLDivElement>) {
    const up = event.key === "ArrowUp";
    if ((!up && event.key !== "ArrowDown") || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return false;
    const editor = inputRef.current;
    if (!editor || !(up ? editor.isCaretOnFirstLine() : editor.isCaretOnLastLine())) return false;
    const current = browsing.current;
    if (!current && !up) return false;
    const index = (current?.index ?? history.length) + (up ? -1 : 1);
    if (index < 0) return false;
    event.preventDefault();
    const stash = current?.stash ?? draft;
    const next = index < history.length ? history[index] : stash;
    browsing.current = index < history.length ? { index, stash } : null;
    setDismissed(true);
    onDraftChange(next);
    inputRef.current?.setSelection(next.length);
    return true;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys during an IME composition belong to the IME: Enter commits the text, it doesn't pick or send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menu && rows.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setEngaged(true);
        setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        pick(rows[active] ?? rows[0]);
        return;
      }
    }
    if (recall(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <div data-promptbar className="w-full" onKeyDown={handleEscape}>
      <div ref={popoverRootRef} className="relative">
        {menu && (
          <div
            data-picker-panel
            onMouseLeave={() => setEngaged(false)}
            className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-[10px] border border-line bg-surface p-1 shadow-raised"
            style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}
          >
            <ScrollArea className="relative max-h-64" aria-label={menu === "slash" ? "Commands and skills" : plusOpen ? "Sources" : "Project files"}>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
                style={{
                  top: rowBox?.top ?? 0,
                  height: rowBox?.height ?? 0,
                  opacity: rowBox && engaged ? 1 : 0,
                  transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
                }}
              />
              {rows.map((row, index) => {
                const source = menu === "at" ? SOURCES.find((item) => item.key === row.key) : undefined;
                const showGroup = row.group && row.group !== rows[index - 1]?.group;
                return (
                  <Fragment key={row.key}>
                    {showGroup && (
                      <div data-skill-group={row.group} className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                        {row.group}
                      </div>
                    )}
                    <button
                      type="button"
                      ref={(element) => {
                        rowRefs.current[index] = element;
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => {
                        setActive(index);
                        setEngaged(true);
                      }}
                      onClick={() => pick(row)}
                      title={row.path ?? row.desc}
                      className="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left"
                    >
                      {source && (
                        <span className="flex size-5.5 shrink-0 items-center justify-center text-ink-2">
                          <Icon icon={source.icon} size={15} />
                        </span>
                      )}
                      <span className="max-w-[45%] shrink-0 truncate text-[12.5px] font-medium text-ink">{row.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{row.desc}</span>
                      {row.source && <span className="shrink-0 text-[10px] text-ink-3">{row.source}</span>}
                    </button>
                  </Fragment>
                );
              })}
              {menu === "at" && !plusOpen && fileSearch.error && (
                <div role="status" className="px-2 text-xs text-red">
                  {fileSearch.error}
                </div>
              )}
              {rows.length === 0 && (
                <div className="flex h-9 items-center px-2 text-[12px] text-ink-3">
                  {fileSearch.loading && menu === "at" ? "Searching files..." : `No matches for "${tokenQuery}"`}
                </div>
              )}
            </ScrollArea>
            {menu === "slash" && skillWarnings.length > 0 && (
              <div role="status" title={skillWarnings.join("\n")} className="px-2 py-1 text-[11px] text-ink-3">
                {skillWarnings.length === 1 ? skillWarnings[0] : `${skillWarnings.length} skills could not be loaded. Hover for details.`}
              </div>
            )}
            <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">
              {menu === "at" ? "Type to search files" : skillsLoading ? "Loading skills…" : "Type to search commands & skills"}
            </div>
          </div>
        )}

        {modelOpen && (
          <ModelPicker
            style={anchorStyle}
            providers={providerTabs}
            provider={provider}
            onProviderChange={setProvider}
            models={modelRows}
            totalModels={models.filter((model) => model.provider === provider).length}
            query={query}
            onQueryChange={setQuery}
            cliStatus={cliStatus}
            notice={
              providerNotice ? (
                <div role="status" className="mx-1 mb-1 flex flex-col gap-2 rounded-control bg-inset px-2.5 py-2 text-[12px] text-ink-2">
                  <p className="leading-snug">
                    {messageParts(providerNotice).map((part, index) =>
                      part.code ? (
                        <code key={index} className="rounded-chip bg-surface px-1 py-px font-mono text-[11px] text-ink">
                          {part.text}
                        </code>
                      ) : (
                        part.text
                      ),
                    )}
                  </p>
                  {onUpdateCli &&
                    (cliStatus?.[provider]?.state === "outdated" ||
                      (providerCapabilities(provider).managedInstall && ["missing", "broken"].includes(cliStatus?.[provider]?.state ?? ""))) && (
                      <div className="flex items-center justify-end pt-0.5">
                        <button
                          type="button"
                          disabled={updatingCli === provider}
                          onClick={() => onUpdateCli(provider)}
                          className="flex items-center gap-1.5 rounded-chip border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink shadow-xs transition-colors hover:bg-hover active:scale-[0.98] disabled:opacity-50"
                        >
                          {updatingCli === provider ? (
                            <>
                              <span className="size-3 animate-spin rounded-full border-2 border-ink border-t-transparent" />
                              <span>{cliStatus?.[provider]?.state === "outdated" ? "Updating…" : "Installing…"}</span>
                            </>
                          ) : (
                            <span>
                              {cliStatus?.[provider]?.state === "outdated" ? "Update" : cliStatus?.[provider]?.state === "broken" ? "Reinstall" : "Install"}{" "}
                              {provider === "antigravity" ? cliName(provider) : providerName(provider)}
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                </div>
              ) : null
            }
            selectedModel={selectedModel}
            onModelChange={chooseModel}
            capability={capability}
            effort={effort}
            onEffortChange={onEffortChange}
            fastMode={fastMode}
            onFastModeChange={onFastModeChange}
            ultracode={ultracode}
            onUltracodeChange={(on) => {
              onUltracodeChange(on);
              if (on && ultracodeFatality) setFatality((count) => count + 1);
            }}
          />
        )}
        {fatality > 0 && <UltracodeFatality key={fatality} onDone={() => setFatality(0)} />}

        {permissionOpen && (
          <PickerPanel title="Agent permissions" className="absolute w-[340px]" style={anchorStyle}>
            {PERMISSION_MODES.map((mode) => (
              <PickerRow
                key={mode.id}
                icon={
                  <span className={`flex shrink-0 ${mode.id === "full" ? "text-ink" : mode.id === "auto" ? "text-green" : "text-accent-ink"}`}>
                    <Icon icon={SecurityCheckIcon} size={14} />
                  </span>
                }
                label={mode.name}
                description={mode.description}
                selected={permissionMode === mode.id}
                onClick={() => {
                  onPermissionModeChange(mode.id);
                  setPermissionOpen(false);
                  inputRef.current?.focus();
                }}
              />
            ))}
          </PickerPanel>
        )}

        <div
          data-ultracode={ultracodeOn || undefined}
          className={`promptbar-surface relative isolate flex flex-col overflow-visible border border-line transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${expanded ? "gap-2.5 rounded-[22px] p-3.5" : "gap-1.5 rounded-[14px] p-1.5"}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              void imageDraft.attachFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Attachments
            localFiles={imageDraft.localFiles}
            images={imageDraft.images}
            files={imageDraft.files}
            removeImage={imageDraft.remove}
            removeFile={imageDraft.removeFile}
          />
          {imageDraft.loading && (
            <div role="status" className="px-2 text-xs text-ink-3">
              Loading images…
            </div>
          )}
          {imageDraft.error && (
            <div role="alert" className="px-2 text-xs text-red">
              {imageDraft.error}
            </div>
          )}

          <div
            className={`grid items-end gap-x-1 gap-y-1.5 ${expanded ? "grid-cols-[28px_auto_minmax(0,1fr)_auto_auto]" : "grid-cols-[28px_minmax(0,1fr)_auto_auto_auto]"}`}
          >
            <div className={`relative min-w-0 w-full ${expanded ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1"}`}>
              <PromptEditor
                ref={inputRef}
                value={draft}
                parts={parts}
                skillDescriptions={skillDescriptions}
                onPaste={(event) => void imageDraft.onPaste(event)}
                onSelect={setCaret}
                onChange={(value, position) => {
                  setCaret(position);
                  onDraftChange(value);
                  setDismissed(false);
                  setPlusOpen(false);
                }}
                onKeyDown={handleKeyDown}
                disabled={Boolean(offlineName)}
                maxHeight={100}
                placeholder={
                  (running
                    ? // A provider that can't steer mid-turn takes the message at the start of the next turn.
                      providerCapabilities(provider).steer
                      ? "Steer the agent…"
                      : "Queue a message for the next turn…"
                    : "Prompt or mention a file with @") + (offlineName ? offlinePlaceholder(offlineName) : "")
                }
                className={inputTextClass}
                placeholderClassName={expanded ? "" : "truncate whitespace-nowrap"}
              />
            </div>
            <button
              type="button"
              aria-label="Add attachments and sources"
              aria-expanded={plusOpen}
              onClick={() => {
                setModelOpen(false);
                setPlusOpen((current) => !current);
                inputRef.current?.focus();
              }}
              className={`col-start-1 ${expanded ? "row-start-2" : "row-start-1"} flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink ${plusOpen ? "bg-hover" : ""}`}
            >
              <Icon icon={Add01Icon} size={16} />
            </button>
            <div className={`flex shrink-0 items-center gap-0.5 ${expanded ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"}`}>
              <button
                type="button"
                aria-expanded={modelOpen}
                title={[selectedModel.name, effortLabel, canUseFastMode && fastMode ? "Fast mode" : ""].filter(Boolean).join(" · ")}
                onClick={(event) => {
                  anchorTo(event.currentTarget, capability.efforts.length > 0 || capability.fastMode || capability.ultracode ? 580 : 300);
                  setPlusOpen(false);
                  setPermissionOpen(false);
                  setModelOpen((current) => !current);
                }}
                className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                <ProviderLogo provider={selectedModel.provider} size={13} />
                <span data-model-name className="max-w-28 truncate">
                  {selectedModel.name}
                </span>
                {effortLabel && (
                  <span data-effort-label className={`flex items-center gap-1 ${orchestrating ? "text-purple-ink" : ""}`}>
                    <span className="text-ink-3">·</span>
                    <span className="hidden min-[900px]:inline">{effortLabel}</span>
                    <span className="min-[900px]:hidden">
                      <EffortMeter level={effortIndex} total={effortLevels.length} />
                    </span>
                  </span>
                )}
                {canUseFastMode && fastMode && (
                  <span data-fast-mode className="text-orange">
                    <Icon icon={FlashIcon} size={13} />
                  </span>
                )}
                <Icon icon={ArrowDown01Icon} size={12} />
              </button>
            </div>
            <button
              type="button"
              aria-label="Agent permissions"
              aria-expanded={permissionOpen}
              onClick={(event) => {
                anchorTo(event.currentTarget, 340);
                setPlusOpen(false);
                setModelOpen(false);
                setPermissionOpen((current) => !current);
              }}
              className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium transition-colors hover:bg-hover ${permissionMode === "full" ? "text-ink" : permissionMode === "auto" ? "text-green" : "text-ink-2"} ${expanded ? "col-start-3 row-start-2 justify-self-start" : "col-start-4 row-start-1"}`}
            >
              <Icon icon={SecurityCheckIcon} size={14} />
              <span className="hidden min-[900px]:inline">{permissionMode === "ask" ? "Ask" : permissionMode === "auto" ? "Auto" : "Full"}</span>
            </button>
            <div className={`flex shrink-0 items-center gap-1.5 ${expanded ? "col-start-5 row-start-2" : "col-start-5 row-start-1"}`}>
              {contextUsage && contextUsage.size > 0 && (
                <ContextRing
                  {...contextUsage}
                  onCompact={onCompact}
                  compactBlocked={running ? "Wait for the agent to finish." : sendBlocked ? "Not available right now." : null}
                />
              )}
              <button
                type="button"
                aria-label={canStop ? "Stop agent" : "Send"}
                disabled={!canStop && (!canSend || sendBlocked || imageDraft.loading)}
                onClick={canStop ? onStop : send}
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-surface transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-ink-2`}
                style={{ background: canStop || (canSend && !sendBlocked) ? (ultracodeOn ? "var(--purple)" : "var(--ink)") : "var(--line-strong)" }}
              >
                {canStop ? <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-current" /> : <Icon icon={ArrowUp01Icon} size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

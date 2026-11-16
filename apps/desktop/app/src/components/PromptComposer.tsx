import { COMMANDS, UNDO_COMMAND } from "./composer/prompt-commands";
import { useContextSettings } from "../lib/context-settings";
import { cliName, pickerProviders, providerName } from "@milagre/shared/providers";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { followUpDelivery, type MessageDelivery } from "@milagre/shared/queued-messages";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { CleanIcon, Cancel01Icon, ArrowUp02Icon, Attachment01Icon, FlashIcon, Mic01Icon } from "@hugeicons/core-free-icons";
import type { AgentCliStatus, ContextUsage, EffortLevel, ModelCapability, ModelOption, ModelProvider, PermissionMode } from "../model";
import { effortCopy, PERMISSION_MODE_LABEL } from "../model";
import { cliNotice, messageParts } from "../lib/cli-status";
import type { ImageDraft } from "./usePastedImages";
import { ModelPicker } from "./ModelPicker";
import { UltracodeFatality } from "./UltracodeFatality";
import { useDismiss } from "../lib/use-dismiss";
import { useSettings } from "../lib/settings";
import { ProviderLogo } from "./ProviderLogo";
import { Attachments } from "./Attachments";
import { QuoteChips } from "./QuoteChips";
import { useProjectFiles } from "./useProjectFiles";
import { promptToken, fileMentionPath, insertImageMentions, insertPromptToken } from "../lib/file-mentions";
import { mentionedImages, shiftImageMentions } from "../lib/prompt-mentions";
import { isOrchestratorRow, ORCHESTRATOR_MENTION, orchestratorMentionRows } from "../lib/orchestrator-mention";
import { formatChatMention, formatComputerMention, formatFileMention, promptParts, type ComposerQuote } from "@milagre/shared/prompt-parts";
import { rankSkillMatches } from "@milagre/shared/skill-catalog";
import { useSkills } from "./useSkills";
import { ScrollArea } from "./primitives/ScrollArea";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { useKnownFiles } from "./useKnownFiles";
import { ContextRing } from "./ContextRing";
import { compactButtonState } from "@milagre/shared/chat-display";
import { PROMPT_PLACEHOLDER, matchingMentionChats, matchingMentionComputers } from "@milagre/shared/prompt-mentions";
import { useChatMentions, useMentionComputers } from "./ChatMentions";
import { offlinePlaceholder, reconnectingPlaceholder } from "../lib/computers";
import { DictationNotice } from "./DictationNotice";
import { DownloadRing, DroppingArrow } from "./DownloadRing";
import Tooltip from "./primitives/Tooltip";
import { SpinnerRing } from "./primitives/SpinnerRing";
import { useDictationTake } from "./composer/use-dictation-take";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 15 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

type MenuRow = { key: string; name: string; desc: string; group?: string; source?: string; path?: string; chatId?: number; computer?: string };

interface PromptComposerProps {
  offlineName?: string | null;
  reconnectingName?: string | null;
  imageDraft: ImageDraft;
  projectPath: string;
  skillScope?: string;
  accountScope?: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  quotes?: readonly ComposerQuote[];
  onRemoveQuote?: (id: string) => void;
  history?: string[];
  onSend: (delivery?: MessageDelivery) => void;
  onStop?: () => void;
  sendBlocked: boolean;
  running?: boolean;
  runningProvider?: ModelProvider;
  suggestion?: string;
  onCompact?: () => void;
  compactionFeedback?: { percent: number; freed: string } | null;
  compacting?: boolean;
  compactQueued?: boolean;
  onCancelCompact?: () => void;
  models: ModelOption[];
  cliStatus: AgentCliStatus | null;
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
  contextUsage?: ContextUsage;
  canUndo?: boolean;
  placeholder?: string;
}

const NO_HISTORY: string[] = [];
const NO_QUOTES: readonly ComposerQuote[] = [];

const DICTATION_LABELS = {
  idle: "Dictate",
  preparing: "Cancel dictation",
  recording: "Stop dictation",
  transcribing: "Transcribing",
} as const;

const POPOVER_GAP = 12;
const POPOVER_EDGE = 8;

function clipRect(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowX } = getComputedStyle(node);
    if (overflowX !== "visible") return node.getBoundingClientRect();
  }
  return { left: 0, right: window.innerWidth };
}
const POPOVER_BUTTON_GAP = 8;
const POPOVER_TOP_INSET = 48;
const POPOVER_BOTTOM_INSET = 16;
const POPOVER_MIN_BELOW = 220;

export function PromptComposer({
  offlineName,
  reconnectingName,
  imageDraft,
  projectPath,
  skillScope,
  accountScope = projectPath,
  draft,
  onDraftChange,
  quotes = NO_QUOTES,
  onRemoveQuote,
  history = NO_HISTORY,
  onSend,
  onStop,
  sendBlocked,
  running = false,
  runningProvider,
  suggestion,
  onCompact,
  compactionFeedback,
  compacting = false,
  compactQueued = false,
  onCancelCompact,
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
  contextUsage,
  canUndo = false,
  placeholder,
}: PromptComposerProps) {
  const mentions = useChatMentions();
  const mentionComputers = useMentionComputers();
  const [dismissed, setDismissed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [fatality, setFatality] = useState(0);
  const { ultracodeFatality, dictationAction, dictationShortcutMode, showContextSize, compactButtonDisplay } = useSettings();
  const { settings: contextSettings } = useContextSettings();
  const delivery = followUpDelivery(contextSettings.followUps);
  const queuesFollowUp = delivery === "queue" || compacting || !providerCapabilities(runningProvider ?? selectedModel.provider).steer;
  const quiet = contextSettings.autoCompact && Boolean(onCompact);
  const compactButton = compactButtonState(compactButtonDisplay, contextUsage, Boolean(onCompact), contextSettings.buttonThreshold, quiet);
  const compactLabel = compacting ? "Compacting…" : compactQueued ? "Queued for after turn" : running ? "Compact after turn" : "Compact";
  const compactBlocked = compacting ? "Compacting context." : sendBlocked ? "Not available right now." : null;
  const effortName = effort ? effortCopy(effort).name : "";
  const ultracodeOn = capability.ultracode && ultracode;
  const orchestrating = ultracodeOn || effort === "ultra";
  const effortLabel = ultracodeOn ? "Ultra" : effortName;
  const canUseFastMode = capability.fastMode;
  const [provider, setProvider] = useState<ModelProvider>(selectedModel.provider);
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
  const inputRef = useRef<PromptEditorHandle>(null);
  const popoverRootRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
    below: boolean;
    alignRight: boolean;
  }>({
    left: 0,
    maxHeight: 480,
    below: false,
    alignRight: true,
  });
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);

  const browsing = useRef<{ index: number; stash: string } | null>(null);
  useEffect(() => {
    browsing.current = null;
  }, [history]);

  const [caret, setCaret] = useState(draft.length);
  const token = dismissed ? null : promptToken(draft, Math.min(caret, draft.length));
  const menu: "at" | "slash" | null = token?.kind ?? null;
  const tokenQuery = token?.query ?? "";
  const fileSearch = useProjectFiles(projectPath, tokenQuery, menu === "at");
  const { skills, warnings: skillWarnings, loading: skillsLoading } = useSkills(skillScope ?? projectPath, menu === "slash" || /(^|\s)\//.test(draft));
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
  const typing = token?.kind === "at" ? draft.slice(token.start + 1, token.end) : null;
  const { known, version: knownVersion, markKnown } = useKnownFiles(projectPath, draft, typing);
  const imageCount = imageDraft.images.length;
  const parts = useMemo(
    () =>
      promptParts(draft, {
        skills: skillKey ? skillKey.split("\n") : [],
        files: (path) => known.has(path),
        images: imageCount,
        chats: (id) => mentions.chats.some((chat) => chat.id === id && chat.available),
        computers: (name) => mentionComputers.some((computer) => computer.name.toLowerCase() === name.toLowerCase()),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `known` is a Set that grows in place; `knownVersion` counts its growth.
    [draft, skillKey, known, knownVersion, imageCount, mentions.chats, mentionComputers],
  );
  const typedFound = typing !== null && fileSearch.files.includes(typing) ? typing : null;
  useEffect(() => {
    if (typedFound) markKnown(typedFound);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `markKnown` is rebuilt each render.
  }, [typedFound, projectPath]);
  const mentionAttached = useRef(new Set<string>());
  const mentionScope = useRef(imageDraft.scope);
  const chipKey = [...new Set(parts.flatMap((part) => (part.kind === "file" ? [fileMentionPath(projectPath, part.path) ?? ""] : [])).filter(Boolean))].join(
    "\n",
  );
  const chipPaths = useMemo(() => (chipKey ? chipKey.split("\n") : []), [chipKey]);
  useEffect(() => {
    if (mentionScope.current !== imageDraft.scope) {
      mentionScope.current = imageDraft.scope;
      mentionAttached.current.clear();
    }
    for (const path of Array.from(mentionAttached.current)) {
      if (chipPaths.includes(path)) continue;
      mentionAttached.current.delete(path);
      if (imageDraft.files.includes(path)) imageDraft.removeFile(path);
    }
    for (const path of chipPaths) {
      if (imageDraft.files.includes(path)) continue;
      mentionAttached.current.add(path);
      imageDraft.attachPath(path);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `imageDraft` is a new object each render; its files and scope are what count.
  }, [chipPaths, imageDraft.files, imageDraft.scope, imageDraft.remote]);
  const onSendLatest = useRef(onSend);
  onSendLatest.current = onSend;
  const chatMatches = menu === "at" ? matchingMentionChats(mentions.chats, tokenQuery, mentions.currentId) : [];
  const computerMatches = menu === "at" && mentionComputers.length > 1 ? matchingMentionComputers(mentionComputers, tokenQuery) : [];
  const rows: MenuRow[] =
    menu === "at"
      ? [
          ...orchestratorMentionRows(menu === "at", tokenQuery),
          ...fileSearch.files
            .slice(0, chatMatches.length || computerMatches.length ? 3 : undefined)
            .map((path) => ({ key: `file:${path}`, name: path.split("/").at(-1) || path, desc: path, path, group: "Files" })),
          ...chatMatches.map((chat) => ({
            key: `chat:${chat.id}`,
            name: chat.title,
            desc: chat.branch,
            chatId: chat.id,
            group: "Chats",
          })),
          ...computerMatches.map((computer) => ({
            key: `computer:${computer.id}`,
            name: computer.name,
            desc: computer.self ? "This Mac" : computer.online ? "Online" : "Offline",
            computer: computer.name,
            group: "Computers",
          })),
        ]
      : menu === "slash"
        ? rankSkillMatches(commands, tokenQuery, (command) => ({
            name: command.name,
            description: command.desc,
          }))
        : [];
  const providerNotice = cliNotice(cliStatus?.[provider]);
  const providerTabs = pickerProviders(cliStatus, selectedModel.provider, provider);
  const modelRows = models.filter((model) => model.provider === provider && `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  const canSend = draft.trim().length > 0 || quotes.length > 0 || imageDraft.images.length > 0 || imageDraft.files.length > 0;
  const canStop = !offlineName && running && Boolean(onStop) && !canSend;
  const visibleSuggestion =
    suggestion &&
    !draft &&
    !quotes.length &&
    !running &&
    !sendBlocked &&
    !offlineName &&
    selectedModel.provider === "claude" &&
    !imageDraft.images.length &&
    !imageDraft.files.length &&
    !imageDraft.loading &&
    !menu &&
    !modelOpen
      ? suggestion
      : undefined;

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, tokenQuery, projectPath, skills]);

  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target && engaged) target.scrollIntoView({ block: "nearest" });
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [active, engaged, menu, tokenQuery, rows.length]);

  useDismiss(
    modelOpen,
    () => {
      setModelOpen(false);
    },
    (target) => !!target.closest("[data-picker-panel], [data-promptbar] button[aria-expanded]"),
    () => {
      if (lastAnchor.current) anchorTo(...lastAnchor.current);
    },
  );
  const lastAnchor = useRef<[HTMLElement, number] | null>(null);

  function anchorTo(trigger: HTMLElement, width: number) {
    lastAnchor.current = [trigger, width];
    const rootElement = popoverRootRef.current;
    const root = rootElement?.getBoundingClientRect();
    if (!rootElement || !root) return;
    const button = trigger.getBoundingClientRect();
    const clip = clipRect(rootElement);
    const min = clip.left + POPOVER_EDGE - root.left;
    const max = clip.right - POPOVER_EDGE - root.left - width;
    const fits = width <= root.width;
    const alignRight = button.right - width - root.left >= (fits ? 0 : min);
    const lowest = fits ? 0 : Math.min(min, 0);
    const highest = fits ? root.width - width : Math.max(max, root.width - width);
    const left = Math.max(lowest, Math.min((alignRight ? button.right - width : button.left) - root.left, highest));
    const roomBelow = window.innerHeight - button.bottom - POPOVER_BUTTON_GAP - POPOVER_BOTTOM_INSET;
    const below = roomBelow >= POPOVER_MIN_BELOW;
    const edge = root.top - POPOVER_GAP;
    setAnchor(
      below
        ? {
            left,
            alignRight,
            below,
            top: button.bottom + POPOVER_BUTTON_GAP - root.top,
            maxHeight: roomBelow,
          }
        : {
            left,
            alignRight,
            below,
            bottom: root.bottom - edge,
            maxHeight: edge - POPOVER_TOP_INSET,
          },
    );
  }

  const anchorStyle = {
    left: anchor.left,
    top: anchor.top,
    bottom: anchor.bottom,
    maxHeight: anchor.maxHeight,
    transformOrigin: `${anchor.below ? "top" : "bottom"} ${anchor.alignRight ? "right" : "left"}`,
  };

  function send() {
    browsing.current = null;
    setModelOpen(false);
    const missing = chipPaths.filter((path) => !imageDraft.files.includes(path));
    if (missing.length) {
      flushSync(() => {
        for (const path of missing) {
          mentionAttached.current.add(path);
          imageDraft.attachPath(path);
        }
      });
      onSendLatest.current(delivery);
      return;
    }
    onSend(delivery);
  }

  function chooseModel(model: ModelOption) {
    onModelChange(model);
    setProvider(model.provider);
  }

  const draftLatest = useRef(draft);
  draftLatest.current = draft;
  useEffect(() => {
    const pending = dictatedSend.current;
    if (!pending) return;
    dictatedSend.current = null;
    if (pending.scope !== imageDraft.scope || pending.value !== draft || dictationAction !== "send") return;
    if (canSend && !sendBlocked && !imageDraft.loading && !offlineName) send();
  });

  const { dictateShortcutLabel, dictating, dictation, dictationError, discardDictation, fixing, provisional, rootRef, startDictation, dictatedSend } =
    useDictationTake({
      projectPath,
      imageDraft,
      draft,
      draftLatest,
      onDraftChange,
      setCaret,
      inputRef,
      caret,
      dictationAction,
      dictationShortcutMode,
      mentions,
      selectedModel,
    });

  function insertImages(promise: Promise<number[]>, range = inputRef.current?.getSelection() ?? { start: caret, end: caret }) {
    const original = draftLatest.current;
    void promise.then((indices) => {
      if (!indices.length) return;
      const currentCaret = inputRef.current?.getSelection().end ?? draftLatest.current.length;
      const target = draftLatest.current === original ? range : { start: currentCaret, end: currentCaret };
      const next = insertImageMentions(draftLatest.current, indices, target);
      setCaret(next.caret);
      onDraftChange(next.value);
      inputRef.current?.setSelection(next.caret);
    });
  }

  function dropUnmentionedImages(previous: string, next: string) {
    const before = mentionedImages(previous, imageCount);
    const after = mentionedImages(next, imageCount);
    const removed = [...before].filter((index) => !after.has(index)).sort((a, b) => b - a);
    for (const index of removed) {
      const image = imageDraft.images[index - 1];
      if (image?.path) imageDraft.removeFile(image.path);
      else if (image) imageDraft.remove(image.id);
      next = shiftImageMentions(next, index);
    }
    return next;
  }

  const [previewId, setPreviewId] = useState<string | null>(null);

  function removeAttachment(field: "id" | "path", value: string) {
    const index = imageDraft.images.findIndex((image) => image[field] === value);
    if (field === "id") imageDraft.remove(value);
    else imageDraft.removeFile(value);
    const next = index < 0 ? draftLatest.current : shiftImageMentions(draftLatest.current, index + 1);
    if (next !== draftLatest.current) onDraftChange(next);
  }

  function pick(row: MenuRow) {
    if (menu === "at") {
      if (token && (row.chatId !== undefined || row.computer || isOrchestratorRow(row))) {
        const mention = isOrchestratorRow(row) ? ORCHESTRATOR_MENTION : row.computer ? formatComputerMention(row.computer) : formatChatMention(row.chatId!);
        onDraftChange(insertPromptToken(draft, token, mention));
        inputRef.current?.setSelection(token.start + mention.length + 1);
      } else if (token && row.path) {
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
    setDismissed(true);
    inputRef.current?.focus();
  }

  function handleEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !(menu || modelOpen)) return;
    event.preventDefault();
    setDismissed(true);
    setModelOpen(false);
    setQuery("");
    inputRef.current?.focus();
  }

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
    const next = index < history.length ? (history[index] ?? stash) : stash;
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
        const row = rows[active] ?? rows[0];
        if (row) pick(row);
        return;
      }
    }
    if (visibleSuggestion && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "Tab") {
      const selection = inputRef.current?.getSelection();
      if (selection?.start === 0 && selection.end === 0) {
        event.preventDefault();
        onDraftChange(visibleSuggestion);
        inputRef.current?.setSelection(visibleSuggestion.length);
        return;
      }
    }
    if (event.key === "Backspace" && onRemoveQuote && quotes.length && !event.metaKey && !event.altKey && !event.ctrlKey) {
      const selection = inputRef.current?.getSelection();
      if (selection?.start === 0 && selection.end === 0) {
        event.preventDefault();
        onRemoveQuote(quotes.at(-1)!.id);
        return;
      }
    }
    if (recall(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend || !visibleSuggestion) send();
    }
  }

  return (
    <div ref={rootRef} data-promptbar className="@container w-full" onKeyDown={handleEscape}>
      <div ref={popoverRootRef} className="relative">
        {menu && (
          <div
            data-picker-panel
            onMouseLeave={() => setEngaged(false)}
            className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-card bg-surface p-1.5 shadow-raised"
            style={{
              animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) backwards",
              transformOrigin: "bottom center",
            }}
          >
            <ScrollArea className="relative max-h-64" aria-label={menu === "slash" ? "Commands and skills" : "Project files and Chats"}>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 rounded-inline bg-hover-2"
                style={{
                  top: rowBox?.top ?? 0,
                  height: rowBox?.height ?? 0,
                  opacity: rowBox && engaged ? 1 : 0,
                  transition: "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
                }}
              />
              {rows.map((row, index) => {
                const showGroup = (menu === "at" || !tokenQuery) && row.group && row.group !== rows[index - 1]?.group;
                return (
                  <Fragment key={row.key}>
                    {showGroup && (
                      <div data-skill-group={row.group} className="px-2 pt-2 pb-1 text-10 font-semibold uppercase tracking-wide text-ink-3">
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
                      className="relative z-10 flex h-8 w-full items-center gap-2 rounded-inline px-2 text-left focus-visible:-outline-offset-2"
                    >
                      <span className="max-w-[45%] shrink-0 truncate text-13 font-medium text-ink">{row.name}</span>
                      <span className="min-w-0 flex-1 truncate text-12 text-ink-3">{row.desc}</span>
                      {row.source && <span className="shrink-0 text-11 text-ink-3">{row.source}</span>}
                    </button>
                  </Fragment>
                );
              })}
              {menu === "at" && fileSearch.error && (
                <div role="status" className="px-2 text-12 text-red-ink">
                  {fileSearch.error}
                </div>
              )}
              {rows.length === 0 && (
                <div className="flex h-8 items-center px-2 text-12 text-ink-3">
                  {fileSearch.loading && menu === "at" ? "Searching files..." : `No matches for "${tokenQuery}"`}
                </div>
              )}
            </ScrollArea>
            {menu === "slash" && skillWarnings.length > 0 && (
              <div role="status" title={skillWarnings.join("\n")} className="px-2 py-1 text-11 text-ink-3">
                {skillWarnings.length === 1 ? skillWarnings[0] : `${skillWarnings.length} skills could not be loaded. Hover for details.`}
              </div>
            )}
            <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-11 text-ink-3">
              {menu === "at"
                ? mentionComputers.length > 1
                  ? "Type to search files, Chats and computers"
                  : "Type to search files and Chats"
                : skillsLoading
                  ? "Loading skills…"
                  : "Type to search commands & skills"}
            </div>
          </div>
        )}

        {modelOpen && (
          <ModelPicker
            scope={accountScope}
            style={anchorStyle}
            providers={providerTabs}
            provider={provider}
            onProviderChange={setProvider}
            models={modelRows}
            query={query}
            onQueryChange={setQuery}
            cliStatus={cliStatus}
            notice={
              providerNotice ? (
                <div role="status" className="mx-1 mb-1 flex flex-col gap-2 rounded-control bg-inset px-2.5 py-2 text-12 text-ink-2">
                  <p className="leading-snug">
                    {messageParts(providerNotice).map((part, index) =>
                      part.code ? (
                        <code key={index} className="rounded-chip bg-surface px-1 py-px font-mono text-11 text-ink">
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
                          className="flex items-center gap-1.5 rounded-chip border border-line bg-surface px-2.5 py-1 text-12 font-semibold text-ink shadow-xs transition-colors hover:bg-hover active:scale-[0.98] disabled:opacity-50"
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
            permissionMode={permissionMode}
            onPermissionModeChange={(mode) => {
              onPermissionModeChange(mode);
              inputRef.current?.focus();
            }}
            ultracode={ultracode}
            onUltracodeChange={(on) => {
              onUltracodeChange(on);
              if (on && ultracodeFatality) setFatality((count) => count + 1);
            }}
          />
        )}
        {fatality > 0 && <UltracodeFatality key={fatality} onDone={() => setFatality(0)} />}

        <div
          data-ultracode={ultracodeOn || undefined}
          className={`promptbar-surface relative isolate flex flex-col overflow-visible border border-line transition-[border-color,border-radius] duration-fast gap-2 rounded-window p-3`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              insertImages(imageDraft.attachFiles(Array.from(event.target.files ?? [])));
              event.target.value = "";
            }}
          />
          <Attachments
            localFiles={imageDraft.localFiles}
            images={imageDraft.images}
            files={imageDraft.files.filter((file) => !chipPaths.includes(file))}
            order={imageDraft.order}
            previewId={previewId}
            onPreview={setPreviewId}
            removeImage={(id) => removeAttachment("id", id)}
            removeFile={(path) => removeAttachment("path", path)}
            uploads={imageDraft.uploads}
            cancelUpload={imageDraft.cancelUpload}
          />
          {imageDraft.loading && !imageDraft.uploads.length && (
            <div role="status" className="px-2 text-12 text-ink-3">
              Loading images…
            </div>
          )}
          {imageDraft.error && (
            <div role="alert" className="px-2 text-12 text-red-ink">
              {imageDraft.error}
            </div>
          )}
          {dictation.phase === "preparing" || dictation.phase === "transcribing" ? (
            <p role="status" data-dictation-status className="sr-only">
              {dictation.phase === "preparing" ? "Preparing the microphone…" : "Finishing the last words…"}
            </p>
          ) : fixing !== null ? (
            <span role="status" className="sr-only">
              {fixing ? `Correcting names · ${fixing}` : "Correcting names…"}
            </span>
          ) : null}

          <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,max-content)_auto] items-end gap-x-1 gap-y-1.5">
            <div className="relative col-span-full row-start-1 flex w-full min-w-0 flex-wrap items-start">
              {onRemoveQuote && quotes.length > 0 && (
                <span className="contents text-[length:calc(var(--chat-size)+1px)] leading-5 [&>[data-quote-chip]]:mt-2 [&>[data-quote-chip]]:ml-2 [&>[data-quote-chip]]:top-0">
                  <QuoteChips
                    quotes={quotes}
                    onRemove={(id) => {
                      onRemoveQuote(id);
                      inputRef.current?.focus();
                    }}
                  />
                </span>
              )}
              <div className="relative min-w-40 flex-1 basis-40">
                <PromptEditor
                  ref={inputRef}
                  resetKey={imageDraft.scope}
                  value={draft}
                  parts={parts}
                  skillDescriptions={skillDescriptions}
                  onOpenImage={(index) => setPreviewId(imageDraft.images[index - 1]?.id ?? null)}
                  onPaste={(event) => {
                    const selection = inputRef.current?.getSelection() ?? {
                      start: caret,
                      end: caret,
                    };
                    const promise = imageDraft.onPaste(event);
                    if (event.defaultPrevented) insertImages(promise, selection);
                  }}
                  provisional={provisional}
                  onSelect={setCaret}
                  onChange={(value, position) => {
                    setCaret(position);
                    onDraftChange(dropUnmentionedImages(draftLatest.current, value));
                    setDismissed(false);
                  }}
                  onKeyDown={handleKeyDown}
                  disabled={false}
                  maxHeight={100}
                  suggestion={visibleSuggestion}
                  placeholder={
                    offlineName
                      ? offlinePlaceholder(offlineName)
                      : (running ? (queuesFollowUp ? "Queue a message for the next turn…" : "Steer the agent…") : (placeholder ?? PROMPT_PLACEHOLDER)) +
                        (reconnectingName ? reconnectingPlaceholder(reconnectingName) : "")
                  }
                  className="min-h-[68px] px-2 py-2 text-[length:calc(var(--chat-size)+1px)] leading-5"
                />
              </div>
            </div>
            <Tooltip label="Attach files" asChild>
              <button
                type="button"
                aria-label="Attach files"
                onClick={() => {
                  setModelOpen(false);
                  fileInputRef.current?.click();
                }}
                className="col-start-1 row-start-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              >
                <Icon icon={Attachment01Icon} size={16} />
              </button>
            </Tooltip>
            <button
              type="button"
              aria-expanded={modelOpen}
              data-permission-mode={permissionMode}
              title={[selectedModel.name, effortLabel, canUseFastMode && fastMode ? "Fast mode" : "", PERMISSION_MODE_LABEL[permissionMode]]
                .filter(Boolean)
                .join(" · ")}
              onClick={(event) => {
                anchorTo(event.currentTarget, capability.efforts.length > 0 || capability.fastMode || capability.ultracode ? 580 : 300);
                setModelOpen((current) => !current);
              }}
              className="col-start-3 row-start-2 flex h-7 min-w-0 items-center gap-1 justify-self-end rounded-control px-1.5 text-12 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
            >
              <ProviderLogo provider={selectedModel.provider} size={14} optical />
              <span data-model-name className="min-w-0 max-w-28 truncate">
                {selectedModel.name}
              </span>
              {effortLabel && (
                <span data-effort-label className={`flex shrink-0 items-center gap-1 ${orchestrating ? "text-purple-ink" : ""}`}>
                  <span className="text-ink-3">·</span>
                  {effortLabel}
                </span>
              )}
              {canUseFastMode && fastMode && (
                <span data-fast-mode className="text-orange-ink">
                  <Icon icon={FlashIcon} size={13} />
                </span>
              )}
            </button>
            <div className="col-start-4 row-start-2 flex shrink-0 items-center gap-1.5">
              {!quiet && compactionFeedback ? (
                <span role="status" className="flex h-7 items-center gap-1 rounded-control bg-green/10 px-2 text-12 text-green-ink">
                  ✓ {compactionFeedback.percent}%<span className="@max-[700px]:hidden"> · {compactionFeedback.freed} freed</span>
                </span>
              ) : (
                !quiet &&
                (compactButton.visible || compactQueued || compacting || (showContextSize && contextUsage && contextUsage.size > 0)) && (
                  <div
                    data-context-capsule
                    className={`flex shrink-0 items-center overflow-hidden rounded-control ${compactButton.warning ? "bg-orange/15 text-orange-ink" : "text-ink-2"}`}
                  >
                    {(compactButton.visible || compactQueued || compacting) && (
                      <button
                        type="button"
                        data-compact-context
                        aria-label={compactQueued ? "Cancel queued compaction" : "Compact context"}
                        disabled={Boolean(compactBlocked)}
                        title={compactLabel}
                        onClick={compactQueued ? onCancelCompact : onCompact}
                        className="flex h-7 items-center gap-1 px-2 text-12 font-medium disabled:opacity-40"
                      >
                        <Icon icon={compactQueued ? Cancel01Icon : CleanIcon} size={14} />
                        <span className="@max-[700px]:hidden">{compactLabel}</span>
                      </button>
                    )}
                    {contextUsage && contextUsage.size > 0 && (
                      <ContextRing
                        {...contextUsage}
                        onCompact={onCompact}
                        compactBlocked={compactBlocked}
                        compactLabel={running ? "Compact after turn" : "Compact now"}
                        settings={contextSettings}
                        showSize={showContextSize}
                      />
                    )}
                  </div>
                )
              )}
              <span className="relative flex shrink-0">
                {dictationError && <DictationNotice error={dictationError} onOpenSettings={dictation.openSettings} />}
                {dictation.download ? (
                  <Tooltip
                    label={`Downloading speech model · ${Math.round((dictation.download.received / dictation.download.total) * 100)}% of ${Math.round(dictation.download.total / 1e6)} MB`}
                    align="end"
                  >
                    <button
                      type="button"
                      data-dictation-download
                      aria-label={`Downloading speech model, ${Math.round((dictation.download.received / dictation.download.total) * 100)}%. Cancel`}
                      onClick={discardDictation}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink"
                    >
                      <DownloadRing size={28} progress={dictation.download.received / dictation.download.total}>
                        <DroppingArrow size={14} well={20} />
                      </DownloadRing>
                    </button>
                  </Tooltip>
                ) : dictating ? (
                  <span data-dictation-capsule className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-hover px-1">
                    <button
                      type="button"
                      aria-label="Discard dictation"
                      title="Discard dictation"
                      onClick={discardDictation}
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:text-ink"
                    >
                      <Icon icon={Cancel01Icon} size={14} />
                    </button>
                    {dictation.phase === "recording" ? (
                      <button
                        ref={(node) => {
                          dictation.meter.current = node;
                        }}
                        type="button"
                        aria-label="Stop dictation"
                        title="Stop dictation"
                        onClick={() => void dictation.stop()}
                        className="relative flex size-6 shrink-0 items-center justify-center rounded-full"
                      >
                        <span
                          aria-hidden
                          className="absolute inset-0.5 rounded-full bg-red/25 motion-safe:transition-transform motion-safe:duration-75"
                          style={{
                            transform: "scale(calc(1 + var(--level, 0) * 0.38))",
                          }}
                        />
                        <span aria-hidden className="relative block size-2.5 rounded-inline bg-red" />
                      </button>
                    ) : (
                      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                        <span className="block size-4 rounded-full border-2 border-line border-t-ink-2 border-r-ink-2 motion-safe:animate-spin" />
                      </span>
                    )}
                  </span>
                ) : (
                  <Tooltip
                    label={fixing !== null ? (fixing ? `Correcting names · ${fixing}` : "Correcting names…") : DICTATION_LABELS.idle}
                    shortcut={dictateShortcutLabel}
                    align="end"
                  >
                    <button
                      type="button"
                      data-dictation-processing={fixing !== null || undefined}
                      aria-label={DICTATION_LABELS.idle}
                      aria-busy={fixing !== null}
                      aria-description={fixing !== null ? "Correcting names. Start a new dictation to replace the pending correction." : undefined}
                      onClick={startDictation}
                      className={`relative flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ${fixing !== null ? "bg-hover text-ink-4" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
                    >
                      {fixing !== null && (
                        <span className="pointer-events-none absolute inset-0">
                          <SpinnerRing size={28} stroke={1.5} color="var(--accent)" />
                        </span>
                      )}
                      <Icon icon={Mic01Icon} size={16} />
                    </button>
                  </Tooltip>
                )}
              </span>
              <button
                type="button"
                aria-label={canStop ? "Stop agent" : offlineName ? "Queue message" : running ? (queuesFollowUp ? "Queue message" : "Send now") : "Send"}
                data-composer-submit
                disabled={!canStop && (dictating || !canSend || sendBlocked || imageDraft.loading)}
                onClick={canStop ? onStop : send}
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-on-ink transition-[background-color,opacity,scale] duration-fast enabled:hover:opacity-90 enabled:active:scale-press disabled:cursor-not-allowed disabled:opacity-40 ${ultracodeOn ? "bg-purple" : "bg-ink"}`}
              >
                {canStop ? (
                  <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="block">
                    <rect width="10" height="10" rx="2" fill="currentColor" />
                  </svg>
                ) : (
                  <Icon icon={ArrowUp02Icon} size={16} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useContextSettings } from "../lib/context-settings";
import { cliName, pickerProviders, providerName } from "@milagre/shared/providers";
import { providerCapabilities } from "@milagre/shared/provider-capabilities";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  CleanIcon,
  AlertCircleIcon,
  Cancel01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Attachment01Icon,
  ClipboardPasteIcon,
  FlashIcon,
  Mic01Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import type { AgentCliStatus, ContextUsage, EffortLevel, ModelCapability, ModelOption, ModelProvider, PermissionMode } from "../model";
import { effortCopy, PERMISSION_MODE_LABEL, PERMISSION_MODES } from "../model";
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
import { promptToken, fileMentionPath, insertImageMentions, insertPromptToken } from "../lib/file-mentions";
import { mentionedImages, shiftImageMentions } from "../lib/prompt-mentions";
import { formatChatMention, formatFileMention, promptParts } from "@milagre/shared/prompt-parts";
import { rankSkillMatches } from "@milagre/shared/skill-catalog";
import { useSkills } from "./useSkills";
import { ScrollArea } from "./primitives/ScrollArea";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { useKnownFiles } from "./useKnownFiles";
import { ContextRing } from "./ContextRing";
import { compactButtonState } from "@milagre/shared/chat-display";
import { matchingMentionChats } from "@milagre/shared/prompt-mentions";
import { useChatMentions } from "./ChatMentions";
import { offlinePlaceholder, reconnectingPlaceholder } from "../lib/computers";
import {
  NOTICE_SECONDS,
  provisionalRange,
  revertTake,
  startTake,
  writeTake,
  type DictationTake,
  type Selection as TextRange,
} from "@milagre/shared/voice-dictation";
import { useDictation } from "./useDictation";

type IconData = ComponentProps<typeof HugeiconsIcon>["icon"];

function Icon({ icon, size = 15 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

type MenuRow = { key: string; name: string; desc: string; group?: string; source?: string; path?: string; chatId?: number };

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
  /** The connection to the chat's computer is coming back: the field stays open, its placeholder says so. */
  reconnectingName?: string | null;
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
  /** A predicted follow-up, offered only in an empty, idle composer. */
  suggestion?: string;
  /** Sends `/compact` to the chat (Claude only); the context card offers it as Compact now. */
  onCompact?: () => void;
  compactionFeedback?: { percent: number; freed: string } | null;
  compacting?: boolean;
  compactQueued?: boolean;
  onCancelCompact?: () => void;
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
  /** The mode is fixed: the chip shows it, disabled. */
  permissionLocked?: boolean;
  /** Keep the tall layout (input above the controls) even while the draft is empty. */
  alwaysExpanded?: boolean;
  /** How full the agent's context window is, shown as a ring beside Send. */
  contextUsage?: ContextUsage;
  /** The Chat is saved: `/undo` is offered, and sending it opens Undo changes instead of reaching the agent. */
  canUndo?: boolean;
  /** The idle field's prompt in place of the default, e.g. a Chat without a Project's. */
  placeholder?: string;
}

const NO_HISTORY: string[] = [];

const DICTATION_LABELS = {
  idle: "Dictate",
  preparing: "Cancel dictation",
  recording: "Stop dictation",
  transcribing: "Transcribing",
} as const;

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
  reconnectingName,
  imageDraft,
  projectPath,
  draft,
  onDraftChange,
  history = NO_HISTORY,
  onSend,
  onStop,
  sendBlocked,
  running = false,
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
  permissionLocked = false,
  alwaysExpanded = false,
  contextUsage,
  canUndo = false,
  placeholder,
}: PromptComposerProps) {
  const mentions = useChatMentions();
  const [dismissed, setDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  // Bumped each time Ultracode turns on; the Fatality overlay plays once per bump (Settings › Experimental).
  const [fatality, setFatality] = useState(0);
  const { ultracodeFatality, appearance, dictationAction, showContextSize, compactButtonDisplay } = useSettings();
  const { settings: contextSettings } = useContextSettings();
  const quiet = contextSettings.autoCompact && Boolean(onCompact);
  const compactButton = compactButtonState(compactButtonDisplay, contextUsage, Boolean(onCompact), contextSettings.buttonThreshold, quiet);
  const compactLabel = compacting ? "Compacting…" : compactQueued ? "Queued for after turn" : running ? "Compact after turn" : "Compact";
  const compactBlocked = compacting ? "Compacting context." : sendBlocked ? "Not available right now." : null;
  const chatSize = appearance.chatSize;
  const effortLevels = capability.efforts;
  const effortIndex = Math.max(0, effortLevels.indexOf(effort ?? ""));
  const effortName = effort ? effortCopy(effort).name : "";
  // Ultracode (Claude) and Codex's ultra level both hand work to parallel agents: they share Ultracode's purple.
  // With Ultracode on, the composer itself turns purple. It only counts for a model that has it.
  const ultracodeOn = capability.ultracode && ultracode;
  const orchestrating = ultracodeOn || effort === "ultra";
  const effortLabel = ultracodeOn ? "Ultra" : effortName;
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
  const imageCount = imageDraft.images.length;
  const parts = useMemo(
    () =>
      promptParts(draft, {
        skills: skillKey ? skillKey.split("\n") : [],
        files: (path) => known.has(path),
        images: imageCount,
        chats: (id) => mentions.chats.some((chat) => chat.id === id && chat.available),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `known` is a Set that grows in place; `knownVersion` counts its growth.
    [draft, skillKey, known, knownVersion, imageCount, mentions.chats],
  );
  // The @ menu searched the mention being typed: an exact match is a file too.
  const typedFound = typing !== null && fileSearch.files.includes(typing) ? typing : null;
  useEffect(() => {
    if (typedFound) markKnown(typedFound);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `markKnown` is rebuilt each render.
  }, [typedFound, projectPath]);
  // A chip is its file's only representation: the file is attached while the chip is in the draft (no tile), deleting
  // the chip detaches it, and undoing that attaches it again. Files attached by paste or + are never detached here.
  const mentionAttached = useRef(new Set<string>());
  const mentionScope = useRef(imageDraft.scope);
  const chipKey = [...new Set(parts.flatMap((part) => (part.kind === "file" ? [fileMentionPath(projectPath, part.path) ?? ""] : [])).filter(Boolean))].join(
    "\n",
  );
  const chipPaths = useMemo(() => (chipKey ? chipKey.split("\n") : []), [chipKey]);
  useEffect(() => {
    // Another Chat's attachments: what this composer attached for the last one is gone with them.
    if (mentionScope.current !== imageDraft.scope) {
      mentionScope.current = imageDraft.scope;
      mentionAttached.current.clear();
    }
    // A copy: removing a file can update the attachment draft.
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
  const inputTextClass = expanded
    ? "min-h-[68px] px-2 py-2 text-[length:calc(var(--chat-size)+1px)] leading-5"
    : "min-h-7 px-1 py-[5px] text-[length:var(--chat-size)] leading-[18px]";
  const rows: MenuRow[] =
    menu === "at"
      ? plusOpen
        ? SOURCES
        : [
            ...fileSearch.files
              .slice(0, matchingMentionChats(mentions.chats, tokenQuery, mentions.currentId).length ? 3 : undefined)
              .map((path) => ({ key: `file:${path}`, name: path.split("/").at(-1) || path, desc: path, path, group: "Files" })),
            ...matchingMentionChats(mentions.chats, tokenQuery, mentions.currentId).map((chat) => ({
              key: `chat:${chat.id}`,
              name: chat.title,
              desc: chat.branch,
              chatId: chat.id,
              group: "Chats",
            })),
          ]
      : menu === "slash"
        ? rankSkillMatches(commands, tokenQuery, (command) => ({ name: command.name, description: command.desc }))
        : [];
  const providerNotice = cliNotice(cliStatus?.[provider]);
  const providerTabs = pickerProviders(cliStatus, selectedModel.provider, provider);
  const modelRows = models.filter((model) => model.provider === provider && `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  const canStop = !offlineName && running && Boolean(onStop);
  const canSend = draft.trim().length > 0 || imageDraft.images.length > 0 || imageDraft.files.length > 0;
  const visibleSuggestion =
    suggestion &&
    !draft &&
    !running &&
    !sendBlocked &&
    !offlineName &&
    selectedModel.provider === "claude" &&
    !imageDraft.images.length &&
    !imageDraft.files.length &&
    !imageDraft.loading &&
    !menu &&
    !modelOpen &&
    !permissionOpen
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
  }, [draft, expanded, selectedModel.name, effortLabel, fastMode, alwaysExpanded, chatSize, showContextSize, compactButton.visible]);

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
    // Every chip's file goes with the message, even one whose attachment the effect hasn't caught up with yet; the
    // parent's send reads its attachments from its render, so commit them first and send from the new render.
    const missing = chipPaths.filter((path) => !imageDraft.files.includes(path));
    if (missing.length) {
      flushSync(() => {
        for (const path of missing) {
          mentionAttached.current.add(path);
          imageDraft.attachPath(path);
        }
      });
      onSendLatest.current();
      return;
    }
    onSend();
  }

  // The picker stays open after a pick: effort, fast mode and Ultracode sit beside the models.
  function chooseModel(model: ModelOption) {
    onModelChange(model);
    setProvider(model.provider);
  }

  const draftLatest = useRef(draft);
  draftLatest.current = draft;
  const dictatedSend = useRef<{ value: string; scope: string } | null>(null);
  // Wait for the parent's updated draft and attachments before using its ordinary send action.
  useEffect(() => {
    const pending = dictatedSend.current;
    if (!pending) return;
    dictatedSend.current = null;
    if (pending.scope !== imageDraft.scope || pending.value !== draft || dictationAction !== "send") return;
    if (canSend && !sendBlocked && !imageDraft.loading && !offlineName) send();
  });

  // The take's words live in the field itself, rewritten in place as the recognizer revises them.
  const take = useRef<DictationTake | null>(null);
  const [provisional, setProvisional] = useState<TextRange | null>(null);
  const write = (text: string, settled: number) => {
    const current = take.current;
    if (!current) return null;
    const written = writeTake(current, draftLatest.current, text, settled);
    if (!written) return null;
    take.current = written.take;
    setProvisional(provisionalRange(written.take));
    setCaret(written.caret);
    onDraftChange(written.value);
    inputRef.current?.setSelection(written.caret);
    return written;
  };
  const writeLatest = useRef(write);
  writeLatest.current = write;

  const dictation = useDictation(projectPath, imageDraft.scope, (text, anchor) => {
    // The last words settle in place: the tint goes, nothing moves. A take that never opened lands at its anchor.
    take.current ??= startTake(draftLatest.current, anchor.selection);
    const written = writeLatest.current(text, text.length);
    take.current = null;
    setProvisional(null);
    if (written && dictationAction === "send") dictatedSend.current = { value: written.value, scope: imageDraft.scope };
  });
  const partialText = dictation.partial.text;
  const partialSettled = dictation.partial.settled;
  useEffect(() => {
    if (take.current && partialText) writeLatest.current(partialText, partialSettled);
  }, [partialText, partialSettled]);
  const discardDictation = () => {
    const current = take.current;
    dictation.cancel();
    take.current = null;
    setProvisional(null);
    if (!current) return;
    const back = revertTake(current, draftLatest.current);
    setCaret(back.selection.start);
    onDraftChange(back.value);
    inputRef.current?.setSelection(back.selection.start, back.selection.end);
  };
  const dictating = dictation.phase !== "idle";
  // A take that ended without delivering (the app lost the microphone, the recognizer failed) leaves no half transcript.
  const discardLatest = useRef(discardDictation);
  discardLatest.current = discardDictation;
  useEffect(() => {
    if (!dictating && take.current) discardLatest.current();
  }, [dictating]);
  const { error: dictationError, dismiss: dismissDictationError } = dictation;
  useEffect(() => {
    // A permission refusal stays until the user acts on it; the other messages clear themselves (and on the next take).
    if (!dictationError || dictationError.kind === "permission") return;
    const timer = setTimeout(dismissDictationError, NOTICE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismissDictationError]);

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

  // Deleting an image's chip from the text removes the image too, and renumbers the chips after it.
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

  function handleRemoveImage(id: string) {
    const index = imageDraft.images.findIndex((image) => image.id === id);
    imageDraft.remove(id);
    if (index >= 0) {
      const next = shiftImageMentions(draftLatest.current, index + 1);
      if (next !== draftLatest.current) onDraftChange(next);
    }
  }

  function handleRemoveFile(path: string) {
    const index = imageDraft.images.findIndex((image) => image.path === path);
    imageDraft.removeFile(path);
    if (index >= 0) {
      const next = shiftImageMentions(draftLatest.current, index + 1);
      if (next !== draftLatest.current) onDraftChange(next);
    }
  }

  function pick(row: MenuRow) {
    const source = SOURCES.find((item) => item.key === row.key);
    if (source?.key === "attach") {
      fileInputRef.current?.click();
    } else if (source?.key === "paste") {
      insertImages(imageDraft.pasteImage());
    } else if (menu === "at") {
      if (token && row.chatId !== undefined) {
        const mention = formatChatMention(row.chatId);
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
    if (visibleSuggestion && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "Tab" || event.key === "ArrowRight")) {
      const selection = inputRef.current?.getSelection();
      if (selection?.start === 0 && selection.end === 0) {
        event.preventDefault();
        onDraftChange(visibleSuggestion);
        inputRef.current?.setSelection(visibleSuggestion.length);
        return;
      }
    }
    if (recall(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // An unaccepted suggestion is never sent. Otherwise the parent checks its live draft, which a render-time
      // `canSend` can trail when Enter follows the edit in the same task.
      if (canSend || !visibleSuggestion) send();
    }
  }

  return (
    <div data-promptbar className="@container w-full" onKeyDown={handleEscape}>
      <div ref={popoverRootRef} className="relative">
        {menu && (
          <div
            data-picker-panel
            onMouseLeave={() => setEngaged(false)}
            className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-[10px] border border-line bg-surface p-1 shadow-raised"
            style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom center" }}
          >
            <ScrollArea className="relative max-h-64" aria-label={menu === "slash" ? "Commands and skills" : plusOpen ? "Sources" : "Project files and Chats"}>
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
                // A search lists its matches best first across the groups, so it carries no group headings.
                const showGroup = (menu === "at" || !tokenQuery) && row.group && row.group !== rows[index - 1]?.group;
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
                <div role="status" className="px-2 text-xs text-red-ink">
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
              {menu === "at" ? "Type to search files and Chats" : skillsLoading ? "Loading skills…" : "Type to search commands & skills"}
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

        {permissionOpen && !permissionLocked && (
          <PickerPanel title="Agent permissions" className="absolute w-[340px]" style={anchorStyle}>
            {PERMISSION_MODES.map((mode) => (
              <PickerRow
                key={mode.id}
                icon={
                  <span className={`flex shrink-0 ${mode.id === "full" ? "text-ink" : mode.id === "auto" ? "text-green-ink" : "text-accent-ink"}`}>
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
            removeImage={handleRemoveImage}
            removeFile={handleRemoveFile}
            uploads={imageDraft.uploads}
            cancelUpload={imageDraft.cancelUpload}
          />
          {imageDraft.loading && !imageDraft.uploads.length && (
            <div role="status" className="px-2 text-xs text-ink-3">
              Loading images…
            </div>
          )}
          {imageDraft.error && (
            <div role="alert" className="px-2 text-xs text-red-ink">
              {imageDraft.error}
            </div>
          )}
          {/* One status slot for the whole take: it never pushes the words around, because it sits above them. */}
          {dictationError ? (
            <div role="alert" data-dictation-status className="flex items-center gap-2 px-2 py-1">
              <span className="flex shrink-0 text-red-ink">
                <Icon icon={AlertCircleIcon} size={14} />
              </span>
              <span className="min-w-0 flex-1 text-12 font-medium text-red-ink">{dictationError.message}</span>
              {dictationError.kind === "permission" ? (
                <button
                  type="button"
                  onClick={dictation.openSettings}
                  className="flex h-7 shrink-0 items-center rounded-control border border-line-strong px-2 text-12 font-semibold text-ink transition-colors hover:bg-hover"
                >
                  Open Settings
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={dismissDictationError}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              )}
            </div>
          ) : dictation.phase === "preparing" || dictation.phase === "transcribing" ? (
            <p role="status" data-dictation-status className="px-2 py-1 text-12 text-ink-2">
              {dictation.phase === "preparing" ? "Preparing the microphone…" : "Finishing the last words…"}
            </p>
          ) : null}
          {dictation.download && (
            <div role="status" data-dictation-download className="px-2 py-1">
              <div className="h-1 w-full overflow-hidden rounded-full bg-line-strong">
                <div
                  className="h-full rounded-full bg-ink transition-[width] duration-200"
                  style={{ width: `${Math.round((dictation.download.received / dictation.download.total) * 100)}%` }}
                />
              </div>
              <p className="pt-1 text-11 text-ink-3">
                Downloading the speech model, once: {Math.round((dictation.download.received / dictation.download.total) * 100)}% of{" "}
                {Math.round(dictation.download.total / 1e6)} MB · the take starts the moment it lands
              </p>
            </div>
          )}

          <div
            className={`grid items-end gap-x-1 gap-y-1.5 ${expanded ? "grid-cols-[28px_auto_minmax(0,1fr)_auto_auto]" : "grid-cols-[28px_minmax(0,1fr)_auto_auto_auto]"} ${compactButton.visible ? "@max-[520px]:grid-cols-[28px_auto_minmax(0,1fr)_auto_auto]" : ""}`}
          >
            <div
              className={`relative min-w-0 w-full ${expanded ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1"} ${compactButton.visible ? "@max-[520px]:col-span-full @max-[520px]:col-start-1 @max-[520px]:row-start-1" : ""}`}
            >
              <PromptEditor
                ref={inputRef}
                resetKey={imageDraft.scope}
                value={draft}
                parts={parts}
                skillDescriptions={skillDescriptions}
                onOpenImage={(index) => setPreviewId(imageDraft.images[index - 1]?.id ?? null)}
                onPaste={(event) => {
                  const selection = inputRef.current?.getSelection() ?? { start: caret, end: caret };
                  const promise = imageDraft.onPaste(event);
                  if (event.defaultPrevented) insertImages(promise, selection);
                }}
                provisional={provisional}
                onSelect={setCaret}
                onChange={(value, position) => {
                  setCaret(position);
                  onDraftChange(dropUnmentionedImages(draftLatest.current, value));
                  setDismissed(false);
                  setPlusOpen(false);
                }}
                onKeyDown={handleKeyDown}
                disabled={false}
                maxHeight={100}
                suggestion={visibleSuggestion}
                placeholder={
                  offlineName
                    ? offlinePlaceholder(offlineName)
                    : (running
                        ? // A provider that can't steer mid-turn takes the message at the start of the next turn.
                          providerCapabilities(provider).steer
                          ? "Steer the agent…"
                          : "Queue a message for the next turn…"
                        : (placeholder ?? "Prompt or mention a file or Chat with @")) + (reconnectingName ? reconnectingPlaceholder(reconnectingName) : "")
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
              className={`col-start-1 ${expanded ? "row-start-2" : "row-start-1"} ${compactButton.visible ? "@max-[520px]:row-start-2" : ""} flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink ${plusOpen ? "bg-hover" : ""}`}
            >
              <Icon icon={Add01Icon} size={16} />
            </button>
            <div
              className={`flex shrink-0 items-center gap-0.5 ${expanded ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1"} ${compactButton.visible ? "@max-[520px]:contents" : ""}`}
            >
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
                className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink ${compactButton.visible ? "@max-[520px]:col-start-2 @max-[520px]:row-start-2" : ""}`}
              >
                <ProviderLogo provider={selectedModel.provider} size={13} />
                <span data-model-name className={`max-w-28 truncate ${compactButton.visible ? "@max-[520px]:max-w-20" : ""}`}>
                  {selectedModel.name}
                </span>
                {effortLabel && (
                  <span
                    data-effort-label
                    className={`flex items-center gap-1 ${orchestrating ? "text-purple-ink" : ""} ${compactButton.visible ? "@max-[520px]:hidden" : ""}`}
                  >
                    <span className="text-ink-3">·</span>
                    <span className="hidden min-[900px]:inline">{effortLabel}</span>
                    <span className="min-[900px]:hidden">
                      <EffortMeter level={effortIndex} total={effortLevels.length} />
                    </span>
                  </span>
                )}
                {canUseFastMode && fastMode && (
                  <span data-fast-mode className="text-orange-ink">
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
              disabled={permissionLocked}
              title={permissionLocked ? PERMISSION_MODE_LABEL[permissionMode] : undefined}
              onClick={(event) => {
                anchorTo(event.currentTarget, 340);
                setPlusOpen(false);
                setModelOpen(false);
                setPermissionOpen((current) => !current);
              }}
              className={`flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium transition-colors hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent ${permissionMode === "full" ? "text-ink" : permissionMode === "auto" ? "text-green-ink" : "text-ink-2"} ${expanded ? "col-start-3 row-start-2 justify-self-start" : "col-start-4 row-start-1"} ${compactButton.visible ? "@max-[520px]:col-start-3 @max-[520px]:row-start-2 @max-[520px]:justify-self-start" : ""}`}
            >
              <Icon icon={SecurityCheckIcon} size={14} />
              <span className={`hidden min-[900px]:inline ${compactButton.visible ? "@max-[520px]:hidden" : ""}`}>{PERMISSION_MODE_LABEL[permissionMode]}</span>
            </button>
            <div
              className={`flex shrink-0 items-center gap-1.5 ${expanded ? "col-start-5 row-start-2" : "col-start-5 row-start-1"} ${compactButton.visible ? "@max-[520px]:row-start-2" : ""}`}
            >
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
              {dictating ? (
                // The mic grew into the capsule, in its own place: discard the take, or stop it. Nothing else moved.
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
                      {/* The halo swells with the voice (--level, 0..1, set each frame by useDictation). */}
                      <span
                        aria-hidden
                        className="absolute inset-0 rounded-full bg-red/25 motion-safe:transition-transform motion-safe:duration-75"
                        style={{ transform: "scale(calc(1 + var(--level, 0) * 0.6))" }}
                      />
                      <span aria-hidden className="relative block size-2.5 rounded-[2px] bg-red" />
                    </button>
                  ) : (
                    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                      <span className="block size-4 rounded-full border-2 border-line border-t-ink-2 border-r-ink-2 motion-safe:animate-spin" />
                    </span>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={DICTATION_LABELS.idle}
                  title={DICTATION_LABELS.idle}
                  onClick={() => {
                    const selection = inputRef.current?.getSelection() ?? { start: caret, end: caret };
                    take.current = startTake(draftLatest.current, selection);
                    setProvisional(null);
                    void dictation.start({ selection });
                  }}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  <Icon icon={Mic01Icon} size={16} />
                </button>
              )}
              <button
                type="button"
                aria-label={canStop ? "Stop agent" : offlineName ? "Queue message" : "Send"}
                disabled={!canStop && (dictating || !canSend || sendBlocked || imageDraft.loading)}
                onClick={canStop ? onStop : send}
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-surface transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-ink-2`}
                style={{
                  background: canStop || (canSend && !sendBlocked && !dictating) ? (ultracodeOn ? "var(--purple)" : "var(--ink)") : "var(--line-strong)",
                }}
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

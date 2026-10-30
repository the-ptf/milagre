import { outbox, outboxAttachments, queueForComputer, hasQueuedChat } from "../lib/outbox";
import { OfflineTray, useOfflineTray } from "./OfflineTray";
import { useDisplayNow } from "../lib/display-clock";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { computerNameOf, offlineBanner, useComputers } from "../lib/computers";
import { archiveLinkChat } from "../lib/archive-flow";
import { shortcutCommand } from "../lib/keybindings";
import { prepareImageUploads, prepareLocalFileUploads } from "../lib/attachment-uploads";
import { PersistenceNotices, type UnsavedScope } from "./PersistenceNotice";
import { CommandPalette } from "./CommandPalette";
import { chatActivity } from "@milagre/shared/chat-activity";
import { useChanges } from "./changes/useChanges";
import { useBranchPullRequests, useLocalChanges, usePullRequest } from "./changes/usePullRequest";
import { usePrReviewActions } from "./changes/usePrReviewActions";
import { PullRequestPanelBody } from "./changes/PullRequestPanel";
import { prRange } from "../lib/pull-request-view";
import { LinkChangesPanel } from "./changes/LinkChangesPanel";
import { sectionOf } from "./changes/ChangesPanel";
import type { DiffList } from "./changes/useDiffFiles";
import { useLinkDiffLists } from "./changes/useLinkDiffLists";
import { ChangesPanelSlot } from "./changes/ChangesPanelSlot";
import { DiffView } from "./changes/DiffView";
import { AttentionButton, ChangesToggle, DiffBar } from "./changes/ChangesChrome";
import { DiffToolbar, useDiffPreferences } from "./changes/DiffPrefs";
import { useDiffComments } from "./changes/useDiffComments";
import { formatCommentsMessage } from "../lib/diff-comments";
import { messageCommands, messageCommandsFrom } from "../lib/message-commands";
import { prefetchChatMessages, useChatMessages } from "../lib/chat-messages";
import { beginChatSwitch } from "../lib/chat-switch-timing";
import { isLean } from "../lib/state-events";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { AgentPorts, LinkState, OpenLink, WorktreeBinding } from "@milagre/shared/model";
import { chatKeyForScope, scopeKey } from "@milagre/shared/chat-scopes";
import { associatedPullRequest } from "@milagre/shared/chats";
import { showNotice } from "../lib/notice";
import { chatTitle, createPendingChat, withPreview, type PendingChat } from "@milagre/shared/chats";
import { sendStatusLabel } from "@milagre/shared/tool-activity";
import { attentionLabel, chatsNeedingAttention, waitingFor } from "@milagre/shared/attention";
import { useHiddenProjects } from "../lib/hidden-projects";
import { useSettings } from "../lib/settings";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { ipcErrorMessage } from "@milagre/shared/result";
import { retryKind, retrySend } from "@milagre/shared/send-retry";
import { DotBackground } from "./DotBackground";
import SidebarNav from "./SidebarNav";
import { runKeys, scopeChats, useScopeStates } from "../lib/sidebar-scopes";
import { DraftChatComposer } from "./DraftChatComposer";
import { useComposerPreferences } from "../lib/use-composer-preferences";
import { effortFor, type ChatMessage, type CoordinatorState, type ModelOption, type ModelProvider } from "../model";
import { createDraftStore, draftKey } from "../lib/draft-store";
import { createScopeDrafts, memberWorktreeForAction } from "../lib/link-scope";
import { usePastedImages } from "./usePastedImages";
import type { useAgentRuns } from "./useAgentRuns";
import { attachmentPrompt } from "../lib/media";
import { sentDecision, sentReply } from "../lib/agent-runs";
import { PermissionCard } from "./agents/PermissionCard";
import { QuestionCard } from "./agents/QuestionCard";
import { getSettings } from "../lib/settings";
import { EditorLinks } from "./editor-links";
import { openInEditor } from "../lib/editors";
import { isModalOpen } from "../lib/modal";
import { GitActionsDialog } from "./GitActionsDialog";
import { gitChatContext } from "../lib/git-dialog";
import { Select } from "./primitives/Select";
import { lazyView } from "../lib/lazy-view";
import type { LinkedWork } from "@milagre/shared/model";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { CORNER_PITCH, PanelToggles, sidePanelCount, useSidePanels } from "./agents/PanelToggles";
import { queueControls } from "./QueuedMessages";
import { BridgeContext, ScopeContext, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { busyTerminals, newTerminal, useTerminalSync, type TerminalPlace } from "../lib/terminal-actions";
const CanvasView = lazyView(() => import("./CanvasView").then((module) => module.CanvasView));
const CANVAS_STATES = {};

type Preferences = Pick<
  ComponentProps<typeof DraftChatComposer>,
  "models" | "selectedModel" | "cliStatus" | "onModelPickerOpen" | "onUpdateCli" | "updatingCli" | "capability"
> & {
  /** A pick, kept by the open chat (its key), or the default for new chats when none is open. */
  onModelChange: (model: ModelOption, chatId: string | null) => void;
  /** The model a chat's picker shows: its own pick, else its last turn's, on its provider. */
  modelForChat: (chatId: string, provider: ModelProvider | undefined, messages: ChatMessage[]) => ModelOption;
  /** Shows a model in the picker without counting as a pick. */
  showModel: (model: ModelOption) => void;
};
const NO_MEMBERS: WorktreeBinding[] = [];
const IDLE: DiffList = { state: "idle" };

export function LinkWorkspace({
  opened,
  state,
  agents,
  preferences,
  drafts,
  onSwitchProject,
  onSwitchLink,
  onLinkProject,
  onAddComputer,
  onOpenComputerSettings,
  onEditLink,
  onOpenProject,
  onSettings,
  onOpenAccounts,
  linkedWork,
  onCanvasChat,
  usage,
  initialSessionId,
  openNonce = 0,
  hostConnection,
  saveNotice,
  saveScopes,
  ports,
  onNewChatInScope,
  onNewChat,
  archivingChats,
  onArchiving,
  scopeChatActions,
}: {
  opened: OpenLink;
  state: LinkState;
  agents: ReturnType<typeof useAgentRuns>;
  preferences: Preferences;
  drafts: ReturnType<typeof createScopeDrafts>;
  initialSessionId?: number;
  /** Counts the requests to show `initialSessionId`, so the same Chat asked for again (from a Project's sidebar) is shown again. */
  openNonce?: number;
  hostConnection: { connected: boolean };
  saveNotice?: ReactNode;
  saveScopes: UnsavedScope[];
  ports: AgentPorts;
  onSwitchProject: (path: string) => void;
  onSwitchLink: (id: string) => void;
  onLinkProject: () => void;
  onAddComputer?: () => void;
  onOpenComputerSettings?: (id: string | null) => void;
  onEditLink: (id: string) => void;
  onOpenProject: () => void;
  onSettings: () => void;
  /** Settings > Accounts, from a Chat's usage-limit card. */
  onOpenAccounts: () => void;
  linkedWork: LinkedWork;
  onCanvasChat: (path: string, id: number) => void;
  usage?: ReactNode;
  onNewChatInScope?: (scopeKey: string) => void;
  /** New chat (⌘N, the sidebar's +, the command palette) starts on this Mac's Project; only the Link's own + starts a Link Chat. */
  onNewChat?: (draftText?: string) => void;
  /** Chats with an archive under way, by chat key: their rows are gone from every sidebar until it ends. */
  archivingChats?: ReadonlySet<string>;
  /** A Chat's archive started; its row comes back if `work` fails. */
  onArchiving?: (key: string, work: Promise<unknown>) => void;
  scopeChatActions?: ComponentProps<typeof SidebarNav>["scopeChatActions"];
}) {
  const scope = { kind: "link" as const, linkId: opened.link.id },
    owner = scopeKey(scope);
  const bridge = bridgeForKey(owner);
  const computer = useComputers().computers.find((item) => item.id === computerOfKey(owner));
  const offline = queueForComputer(owner);
  const bannerNow = useDisplayNow(60_000, offline);
  // oxlint-disable-next-line react/use-memo -- one store per Link, made when the Link changes
  const draftStore = useMemo(createDraftStore, [owner]);
  const saved = drafts.read(scope);
  const [sessionId, setSessionId] = useState<number | null>(
    () => initialSessionId ?? (drafts.has(scope) ? saved.sessionId : (Object.values(state.sessions).findLast((session) => !session.archived)?.id ?? null)),
  );
  const [draftId, setDraftId] = useState(0);
  const sendKey = `${owner}#${sessionId ?? `new:${draftId}`}`;
  const session = sessionId == null ? undefined : state.sessions[sessionId];
  const offlineTray = useOfflineTray(owner, sessionId, offline);
  const chatId = session ? chatKeyForScope(scope, session.id) : null;
  // A shared Chat's Terminals start in one of its Worktrees, chosen when it has several.
  const terminalPlaces: TerminalPlace[] | undefined = session?.worktrees.map((member) => ({
    path: member.worktreePath,
    label: member.alias ?? member.projectPath.split(/[\\/]/).findLast(Boolean) ?? member.worktreePath,
  }));
  const run = chatId ? agents.runs[chatId] : undefined;
  // Every project's chats that wait on the user, except in Projects hidden from the sidebar; the Link's own are marked in its sidebar.
  const hiddenProjects = useHiddenProjects();
  const attentionKey = chatsNeedingAttention(agents.runs, "", hiddenProjects).join("\n");
  const sidebarRunKeys = runKeys(agents.runs);
  const attentionChats = useMemo(() => (attentionKey ? attentionKey.split("\n") : []), [attentionKey]);
  const { showAttentionButton, floatingInbox, chatOrder } = useSettings();
  const runMarks = useMemo(
    () => ({
      running: new Set(sidebarRunKeys.running.split("\n").filter(Boolean)),
      waiting: new Set(sidebarRunKeys.waiting.split("\n").filter(Boolean)),
      asking: new Set(sidebarRunKeys.asking.split("\n").filter(Boolean)),
    }),
    [sidebarRunKeys.running, sidebarRunKeys.waiting, sidebarRunKeys.asking],
  );
  const attentionPaths = useMemo(() => [...new Set(attentionChats.map(projectOfKey))], [attentionChats]);
  const { states: attentionStates } = useScopeStates(true, attentionPaths);
  const sidePanels = useSidePanels();
  const attentionItems = attentionChats.map((key) => {
    const other = attentionStates[projectOfKey(key)];
    const chat = other?.sessions[sessionIdFromKey(key)];
    return {
      key,
      title: chat
        ? chatTitle(
            chat,
            other.messages.filter((message) => message.session_id === chat.id),
          )
        : "Chat",
      project: projectOfKey(key).split("/").pop() ?? key,
      asking: !agents.runs[key]?.approvals.length,
      waitingFor: waitingFor(agents.runs[key]),
    };
  });
  // A host that keeps messages by Chat (chat-pages-v1) sends states without them: the open Chat reads its own.
  const lean = isLean(state);
  const chatWindow = useChatMessages(lean ? owner : null, sessionId);
  const messages = useMemo(
    () => (lean ? chatWindow.messages : state.messages.filter((message) => message.session_id === sessionId)),
    [lean, chatWindow.messages, state.messages, sessionId],
  );
  // The message just sent, shown at once while the host prepares the Chat (its Worktrees' checkpoint, the agent
  // starting), as a Project Chat's and the phone's are. `sent`: the host took it, and the agent is starting.
  const [pendingSends, setPendingSends] = useState<(PendingChat & { key: string; sent?: boolean; provider: ModelProvider })[]>([]);
  const pendingSend = pendingSends.findLast((pending) => pending.key === sendKey || (sessionId !== null && pending.targetSessionId === sessionId));
  const pendingHere = pendingSend !== undefined;
  const preparing = Boolean(pendingSend && !pendingSend.sent);
  const sendsInFlight = useRef(new Set<string>());
  const shownMessages = useMemo(() => (pendingHere ? withPreview(messages, pendingSend) : messages), [pendingHere, pendingSend, messages]);
  // The saved copy replaces the preview once this Chat's messages hold it.
  useEffect(() => {
    const id = pendingSend?.message.clientMessageId;
    if (pendingSend?.sent && pendingHere && messages.some((message) => message.clientMessageId === id))
      setPendingSends((current) => current.filter((pending) => pending.message.clientMessageId !== id));
  }, [pendingSend, pendingHere, messages]);
  const remoteCount = lean ? chatWindow.total - chatWindow.messages.length : 0;
  const earlierMessages = useMemo(
    () => (remoteCount > 0 ? { count: remoteCount, load: chatWindow.loadEarlier, loadAll: chatWindow.loadAll } : undefined),
    [remoteCount, chatWindow.loadEarlier, chatWindow.loadAll],
  );
  const chatMessagesOf = (id: number) => (lean ? (id === sessionId ? messages : []) : state.messages.filter((message) => message.session_id === id));
  const composerPrefs = useComposerPreferences(`${owner}#${sessionId ?? "new"}`);
  // As a Project Chat's: Ultracode and Fast only count for a model that has them, so a Codex pick drops a Claude Ultracode.
  const ultracode = Boolean(preferences.capability?.ultracode) && composerPrefs.ultracode;
  const fastMode = Boolean(preferences.capability?.fastMode) && composerPrefs.fastMode;
  const imageDraft = usePastedImages(`${owner}:${sessionId ?? "new"}`, owner, queueForComputer(owner));
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findSignal, setFindSignal] = useState(0);
  const [findSeed, setFindSeed] = useState<string | undefined>();
  // A ⌘K message result picks its chat first; the find bar opens once that chat's messages are on screen.
  const pendingFind = useRef<{ sessionId: number; term: string } | null>(null);
  const [memberId, setMemberId] = useState<string>("");
  const [gitMemberId, setGitMemberId] = useState("");
  const [gitDialog, setGitDialog] = useState<{ sessionId: number; member: WorktreeBinding } | null>(null);
  const [gitChoice, setGitChoice] = useState<number | null>(null);
  const memberDialog = useRef<HTMLDialogElement>(null);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const terminalChatId = canvasOpen || session?.archived ? null : chatId;
  useTerminalSync(terminalChatId);
  const chosen = session?.worktrees.find((member) => member.projectId === memberId);
  // Each Project's Worktree branch can have its own PR: the panel's menu lists them, open ones first.
  const members = session?.worktrees ?? NO_MEMBERS;
  const branchPrs = useBranchPullRequests({ paths: members.map((member) => member.worktreePath), active: Boolean(session), bridge });
  const memberPrs = members
    .flatMap((member) => {
      const pr = branchPrs[member.worktreePath];
      return pr ? [{ member, pr, name: opened.projects.find((project) => project.id === member.projectId)?.name ?? member.projectId }] : [];
    })
    .sort((a, b) => Number(a.pr.state === "MERGED") - Number(b.pr.state === "MERGED"));
  // The PR shown is the chosen Project's; the panel reads it only while it shows it.
  const prEntry = memberPrs.find((entry) => entry.member.projectId === memberId);
  const [prWanted, setPrWanted] = useState(false);
  const prReview = usePullRequest({ cwd: prEntry?.member.worktreePath, number: prEntry?.pr.number, active: prWanted, bridge });
  const [comparisonBases, setComparisonBases] = useState<Record<string, string>>({});
  const changes = useChanges({
    cwd: chosen?.worktreePath,
    base: chosen ? comparisonBases[chosen.worktreePath] || chosen.base : undefined,
    chatId,
    available: Boolean(session),
    pullRequest: prEntry ? { number: prEntry.pr.number, range: prRange(prReview.pr) } : undefined,
    panelLists: false,
  });
  const prShown = changes.open && changes.mode === "pr" && Boolean(prEntry);
  useEffect(() => setPrWanted(prShown), [prShown]);
  const prLocal = useLocalChanges({ cwd: prEntry?.member.worktreePath, active: prShown, bridge });
  // The Changes tab lists every member's uncommitted and committed files; the diff shows the picked file's section.
  const linkMode = changes.mode === "uncommitted" ? "uncommitted" : "committed";
  const comparisonMembers = (session?.worktrees ?? []).map((member) => ({ ...member, base: comparisonBases[member.worktreePath] || member.base }));
  const uncommittedLists = useLinkDiffLists({ members: session?.worktrees ?? [], chatId, mode: "uncommitted", active: changes.open });
  const committedLists = useLinkDiffLists({ members: comparisonMembers, chatId, mode: "committed", active: changes.open });
  const diffPrefs = useDiffPreferences();
  const comments = useDiffComments(chosen && chatId ? `${chatId}:${chosen.projectId}` : null, changes);
  useEffect(() => {
    if (gitChoice !== null) memberDialog.current?.showModal();
  }, [gitChoice]);
  const latest = useRef({ sessionId, text: "", active: true, selection: 0 });
  latest.current.sessionId = sessionId;
  useEffect(() => {
    latest.current.active = true;
    // The text saved when this Link was last left belongs to the Chat that was open then.
    draftStore.select(draftKey(owner, saved.sessionId));
    draftStore.set(saved.text);
    draftStore.select(draftKey(owner, latest.current.sessionId));
    const unsubscribe = draftStore.subscribe(() => {
      latest.current.text = draftStore.get();
    });
    return () => {
      latest.current.active = false;
      drafts.save(scope, { text: draftStore.get(), sessionId: latest.current.sessionId });
      unsubscribe();
    };
  }, [owner]);
  // Each Chat keeps its own draft; a send clears the one it came from before the selection moves on.
  useLayoutEffect(() => draftStore.select(draftKey(owner, sessionId)), [draftStore, sessionId]);
  const imageDraftRef = useRef(imageDraft);
  imageDraftRef.current = imageDraft;
  useEffect(
    () =>
      drafts.subscribe(scope, (ack) => {
        if (
          latest.current.active &&
          drafts.identity(scope) === ack.identity &&
          latest.current.sessionId === ack.previousSessionId &&
          draftStore.get().trim() === ack.body
        ) {
          latest.current.selection++;
          setSessionId(ack.sessionId);
          draftStore.set("");
          imageDraftRef.current.clear();
        }
      }),
    [owner],
  );
  useEffect(() => {
    void bridge.setOpenChat(chatId).catch((error) => setError(ipcErrorMessage(error)));
  }, [chatId]);
  useEffect(() => {
    if (initialSessionId !== undefined) {
      latest.current.selection++;
      drafts.newSelection(scope);
      setSessionId(initialSessionId);
      if (initialSessionId === null) setDraftId((id) => id + 1);
    }
  }, [initialSessionId, openNonce]);
  const { modelForChat: _modelForChat, showModel: _showModel, onModelChange: _onModelChange, ...composerModels } = preferences;
  // The picker follows the open chat, as a Project's does: its own pick, else its last turn's model.
  useEffect(() => {
    if (!chatId) return;
    const model = preferences.modelForChat(chatId, session?.provider, messages);
    if (model.id !== preferences.selectedModel.id) preferences.showModel(model);
  }, [chatId, session?.provider, messages, preferences.models]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      if (canvasOpen && event.key === "Escape") {
        event.preventDefault();
        setCanvasOpen(false);
        return;
      }
      const command = shortcutCommand(event);
      if (canvasOpen && (command === "changes.toggle" || command === "chat.find")) return;
      if (command === "changes.toggle" && session) {
        event.preventDefault();
        changes.toggle();
        return;
      }
      if (command === "chat.new") {
        event.preventDefault();
        if (onNewChat) onNewChat();
        else {
          // oxlint-disable-next-line react/immutability -- pick is a function declaration, called from the key handler later
          pick(null);
          document.querySelector<HTMLElement>("[data-prompt-editor]")?.focus();
        }
      }
      if (command === "commandPalette.toggle") {
        event.preventDefault();
        setCommandsOpen(true);
      }
      if (command === "terminal.new" && terminalChatId) {
        event.preventDefault();
        newTerminal(terminalChatId, terminalPlaces, setError);
      }
      if (command === "chat.find") {
        event.preventDefault();
        setFindSeed(undefined);
        setFindOpen(true);
        setFindSignal((value) => value + 1);
      }
      if (event.key !== "Escape") return;
      if (findOpen) {
        event.preventDefault();
        setFindOpen(false);
        return;
      }
      if (!chatId || !run) return;
      event.preventDefault();
      const approval = run.approvals[0],
        question = run.questions[0];
      if (approval && !run.answered[approval.requestId]) void agents.respond(chatId, approval.requestId, "deny");
      else if (question && !run.answered[question.requestId])
        void agents.answerQuestion(chatId, question.requestId, null).catch((failure) => setError(ipcErrorMessage(failure)));
      else void agents.interrupt(chatId);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [chatId, run, findOpen, session, changes.toggle, canvasOpen, terminalChatId, onNewChat]);
  function pick(id: number | null) {
    // Another Chat: its page read goes out before this pick renders anything, and the switch is measured from here.
    if (id !== null && Number.isSafeInteger(id) && id > 0 && id !== sessionId) {
      if (lean) prefetchChatMessages(owner, id);
      beginChatSwitch(chatKeyForScope(scope, id));
    }
    latest.current.selection++;
    drafts.newSelection(scope);
    setCanvasOpen(false);
    setSessionId(id);
    if (id === null) setDraftId((id) => id + 1);
    imageDraft.clear();
    setError(null);
    setMemberId("");
    changes.closeDiff();
    setFindOpen(false);
  }
  useEffect(() => {
    const settings = getSettings();
    void window.milagre
      .syncNotifications({
        projectPath: owner,
        activeChatId: chatId,
        unread: Object.values(state.sessions)
          .filter((session) => session.unread && !session.archived)
          .map((session) => chatKeyForScope(scope, session.id)),
        notifyOnCompletion: settings.notifyOnCompletion,
        showDockBadge: settings.showDockBadge,
      })
      .catch(() => {});
  }, [owner, chatId, state.sessions]);
  // `attach` false sends the body alone, as design feedback does: the composer's images and files stay for later.
  async function send(body = draftStore.get().trim(), preserve = false, attach = true) {
    const images = attach ? imageDraft.images : [];
    const files = attach ? imageDraft.files : [];
    if (preparing || sendsInFlight.current.has(sendKey) || imageDraft.loading || (!body && !images.length && !files.length)) return false;
    const selection = latest.current.selection;
    const operation = drafts.beginSend(scope, sessionId, JSON.stringify({ body, images, files }));
    sendsInFlight.current.add(sendKey);
    setError(null);
    // The picker decides the provider: a chat on another one hands off to it.
    const model = preferences.selectedModel;
    if (!outbox.getSnapshot().loaded) await outbox.ready.catch(() => {});
    if (queueForComputer(owner) || hasQueuedChat(owner, sessionId)) {
      try {
        const id = crypto.randomUUID();
        await outbox.enqueue({
          id,
          computerId: computerOfKey(owner),
          computerName: computerNameOf(computerOfKey(owner)),
          owner,
          conversation: sessionId == null ? id : `chat:${sessionId}`,
          link: { linkId: opened.link.id, operationId: operation },
          request: {
            projectPath: owner,
            sessionId,
            worktreeId: 0,
            body,
            images: [],
            files: [],
            prompt: body,
            provider: model.provider,
            model: model.id,
            permissionMode: composerPrefs.permissionMode,
            effort: preferences.capability ? effortFor(preferences.capability, composerPrefs.effort) : composerPrefs.effort,
            ultracode,
            fastMode,
            replies: getSettings().claudeReplies,
            tldrEnabled: getSettings().tldrEnabled,
          },
          attachments: await outboxAttachments(images, files, imageDraft.localFiles),
        });
        if (!preserve && latest.current.active && latest.current.selection === selection) {
          if (draftStore.get().trim() === body) draftStore.set("");
          for (const image of images) imageDraft.remove(image.id);
          for (const file of files) imageDraft.removeFile(file);
        }
        void outbox.flush().catch(() => {});
        return true;
      } catch (error) {
        setError(ipcErrorMessage(error));
        return false;
      } finally {
        sendsInFlight.current.delete(sendKey);
      }
    }
    // A Link's state has no Worktrees (its Chats own theirs); the preview reads only its sessions and messages.
    const preview = createPendingChat({
      state: state as unknown as CoordinatorState,
      worktreeId: 0,
      sessionId,
      body,
      images,
      files,
      model: model.id,
      provider: model.provider,
    });
    const previewId = preview.message.clientMessageId;
    setPendingSends((current) => [...current, { ...preview, key: sendKey, provider: model.provider }]);
    // The message shows in the Chat now, so it leaves the composer now; a failed send puts it back.
    const clears = !preserve && draftStore.get().trim() === body;
    if (clears) {
      draftStore.set("");
      imageDraft.clear();
    }
    try {
      const uploadedFiles = await prepareLocalFileUploads(owner, files, images, imageDraft.localFiles);
      const request = {
        linkId: opened.link.id,
        sessionId,
        operationId: operation,
        clientMessageId: previewId,
        body,
        prompt: attachmentPrompt(body, uploadedFiles),
        images: await prepareImageUploads(owner, images),
        files: uploadedFiles,
        provider: model.provider,
        model: model.id,
        permissionMode: composerPrefs.permissionMode,
        effort: preferences.capability ? effortFor(preferences.capability, composerPrefs.effort) : composerPrefs.effort,
        ultracode,
        fastMode,
        replies: getSettings().claudeReplies,
        tldrEnabled: getSettings().tldrEnabled,
      };
      const sent = await retrySend(() => bridge.sendLinkMessage(request), { retryable: (error) => retryKind(error) !== null });
      drafts.acknowledgeSend(operation, sent.sessionId);
      setPendingSends((current) =>
        current.map((pending) =>
          pending.message.clientMessageId === previewId
            ? { ...pending, sent: true, targetSessionId: sent.sessionId, acceptedSessionId: sent.sessionId }
            : pending,
        ),
      );
      if (latest.current.active && latest.current.selection === selection) {
        setSessionId(sent.sessionId);
      }
      return true;
    } catch (error) {
      setPendingSends((current) => current.filter((pending) => pending.message.clientMessageId !== previewId));
      if (latest.current.active && latest.current.selection === selection) {
        if (clears) {
          const remapped = imageDraft.restore(images, files, draftStore.get());
          draftStore.set([body, remapped].filter(Boolean).join("\n\n"));
        }
        setError(ipcErrorMessage(error));
      }
      return false;
    } finally {
      sendsInFlight.current.delete(sendKey);
    }
  }
  useEffect(() => {
    const pending = pendingFind.current;
    if (!pending || sessionId !== pending.sessionId || !messages.length) return;
    pendingFind.current = null;
    setFindSeed(pending.term);
    setFindOpen(true);
    setFindSignal((value) => value + 1);
  }, [sessionId, messages.length]);
  function openMessage(id: number, term: string) {
    pendingFind.current = { sessionId: id, term };
    if (id === sessionId) {
      // The chat is already open, so the effect above won't run on its own.
      setFindSeed(term);
      setFindOpen(true);
      setFindSignal((value) => value + 1);
      pendingFind.current = null;
    } else pick(id);
  }
  // The same rows the sidebar builds for this Link while a Project is open: its Chat order, pins and times, so the
  // one-list sidebar keeps every row where it was when the window switches between the Link and a Project.
  const recents = scopeChats(owner, state, chatOrder, runMarks).filter((row) => !archivingChats?.has(chatKeyForScope(scope, Number(row.id))));
  const approval = run?.approvals[0],
    question = approval ? undefined : run?.questions[0];
  async function refreshChanges() {
    if (prShown) prLocal.refresh();
    await Promise.all([uncommittedLists.refresh(), committedLists.refresh(), ...(chosen ? [changes.refresh()] : []), ...(prShown ? [prReview.refresh()] : [])]);
  }
  const prActions = usePrReviewActions({
    review: prReview,
    changes,
    send: (text) => void send(text, true, false),
  });
  const pickPr = (projectId: string) => {
    setMemberId(projectId);
    changes.setMode("pr");
  };
  /** The Changes button: the panel opens on the Link Chat's first PR when one of its Projects has one. */
  const toggleChanges = () => {
    if (!changes.open && memberPrs[0]) pickPr(memberPrs[0].member.projectId);
    changes.toggle();
  };
  async function sendComments() {
    const entries = comments.sendable;
    if (!entries.length) return;
    changes.closeDiff();
    const body = formatCommentsMessage(entries, { mode: linkMode, base: chosen?.base });
    if (await send(`Project ${chosen?.projectId}:\n${body}`, true)) comments.removeMany(entries.map((entry) => entry.id));
  }
  const root = session?.workspacePath ?? "";
  const gitSession = gitDialog ? state.sessions[gitDialog.sessionId] : undefined;
  const gitDialogTitle = gitSession ? chatTitle(gitSession, chatMessagesOf(gitSession.id)) : "Chat";
  return (
    <BridgeContext.Provider value={bridge}>
      <ScopeContext.Provider value={owner}>
        <DotBackground>
          <PersistenceNotices scopes={saveScopes.filter((entry) => entry.scope !== owner || canvasOpen || changes.diffOpen)}>
            {!hostConnection.connected && (
              <div
                role="status"
                data-host-disconnected
                className="w-full rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink shadow-overlay [-webkit-app-region:no-drag]"
              >
                <p>Reconnecting to your computer</p>
                <p className="mt-1 text-ink-2">Your draft is kept here. Messages will be available when the host reconnects.</p>
              </div>
            )}
          </PersistenceNotices>
          <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink">
            <div className="flex min-h-0 shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">
              <SidebarNav
                scopeChatActions={scopeChatActions}
                fill
                attentionPaths={attentionPaths}
                workspaceName={opened.link.name}
                selectedLink={{ id: opened.link.id, projects: opened.projects }}
                onSwitchLink={onSwitchLink}
                onLinkProject={onLinkProject}
                onAddComputer={onAddComputer}
                onOpenComputerSettings={onOpenComputerSettings}
                onEditLink={onEditLink}
                onSwitchProject={onSwitchProject}
                onOpenProject={onOpenProject}
                onOpenCommands={() => setCommandsOpen(true)}
                onOpenSettings={onSettings}
                canvasActive={canvasOpen}
                onOpenCanvas={() => {
                  changes.closeDiff();
                  setCanvasOpen(true);
                }}
                onNewChat={onNewChat ? () => onNewChat() : () => pick(null)}
                onNewCurrentScopeChat={() => pick(null)}
                onPick={(id) => pick(Number(id))}
                activeId={sessionId == null ? null : String(sessionId)}
                recents={recents}
                usage={usage}
                runningKeys={sidebarRunKeys.running}
                waitingKeys={sidebarRunKeys.waiting}
                askingKeys={sidebarRunKeys.asking}
                onOpenScopeChat={(key, id) => onCanvasChat(key, Number(id))}
                onNewChatInScope={onNewChatInScope}
                chatActions={{
                  onRename: (id, title) => void bridge.patchChat(owner, Number(id), { title }).catch((error) => setError(ipcErrorMessage(error))),
                  onMarkUnread: (id, unread) => void bridge.patchChat(owner, Number(id), { unread }),
                  onReload: (id) =>
                    void bridge
                      .reloadChat(chatKeyForScope(scope, Number(id)))
                      .then(() => showNotice("Chat reloaded. Your next message starts a fresh agent."))
                      .catch((error) => setError(ipcErrorMessage(error))),
                  remote: isRemoteKey(owner),
                  onReveal: isRemoteKey(owner)
                    ? undefined
                    : (id) => {
                        const target = state.sessions[id];
                        if (target) void window.milagre.revealInFolder(target.workspacePath);
                      },
                  onOpenInEditor: isRemoteKey(owner)
                    ? undefined
                    : (id) => {
                        const target = state.sessions[id];
                        if (target) void openInEditor(target.workspacePath);
                      },
                  onCommit: (id) => {
                    setGitChoice(Number(id));
                    setGitMemberId("");
                  },
                  // A shared Chat keeps its Worktrees when archived; only its Terminals would end.
                  onArchiveCheck: async (id) => ({
                    milagreOwned: false,
                    shared: false,
                    status: null,
                    terminals: await busyTerminals(chatKeyForScope(scope, Number(id))),
                  }),
                  // As a Project's archive: the row goes and the window leaves the Chat at once, without waiting on the
                  // host; a Chat whose archive fails comes back with the error.
                  onArchive: (id) => {
                    const chat = Number(id);
                    const key = chatKeyForScope(scope, chat);
                    const work = archiveLinkChat({
                      running: Boolean(agents.runs[key]),
                      stop: () => agents.interrupt(key),
                      hide: () => bridge.deleteChat(owner, chat),
                    });
                    onArchiving?.(key, work);
                    void work.catch((error) => setError(ipcErrorMessage(error)));
                    // The open Chat went: the new-chat screen takes its place, on this Mac as New chat opens it.
                    if (sessionId === chat) {
                      if (onNewChat) onNewChat();
                      else pick(null);
                    }
                    return Promise.resolve();
                  },
                }}
              />
            </div>
            <main data-chat-pane className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
              {canvasOpen ? (
                <CanvasView
                  states={CANVAS_STATES}
                  runs={agents.runs}
                  linkedWork={linkedWork}
                  focusLink={opened.link}
                  onBack={() => setCanvasOpen(false)}
                  onOpenChat={(path, id) => {
                    if (path === owner && id === sessionId) setCanvasOpen(false);
                    else if (path === owner) pick(id);
                    else onCanvasChat(path, id);
                  }}
                />
              ) : (
                <>
                  {error && session && (
                    <p
                      role="alert"
                      className="absolute inset-x-5 top-14 z-30 rounded-control border border-line bg-surface px-3 py-2 text-[13px] text-red-ink shadow-overlay"
                    >
                      {error}
                    </p>
                  )}

                  <DiffBar
                    open={changes.diffOpen}
                    onBack={changes.closeDiff}
                    send={{ count: comments.sendable.length, onSend: () => void sendComments() }}
                    trailing={<DiffToolbar changes={{ ...changes, refresh: refreshChanges }} prefs={diffPrefs} />}
                  />
                  {changes.diffOpen && (
                    <DiffView
                      key={`${chatId}:${memberId}:${changes.mode}`}
                      changes={changes}
                      prefs={diffPrefs}
                      comments={comments}
                      review={prActions.diffReview}
                    />
                  )}
                  <div className={`min-h-0 flex-1 flex-col overflow-hidden ${changes.diffOpen ? "hidden" : "flex"}`}>
                    <EditorLinks root={root}>
                      <DraftChatComposer
                        saveNotice={saveNotice}
                        {...composerModels}
                        onModelChange={(model) => preferences.onModelChange(model, chatId)}
                        effort={preferences.capability ? effortFor(preferences.capability, composerPrefs.effort) : composerPrefs.effort}
                        onEffortChange={composerPrefs.setEffort}
                        ultracode={ultracode}
                        onUltracodeChange={composerPrefs.setUltracode}
                        fastMode={composerPrefs.fastMode}
                        onFastModeChange={composerPrefs.setFastMode}
                        permissionMode={composerPrefs.permissionMode}
                        scopeKind="link"
                        onOpenAccounts={onOpenAccounts}
                        store={draftStore}
                        projectPath={root}
                        messageScope={owner}
                        onOpenPullRequestLink={(url) => {
                          const entry = associatedPullRequest(
                            url,
                            memberPrs.map((entry) => ({ ...entry, url: entry.pr.url })),
                          );
                          if (!entry) return false;
                          pickPr(entry.member.projectId);
                          if (!changes.open) changes.toggle();
                          return true;
                        }}
                        earlier={earlierMessages}
                        messages={shownMessages}
                        pendingMessageId={pendingHere ? pendingSend.message.id : undefined}
                        loading={lean && chatWindow.loading && !shownMessages.length && session !== undefined}
                        loadError={lean ? chatWindow.error : undefined}
                        onRetryLoad={() => void chatWindow.retry()}
                        imageDraft={imageDraft}
                        onSend={() => void send()}
                        onSendDesignMessage={(text) => send(text, true, false)}
                        onStop={chatId && run ? () => void agents.interrupt(chatId) : undefined}
                        isSending={Boolean(run && !approval && !question) || (pendingHere && !run)}
                        sendBlocked={preparing}
                        offlineName={offline ? computerNameOf(computerOfKey(owner)) : null}
                        offlineTray={
                          offlineTray.shown ? (
                            <OfflineTray
                              owner={owner}
                              sessionId={sessionId}
                              computerName={computerNameOf(computerOfKey(owner))}
                              offline={offline}
                              detail={computer ? offlineBanner(computer, bannerNow) : undefined}
                            />
                          ) : undefined
                        }
                        streamingText={run?.text}
                        streamingSteps={run?.steps}
                        runStartedAt={run?.startedAt ?? (pendingHere ? pendingSend.startedAt : undefined)}
                        statusLabel={pendingHere && !run ? sendStatusLabel({ sent: pendingSend.sent, provider: pendingSend.provider }) : undefined}
                        runModelName={run?.model}
                        sessionProvider={session?.provider}
                        plan={session?.plan}
                        contextUsage={run?.contextUsage ?? session?.contextUsage}
                        suggestion={session?.provider === "claude" ? session.suggestion?.text : undefined}
                        subagents={session?.subagents?.filter((agent) => agent.id !== session.native_session_id)}
                        backgroundTasks={session?.backgroundTasks}
                        ports={chatId ? ports[chatId] : undefined}
                        agentChatId={chatId ?? undefined}
                        onOpenDiff={(path, worktree) => {
                          const member = session?.worktrees.find((item) => item.worktreePath === worktree);
                          if (member) setMemberId(member.projectId);
                          if (!changes.open) changes.toggle();
                          const id = member?.projectId ?? memberId;
                          changes.selectFile(
                            path,
                            sectionOf({ uncommitted: uncommittedLists.lists[id] ?? IDLE, committed: committedLists.lists[id] ?? IDLE }, path),
                          );
                        }}
                        waitingForSubagents={run?.waitingForSubagents}
                        activity={session ? chatActivity(session, run) : undefined}
                        asking={Boolean(question)}
                        waitingStepIds={run?.approvals.flatMap((request) => (request.stepId ? [request.stepId] : []))}
                        resume={
                          session?.resumeTurn
                            ? { onContinue: () => void bridge.resumeChat(owner, session.id).catch((error) => setError(ipcErrorMessage(error))) }
                            : undefined
                        }
                        queue={chatId ? queueControls(bridge, chatId, session, Boolean(run), setError) : undefined}
                        onStopAdvisor={(id) => {
                          if (chatId) void bridge.stopAdvisor(chatId, id).catch((error) => setError(ipcErrorMessage(error)));
                        }}
                        onRetryAdvisor={(id) => {
                          if (chatId) void bridge.retryAdvisor(chatId, id).catch((error) => setError(ipcErrorMessage(error)));
                        }}
                        onArchiveSubagent={(id, archived) => {
                          if (session) void bridge.archiveSubagent(owner, session.id, id, archived).catch((error) => setError(ipcErrorMessage(error)));
                        }}
                        onArchiveFinishedSubagents={() => {
                          if (session) void bridge.archiveFinishedSubagents(owner, session.id).catch((error) => setError(ipcErrorMessage(error)));
                        }}
                        onPermissionModeChange={(mode) => {
                          composerPrefs.setPermissionMode(mode);
                          if (chatId) void bridge.setAgentPermissionMode(chatId, mode).catch((failure) => setError(ipcErrorMessage(failure)));
                        }}
                        onRecommendationSelect={(option) => void send(option)}
                        worktrees={[]}
                        onWorktreeChange={() => {}}
                        isolation="worktree"
                        onIsolationChange={() => {}}
                        branches={[]}
                        baseBranch=""
                        onBaseBranchChange={() => {}}
                        newChatError={error}
                        findOpen={findOpen}
                        findSignal={findSignal}
                        findSeed={findSeed}
                        onFindClose={() => setFindOpen(false)}
                        approval={
                          approval && chatId ? (
                            <PermissionCard
                              request={approval}
                              waiting={(run?.approvals.length ?? 1) - 1}
                              answering={sentDecision(run, approval.requestId)}
                              onAnswer={(decision) =>
                                void agents.respond(chatId, approval.requestId, decision).catch((failure) => setError(ipcErrorMessage(failure)))
                              }
                            />
                          ) : question && chatId ? (
                            <QuestionCard
                              request={question}
                              waiting={(run?.questions.length ?? 1) - 1}
                              answering={sentReply(run, question.requestId)}
                              onAnswer={(answer) =>
                                void agents.answerQuestion(chatId, question.requestId, answer).catch((failure) => setError(ipcErrorMessage(failure)))
                              }
                            />
                          ) : undefined
                        }
                      />
                    </EditorLinks>
                    <TerminalPanel chatId={terminalChatId} places={terminalPlaces} notify={setError} />
                  </div>
                </>
              )}
            </main>
            <ChangesPanelSlot open={!canvasOpen && changes.open}>
              {session && (
                <LinkChangesPanel
                  key={chatId}
                  members={session.worktrees}
                  comparisons={comparisonBases}
                  onComparisonChange={(path, value) => setComparisonBases((previous) => ({ ...previous, [path]: value }))}
                  projects={opened.projects}
                  lists={{ uncommitted: uncommittedLists.lists, committed: committedLists.lists }}
                  loading={uncommittedLists.loading || committedLists.loading}
                  mode={linkMode}
                  onModeChange={changes.setMode}
                  onRefresh={refreshChanges}
                  onSelectFile={(member, path, mode) => {
                    setMemberId(member.projectId);
                    changes.selectFile(path, mode);
                  }}
                  selectedProjectId={memberId}
                  activePath={changes.activePath}
                  commentCounts={comments.counts}
                  onCommit={(member) => setGitDialog({ sessionId: session.id, member: memberWorktreeForAction(state, session.id, member.projectId) })}
                  onOpenEditor={isRemoteKey(owner) ? undefined : (member) => void openInEditor(member.worktreePath)}
                  onReveal={isRemoteKey(owner) ? undefined : (member) => void window.milagre.revealInFolder(member.worktreePath)}
                  pullRequest={
                    memberPrs.length
                      ? {
                          tabs: memberPrs.map(({ member, pr, name }) => ({ key: `pr:${member.projectId}`, number: pr.number, pr, hint: name })),
                          value: prEntry ? `pr:${prEntry.member.projectId}` : undefined,
                          onPick: (value) => pickPr(value.slice(3)),
                          shown: prShown,
                          loading: prReview.state.status === "loading" || prReview.busy !== null,
                          body: (
                            <PullRequestPanelBody
                              review={prReview}
                              source={prEntry ? { bridge: bridge.pr, cwd: prEntry.member.worktreePath } : undefined}
                              actions={prActions.actions}
                              activePath={changes.activePath}
                              local={{ count: prLocal.count, onOpen: () => changes.setMode("uncommitted") }}
                              project={prEntry ? { name: prEntry.name, path: prEntry.member.projectPath } : undefined}
                            />
                          ),
                        }
                      : undefined
                  }
                />
              )}
            </ChangesPanelSlot>
          </div>
          {!canvasOpen && session && <ChangesToggle open={changes.open} onToggle={toggleChanges} />}
          <PanelToggles right={!canvasOpen && session ? 12 + CORNER_PITCH : 12} />
          {showAttentionButton && !floatingInbox && attentionChats[0] && (
            <AttentionButton
              label={attentionLabel(attentionItems.map((item) => item.title))}
              items={attentionItems}
              offset={(!canvasOpen && session ? 1 : 0) + sidePanelCount(sidePanels)}
              onOpen={(key) => onCanvasChat(projectOfKey(key), sessionIdFromKey(key))}
            />
          )}
          {gitChoice !== null && (
            <dialog
              ref={memberDialog}
              aria-label="Choose Project for Git"
              onCancel={() => setGitChoice(null)}
              className="m-auto w-[380px] rounded-card bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
            >
              <div className="p-5" onClick={(event) => event.stopPropagation()}>
                <h2 className="text-[16px] font-semibold">Choose a Project</h2>
                <p className="mt-1 mb-4 text-[13px] text-ink-2">
                  {state.sessions[gitChoice]?.worktrees.length
                    ? "Git actions apply to one Worktree."
                    : "This Chat has no Worktree yet. It creates one when it changes a Project."}
                </p>
                <Select
                  label="Project"
                  value={gitMemberId}
                  onChange={setGitMemberId}
                  options={[
                    { value: "", label: "Choose Project" },
                    ...(state.sessions[gitChoice]?.worktrees ?? []).map((member) => ({
                      value: member.projectId,
                      label: opened.projects.find((project) => project.id === member.projectId)?.name ?? member.projectId,
                      description: member.worktreePath,
                    })),
                  ]}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" className="rounded-control px-3 py-2 text-sm hover:bg-hover-2" onClick={() => setGitChoice(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!gitMemberId}
                    className="rounded-control bg-ink px-3 py-2 text-sm text-surface disabled:opacity-40"
                    onClick={() => {
                      setGitDialog({ sessionId: gitChoice, member: memberWorktreeForAction(state, gitChoice, gitMemberId) });
                      setGitChoice(null);
                    }}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </dialog>
          )}
          {commandsOpen && (
            <CommandPalette
              commands={[
                { id: "new", label: "New Chat", group: "Actions", icon: "chat", run: onNewChat ? () => onNewChat() : () => pick(null) },
                { id: "link", label: "Link projects…", group: "Actions", icon: "folder", run: onLinkProject },
                { id: "edit-link", label: "Edit Link…", group: "Actions", icon: "folder", run: () => onEditLink(opened.link.id) },
                ...recents.map((row) => ({ id: row.id, label: row.label, group: "Chats", icon: "chat" as const, run: () => pick(Number(row.id)) })),
                ...opened.projects.map((project) => ({
                  id: project.id,
                  label: project.name,
                  group: "Projects",
                  icon: "folder" as const,
                  run: () => onSwitchProject(project.path),
                })),
              ]}
              searchMessages={
                lean ? undefined : (query) => messageCommands(state.messages, query, new Map(recents.map((row) => [Number(row.id), row.label])), openMessage)
              }
              searchMessagesAsync={
                lean
                  ? async (query) =>
                      messageCommandsFrom(await bridge.searchChats(owner, query), new Map(recents.map((row) => [Number(row.id), row.label])), openMessage)
                  : undefined
              }
              onStartChat={(query) => {
                if (onNewChat) {
                  onNewChat(query);
                  return;
                }
                pick(null);
                // The new Chat's draft takes the search now, before the render that selects it.
                draftStore.select(draftKey(owner, null));
                draftStore.set(query);
              }}
              onClose={() => setCommandsOpen(false)}
              onError={setError}
            />
          )}
          {gitDialog && (
            <GitActionsDialog
              projectName={opened.projects.find((project) => project.id === gitDialog.member.projectId)?.name}
              cwd={gitDialog.member.worktreePath}
              base={gitDialog.member.base}
              provider={gitSession?.provider}
              chat={gitChatContext(gitDialogTitle, chatMessagesOf(gitDialog.sessionId))}
              turnRunning={Boolean(agents.runs[chatKeyForScope(scope, gitDialog.sessionId)])}
              onClose={() => setGitDialog(null)}
              onSendToAgent={(text) => {
                pick(gitDialog.sessionId);
                draftStore.set(text);
              }}
              onRan={(note) => void bridge.addGitNote(chatKeyForScope(scope, gitDialog.sessionId), note)}
            />
          )}
        </DotBackground>
      </ScopeContext.Provider>
    </BridgeContext.Provider>
  );
}

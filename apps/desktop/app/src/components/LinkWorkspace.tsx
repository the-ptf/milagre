import { CommandPalette } from "./CommandPalette";
import { useChanges } from "./changes/useChanges";
import { LinkChangesPanel } from "./changes/LinkChangesPanel";
import { useLinkDiffLists } from "./changes/useLinkDiffLists";
import { ChangesPanelSlot } from "./changes/ChangesPanelSlot";
import { DiffView } from "./changes/DiffView";
import { AttentionButton, ChangesToggle, DiffBar } from "./changes/ChangesChrome";
import { DiffToolbar, useDiffPreferences } from "./changes/DiffPrefs";
import { useDiffComments } from "./changes/useDiffComments";
import { formatCommentsMessage } from "../lib/diff-comments";
import { messageCommands, messageCommandsFrom } from "../lib/message-commands";
import { useChatMessages } from "../lib/chat-messages";
import { isLean } from "../lib/state-events";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { AgentPorts, LinkState, OpenLink, WorktreeBinding } from "@milagre/shared/model";
import { chatKeyForScope, scopeKey } from "@milagre/shared/chat-scopes";
import { chatTitle } from "@milagre/shared/chats";
import { attentionLabel, chatsNeedingAttention, waitingFor } from "@milagre/shared/attention";
import { useSettings } from "../lib/settings";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { ipcErrorMessage } from "@milagre/shared/result";
import { DotBackground } from "./DotBackground";
import SidebarNav from "./SidebarNav";
import { runKeys } from "../lib/sidebar-scopes";
import { DraftChatComposer } from "./DraftChatComposer";
import { useComposerPreferences } from "../lib/use-composer-preferences";
import { effortFor } from "../model";
import { createDraftStore, draftKey } from "../lib/draft-store";
import { createScopeDrafts, linkChatRows, memberWorktreeForAction } from "../lib/link-scope";
import { REMOTE_FILES_NOTICE, usePastedImages } from "./usePastedImages";
import type { useAgentRuns } from "./useAgentRuns";
import { attachmentPrompt } from "../lib/media";
import { modelForChat, sentDecision, sentReply } from "../lib/agent-runs";
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
import { CORNER_PITCH, PanelToggles } from "./agents/PanelToggles";
import { BridgeContext, ScopeContext, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { busyTerminals, newTerminal, useTerminalSync, type TerminalPlace } from "../lib/terminal-actions";
const CanvasView = lazyView(() => import("./CanvasView").then((module) => module.CanvasView));
const CANVAS_STATES = {};

type Preferences = Pick<
  ComponentProps<typeof DraftChatComposer>,
  "models" | "selectedModel" | "onModelChange" | "cliStatus" | "onModelPickerOpen" | "onUpdateCli" | "updatingCli" | "capability"
>;
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
  linkedWork,
  onCanvasChat,
  usage,
  initialSessionId,
  hostConnection,
  ports,
  onNewChatInScope,
}: {
  opened: OpenLink;
  state: LinkState;
  agents: ReturnType<typeof useAgentRuns>;
  preferences: Preferences;
  drafts: ReturnType<typeof createScopeDrafts>;
  initialSessionId?: number;
  hostConnection: { connected: boolean };
  ports: AgentPorts;
  onSwitchProject: (path: string) => void;
  onSwitchLink: (id: string) => void;
  onLinkProject: () => void;
  onAddComputer?: () => void;
  onOpenComputerSettings?: (id: string | null) => void;
  onEditLink: (id: string) => void;
  onOpenProject: () => void;
  onSettings: () => void;
  linkedWork: LinkedWork;
  onCanvasChat: (path: string, id: number) => void;
  usage?: ReactNode;
  onNewChatInScope?: (scopeKey: string) => void;
}) {
  const scope = { kind: "link" as const, linkId: opened.link.id },
    owner = scopeKey(scope);
  const bridge = bridgeForKey(owner);
  const draftStore = useMemo(createDraftStore, [owner]);
  const saved = drafts.read(scope);
  const [sessionId, setSessionId] = useState<number | null>(
    () =>
      initialSessionId ??
      (drafts.has(scope)
        ? saved.sessionId
        : (Object.values(state.sessions)
            .filter((session) => !session.archived)
            .at(-1)?.id ?? null)),
  );
  const session = sessionId == null ? undefined : state.sessions[sessionId];
  const chatId = session ? chatKeyForScope(scope, session.id) : null;
  // A shared Chat's Terminals start in one of its Worktrees, chosen when it has several.
  const terminalPlaces: TerminalPlace[] | undefined = session?.worktrees.map((member) => ({
    path: member.worktreePath,
    label: member.alias ?? member.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? member.worktreePath,
  }));
  const run = chatId ? agents.runs[chatId] : undefined;
  // Every project's chats that wait on the user; the Link's own are marked in its sidebar.
  const attentionKey = chatsNeedingAttention(agents.runs).join("\n");
  const sidebarRunKeys = runKeys(agents.runs);
  const attentionChats = useMemo(() => (attentionKey ? attentionKey.split("\n") : []), [attentionKey]);
  const { showAttentionButton, floatingInbox } = useSettings();
  const attentionPaths = useMemo(() => [...new Set(attentionChats.map(projectOfKey))], [attentionChats]);
  // A host that keeps messages by Chat (chat-pages-v1) sends states without them: the open Chat reads its own.
  const lean = isLean(state);
  const chatWindow = useChatMessages(lean ? owner : null, sessionId);
  const messages = useMemo(
    () => (lean ? chatWindow.messages : state.messages.filter((message) => message.session_id === sessionId)),
    [lean, chatWindow.messages, state.messages, sessionId],
  );
  const remoteCount = lean ? chatWindow.total - chatWindow.messages.length : 0;
  const earlierMessages = useMemo(
    () => (remoteCount > 0 ? { count: remoteCount, load: chatWindow.loadEarlier, loadAll: chatWindow.loadAll } : undefined),
    [remoteCount, chatWindow.loadEarlier, chatWindow.loadAll],
  );
  const chatMessagesOf = (id: number) => (lean ? (id === sessionId ? messages : []) : state.messages.filter((message) => message.session_id === id));
  const composerPrefs = useComposerPreferences(`${owner}#${sessionId ?? "new"}`);
  const imageDraft = usePastedImages(`${owner}:${sessionId ?? "new"}`, isRemoteKey(owner));
  const [preparing, setPreparing] = useState(false);
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
  const changes = useChanges({ cwd: chosen?.worktreePath, base: chosen?.base, chatId, available: Boolean(session) });
  const groupChanges = useLinkDiffLists({ members: session?.worktrees ?? [], chatId, mode: changes.mode, active: changes.open });
  const diffPrefs = useDiffPreferences();
  const comments = useDiffComments(chosen && chatId ? `${chatId}:${chosen.projectId}` : null, changes);
  useEffect(() => {
    if (gitChoice !== null) memberDialog.current?.showModal();
  }, [gitChoice]);
  const pendingOperation = useRef<string | null>(null);
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
    }
  }, [initialSessionId]);
  useEffect(() => {
    const model = modelForChat(preferences.selectedModel, session?.provider, messages, preferences.models);
    if (model.id !== preferences.selectedModel.id) preferences.onModelChange(model);
  }, [sessionId, session?.provider]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || isModalOpen()) return;
      if (canvasOpen && event.key === "Escape") {
        event.preventDefault();
        setCanvasOpen(false);
        return;
      }
      if (canvasOpen && (event.metaKey || event.ctrlKey) && ["d", "f"].includes(event.key.toLowerCase())) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "d" && session) {
        event.preventDefault();
        changes.toggle();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        pick(null);
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandsOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "t" && terminalChatId) {
        event.preventDefault();
        newTerminal(terminalChatId, terminalPlaces, setError);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
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
      else if (question && !run.answered[question.requestId]) void agents.answerQuestion(chatId, question.requestId, null);
      else void agents.interrupt(chatId);
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [chatId, run, findOpen, session, changes.toggle, canvasOpen, terminalChatId]);
  function pick(id: number | null) {
    latest.current.selection++;
    drafts.newSelection(scope);
    setCanvasOpen(false);
    setSessionId(id);
    imageDraft.clear();
    setError(null);
    setMemberId("");
    changes.closeDiff();
    setFindOpen(false);
    pendingOperation.current = null;
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
  async function send(body = draftStore.get().trim(), preserve = false) {
    if (preparing || imageDraft.loading || (!body && !imageDraft.images.length && !imageDraft.files.length)) return;
    // A file attached from this Mac is a path the other Mac can't read; pasted images travel as data and still go.
    if (isRemoteKey(owner) && imageDraft.files.length) {
      setError(REMOTE_FILES_NOTICE);
      return;
    }
    const selection = latest.current.selection;
    const operation = drafts.beginSend(scope, sessionId, JSON.stringify({ body, images: imageDraft.images, files: imageDraft.files }));
    setPreparing(true);
    setError(null);
    pendingOperation.current = operation;
    // The picker decides the provider: a chat on another one hands off to it.
    const model = preferences.selectedModel;
    try {
      const sent = await bridge.sendLinkMessage({
        linkId: opened.link.id,
        sessionId,
        operationId: operation,
        body,
        prompt: attachmentPrompt(body, imageDraft.files),
        images: imageDraft.images,
        files: imageDraft.files,
        provider: model.provider,
        model: model.id,
        permissionMode: composerPrefs.permissionMode,
        effort: preferences.capability ? effortFor(preferences.capability, composerPrefs.effort) : composerPrefs.effort,
        ultracode: composerPrefs.ultracode,
        fastMode: composerPrefs.fastMode,
        replies: getSettings().claudeReplies,
        tldrEnabled: getSettings().tldrEnabled,
      });
      drafts.acknowledgeSend(operation, sent.sessionId);
      if (pendingOperation.current === operation) pendingOperation.current = null;
      if (latest.current.active && latest.current.selection === selection) {
        setSessionId(sent.sessionId);
        if (!preserve && draftStore.get().trim() === body) {
          draftStore.set("");
          imageDraft.clear();
        }
      }
      return true;
    } catch (error) {
      if (latest.current.active && latest.current.selection === selection) setError(ipcErrorMessage(error));
    } finally {
      if (latest.current.active) setPreparing(false);
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
  const recents = linkChatRows(state).map((row) => {
    const running = agents.runs[chatKeyForScope(scope, Number(row.id))];
    return {
      ...row,
      details: { path: state.sessions[row.id]?.workspacePath },
      mark: running?.questions.length
        ? ("question" as const)
        : running?.approvals.length
          ? ("waiting" as const)
          : running
            ? ("running" as const)
            : row.unread
              ? ("unread" as const)
              : ("idle" as const),
    };
  });
  const approval = run?.approvals[0],
    question = approval ? undefined : run?.questions[0];
  async function refreshChanges() {
    await Promise.all([groupChanges.refresh(), ...(chosen ? [changes.refresh()] : [])]);
  }
  async function sendComments() {
    const entries = comments.sendable;
    if (!entries.length) return;
    changes.closeDiff();
    const body = formatCommentsMessage(entries, { mode: changes.mode, base: chosen?.base });
    if (await send(`Project ${chosen?.projectId}:\n${body}`, true)) comments.removeMany(entries.map((entry) => entry.id));
  }
  const root = session?.workspacePath ?? "";
  return (
    <BridgeContext.Provider value={bridge}>
      <ScopeContext.Provider value={owner}>
        <DotBackground>
          {!hostConnection.connected && (
            <div
              role="status"
              data-host-disconnected
              className="fixed inset-x-4 top-12 z-50 mx-auto max-w-2xl rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink shadow-overlay [-webkit-app-region:no-drag]"
            >
              <p>Reconnecting to your computer</p>
              <p className="mt-1 text-ink-2">Your draft is kept here. Messages will be available when the host reconnects.</p>
            </div>
          )}
          <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-10" />
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden text-ink">
            <div className="flex min-h-0 shrink-0 pt-[60px] pb-3 pl-3">
              <SidebarNav
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
                onNewChat={() => pick(null)}
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
                  onArchive: (id) => {
                    const key = chatKeyForScope(scope, Number(id));
                    return agents
                      .interrupt(key)
                      .then(() => bridge.patchChat(owner, Number(id), { archived: true }))
                      .then(() => {
                        if (sessionId === Number(id)) pick(null);
                      })
                      .catch((error) => setError(ipcErrorMessage(error)));
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
                      className="absolute inset-x-5 top-14 z-30 rounded-control border border-line bg-surface px-3 py-2 text-[13px] text-red shadow-overlay"
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
                  {changes.diffOpen && <DiffView key={`${chatId}:${memberId}:${changes.mode}`} changes={changes} prefs={diffPrefs} comments={comments} />}
                  <div className={`min-h-0 flex-1 flex-col overflow-hidden ${changes.diffOpen ? "hidden" : "flex"}`}>
                    <EditorLinks root={root}>
                      <DraftChatComposer
                        {...preferences}
                        effort={preferences.capability ? effortFor(preferences.capability, composerPrefs.effort) : composerPrefs.effort}
                        onEffortChange={composerPrefs.setEffort}
                        ultracode={composerPrefs.ultracode}
                        onUltracodeChange={composerPrefs.setUltracode}
                        fastMode={composerPrefs.fastMode}
                        onFastModeChange={composerPrefs.setFastMode}
                        permissionMode={composerPrefs.permissionMode}
                        scopeKind="link"
                        store={draftStore}
                        projectPath={root}
                        messageScope={owner}
                        earlier={earlierMessages}
                        messages={messages}
                        imageDraft={imageDraft}
                        onSend={() => void send()}
                        onStop={chatId && run ? () => void agents.interrupt(chatId) : undefined}
                        isSending={Boolean(run && !approval && !question)}
                        sendBlocked={preparing}
                        streamingText={run?.text}
                        streamingSteps={run?.steps}
                        runStartedAt={run?.startedAt}
                        runModelName={run?.model}
                        sessionProvider={session?.provider}
                        tasks={run?.tasks}
                        contextUsage={run?.contextUsage ?? session?.contextUsage}
                        subagents={session?.subagents?.filter((agent) => agent.id !== session.native_session_id)}
                        ports={chatId ? ports[chatId] : undefined}
                        agentChatId={chatId ?? undefined}
                        waitingForSubagents={run?.waitingForSubagents}
                        asking={Boolean(question)}
                        waitingStepIds={run?.approvals.flatMap((request) => (request.stepId ? [request.stepId] : []))}
                        resume={
                          session?.resumeTurn
                            ? { onContinue: () => void bridge.resumeChat(owner, session.id).catch((error) => setError(ipcErrorMessage(error))) }
                            : undefined
                        }
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
                          if (chatId) void bridge.setAgentPermissionMode(chatId, mode);
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
                              onAnswer={(decision) => void agents.respond(chatId, approval.requestId, decision)}
                            />
                          ) : question && chatId ? (
                            <QuestionCard
                              request={question}
                              waiting={(run?.questions.length ?? 1) - 1}
                              answering={sentReply(run, question.requestId)}
                              onAnswer={(answer) => void agents.answerQuestion(chatId, question.requestId, answer)}
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
                  projects={opened.projects}
                  lists={groupChanges.lists}
                  loading={groupChanges.loading}
                  mode={changes.mode}
                  onModeChange={changes.setMode}
                  onRefresh={() => void refreshChanges()}
                  onSelectFile={(member, path) => {
                    setMemberId(member.projectId);
                    changes.selectFile(path);
                  }}
                  selectedProjectId={memberId}
                  activePath={changes.activePath}
                  commentCounts={comments.counts}
                  onCommit={(member) => setGitDialog({ sessionId: session.id, member: memberWorktreeForAction(state, session.id, member.projectId) })}
                  onOpenEditor={isRemoteKey(owner) ? undefined : (member) => void openInEditor(member.worktreePath)}
                  onReveal={isRemoteKey(owner) ? undefined : (member) => void window.milagre.revealInFolder(member.worktreePath)}
                />
              )}
            </ChangesPanelSlot>
          </div>
          {!canvasOpen && session && <ChangesToggle open={changes.open} onToggle={changes.toggle} />}
          <PanelToggles right={!canvasOpen && session ? 12 + CORNER_PITCH : 12} />
          {showAttentionButton && !floatingInbox && attentionChats[0] && (
            <AttentionButton
              label={attentionLabel(attentionPaths.map((path) => path.split("/").pop() ?? path))}
              items={attentionChats.map((key) => ({
                key,
                project: projectOfKey(key).split("/").pop() ?? key,
                asking: !agents.runs[key]?.approvals.length,
                waitingFor: waitingFor(agents.runs[key]),
              }))}
              offset={!canvasOpen && session ? 1 : 0}
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
                <p className="mt-1 mb-4 text-[13px] text-ink-2">Git actions apply to one Worktree.</p>
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
                { id: "new", label: "New Chat", group: "Actions", icon: "chat", run: () => pick(null) },
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
              onClose={() => setCommandsOpen(false)}
              onError={setError}
            />
          )}
          {gitDialog && (
            <GitActionsDialog
              projectName={opened.projects.find((project) => project.id === gitDialog.member.projectId)?.name}
              cwd={gitDialog.member.worktreePath}
              base={gitDialog.member.base}
              provider={state.sessions[gitDialog.sessionId]?.provider}
              chat={gitChatContext(chatTitle(state.sessions[gitDialog.sessionId], chatMessagesOf(gitDialog.sessionId)), chatMessagesOf(gitDialog.sessionId))}
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

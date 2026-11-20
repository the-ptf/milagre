import { useRef, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View, type ViewInstance, type ViewStyle } from "react-native";
import { router } from "expo-router";
import { ArrowUp01Icon, Attachment01Icon, Cancel01Icon, File01Icon, StopIcon, Video01Icon } from "@hugeicons/core-free-icons";
import type { ChatMessage, ContextUsage } from "@milagre/shared/model";
import { compactionContext } from "@milagre/shared/compaction";
import { NO_PROJECT_LABEL } from "@milagre/shared/chats-home";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { shiftImageMentions, type MentionChat, type MentionComputer } from "@milagre/shared/prompt-mentions";
import type { Client, Snapshot } from "./client";
import { useComposer, useComposerDrafts } from "./session";
import { ComposerTray, OfflineTray, type OfflineTrayTarget } from "./offline-tray";
import { ComposerGlass } from "./composer-glass";
import { UltracodeGlow } from "./ultracode-glow";
import { QuoteChips } from "./quote-chips";
import { PromptField } from "./prompt-field";
import { useSendStayShortcut } from "./send-stay-shortcut";
import { AgentControls } from "./agent-controls";
import { ContextRing } from "./context-ring";
import { Icon } from "./icons";
import { DISABLED_OPACITY, IconButton, PageScroll, PullDown, useStyles } from "./ui";
import { useTheme } from "./theme";
import { lineHeight, radius, space, type } from "./design-tokens";
import { PersistenceNotice } from "./persistence-notice";
import { ProviderUpdatePill } from "./provider-update-notice";
import { SubchatAsk, SubchatPill, type SubchatPanelState } from "./subchat-pill";
import { PlanPill, type PlanPanelState } from "./plan-pill";
import { PullRequestAction, PullRequestMerge, PullRequestReview, SubagentChip } from "./status-indicators";
import { TerminalChip, terminalPlaces } from "./terminal";
import { PortsChip } from "./ports";
import { SimulatorChip } from "./simulator";
import { QueuedMessages } from "./queued-messages";
import { SubchatWaitingNote } from "./subchat-note";
import { ActivityQuestions } from "./questions";
import { UndoPanel, type CheckpointReview, type UndoIntent } from "./undo-panel";
import type { KnownFiles } from "./file-mentions";
import type { PastedImage } from "./attachment-picker";
import type { Attachment } from "./attachments";
import type { MobileModel, TurnPreferences } from "./turn-options";
import type { RunShape } from "./run-shape";
import { armSendLaunch } from "./send-launch-store";

type Project = Snapshot["project"];
type DockChat = NonNullable<Project["state"]["sessions"][number]>;
type PullRequest = Parameters<typeof PullRequestMerge>[0]["pr"];
type Question = RunShape["questions"][number];
type QuestionProps = Parameters<typeof ActivityQuestions>[0];

type DockChipsProps = {
  chat: DockChat | null | undefined;
  chatId: string;
  savedId?: string;
  chatsHomeOpen: boolean;
  subchatPanel: SubchatPanelState;
  messages: ChatMessage[];
  actionPr?: PullRequest;
  actionDisabled: boolean;
  onAction: () => void;
  pr?: PullRequest | null;
  mergeable: boolean;
  openThreads: number;
  onOpenPr: (page?: "threads") => void;
  terminalDocks: boolean;
  terminalShown: boolean;
  terminalCount?: number;
  onTerminal: () => void;
  ports: Parameters<typeof PortsChip>[0]["ports"];
  planPanel: PlanPanelState;
  agents: Parameters<typeof SubagentChip>[0]["agents"];
  onAgents: () => void;
};

function DockChips(props: DockChipsProps) {
  const { chat, chatId, savedId, chatsHomeOpen, pr } = props;
  const saved = savedId && Number(savedId) > 0;
  const own = chat && !chatsHomeOpen;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ marginHorizontal: -12, flexGrow: 0 }}
      contentContainerStyle={{ flexGrow: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 8 }}
    >
      <ProviderUpdatePill />
      {own && <SubchatPill panel={props.subchatPanel} messages={props.messages} />}
      {props.actionPr && own && <PullRequestAction pr={props.actionPr} disabled={props.actionDisabled} onRun={props.onAction} />}
      {props.mergeable && own && pr && <PullRequestMerge pr={pr} onOpen={() => props.onOpenPr()} />}
      {own && pr && props.openThreads > 0 && <PullRequestReview count={props.openThreads} onOpen={() => props.onOpenPr("threads")} />}
      <View style={{ flex: 1 }} />
      {saved && chat && !chat.archived && (
        <TerminalChip
          key={`terminal-${chatId}`}
          chatId={chatId}
          places={terminalPlaces(chat)}
          onOpen={props.terminalDocks ? props.onTerminal : undefined}
          docked={props.terminalDocks ? props.terminalShown : undefined}
          liveCount={props.terminalCount}
        />
      )}
      {saved && <PortsChip key={`ports-${chatId}`} chatId={chatId} ports={props.ports} />}
      <PlanPill panel={props.planPanel} />
      {saved && <SimulatorChip key={chatId} chatId={chatId} />}
      {props.agents.length > 0 && <SubagentChip agents={props.agents} onPress={props.onAgents} />}
    </ScrollView>
  );
}

function AttachmentStrip({ chatId, attachments, disabled }: { chatId: string; attachments: Attachment[]; disabled: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const composer = useComposer();
  return (
    <PageScroll horizontal contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 8 }}>
      {attachments.map((item) => {
        const imageIndex = item.image ? attachments.filter((attachment) => attachment.image).indexOf(item) + 1 : 0;
        return (
          <View
            key={item.id}
            style={{
              backgroundColor: colors.field,
              borderRadius: radius.card,
              borderCurve: "continuous",
              paddingLeft: item.image ? 4 : space.md,
              flexDirection: "row",
              alignItems: "center",
              maxWidth: 220,
            }}
          >
            {item.image ? (
              <Image source={{ uri: item.uri }} accessibilityLabel={item.name} style={{ width: 44, height: 44, borderRadius: radius.control }} />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Preview ${item.name}`}
                onPress={() =>
                  router.push({
                    pathname: "/file-preview",
                    params: item.path ? { path: item.path } : { uri: item.uri, name: item.name },
                  })
                }
                style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}
              >
                <Icon icon={item.video ? Video01Icon : File01Icon} tone="ink2" size={18} />
                <Text numberOfLines={1} style={[styles.label, { flexShrink: 1, paddingLeft: 6 }]}>
                  {item.name}
                </Text>
              </Pressable>
            )}
            {item.image && (
              <Text numberOfLines={1} style={[styles.label, { flexShrink: 1, paddingLeft: 6 }]}>
                {`#${imageIndex} ${item.name}`}
              </Text>
            )}
            <IconButton
              label={`Remove ${item.name}`}
              icon={Cancel01Icon}
              size={32}
              disabled={disabled}
              onPress={() => {
                composer.setAttachments((currentAttachments) => ({
                  ...currentAttachments,
                  [chatId]: (currentAttachments[chatId] || []).filter((attachment) => attachment.id !== item.id),
                }));
                if (imageIndex > 0) {
                  composer.setDrafts((current) => ({
                    ...current,
                    [chatId]: shiftImageMentions(current[chatId] || "", imageIndex),
                  }));
                }
              }}
            />
          </View>
        );
      })}
    </PageScroll>
  );
}

type ComposerControlsProps = {
  attachDisabled: boolean;
  onPick: (kind: "photos" | "camera" | "files" | "paste") => void;
  compactButton: ReactNode;
  model: MobileModel;
  preferences: TurnPreferences;
  onModel: () => void;
  quietContext: boolean;
  compactionFeedback: { percent: number; freed: string } | null;
  contextUsage?: ContextUsage;
  showContextSize: boolean;
  compactWarning: boolean;
  canCompact: boolean;
  threshold: number;
  onContext?: () => void;
};

function ComposerControls(props: ComposerControlsProps) {
  const { colors } = useTheme();
  const { attachDisabled, compactButton, contextUsage, quietContext, compactionFeedback } = props;
  return (
    <>
      <PullDown
        label="Attach photos or files"
        nativeTrigger={{ systemImage: "paperclip", iconSize: 16, disabled: attachDisabled }}
        sections={[
          {
            items: [
              { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled: attachDisabled },
              { id: "camera", title: "Take Photo", systemImage: "camera", disabled: attachDisabled },
              { id: "files", title: "Choose Files", systemImage: "folder", disabled: attachDisabled },
              { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled: attachDisabled },
            ],
          },
        ]}
        onSelect={(kind) => props.onPick(kind as "photos" | "camera" | "files" | "paste")}
      >
        <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: attachDisabled ? DISABLED_OPACITY.control : 1 }}>
          <Icon icon={Attachment01Icon} tone="ink2" size={18} />
        </View>
      </PullDown>
      <AgentControls
        compact={Boolean(compactButton)}
        model={props.model}
        effort={props.preferences.effort}
        fastMode={props.preferences.fastMode}
        ultracode={props.preferences.ultracode}
        onToggle={props.onModel}
      />
      <View style={{ flex: 1 }} />
      {!quietContext && compactionFeedback ? (
        <Text
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
          style={{ fontSize: type.caption1, lineHeight: lineHeight.caption1, color: colors.greenInk, paddingHorizontal: 8 }}
        >
          ✓ {compactionFeedback.percent}% · {compactionFeedback.freed} freed
        </Text>
      ) : (
        !quietContext &&
        (compactButton || (props.showContextSize && contextUsage && contextUsage.size > 0)) && (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {props.compactWarning && (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "50%",
                  height: 34,
                  transform: [{ translateY: -17 }],
                  borderRadius: radius.full,
                  backgroundColor: colors.orangeTint,
                }}
              />
            )}
            {compactButton}
            {contextUsage && contextUsage.size > 0 && props.onContext && (
              <ContextRing
                {...contextUsage}
                canCompact={props.canCompact}
                threshold={props.threshold}
                showSize={props.showContextSize}
                onPress={props.onContext}
              />
            )}
          </View>
        )
      )}
    </>
  );
}

type DraftComposerProps = {
  chatId: string;
  fieldKey: string;
  start: boolean;
  ultracodeOn: boolean;
  picking: boolean;
  busy: boolean;
  sendBlocked: boolean;
  running: boolean;
  offline: boolean;
  actionBusy: boolean;
  sendLabel: string;
  chats: readonly MentionChat[];
  computers: readonly MentionComputer[];
  currentId?: number;
  client: Client;
  projectPath: string;
  skillScope?: string;
  suggestion?: string;
  chatTitle: string;
  provider: string;
  onImagePaste: (image: PastedImage) => void;
  known: KnownFiles;
  onMention?: (path: string) => void;
  commands: { name: string; description: string }[];
  placeholder?: string;
  focusRequest: number;
  onSend: () => void;
  onSendStay?: () => void;
  onStop: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onTouchStart: () => void;
  controls: ReactNode;
};

const NO_QUOTES: ComposerQuote[] = [];
const NO_ATTACHMENTS: Attachment[] = [];

function DraftComposer(props: DraftComposerProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const composer = useComposer();
  const held = useComposerDrafts();
  const { chatId, start, ultracodeOn, picking, busy, running, offline } = props;
  const draft = held.drafts[chatId] || "";
  const quotes = held.quotes[chatId] || NO_QUOTES;
  const attachments = held.attachments[chatId] || NO_ATTACHMENTS;
  const empty = !draft.trim() && !quotes.length && !attachments.length;
  const sendDisabled = props.sendBlocked || empty;
  const focused = useRef(false);
  const field = useRef<ViewInstance>(null);
  const send = () => {
    if (start) armSendLaunch(field);
    props.onSend();
  };
  const sendStay = start && !sendDisabled ? props.onSendStay : undefined;
  useSendStayShortcut(sendStay, () => focused.current);
  return (
    <View
      ref={field}
      style={{
        backgroundColor: start ? colors.surface : "transparent",
        borderWidth: 1,
        borderColor: start ? colors.lineStrong : ultracodeOn ? colors.line : "transparent",
        borderRadius: radius.composer,
        borderCurve: "continuous",
        paddingTop: 8,
        paddingHorizontal: 8,
        paddingBottom: 6,
        gap: 4,
        // oxlint-disable-next-line milagre-design/shadow-token -- Ultracode's purple glow is brand artwork, not an elevation
        boxShadow: ultracodeOn ? `0 4px 22px ${colors.purple}47` : start ? undefined : colors.shadowRaised,
      }}
    >
      {!start && <ComposerGlass radius={radius.composer} />}
      {ultracodeOn && <UltracodeGlow radius={radius.composer} />}
      {picking && (
        <Text accessibilityRole="progressbar" accessibilityLabel="Preparing attachment" style={styles.caption}>
          Preparing attachment...
        </Text>
      )}
      <QuoteChips
        quotes={quotes}
        disabled={busy}
        onRemove={(id) => composer.setQuotes((current) => ({ ...current, [chatId]: (current[chatId] || []).filter((quote) => quote.id !== id) }))}
      />
      {!!attachments.length && <AttachmentStrip chatId={chatId} attachments={attachments} disabled={busy || picking} />}
      <PromptField
        // A draft keeps its native text input when its computer or Project changes, preserving
        // keyboard focus and the caret. Saved Chats still get an input of their own.
        key={props.fieldKey}
        chats={props.chats}
        computers={props.computers}
        currentId={props.currentId}
        client={props.client}
        projectPath={props.projectPath}
        skillScope={props.skillScope}
        draft={draft}
        suggestion={attachments.length ? undefined : props.suggestion}
        onAcceptSuggestion={(text) => composer.setDrafts((current) => (current[chatId] ? current : { ...current, [chatId]: text }))}
        chatTitle={props.chatTitle}
        provider={props.provider}
        images={attachments.filter((item) => item.image).length}
        onImagePaste={props.onImagePaste}
        known={props.known}
        onMention={props.onMention}
        commands={props.commands}
        placeholder={props.placeholder}
        onSubmit={() => {
          if (!sendDisabled) send();
        }}
        onFocus={() => {
          focused.current = true;
          props.onFocus();
        }}
        onBlur={() => {
          focused.current = false;
          props.onBlur();
        }}
        focusRequest={props.focusRequest}
        onTouchStart={props.onTouchStart}
        onChangeText={(value) => {
          composer.setDrafts((current) => ({ ...current, [chatId]: value }));
        }}
        renderControls={(mic) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            {props.controls}
            {mic}
            {running && !offline && empty && (
              <IconButton label="Stop agent" icon={StopIcon} filled size={36} disabled={props.actionBusy} onPress={props.onStop} />
            )}
            {(offline || !running || !empty) && (
              <IconButton
                label={props.sendLabel}
                icon={ArrowUp01Icon}
                filled
                size={36}
                loading={busy}
                disabled={sendDisabled}
                onPress={send}
                onLongPress={sendStay}
                longPressLabel="Start in a new worktree, stay here"
              />
            )}
          </View>
        )}
      />
    </View>
  );
}

type ChatComposerDockProps = {
  column: ViewStyle;
  padding: number;
  onRoom: PlanPanelState["attachRoom"];
  onHeight: (height: number) => void;
  client: Client;
  project: Project;
  chat: DockChat | null | undefined;
  chatId: string;
  chatsHomeOpen: boolean;
  disconnected: boolean;
  subchatPanel: SubchatPanelState;
  messages: ChatMessage[];
  onOpenChat: (chatKey: string) => void;
  question?: Question;
  answering: boolean;
  chips: Omit<DockChipsProps, "chat" | "chatId" | "chatsHomeOpen" | "subchatPanel" | "messages">;
  running: boolean;
  canSteer: boolean;
  actionBusy: boolean;
  onQueueSend: (id: string) => void;
  onQueueRemove: (id: string) => void;
  waiting?: Parameters<typeof SubchatWaitingNote>[0]["note"] | null;
  approvals: ReactNode;
  sessionId: number;
  dictationChat: QuestionProps["dictationChat"];
  onAnswer: QuestionProps["submit"];
  undo: CheckpointReview;
  undoIntent: UndoIntent;
  onOpenUndoFile?: Parameters<typeof UndoPanel>[0]["onOpenFile"];
  btw?: ReactNode;
  start: boolean;
  trayTarget: OfflineTrayTarget;
  tray: ReactNode;
  composer: Omit<DraftComposerProps, "chatId" | "start" | "controls">;
  controls: ComposerControlsProps;
};

export function ChatComposerDock({ onRoom, onHeight, column, padding, ...props }: ChatComposerDockProps) {
  const { client, project, chat, chatId, chatsHomeOpen, question, answering } = props;
  const asking = !question || answering;
  return (
    <View
      ref={onRoom}
      collapsable={false}
      onLayout={({ nativeEvent }) => onHeight(Math.round(nativeEvent.layout.height))}
      style={[column, { paddingHorizontal: 12, paddingTop: 6, paddingBottom: padding, gap: 8 }]}
    >
      <PersistenceNotice
        key={`${client.url}|${project.path}`}
        client={client}
        scope={project.path}
        name={chatsHomeOpen ? NO_PROJECT_LABEL : project.name}
        failure={project.state.persistence}
        offline={props.disconnected}
      />
      {chat && !chatsHomeOpen && asking && <SubchatAsk panel={props.subchatPanel} messages={props.messages} onOpenChat={props.onOpenChat} />}
      {asking && (
        <DockChips {...props.chips} chat={chat} chatId={chatId} chatsHomeOpen={chatsHomeOpen} subchatPanel={props.subchatPanel} messages={props.messages} />
      )}
      {chat?.queued?.length ? (
        <QueuedMessages
          items={chat.queued.filter((item) => !compactionContext(item) || chat.queueHeld)}
          held={Boolean(chat.queueHeld)}
          running={props.running}
          canSteer={props.canSteer}
          disabled={props.actionBusy}
          onSendNow={props.onQueueSend}
          onRemove={props.onQueueRemove}
        />
      ) : null}
      {props.waiting && <SubchatWaitingNote note={props.waiting} />}
      {props.approvals}
      {question && (
        <View style={answering ? { display: "none" } : undefined}>
          <ActivityQuestions
            hostId={client.url}
            projectPath={project.path}
            sessionId={props.sessionId}
            key={question.requestId}
            request={question}
            busy={props.actionBusy || answering}
            dictationChat={props.dictationChat}
            submit={props.onAnswer}
          />
        </View>
      )}
      {props.btw}
      {props.undo.view !== "closed" && chat ? (
        <UndoPanel readOnly={!!chat.readOnlyReason} review={props.undo} intent={props.undoIntent} onOpenFile={props.onOpenUndoFile} />
      ) : (
        asking && (
          <ComposerTray start={props.start} target={props.trayTarget}>
            {props.tray}
            <OfflineTray target={props.trayTarget} chip={!props.start} />
            <DraftComposer {...props.composer} chatId={chatId} start={props.start} controls={<ComposerControls {...props.controls} />} />
          </ComposerTray>
        )
      )}
    </View>
  );
}

import type { MessageDelivery } from "@milagre/shared/queued-messages";
import type { AgentSession } from "@milagre/shared/model";
import type { AgentPort, BackgroundTask, ChatPlan, ContextUsage, ImageAttachment, Subagent } from "../../model";
import type { ReactNode } from "react";
import { type Starter } from "../Onboarding";
import type { LinearIssue } from "@milagre/shared/linear";
import type {
  AgentCliStatus,
  EffortLevel,
  ModelCapability,
  ChatMessage as AppChatMessage,
  ChatStep,
  Isolation,
  ModelOption,
  ModelProvider,
  PermissionMode,
} from "../../model";
import { type ChatMentionScope } from "../ChatMentions";
import { type StepApproval } from "../agents/step-approval";
import type { ComposerQuestionProps } from "../agents/ComposerQuestion";
import type { ImageDraft } from "../usePastedImages";
import type { DraftStore } from "../../lib/draft-store";
import type { QueueControls } from "../QueuedMessages";
import type { ChatActivity } from "@milagre/shared/chat-activity";
import type { ChatsHome, ProjectKind } from "@milagre/shared/chats-home";

export type ComposerSession = Pick<AgentSession, "id" | "limitResume" | "limitTurn" | "queued" | "readOnlyReason" | "done_at" | "archived">;

export interface ChatComposerProps {
  session?: ComposerSession;
  mentionContext?: ChatMentionScope;
  offlineName?: string | null;
  reconnectingName?: string | null;
  offlineTray?: ReactNode;
  offScreen?: boolean;
  onSendDesignMessage?: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  onSendPageComments?: (text: string, images: ImageAttachment[]) => Promise<boolean>;
  onOpenDiff?: (path: string, worktree: string) => void;
  onOpenPullRequestLink?: (url: string) => boolean;
  scopeKind?: "project" | "link";
  findOpen?: boolean;
  findSignal?: number;
  findSeed?: string;
  onFindClose?: () => void;
  imageDraft: ImageDraft;
  projectPath: string;
  skillScope?: string;
  earlier?: { count: number; load: () => Promise<void>; loadAll: (signal?: AbortSignal) => Promise<void> };
  trimHistory?: (canTrim: () => boolean) => void;
  messageScope?: string;
  scrollKey?: number | string;
  messages: AppChatMessage[];
  loading?: boolean;
  loadError?: string;
  onRetryLoad?: () => void;
  pendingMessageId?: number;
  store: DraftStore;
  onSend: (delivery?: MessageDelivery, background?: boolean) => void;
  onStop?: () => void;
  onSettle?: (sessionId: number, snoozeUntil?: number) => void;
  onCompact?: () => void;
  pullRequestAction?: { label: string; tone: "red" | "orange" | "green"; onRun: () => void };
  pullRequestReview?: { count: number; onOpen: () => void };
  isSending: boolean;
  sendBlocked: boolean;
  readOnlyHistory?: boolean;
  streamingKey?: string;
  streamingText?: string;
  streamingSteps?: ChatStep[];
  subagents?: Subagent[];
  backgroundTasks?: BackgroundTask[];
  onArchiveFinishedSubagents?: () => void;
  onArchiveSubagent?: (id: string, archived: boolean) => void;
  onStopAdvisor?: (id: string) => void;
  onRetryAdvisor?: (id: string) => void;
  waitingForSubagents?: boolean;
  activity?: ChatActivity;
  plan?: ChatPlan;
  contextUsage?: ContextUsage;
  suggestion?: string;
  ports?: AgentPort[];
  agentChatId?: string;
  onStopPort?: (pid: number) => Promise<unknown>;
  waitingStepIds?: string[];
  asking?: boolean;
  runModelName?: string;
  sessionProvider?: ModelProvider;
  runStartedAt?: number;
  statusLabel?: string;
  onOpenLinkedChat?: (chatKey: string) => void;
  onOpenAccounts?: () => void;
  resume?: { onContinue: () => void };
  queue?: QueueControls;
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
  onRecommendationSelect: (option: string) => void;
  approval?: ReactNode;
  question?: ComposerQuestionProps;
  approvalHidden?: boolean;
  stepApproval?: StepApproval | null;
  newChatProject?: {
    key: string;
    name: string;
    kind?: ProjectKind;
    onChange?: (key: string, home?: Pick<ChatsHome, "exists">, others?: readonly string[]) => void;
    onLinkPick?: (id: string) => void;
  };
  worktrees: Array<{ id: number; name: string; path: string }>;
  selectedWorktreeId?: number;
  onWorktreeChange: (id: number) => void;
  isolation: Isolation;
  onIsolationChange: (isolation: Isolation) => void;
  branches: string[];
  baseBranch: string;
  onBaseBranchChange: (branch: string) => void;
  linearActive?: boolean;
  onStartFromIssue?: (issue: LinearIssue) => void;
  newChatError: string | null;
  saveNotice?: ReactNode;
  notice?: string | null;
  onDismissNotice?: () => void;
  composerNote?: string;
  noGit?: boolean;
  starters?: Starter[];
}

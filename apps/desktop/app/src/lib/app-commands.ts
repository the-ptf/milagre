import { requestSideQuestion } from "./chat-branch-events";
import { bridgeForKey } from "./computer-bridge";
import { RELOAD_HINT } from "@milagre/shared/chat-reload";
import { UI_COPY } from "@milagre/shared/model-copy";
import { GITHUB_ISSUE_TITLE } from "@milagre/shared/github-issue";
import { requestGithubIssuePicker } from "./issue-picker-request";
import type { SettingsSection } from "../components/Settings";
import type { SidebarRecent } from "../components/sidebar/ChatRow";
import type { AgentSession, OpenProject } from "../model";
import type { ChatLayout } from "./chat-grid";
import type { Command } from "./commands";
import type { RecentProject } from "./project-list";
import { getSettings, updateSettings } from "./settings";
import { settingsCommands, settingsPageCommands } from "./settings-commands";
import { orchestratorEnabled } from "./orchestrator-store";
import { openDesignLibrary } from "./design-library-page";
import type { AppView } from "./run-pane";

type Run = void | Promise<unknown>;

type AppCommandActions = {
  newChat: () => Run;
  newWorktree: () => void;
  newTerminal: (chatId: string) => Run;
  openProject: () => Run;
  openCanvas: () => void;
  openRoutines: () => void;
  openOrchestrator: () => void;
  openUsage: () => void;
  openStorage: () => void;
  startTriage: () => Run;
  openSettingsAt: (section: SettingsSection, row?: string) => void;
  toggleTheme: () => void;
  openProjectSettings: () => void;
  backToChat: () => void;
  showOneChat: () => void;
  openGitDialog: (sessionId: number) => Run;
  openChatInEditor: (sessionId: number) => Run;
  revealChat: (sessionId: number) => Run;
  openFind: () => void;
  setUnread: (sessionId: number, unread: boolean) => void;
  reloadChat: (sessionId: number) => Run;
  reportMilagreBug: (sessionId: number) => void;
  copyPath: (path: string) => Run;
  openChat: (sessionId: number) => void;
  switchProject: (path: string) => void;
};

export type AppCommandContext = {
  current: OpenProject;
  terminalChatId: string | null;
  projectSettings: boolean;
  view: AppView;
  settingsOpen: boolean;
  layout: ChatLayout;
  selectedSession: AgentSession | undefined;
  selectedWorktreePath: string | undefined;
  showGit: boolean;
  remoteProject: boolean;
  chatCount: number;
  chats: SidebarRecent[];
  recentProjects: RecentProject[];
  actions: AppCommandActions;
};

function actionCommands(ctx: AppCommandContext): Command[] {
  const { actions, terminalChatId } = ctx;
  return [
    {
      id: "new-chat",
      label: UI_COPY.newChat,
      group: "Actions",
      icon: "add",
      keybinding: "chat.new" as const,
      keywords: "create agent session",
      run: () => actions.newChat(),
    },
    {
      id: "new-worktree",
      label: "New worktree…",
      group: "Actions",
      icon: "add",
      keybinding: "worktree.new" as const,
      keywords: "create chat agent background quick",
      run: () => actions.newWorktree(),
    },
    ...(ctx.showGit
      ? [
          {
            id: "github-issue",
            label: GITHUB_ISSUE_TITLE,
            group: "Actions",
            icon: "github" as const,
            keywords: "github issue gh ticket bug new chat worktree",
            run: async () => {
              await actions.newChat();
              requestGithubIssuePicker();
            },
          },
        ]
      : []),
    ...(terminalChatId
      ? [
          {
            id: "new-terminal",
            label: "New Terminal",
            group: "Actions",
            icon: "terminal" as const,
            keybinding: "terminal.new" as const,
            keywords: "shell console command line",
            run: () => actions.newTerminal(terminalChatId),
          },
        ]
      : []),
    {
      id: "open-project",
      label: UI_COPY.addProject,
      group: "Actions",
      icon: "folderAdd",
      keybinding: "project.add" as const,
      keywords: "add repository workspace folder",
      run: () => actions.openProject(),
    },
    {
      id: "canvas",
      label: "Projects and Links",
      group: "Actions",
      icon: "canvas",
      keybinding: "canvas.open" as const,
      keywords: "canvas linked worktrees",
      run: actions.openCanvas,
    },
    {
      id: "routines",
      label: "Routines",
      group: "Actions",
      icon: "routines",
      keywords: "heartbeats triggers schedule linear webhook automations",
      run: actions.openRoutines,
    },
    ...(orchestratorEnabled()
      ? [
          {
            id: "orchestrator",
            label: "Orchestrator",
            group: "Actions",
            icon: "orchestrator" as const,
            keywords: "board tasks route mascot box",
            run: actions.openOrchestrator,
          },
        ]
      : []),
    {
      id: "usage",
      label: "Token usage",
      group: "Actions",
      icon: "usage",
      keybinding: "usage.open" as const,
      keywords: "tokens cost spend analytics dollars models claude codex",
      run: actions.openUsage,
    },
    {
      id: "storage",
      label: "Clean up worktrees",
      group: "Actions",
      icon: "storage",
      keywords: "disk space worktrees clean up free what milagre uses",
      run: () => actions.openStorage(),
    },
    {
      id: "triage",
      label: "Triage an issue",
      group: "Actions",
      icon: "triage",
      keywords: "bug report problem diagnose help support broken",
      run: () => actions.startTriage(),
    },
    {
      id: "settings",
      label: "Settings",
      group: "Actions",
      icon: "settings",
      keybinding: "settings.open" as const,
      keywords: "preferences model permissions",
      run: () => actions.openSettingsAt("general"),
    },
    {
      id: "appearance",
      label: "Appearance settings",
      group: "Actions",
      icon: "settings",
      keywords: "theme preferences",
      run: () => actions.openSettingsAt("appearance"),
    },
    {
      id: "toggle-theme",
      label: "Toggle theme",
      group: "Actions",
      icon: "settings",
      keybinding: "theme.toggle" as const,
      keywords: "appearance switch color mode",
      run: actions.toggleTheme,
    },
    ...(ctx.projectSettings && ctx.current.path
      ? [
          {
            id: "design-library",
            label: "Design library",
            group: "Actions",
            icon: "library" as const,
            detail: ctx.current.name,
            keywords: "designs project library pages mockups",
            run: () => openDesignLibrary(ctx.current.path, ctx.current.name),
          },
        ]
      : []),
    ...(ctx.projectSettings
      ? [
          {
            id: "project-settings",
            label: "Project settings",
            group: "Actions",
            icon: "settings" as const,
            detail: ctx.current.name,
            keywords: "worktree setup files",
            run: actions.openProjectSettings,
          },
        ]
      : []),
  ];
}

function currentChatCommands(ctx: AppCommandContext, session: AgentSession): Command[] {
  const { actions, showGit } = ctx;
  const sessionId = session.id;
  return [
    ...(showGit
      ? [
          {
            id: "git",
            label: "Commit and open PR…",
            group: UI_COPY.currentChat,
            icon: "pullRequest" as const,
            keywords: "git changes pull request push",
            run: () => actions.openGitDialog(sessionId),
          },
        ]
      : []),
    ...(ctx.remoteProject || !showGit
      ? []
      : [
          {
            id: "editor",
            label: "Open in editor",
            group: UI_COPY.currentChat,
            icon: "editor" as const,
            keywords: "code vscode cursor",
            run: () => actions.openChatInEditor(sessionId),
          },
          {
            id: "reveal",
            label: "Reveal folder",
            group: UI_COPY.currentChat,
            icon: "folder" as const,
            keywords: "finder explorer worktree",
            run: () => actions.revealChat(sessionId),
          },
        ]),
    ...(ctx.chatCount
      ? [
          {
            id: "find",
            label: UI_COPY.findInChat,
            group: UI_COPY.currentChat,
            icon: "search" as const,
            keybinding: "chat.find" as const,
            keywords: "search text messages",
            run: actions.openFind,
          },
        ]
      : []),
    {
      id: "unread",
      label: session.unread ? "Mark as read" : "Mark as unread",
      group: UI_COPY.currentChat,
      icon: "unread",
      run: () => actions.setUnread(sessionId, !session.unread),
    },
    {
      id: "btw",
      label: "Ask a side question",
      group: UI_COPY.currentChat,
      icon: "message",
      keywords: "btw ephemeral side question",
      run: () => requestSideQuestion(`${ctx.current.path}#${sessionId}`),
    },
    {
      id: "fork",
      label: UI_COPY.forkChat,
      group: UI_COPY.currentChat,
      icon: "git",
      keywords: "branch duplicate clone copy conversation",
      run: async () => {
        const result = await bridgeForKey(ctx.current.path).forkChat(ctx.current.path, sessionId);
        actions.openChat(result.sessionId);
      },
    },
    {
      id: "reload",
      label: UI_COPY.reloadChat,
      group: UI_COPY.currentChat,
      icon: "reload",
      hint: RELOAD_HINT,
      keywords: "restart agent mcp skills login refresh",
      run: () => void actions.reloadChat(sessionId),
    },
    {
      id: "report-bug",
      label: UI_COPY.reportMilagreBug,
      group: UI_COPY.currentChat,
      icon: "triage",
      keywords: "bug report issue github problem broken feedback",
      run: () => actions.reportMilagreBug(sessionId),
    },
  ];
}

function chatDetail(chat: SidebarRecent) {
  const status =
    chat.mark === "waiting" || chat.mark === "question"
      ? "Needs you"
      : chat.mark === "running"
        ? "Working"
        : chat.mark === "background"
          ? "In the background"
          : chat.unread
            ? "Unread"
            : "";
  return [status, chat.details?.branch].filter(Boolean).join(" · ");
}

function chatCommands(chats: SidebarRecent[], openChat: (sessionId: number) => void): Command[] {
  return chats.map((chat): Command => ({
    id: `chat:${chat.id}`,
    label: chat.label,
    group: "Chats",
    icon: "chat",
    detail: chatDetail(chat),
    keywords: [chat.details?.path, ...(chat.details?.pullRequests ?? []).flatMap((pr) => [pr.title, `#${pr.number}`])].filter(Boolean).join(" "),
    run: () => openChat(Number(chat.id)),
  }));
}

function projectCommands(ctx: AppCommandContext): Command[] {
  return ctx.recentProjects
    .filter((recent) => recent.path !== ctx.current.path)
    .map((recent): Command => ({
      id: `project:${recent.path}`,
      label: recent.name,
      group: "Projects",
      icon: "folder",
      detail: recent.path,
      run: () => {
        void ctx.actions.switchProject(recent.path);
      },
    }));
}

export function buildCommands(ctx: AppCommandContext): Command[] {
  const { actions, selectedSession } = ctx;
  const commands = actionCommands(ctx);
  if (ctx.view === "routines" || ctx.settingsOpen)
    commands.push({
      id: "back-to-chat",
      label: UI_COPY.backToChat,
      group: "Actions",
      icon: "chat",
      run: actions.backToChat,
    });
  if (ctx.layout === "grid")
    commands.push({
      id: "chat-layout",
      label: "Show one Chat",
      group: "Actions",
      icon: "chat",
      keywords: "grid layout split multiple chats tiles",
      run: actions.showOneChat,
    });
  commands.push(...settingsCommands(getSettings(), updateSettings));
  if (selectedSession && ctx.view === "chat" && !ctx.settingsOpen) {
    commands.unshift(...currentChatCommands(ctx, selectedSession));
    const worktreePath = ctx.selectedWorktreePath;
    if (worktreePath !== undefined && ctx.showGit)
      commands.splice(3, 0, {
        id: "copy-path",
        label: UI_COPY.copyWorktreePath,
        group: UI_COPY.currentChat,
        icon: "copy",
        run: () => actions.copyPath(worktreePath),
      });
  }
  commands.push(...chatCommands(ctx.chats, actions.openChat));
  commands.push(...projectCommands(ctx));
  commands.push(...settingsPageCommands((section, row) => actions.openSettingsAt(section, row)));
  return commands;
}

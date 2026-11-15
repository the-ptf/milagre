import { settleSnooze, snoozeAt, snoozeMarkFor, WAKE, type SnoozeMark } from "./snooze-actions";
import { chatSummary } from "@milagre/shared/chat-summary";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { appVersionLine } from "./app-version";
import * as Clipboard from "expo-clipboard";
import type { Href } from "expo-router";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import { chatTitle } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";
import type { Client } from "./client";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { useComposer, type MobilePendingChat, type Session } from "./session";
import { savedChatDefaults, savedChatPins } from "./hosts-native";
import { newChatProjects, noProjectChoice, pickNewChatProject } from "./new-chat-project";
import { useLinks } from "./use-links";
import { endNamer, linkWorktree, linkedLabels, type LinkChat } from "./chat-links";
import { linkWithChat, removeLinkFromChat } from "./link-actions";
import { afterSend, selectedModel, sendOptions, turnTarget } from "./turn-options";
import { shownChat } from "./chat-list-filter";
import { runChatAction } from "./chat-actions";
import { closeBeside, openBeside } from "./split-chats";
import { confirm } from "./confirm-store";
import { confirmLinkDelete, linkDeleteError } from "./link-delete";
import { deletedLinkText } from "@milagre/shared/worktree-link";
import { showChoiceSheet } from "./choice-store";
import { clearArchiveNotice, showArchiveNotice } from "./archive";
import { undoHistory } from "./undo-history";
import type { UndoAction } from "@milagre/shared/undo-history";
import { lastUserModel } from "@milagre/shared/agent-runs";
import { CHAT_ROW_FIELDS } from "@milagre/shared/chat-row";
import { saveChatRowShow, useChatRowShow } from "./chat-row-store";
import { allComputers, chatsHomePath } from "./all-computers";
import type { ProjectCopy } from "./all-computers-store";
import { SENT_FROM } from "./sent-from";
import { type Destination, type HostBuild, type DoneMark, type Show } from "./navigation-build";
import { type RowActions, type RowView } from "./navigation-row";

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { HostView } from "./all-computers-store";

// What a Chat row can show under its title (the Filters menu's "On Chats"); the computer is a desktop choice.
export const ROW_FIELDS = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer");
/** What the sidebar's actions read and set: its state, the session and how it routes. */
export type NavigationActionsContext = {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  session: Session;
  currentHostId?: string;
  currentPath?: string;
  activeChatId?: number;
  onNavigate: Destination;
  onClose?: () => void;
  docked: boolean;
  snoozeMinutes: number;
  clientOf: (hostId: string) => Client | null;
  copyOf: (hostId: string, projectPath: string) => ProjectCopy | undefined;
  archiveRequests: Set<string>;
  setDoneMarks: Dispatch<SetStateAction<ReadonlyMap<string, DoneMark>>>;
  setSnoozeMarks: Dispatch<SetStateAction<ReadonlyMap<string, SnoozeMark>>>;
  alive: RefObject<boolean>;
  links: ReturnType<typeof useLinks>;
  worktreeForLinks: RowView["worktreeForLinks"];
  endNames: ReturnType<typeof endNamer>;
  builds: HostBuild[];
  readComposer: () => ReturnType<typeof useComposer>;
  load: RowActions["load"];
  views: HostView[];
  addHostId: string | undefined;
  setPage: (page: "add" | null) => void;
  setAddHostId: (hostId: string | undefined) => void;
  setChatsFolded: Dispatch<SetStateAction<boolean>>;
  setDoneOpen: Dispatch<SetStateAction<boolean>>;
  setSnoozedOpen: Dispatch<SetStateAction<boolean>>;
  setSubchatOpen: Dispatch<SetStateAction<ReadonlySet<string>>>;
  registerHeader: RowActions["registerHeader"];
  reorderProjects: RowActions["reorderProjects"];
  rowShow: ReturnType<typeof useChatRowShow>;
  setShow: (show: Show) => void;
};

/** Opening a Chat or a new Chat, on its own computer. */
function openActions(ctx: NavigationActionsContext) {
  const { busy, setBusy, setError, session, currentHostId, currentPath, activeChatId, onNavigate, onClose, alive } = ctx;
  /** Where a Chat or a new Chat goes on the computer `hostId`, which is the connected one by now. */
  function navigateTo(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string) {
    // Every route opens its Chat alone: the beside Chat's state outlives the route, so a split ends here, not by itself.
    closeBeside();
    const params = { projectPath, hostId };
    if (chatId === undefined)
      onNavigate({
        pathname: "/chat",
        params: prefill ? { ...params, prefill } : params,
      });
    else if (hostId === currentHostId && projectPath === currentPath && chatId === activeChatId && onClose) onClose();
    else if (pending?.accepted && pending.preview.targetSessionId !== null)
      onNavigate({
        pathname: "/chat",
        params: { ...params, id: String(pending.preview.targetSessionId) },
      });
    else if (pending)
      onNavigate({
        pathname: "/chat",
        params: {
          ...params,
          ...(pending.originSessionId !== null
            ? { id: String(pending.originSessionId) }
            : {
                worktreeId: String(pending.worktreeId),
                ...(pending.draft ? { draft: pending.draft } : {}),
              }),
        },
      });
    else
      onNavigate({
        pathname: "/chat",
        params: {
          ...params,
          id: String(chatId),
        },
      });
  }
  // Revisited Chats adopt their full cached Project before routing, including on another computer. Only a cold
  // destination needs to wait for its computer; messages start reading during the route handoff.
  async function enter(hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string) {
    if (busy) return;
    const host = hostId === currentHostId ? undefined : allComputers.hostFor(hostId);
    if (chatId !== undefined && !pending && (hostId === currentHostId || host)) {
      const cached = session.openCachedChat(projectPath, chatId, host);
      if (cached) {
        navigateTo(hostId, projectPath, chatId);
        return;
      }
    }
    if (hostId === currentHostId && session.client) {
      navigateTo(hostId, projectPath, chatId, pending, prefill);
      return;
    }
    if (!host) {
      setError("This computer is no longer in your list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (chatId !== undefined && !pending) {
        if (!(await session.openNotificationTarget(host, projectPath, chatId)) || !alive.current) return;
      } else if (!(await session.connect(host, false)) || !alive.current) return;
      navigateTo(hostId, projectPath, chatId, pending, prefill);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { navigateTo, enter };
}

/** Linking a Chat's Worktree with another Chat's, and asking it from the link. */
function linkActions(ctx: NavigationActionsContext, open: ReturnType<typeof openActions>) {
  const { setError, session, currentHostId, currentPath, copyOf, links, worktreeForLinks, endNames, builds, readComposer, load } = ctx;
  const { navigateTo } = open;
  /** A Chat as the Link picker names it, or undefined when it can't join a Link (no Worktree, not a local Project). */
  function linkChatOf(projectPath: string, chat: AgentSession, messages?: Parameters<typeof chatTitle>[1]): LinkChat | undefined {
    const copy = copyOf(currentHostId ?? "", projectPath);
    const worktree = copy && !copy.project.link ? copy.project.state.worktrees[chat.worktree_id] : undefined;
    const target = worktreeForLinks(projectPath, worktree?.path);
    if (!copy || !worktree || !target) return undefined;
    return {
      projectPath: copy.project.path,
      projectName: links.projectNameOf(target.project_id) || copy.project.name || projectPath.split("/").at(-1) || "Project",
      projectId: target.project_id,
      chatId: chat.id,
      title: chatTitle(chat, messages ?? (copy.project.state.messages || []).filter((message) => message.session_id === chat.id)),
      branch: worktree.name,
      worktreePath: worktree.path,
    };
  }
  // The Chats "Link with…" offers: those listed in every local Project of the open computer, newest first.
  function linkChats() {
    const build = builds.find((item) => item.hostId === currentHostId);
    const paths = [
      ...new Set([currentPath, ...(build?.projects.map((item) => item.path) ?? [])].filter((path): path is string => !!path && !isLinkScopeKey(path))),
    ];
    return paths.flatMap((projectPath) => {
      const copy = copyOf(currentHostId ?? "", projectPath);
      if (!copy || copy.project.link) return [];
      const byChat = new Map<number, typeof copy.project.state.messages>();
      for (const message of copy.project.state.messages || []) {
        const list = byChat.get(message.session_id) || [];
        list.push(message);
        byChat.set(message.session_id, list);
      }
      return Object.values(copy.project.state.sessions)
        .filter((chat) => !chat.archived && shownChat(chat, copy.runs.runs[`${copy.project.path}#${chat.id}`], chatSummary(chat, byChat.get(chat.id)).count))
        .sort((a, b) => b.id - a.id)
        .flatMap((chat) => linkChatOf(projectPath, chat, byChat.get(chat.id) ?? []) ?? []);
    });
  }
  // "Link and ask" sends to the source Chat as its composer would: its own provider and model, its permission mode.
  async function askChat(projectPath: string, chat: AgentSession, message: { body: string; prompt: string }) {
    const copy = copyOf(currentHostId ?? "", projectPath);
    const client = session.client;
    const composer = readComposer();
    if (!copy || !client) throw new Error("Connection lost. Reconnect to your computer.");
    const key = `${copy.project.path}#${chat.id}`;
    const preferences = composer.preferences[key] || composer.defaults;
    const turn = turnTarget(composer.preferences[key], chat.provider, composer.defaults);
    const model = selectedModel(turn.provider, turn.model || (!turn.picked ? lastUserModel(copy.project.state, chat.id) : ""), session.models);
    await client.call("chat:send", [
      {
        projectPath: copy.project.path,
        sessionId: chat.id,
        worktreeId: chat.worktree_id,
        ...message,
        ...sendOptions(model, preferences),
        sentFrom: SENT_FROM,
      },
    ]);
    composer.setPreferences((current) => ({
      ...current,
      [key]: afterSend(current[key] || preferences, turn, chat.provider, model.id, !!copy.runs.runs[key]),
    }));
    session.expectActivity();
    await load(client.url, projectPath).catch(() => {});
  }
  function linkAction(projectPath: string, chat: AgentSession, action: "link-with" | "link-remove") {
    const client = session.client;
    const source = linkChatOf(projectPath, chat);
    if (!client || !source) return;
    setError("");
    clearArchiveNotice();
    if (action === "link-with")
      linkWithChat({
        client,
        links: links.links,
        source,
        chats: linkChats(),
        send: (message) => askChat(projectPath, chat, message),
        notify: showArchiveNotice,
        onAsked: () => navigateTo(client.url, projectPath, chat.id),
      });
    else
      void removeLinkFromChat({
        client,
        ends: linkedLabels(links.links, linkWorktree(source), endNames),
        notify: showArchiveNotice,
      });
  }
  return { linkChatOf, linkChats, askChat, linkAction };
}

/** A Chat row's ⋯ choices, with their steps in the undo history. */
function chatActions(ctx: NavigationActionsContext, link: ReturnType<typeof linkActions>) {
  const {
    setError,
    session,
    currentHostId,
    currentPath,
    activeChatId,
    onNavigate,
    docked,
    snoozeMinutes,
    clientOf,
    copyOf,
    archiveRequests,
    setDoneMarks,
    setSnoozeMarks,
    alive,
  } = ctx;
  const { linkAction } = link;
  /** Done, Reopen, Pin and Unpin as steps in the undo history; undefined for the actions it doesn't take back. */
  function undoStep(row: { hostId: string; path: string; chat: AgentSession; home?: boolean }, action: string): UndoAction | undefined {
    const run = (next: string) => () => void act(row, next, false);
    if (action === "done")
      return {
        text: "Moved to Done",
        kind: "done",
        undoneText: "Back in Chats",
        place: "list",
        // Done also marked it read; Undo puts back the unread it had.
        undo: () => void act(row, "reopen", false).then(() => (row.chat.unread ? act(row, "unread", false) : undefined)),
        redo: run("done"),
      };
    if (action === "reopen")
      return {
        text: "Back in Chats",
        kind: "undone",
        undoneText: "Moved to Done",
        undoneKind: "done",
        place: "list",
        undo: run("done"),
        redo: run("reopen"),
      };
    // A snooze arrives here settled ("snooze-at:<ms>"), so Redo snoozes to the same time.
    const snooze = snoozeMarkFor(action);
    if (snooze?.until)
      return {
        text: "Snoozed",
        undoneText: "Back in Chats",
        place: "list",
        undo: run(WAKE),
        redo: run(action),
      };
    // Undoing a Wake snoozes it again until the time it had, while that is still ahead.
    const wakeAt = row.chat.snoozed_until;
    if (action === WAKE && wakeAt && wakeAt > Date.now())
      return {
        text: "Back in Chats",
        kind: "undone",
        undoneText: "Snoozed",
        place: "list",
        undo: run(snoozeAt(wakeAt)),
        redo: run(WAKE),
      };
    if (action === "pin" || action === "unpin") {
      const other = action === "pin" ? "unpin" : "pin";
      return {
        text: action === "pin" ? "Pinned" : "Unpinned",
        undoneText: other === "pin" ? "Pinned" : "Unpinned",
        place: "list",
        undo: run(other),
        redo: run(action),
      };
    }
    return undefined;
  }
  // A Chat's ⋯ choice runs against its own computer's client and its own Project's copy, which is reread afterwards.
  // Archive stays in this sidebar, including when its Chat is open behind it, so the row's progress and the list's
  // scroll position stay in place.
  async function act(row: { hostId: string; path: string; chat: AgentSession; home?: boolean }, choice: string, record = true) {
    const { hostId, path: projectPath, chat } = row;
    // A Snooze choice takes its wake time now, when it is picked.
    const action = settleSnooze(choice, snoozeMinutes);
    if (action === "open-beside") {
      openBeside({ hostId, projectPath, chatId: chat.id });
      return;
    }
    const client = clientOf(hostId);
    const copy = copyOf(hostId, projectPath);
    if (!copy || !client) return;
    const isCurrent = hostId === currentHostId;
    if (action === "link-with" || action === "link-remove") {
      if (isCurrent) linkAction(projectPath, chat, action);
      return;
    }
    const archiveKey = `${hostId}|${projectPath}#${chat.id}`;
    if (archiveRequests.has(archiveKey)) return;
    // Done and Reopen move the row now; the computer saves it meanwhile, and its copy takes over once read again.
    const doneMark: DoneMark | undefined = action === "done" ? { doneAt: Date.now() } : action === "reopen" ? { doneAt: null } : undefined;
    const settleDone = () =>
      doneMark &&
      alive.current &&
      setDoneMarks((marks) => {
        if (marks.get(archiveKey) !== doneMark) return marks;
        const next = new Map(marks);
        next.delete(archiveKey);
        return next;
      });
    if (doneMark) setDoneMarks((marks) => new Map(marks).set(archiveKey, doneMark));
    // Snooze and Wake move the row now too.
    const snoozeMark = snoozeMarkFor(action);
    const settleSnoozeMark = () =>
      snoozeMark &&
      alive.current &&
      setSnoozeMarks((marks) => {
        if (marks.get(archiveKey) !== snoozeMark) return marks;
        const next = new Map(marks);
        next.delete(archiveKey);
        return next;
      });
    if (snoozeMark) setSnoozeMarks((marks) => new Map(marks).set(archiveKey, snoozeMark));
    // Done, Reopen and pins join the undo history: the toast's Undo and Redo (and an iPad's ⌘Z / ⇧⌘Z) run their opposite
    // through here again, unrecorded.
    const step = record ? undoStep(row, action) : undefined;
    if (step) undoHistory.record(step);
    if (action === "archive") archiveRequests.add(archiveKey);
    let confirmed = false;
    setError("");
    clearArchiveNotice();
    try {
      await runChatAction({
        action,
        chat,
        running: !!copy.runs.runs[`${copy.project.path}#${chat.id}`],
        client,
        projectPath: copy.project.path,
        state: copy.project.state,
        link: copy.project.link,
        chatsHome: row.home,
        hostId,
        pins: {
          saved: savedChatPins.pins(hostId),
          set: (sessions, id, order) => savedChatPins.set(hostId, copy.project.path, sessions, id, order),
        },
        onConfirm: () => {
          confirmed = true;
        },
        // The phone may show another Project by the time the archive ends, so the list's copy is read again too.
        refresh: () =>
          !isCurrent || projectPath !== currentPath
            ? allComputers.refreshProject(hostId, projectPath)
            : Promise.all([session.refresh(), action === "archive" ? allComputers.refreshProject(hostId, projectPath) : undefined]),
        expectActivity: session.expectActivity,
        notify: showArchiveNotice,
      });
      // Done on the open Chat leaves it for a new Chat in its Project beside the pinned sidebar, as on the desktop.
      // A phone stays on the sidebar.
      if (action === "done" && docked && isCurrent && projectPath === currentPath && chat.id === activeChatId && alive.current)
        onNavigate({ pathname: "/chat", params: { projectPath, hostId } });
    } catch (e) {
      if (step) undoHistory.drop(step);
      if (confirmed) showArchiveNotice(`Could not delete Chat: ${(e as Error).message}`);
      else if (alive.current) setError((e as Error).message);
    } finally {
      archiveRequests.delete(archiveKey);
      settleDone();
      settleSnoozeMark();
    }
  }
  return { undoStep, act };
}

/** A Project header's ⋯ choices, a Link's deletion and adding a Project. */
function projectActions(ctx: NavigationActionsContext, open: ReturnType<typeof openActions>) {
  const { busy, setBusy, setError, session, currentHostId, currentPath, onNavigate, clientOf, alive, builds, addHostId, setPage, setAddHostId } = ctx;
  const { enter } = open;
  // Removing a Project takes it off the recent list, as desktop does; its folder and Chats stay on the Mac.
  async function projectAction(hostId: string, projectPath: string, name: string, action: string) {
    if (action === "new") {
      void enter(hostId, projectPath);
      return;
    }
    const isCurrent = hostId === currentHostId;
    if (isLinkScopeKey(projectPath)) {
      const linkId = projectPath.slice("milagre-link:".length);
      if (action === "copy") await Clipboard.setStringAsync(name);
      if (action === "edit" && isCurrent) onNavigate({ pathname: "/link-projects", params: { linkId } }, true);
      if (action === "delete" && isCurrent) await deleteLink(linkId, projectPath, name);
      return;
    }
    if (action === "copy") {
      await Clipboard.setStringAsync(projectPath);
      return;
    }
    const client = clientOf(hostId);
    if (action !== "remove" || !client) return;
    const confirmed = await confirm(
      `Remove ${name}?`,
      "It leaves this list on your phone and your computer. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back. Running Chats keep running.",
      "Remove",
    );
    if (!confirmed) return;
    setError("");
    try {
      if (isCurrent) {
        const sameNavigation = await session.forgetProject(projectPath);
        if (sameNavigation && projectPath === currentPath) onNavigate("/projects");
      } else await client.call("project:forget", [projectPath]);
      await allComputers.refreshAll();
    } catch (e) {
      const message = (e as Error).message;
      if (alive.current) setError(/not available from mobile/i.test(message) ? "Update Milagre on your computer to remove Projects from your phone." : message);
    }
  }
  // Deleting a Link asks first, as desktop does; the open one leaves for this list, and Worktrees it kept are named.
  async function deleteLink(linkId: string, projectPath: string, name: string) {
    const client = session.client;
    if (!client) return;
    setError("");
    try {
      if (!(await confirmLinkDelete(client.call, linkId, name))) return;
      const { result, sameNavigation } = await session.deleteLink(linkId);
      if (sameNavigation && projectPath === currentPath) onNavigate("/projects");
      const kept = deletedLinkText(name, result.kept);
      if (kept) showArchiveNotice(kept);
      await allComputers.refreshAll();
    } catch (e) {
      if (alive.current) setError(linkDeleteError(e));
    }
  }
  // A typed path opens like any Project: the Chat loads it behind the splash mark and shows a wrong path with Retry.
  function addProject(projectPath: string) {
    const hostId = addHostId ?? session.client?.url;
    if (busy || !hostId) return;
    setPage(null);
    onNavigate({ pathname: "/chat", params: { projectPath, hostId } });
  }
  /** Which computer a Project or New Chat goes to when several are listed; null when the pick was dismissed. */
  function chooseComputer(title: string): Promise<string | null> {
    const reachable = builds.filter((build) => build.reach !== "offline");
    if (reachable.length <= 1) return Promise.resolve(reachable[0]?.hostId ?? currentHostId ?? null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (id: string | null) => {
        if (done) return;
        done = true;
        resolve(id);
      };
      showChoiceSheet({
        title,
        placeholder: "Search computers",
        emptyLabel: "No computers",
        icon: LaptopIcon,
        items: reachable.map((build) => ({
          id: build.hostId,
          title: build.hostName,
          checked: build.hostId === currentHostId,
        })),
        onSelect: finish,
      });
    });
  }
  async function startAddProject() {
    const hostId = await chooseComputer("Add project to");
    if (!hostId || busy) return;
    if (hostId !== currentHostId) {
      const host = allComputers.hostFor(hostId);
      if (!host) return;
      setBusy(true);
      setError("");
      try {
        if (!(await session.connect(host, false)) || !alive.current) return;
      } catch (e) {
        if (alive.current) setError((e as Error).message);
        return;
      } finally {
        if (alive.current) setBusy(false);
      }
    }
    setAddHostId(hostId);
    setPage("add");
  }
  return { projectAction, deleteLink, addProject, chooseComputer, startAddProject };
}

/** New Chat, a Chat without a Project, triage, and the header's and Filters menus. */
function newChatActions(ctx: NavigationActionsContext, open: ReturnType<typeof openActions>, project: ReturnType<typeof projectActions>) {
  const { busy, setError, currentHostId, currentPath, onNavigate, clientOf, alive, views, rowShow, setShow } = ctx;
  const { enter } = open;
  const { startAddProject } = project;
  // New Chat opens in the Project the last new Chat started in (else the open one); the Chat screen switches Projects.
  // A search that found nothing comes along as the new Chat's draft.
  function startNewChat(prefill?: string) {
    const target = pickNewChatProject(
      newChatProjects(views),
      savedChatDefaults.readLastProject(),
      currentPath ? { hostId: currentHostId ?? "", projectPath: currentPath } : null,
    );
    if (!target) {
      // With no Project anywhere, a Chat without one is still there to start.
      if (noProjectChoice(views, null, currentHostId)) void startWithoutProject();
      else setError("Add a project from your computer to start a Chat.");
      return;
    }
    void enter(target.hostId, target.path, undefined, undefined, prefill);
  }
  // The Chats group's +: a Chat without a Project, on the computer the last new Chat started on (else the open one).
  async function startWithoutProject() {
    const choice = noProjectChoice(views, savedChatDefaults.readLastComputer(), currentHostId);
    const copy = choice?.copies.find((item) => item.hostId === choice.computerId);
    const client = copy && !copy.offline ? clientOf(copy.hostId) : null;
    if (busy) return;
    if (!copy || !client) {
      setError("Connect to your computer to start a Chat.");
      return;
    }
    setError("");
    try {
      const path = await chatsHomePath(client, copy.hostId, copy.home);
      if (alive.current) await enter(copy.hostId, path);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }
  // As desktop's palette row: a new Chat whose draft points its agent at a triage playbook, on the computer New Chat would
  // pick. The user writes what went wrong after it.
  async function startTriage() {
    const target = pickNewChatProject(
      newChatProjects(views),
      savedChatDefaults.readLastProject(),
      currentPath ? { hostId: currentHostId ?? "", projectPath: currentPath } : null,
    );
    const client = target && clientOf(target.hostId);
    if (!target || !client) {
      setError("Add a project from your computer to triage an issue.");
      return;
    }
    try {
      const { prompt } = await client.call<{ prompt: string }>("triage:prepare", [
        `Milagre for ${Platform.OS === "ios" ? "iPhone" : "Android"} ${appVersionLine()}`,
      ]);
      await enter(target.hostId, target.path, undefined, undefined, prompt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start triage.");
    }
  }
  function menuChoice(id: string) {
    if (id === "triage") void startTriage();
    else if (id === "add") void startAddProject();
    else if (id === "link") onNavigate("/link-projects", true);
    else if (id === "canvas") onNavigate("/canvas", true);
  }
  function filterChoice(id: string) {
    const field = ROW_FIELDS.find((item) => id === `field:${item.id}`);
    if (field) saveChatRowShow({ ...rowShow, [field.id]: !rowShow[field.id] });
    else if (id === "choose-projects") onNavigate("/choose-projects", "sheet");
    else setShow(id as Show);
  }
  return { startNewChat, startWithoutProject, startTriage, menuChoice, filterChoice };
}

/** Every action of the sidebar for this render, and the row actions that always run the latest of them. */
export function useNavigationActions(ctx: NavigationActionsContext) {
  const open = openActions(ctx);
  const project = projectActions(ctx, open);
  const current = { ...open, ...chatActions(ctx, linkActions(ctx, open)), ...project, ...newChatActions(ctx, open, project) };
  const { onNavigate, setChatsFolded, setDoneOpen, setSnoozedOpen, setSubchatOpen, load, registerHeader, reorderProjects } = ctx;
  const { enter, act, projectAction, startNewChat, startWithoutProject } = current;
  // The rows render apart (NavigationRow), from what they show and actions that always run the latest closures: a render of
  // the list that changes nothing a row shows (a search keystroke elsewhere, a poll that found nothing new) skips them.
  const latestActions = useRef<RowActions | null>(null);
  useLayoutEffect(() => {
    latestActions.current = {
      enter,
      act,
      projectAction,
      startNewChat,
      startWithoutProject,
      // Routines is a page of the app; the rest open in the Settings sheet, with Settings under them to go back to.
      openSetting: (page, find) =>
        onNavigate(find ? { pathname: `/${page}`, params: { find, findAt: String(Date.now()) } } : (`/${page}` as Href), page === "routines" ? true : "sheet"),
      foldChats: () => setChatsFolded((folded) => !folded),
      foldDone: () => setDoneOpen((open) => !open),
      foldSnoozed: () => setSnoozedOpen((open) => !open),
      foldSubchats: (key) =>
        setSubchatOpen((open) => {
          const next = new Set(open);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
      load,
      registerHeader,
      reorderProjects,
    };
  });
  const actions = useMemo<RowActions>(
    () => ({
      enter: (...args) => latestActions.current!.enter(...args),
      act: (...args) => latestActions.current!.act(...args),
      projectAction: (...args) => latestActions.current!.projectAction(...args),
      startNewChat: (...args) => latestActions.current!.startNewChat(...args),
      startWithoutProject: () => latestActions.current!.startWithoutProject(),
      openSetting: (...args) => latestActions.current!.openSetting(...args),
      foldChats: () => latestActions.current!.foldChats(),
      foldDone: () => latestActions.current!.foldDone(),
      foldSnoozed: () => latestActions.current!.foldSnoozed(),
      foldSubchats: (key) => latestActions.current!.foldSubchats(key),
      load: (...args) => latestActions.current!.load(...args),
      registerHeader: (...args) => latestActions.current!.registerHeader(...args),
      reorderProjects: (...args) => latestActions.current!.reorderProjects(...args),
    }),
    [],
  );
  return { ...current, actions };
}

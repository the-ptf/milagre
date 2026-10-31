import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { AgentSession, OpenLink } from "@milagre/shared/model";
import type { Client } from "./client";
import type { MenuSection } from "./ui";
import { archiveFromPhone, startArchiving, type ArchiveRequest } from "./archive";
import { archiveLinkChat } from "@milagre/shared/archive";
import { pinPatch } from "./pins";

/**
 * Desktop's ⋯ menu for a Chat, less what only makes sense at the Mac (Finder, editor, commit). `links` is the Link
 * section (chat-links.ts `linkMenuSection`), which goes after the pins when the Chat can be linked. `beside` leads with
 * "Open beside", which a wide iPad offers for another Chat on a computer that answers (split-chats.ts).
 */
/**
 * `project` false: a Chat without a Project, whose Worktree is the Chats home's own, internal to Milagre: no path or
 * branch to copy.
 */
export function chatMenu(
  chat: AgentSession,
  worktree?: { path?: string; name?: string },
  links?: MenuSection | null,
  beside = false,
  project = true,
  /** The Chat's Mac keeps Done; an older one gets no Mark Done or Reopen. */
  doneable = true,
): MenuSection[] {
  return [
    ...(beside ? [{ items: [{ id: "open-beside", title: "Open beside", systemImage: "rectangle.split.2x1" }] }] : []),
    ...(project
      ? [
          {
            items: [
              { id: "copy-path", title: "Copy path", systemImage: "doc.on.doc", disabled: !worktree?.path },
              { id: "copy-branch", title: "Copy branch name", systemImage: "arrow.triangle.branch", disabled: !worktree?.name },
            ],
          },
        ]
      : []),
    {
      items: [
        { id: "rename", title: "Rename chat", systemImage: "pencil" },
        chat.unread ? { id: "read", title: "Mark as read", systemImage: "checkmark" } : { id: "unread", title: "Mark as unread", systemImage: "circle" },
      ],
    },
    // Desktop drags pinned chats into order; here they move one place at a time.
    {
      items: chat.pinned
        ? [
            { id: "unpin", title: "Unpin", systemImage: "pin.slash" },
            { id: "pin-up", title: "Move up", systemImage: "arrow.up" },
            { id: "pin-down", title: "Move down", systemImage: "arrow.down" },
          ]
        : [{ id: "pin", title: "Pin", systemImage: "pin" }],
    },
    ...(links ? [links] : []),
    {
      items: [
        ...(chat.archived || !doneable
          ? []
          : chat.done_at
            ? [{ id: "reopen", title: "Reopen", systemImage: "arrow.uturn.backward" }]
            : [{ id: "done", title: "Mark Done", systemImage: "checkmark.circle" }]),
        chat.archived
          ? { id: "archive", title: "Restore", systemImage: "tray.and.arrow.up" }
          : { id: "archive", title: "Delete", systemImage: "trash", destructive: true },
      ],
    },
  ];
}

/**
 * Runs a choice from `chatMenu` against the Chat's Project. Delete acts immediately and stops a running Chat. `onConfirm` runs once the archive goes ahead: a screen showing
 * the Chat leaves then, not when the archive ends, by which time the phone may be somewhere else.
 */
export async function runChatAction({
  action,
  chat,
  running,
  client,
  projectPath,
  state,
  link,
  chatsHome,
  hostId,
  refresh,
  expectActivity,
  notify,
  onConfirm,
}: {
  action: string;
  chat: AgentSession;
  running: boolean;
  client: Client;
  projectPath: string;
  state: ArchiveRequest["state"];
  link?: OpenLink;
  /** The Chat has no Project. */
  chatsHome?: boolean;
  /** The Computer the Chat is on, so its deletion hides and undoes only its own row. */
  hostId?: string;
  onConfirm?: () => void;
  refresh: () => Promise<unknown>;
  expectActivity: () => void;
  notify: (message: string) => void;
}) {
  if (action === "archive" && !chat.archived) {
    if (link) {
      const done = startArchiving(`${projectPath}#${chat.id}`);
      try {
        onConfirm?.();
        expectActivity();
        await archiveLinkChat({
          running,
          stop: () => client.call("agent:interrupt", [`${projectPath}#${chat.id}`]),
          hide: () => client.call("chat:delete", [projectPath, chat.id]),
        });
        await refresh();
      } finally {
        done();
      }
      return "hidden";
    }
    return archiveFromPhone({
      client,
      projectPath,
      state,
      chat,
      running,
      chatsHome,
      hostId,
      onConfirm: () => {
        onConfirm?.();
        expectActivity();
      },
      notify,
      refresh: async () => {
        await refresh();
      },
    });
  }
  if (action === "archive") await client.call("chat:patch", [projectPath, chat.id, { archived: false }]);
  if (action === "pin" || action === "unpin" || action === "pin-up" || action === "pin-down") {
    const patch = pinPatch(action, chat, Object.values(state.sessions));
    if (patch) await client.call("chat:patch", [projectPath, chat.id, patch]);
  }
  if (action === "read" || action === "unread") await client.call("chat:patch", [projectPath, chat.id, { unread: action === "unread" }]);
  // The Mac stamps when it went Done, so the countdown follows its clock, not the phone's.
  if (action === "done") await client.call("chat:patch", [projectPath, chat.id, { done: true, unread: false }]);
  if (action === "reopen") await client.call("chat:patch", [projectPath, chat.id, { done: false }]);
  const worktree = state.worktrees[chat.worktree_id];
  if (action === "copy-path" && worktree) await Clipboard.setStringAsync(worktree.path);
  if (action === "copy-branch" && worktree) await Clipboard.setStringAsync(worktree.name);
  if (action === "rename") {
    const title = await new Promise<string | null>((resolve) =>
      Alert.prompt(
        "Rename Chat",
        undefined,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          { text: "Save", onPress: (value?: string) => resolve(value ?? null) },
        ],
        "plain-text",
        chat.title || chat.generatedTitle || "",
      ),
    );
    if (!title?.trim()) return;
    await client.call("chat:patch", [projectPath, chat.id, { title: title.trim() }]);
  }
  await refresh();
}

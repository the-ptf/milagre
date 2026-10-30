// Chat deletion shared by desktop and mobile. Internal archive names preserve the cleanup API.
// Each app supplies its own persistence and network operations. Types: archive.d.mts.
import { GIT_CODES, gitMessage } from "./git-codes.mjs";
import { ipcErrorCode, ipcErrorMessage } from "./result.mjs";

/** Whether `path` is a folder under one of `roots`, the folders Milagre keeps its worktrees in. */
export function isInsideRoots(path, roots) {
  return roots.some((root) => {
    const base = root.replace(/\/+$/, "");
    return base !== "" && path.startsWith(`${base}/`) && path.length > base.length + 1;
  });
}

/** A worktree Milagre created: it recorded a base, and the folder is under its worktree root. */
export function isMilagreWorktree(worktree, roots) {
  return Boolean(worktree?.base) && isInsideRoots(worktree.path, roots);
}

/** Whether another chat that isn't archived, even an empty one, uses the chat's worktree. */
export function worktreeShared(state, sessionId) {
  const worktreeId = state.sessions[sessionId]?.worktree_id;
  if (worktreeId === undefined) return false;
  return Object.values(state.sessions).some((session) => session.id !== sessionId && session.worktree_id === worktreeId && !session.archived);
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What would be lost, in a line: "3 uncommitted files and 2 unpushed commits will be lost". */
export function lossReason(status) {
  const parts = [
    ...(status.uncommitted > 0 ? [plural(status.uncommitted, "uncommitted file")] : []),
    ...(status.unpushed > 0 ? [plural(status.unpushed, "unpushed commit")] : []),
  ];
  // A detached HEAD is never removed safely: its commits belong to no branch.
  if (parts.length === 0) return "Its HEAD is detached, so what it holds isn't on a branch";
  return `${parts.join(" and ")} will be lost`;
}

/** The loss line and how to avoid it: "2 uncommitted files will be lost. Commit them first to keep them." */
export function deleteNote(status) {
  const pointer =
    status.uncommitted > 0 && status.unpushed > 0
      ? "Commit and push them first to keep them."
      : status.uncommitted > 0
        ? "Commit them first to keep them."
        : status.unpushed > 0
          ? "Push them first to keep them."
          : "Check out a branch first to keep it.";
  return `${lossReason(status)}. ${pointer}`;
}

/**
 * What a Chat without a Project would lose, in plain words: its folder is all the user knows of its Worktree.
 * "Its folder has 3 changed files that will be deleted."
 */
export function homeLossReason(status) {
  if (status.uncommitted > 0) return `Its folder has ${plural(status.uncommitted, "changed file")} that will be deleted.`;
  return "Its folder has saved work that will be deleted.";
}

/** Archive immediately. Only remove a worktree checked as safe; keep unsaved work for restoration. */
export function archiveMode(plan) {
  return plan?.milagreOwned && !plan.shared && plan.status?.removable ? "remove" : "hide";
}

/** The immediate deletion mode; shared, external and unchecked Worktrees stay. */
export function archiveChoices({ plan }) {
  const mode = archiveMode(plan);
  return { choices: [{ mode, label: "Delete", tone: "danger" }], reason: null, immediate: true };
}

/** How long a deleted Chat can still be brought back: its toast's Undo. The conversation and worktree go after it. */
export const DELETE_UNDO_MS = 6000;

// Deletions waiting out their Undo, by `projectPath#id`: each holds the function that calls the deletion off.
const undoable = new Map();

/**
 * Waits out a deletion's Undo. Resolves `true` when `undoDelete` called it off, `false` once the time is up. A second
 * wait on the same Chat ends the first as if its time were up.
 */
export function deleteUndoWindow(chatId, ms = DELETE_UNDO_MS) {
  undoable.get(chatId)?.(false);
  return new Promise((resolve) => {
    const finish = (undone) => {
      clearTimeout(timer);
      if (undoable.get(chatId) === finish) undoable.delete(chatId);
      resolve(undone);
    };
    const timer = setTimeout(() => finish(false), ms);
    // Node (the tests) needn't stay up for it; React Native's timers have no unref.
    timer.unref?.();
    undoable.set(chatId, finish);
  });
}

/** Calls off a deletion still waiting out its Undo; `false` when it has gone ahead (or never started). */
export function undoDelete(chatId) {
  const finish = undoable.get(chatId);
  if (!finish) return false;
  finish(true);
  return true;
}

/** What archiving ends among the chat's Terminals: those running a command, by its name. */
export function terminalNote(busy) {
  if (!busy.length) return null;
  if (busy.length === 1) return `Deleting ends the Terminal running ${busy[0]}.`;
  return `Deleting ends ${busy.length} Terminals running ${[...new Set(busy)].join(", ")}.`;
}

/**
 * The notice for a worktree that wouldn't go. The worktree is kept, so the chat is brought back with it
 * (hide-only archive would leave the worktree invisible), and the notice says so.
 */
export function removeFailureNotice(error) {
  // The daemon refuses a removal that the worktree outgrew after the user looked at it.
  if (ipcErrorCode(error) === GIT_CODES.WORKTREE_CHANGED) return gitMessage(GIT_CODES.WORKTREE_CHANGED);
  const message = ipcErrorMessage(error)
    .replace(/^fatal: /, "")
    .trim()
    .replace(/[.\s]+$/, "");
  return `Couldn't remove the worktree: ${message}. The chat stays so you can find it.`;
}

/**
 * Deletes a Chat. It is hidden at once; `undoWindow`, when given, then holds the permanent steps back, and an Undo in it
 * brings the Chat back ("undone") with nothing removed. After it the checked Worktree cleanup runs.
 * The worktree is removed only when the chosen mode asks for it, the menu's status is at hand, and no other chat
 * uses it by now. A refusal restores the Chat. With its Worktree kept, destroy removes the conversation.
 */
export async function archiveChat(deps, sessionId, mode, plan) {
  const latest = deps.getState();
  const worktree = latest ? latest.worktrees[latest.sessions[sessionId]?.worktree_id ?? -1] : undefined;
  const wantsRemoval = mode === "remove" || mode === "delete";
  // Another chat may have started using the worktree since the menu looked at it.
  const removing = wantsRemoval && latest && worktree?.base && plan?.status && !worktreeShared(latest, sessionId) ? worktree : null;
  // The window opens with the toast, before the host has answered the hide, so an Undo tapped at once still counts.
  const undone = deps.undoWindow?.();
  const stopped = deps.stop();
  await deps.hide();
  if (undone && (await undone)) {
    await deps.restore();
    return "undone";
  }
  if (!removing || !plan?.status) {
    try {
      await deps.destroy();
    } catch (error) {
      await deps.restore();
      throw error;
    }
    return "hidden";
  }
  const sessionIds = Object.values(latest.sessions)
    .filter((session) => session.worktree_id === removing.id)
    .map((session) => session.id);
  // The turn must have wound down before the daemon closes the agent and looks at the folder.
  await stopped;
  try {
    await deps.remove(removing, { force: mode === "delete", base: removing.base, projectPath: deps.projectPath, chatId: deps.chatId, seen: plan.status });
  } catch (error) {
    // The worktree stays, and with hide-only archive it would be invisible: the chat comes back with it.
    await deps.restore();
    deps.notify(removeFailureNotice(error));
    return "kept";
  }
  // The window moved to another project meanwhile: its selection isn't in that project any more.
  if (deps.currentProjectPath() !== deps.projectPath) return "removed";
  deps.applyRemoval({ worktreeId: removing.id, sessionIds });
  deps.refreshBranches();
  return "removed";
}

/**
 * Archives a shared (Link) Chat, which keeps its Worktrees. As `archiveChat` does, only a running turn is stopped, and
 * the stop never holds the archive up: waiting on it left the Chat unarchived whenever `agent:interrupt` timed out.
 */
export async function archiveLinkChat({ running, stop, hide }) {
  // The stop goes out first; one that throws or rejects is let go.
  if (running) new Promise((resolve) => resolve(stop())).catch(() => {});
  await hide();
}

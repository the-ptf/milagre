// /storage in the composer and the ⌘K entry open Clean up worktrees for a computer, over whatever is on screen.

export const OPEN_STORAGE = "milagre:open-storage";

/** Asks the app to open Clean up worktrees for `computerId` (null for this Mac). */
export function openStorage(computerId: string | null) {
  window.dispatchEvent(new CustomEvent(OPEN_STORAGE, { detail: computerId }));
}

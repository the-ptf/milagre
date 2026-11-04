// /storage in the composer and the ⌘K entry open What Milagre uses for a computer: Settings › Devices with This Mac's row
// open, or a paired computer's own page (whose row is always open). The request waits here until the page mounts.

export const OPEN_STORAGE = "milagre:open-storage";

let pending: string | null = null;

/** Asks the app to show What Milagre uses for `computerId` (null for this Mac). */
export function openStorage(computerId: string | null) {
  pending = computerId ?? "this-mac";
  window.dispatchEvent(new CustomEvent(OPEN_STORAGE, { detail: computerId }));
}

/** The row to open, once: the page that asked reads it as it mounts. */
export function takeStorageOpen(): string | null {
  const next = pending;
  pending = null;
  return next;
}

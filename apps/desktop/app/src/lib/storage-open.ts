export const OPEN_STORAGE = "milagre:open-storage";

export function openStorage(computerId: string | null) {
  window.dispatchEvent(new CustomEvent(OPEN_STORAGE, { detail: computerId }));
}

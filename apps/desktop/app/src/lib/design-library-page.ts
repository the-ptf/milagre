import { unqualifyKey } from "@milagre/shared/chat-scopes";

const OPEN = "milagre:design-library";

/** The Project whose Design library page is open: its key (qualified for a paired computer's) and its name. */
export type DesignLibraryTarget = { projectKey: string; name: string };

const nameOf = (projectKey: string) => unqualifyKey(projectKey).split(/[\\/]/).findLast(Boolean) ?? projectKey;

/** Opens the Design library page of the Project `projectKey` names, from wherever the window is. */
export function openDesignLibrary(projectKey: string, name?: string) {
  window.dispatchEvent(new CustomEvent<DesignLibraryTarget>(OPEN, { detail: { projectKey, name: name || nameOf(projectKey) } }));
}

export function onDesignLibraryOpen(listener: (target: DesignLibraryTarget) => void): () => void {
  const opened = (event: Event) => listener((event as CustomEvent<DesignLibraryTarget>).detail);
  window.addEventListener(OPEN, opened);
  return () => window.removeEventListener(OPEN, opened);
}

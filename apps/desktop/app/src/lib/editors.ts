import { ipcErrorMessage } from "@milagre/shared/result";
import { useSyncExternalStore } from "react";
import type { EditorInfo } from "../model";
import { showNotice } from "./notice";
import { getSettings, useSettings } from "./settings";

// The installed editors, asked of the main process once per run. null until the answer arrives.
let found: EditorInfo[] | null = null;
let requested = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    (window.milagre?.listEditors() ?? Promise.resolve([]))
      .catch(() => [] as EditorInfo[])
      .then((editors) => {
        found = editors;
        listeners.forEach((notify) => notify());
      });
  }
  return () => listeners.delete(listener);
}

/** The editor "Open in" uses: the one chosen in Settings if it's still installed, else the first found. */
function pickEditor(editors: EditorInfo[], editorId: string): EditorInfo | undefined {
  return editors.find((editor) => editor.id === editorId) ?? editors[0];
}

/** The detected editors (null while looking) and the one in use (undefined when none is installed). */
export function useEditors(): { editors: EditorInfo[] | null; editor: EditorInfo | undefined } {
  const editors = useSyncExternalStore(subscribe, () => found);
  const { editorId } = useSettings();
  return { editors, editor: editors ? pickEditor(editors, editorId) : undefined };
}

/**
 * Opens a file (or, with no path, the folder) in the chosen editor; a failure shows as a small notice. When the path
 * is missing, main opens the first of `fallbacks` (files the Chat worked on that end with it) found in the folder.
 */
export async function openInEditor(root: string, target: { path?: string; line?: number; fallbacks?: string[] } = {}) {
  const { fallbacks, ...request } = target;
  try {
    const result = await window.milagre.openInEditor({
      root,
      ...request,
      ...(fallbacks?.length ? { fallbacks } : {}),
      editor: getSettings().editorId || undefined,
    });
    if (!result.ok) showNotice(result.error.message);
  } catch (error) {
    showNotice(ipcErrorMessage(error));
  }
}

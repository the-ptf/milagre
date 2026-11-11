import { ipcErrorMessage } from "@milagre/shared/result";
import { useSyncExternalStore } from "react";
import type { EditorInfo } from "../model";
import { openFirstFound } from "./file-links";
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
 * isn't there, each of `fallbacks` (files the Chat worked on that end with it) is tried before the notice.
 */
export async function openInEditor(root: string, target: { path?: string; line?: number } = {}, fallbacks: readonly string[] = []) {
  const editor = getSettings().editorId || undefined;
  try {
    const failure =
      target.path === undefined
        ? await window.milagre.openInEditor({ root, editor }).then((result) => (result.ok ? null : result.error.message))
        : await openFirstFound((path) => window.milagre.openInEditor({ root, path, line: target.line, editor }), target.path, fallbacks);
    if (failure) showNotice(failure);
  } catch (error) {
    showNotice(ipcErrorMessage(error));
  }
}

import { ipcErrorMessage } from "@milagre/shared/result";
import { useSyncExternalStore } from "react";
import type { EditorInfo } from "../model";
import { showNotice } from "./notice";
import { getSettings, useSettings } from "./settings";

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

function pickEditor(editors: EditorInfo[], editorId: string): EditorInfo | undefined {
  return editors.find((editor) => editor.id === editorId) ?? editors[0];
}

export function useEditors(): { editors: EditorInfo[] | null; editor: EditorInfo | undefined } {
  const editors = useSyncExternalStore(subscribe, () => found);
  const { editorId } = useSettings();
  return { editors, editor: editors ? pickEditor(editors, editorId) : undefined };
}

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

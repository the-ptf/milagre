import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { openInEditor, useEditors } from "../lib/editors";
import { touchedFileMatches } from "@milagre/shared/file-link";
import { useNotice } from "../lib/notice";
import { TOAST } from "../lib/toast";

const RootContext = createContext<string | null>(null);
const FilesRootContext = createContext<string | null>(null);

/**
 * Names the folder (the chat's worktree or project) that file links in the replies below it resolve against.
 * `root` is empty on another Mac, where no editor can open; `files` still names that Mac's folder for the file viewer.
 */
export function EditorLinks({ root, files = root, children }: { root: string; files?: string; children: ReactNode }) {
  return (
    <RootContext.Provider value={root}>
      <FilesRootContext.Provider value={files}>{children}</FilesRootContext.Provider>
    </RootContext.Provider>
  );
}

/** Resolves relative file links below it against another folder, such as the folder of a markdown file on view. */
export function FilesRoot({ root, children }: { root: string; children: ReactNode }) {
  return <FilesRootContext.Provider value={root}>{children}</FilesRootContext.Provider>;
}

/** The folder relative file links in a reply resolve against, on the computer the chat runs on. */
export const useFilesRoot = () => useContext(FilesRootContext);

type StepFile = { file?: string; files?: readonly string[] };
const ChatFilesContext = createContext<{ readonly current: readonly StepFile[] }>({ current: [] });

/**
 * The Chat's steps, whose files a reply may name relative to a subfolder (see touchedFileMatches). A ref, read on a
 * click: a value that changed with each streamed step would re-render every file link in the transcript.
 */
export function ChatFiles({ steps, children }: { steps: readonly StepFile[]; children: ReactNode }) {
  const latest = useRef(steps);
  useLayoutEffect(() => {
    latest.current = steps;
  }, [steps]);
  return <ChatFilesContext.Provider value={latest}>{children}</ChatFilesContext.Provider>;
}

/**
 * Opens a file of the chat's folder in the editor, or null when there is no folder or no editor to open it in. A path
 * missing there falls back to a file the Chat worked on that ends with it.
 */
export function useFileOpener(): { open: (path: string, line?: number) => void; title: string } | null {
  const root = useContext(RootContext);
  const steps = useContext(ChatFilesContext);
  const { editor } = useEditors();
  return useMemo(() => {
    if (!root || !editor) return null;
    const open = (path: string, line?: number) => void openInEditor(root, { path, line, fallbacks: touchedFileMatches(path, steps.current) });
    return { open, title: `Open in ${editor.name}` };
  }, [root, editor, steps]);
}

/** The small notice at the bottom of the window, drawn as the toast (lib/toast): an ink capsule that fades up. */
export function Notice() {
  const notice = useNotice();
  if (!notice) return null;
  return (
    <div role="status" key={notice.id} className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-6">
      <div className={TOAST} style={{ animation: "fade-up var(--duration-base) var(--ease-enter) both" }}>
        {notice.text}
      </div>
    </div>
  );
}

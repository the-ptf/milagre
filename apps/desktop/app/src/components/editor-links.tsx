import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { openInEditor, useEditors } from "../lib/editors";
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

/** Opens a file of the chat's folder in the editor, or null when there is no folder or no editor to open it in. */
export function useFileOpener(): { open: (path: string, line?: number) => void; title: string } | null {
  const root = useContext(RootContext);
  const { editor } = useEditors();
  return useMemo(
    () => (root && editor ? { open: (path, line) => void openInEditor(root, { path, line }), title: `Open in ${editor.name}` } : null),
    [root, editor],
  );
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

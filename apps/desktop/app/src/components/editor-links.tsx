import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { openInEditor, useEditors } from "../lib/editors";
import { touchedFileMatches } from "@milagre/shared/file-link";
import { useNotice } from "../lib/notice";
import { TOAST } from "../lib/toast";

const RootContext = createContext<string | null>(null);
const FilesRootContext = createContext<string | null>(null);

export function EditorLinks({ root, files = root, children }: { root: string; files?: string; children: ReactNode }) {
  return (
    <RootContext.Provider value={root}>
      <FilesRootContext.Provider value={files}>{children}</FilesRootContext.Provider>
    </RootContext.Provider>
  );
}

export function FilesRoot({ root, children }: { root: string; children: ReactNode }) {
  return <FilesRootContext.Provider value={root}>{children}</FilesRootContext.Provider>;
}

export const useFilesRoot = () => useContext(FilesRootContext);

type StepFile = { file?: string; files?: readonly string[] };
const ChatFilesContext = createContext<{ readonly current: readonly StepFile[] }>({ current: [] });

export function ChatFiles({ steps, children }: { steps: readonly StepFile[]; children: ReactNode }) {
  const latest = useRef(steps);
  useLayoutEffect(() => {
    latest.current = steps;
  }, [steps]);
  return <ChatFilesContext.Provider value={latest}>{children}</ChatFilesContext.Provider>;
}

export function useFileOpener(): { open: (path: string, line?: number) => void; title: string; name: string } | null {
  const root = useContext(RootContext);
  const steps = useContext(ChatFilesContext);
  const { editor } = useEditors();
  return useMemo(() => {
    if (!root || !editor) return null;
    const open = (path: string, line?: number) => void openInEditor(root, { path, line, fallbacks: touchedFileMatches(path, steps.current) });
    return { open, title: `Open in ${editor.name}`, name: editor.name };
  }, [root, editor, steps]);
}

export function Notice() {
  const notice = useNotice();
  if (!notice) return null;
  return (
    <div role="status" key={notice.id} className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-6">
      <div className={TOAST} style={{ animation: "fade-up var(--duration-base) var(--ease-enter) backwards" }}>
        {notice.text}
      </div>
    </div>
  );
}

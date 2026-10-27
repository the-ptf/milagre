import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { PROJECT_REMOVED, RECENT_PROJECTS_CHANGED } from "../lib/project-list";

export function RemoveProjectDialog({ project, onClose }: { project: { path: string; name: string }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await bridgeForKey(project.path).forgetProject(project.path);
      window.dispatchEvent(new CustomEvent(PROJECT_REMOVED, { detail: project.path }));
      window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
      onClose();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="remove-project-title"
      aria-describedby="remove-project-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onClose();
      }}
      className="m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[16px] bg-surface p-5 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <h2 id="remove-project-title" className="break-words text-[17px] font-semibold">
        Remove {project.name}?
      </h2>
      <p id="remove-project-description" className="mt-2 text-[13px] text-ink-3">
        This removes the Project from the list on your computer and paired phones. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring
        it back. Running Chats keep running.
      </p>
      {error && (
        <p role="alert" className="mt-3 break-words text-[12px] text-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" autoFocus disabled={busy} onClick={onClose} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
          Cancel
        </button>
        <button
          type="button"
          data-project-remove-confirm
          disabled={busy}
          onClick={() => void remove()}
          className="rounded-control bg-red px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy ? "Removing..." : "Remove Project"}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

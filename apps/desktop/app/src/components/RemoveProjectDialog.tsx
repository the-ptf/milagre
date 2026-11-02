import { useState } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { PROJECT_REMOVED, RECENT_PROJECTS_CHANGED } from "../lib/project-list";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";

export function RemoveProjectDialog({ project, onClose }: { project: { path: string; name: string }; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  return (
    <Dialog
      title={<span className="break-words">Remove {project.name}?</span>}
      description="This removes the Project from the list on your computer and paired phones. Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back. Running Chats keep running."
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <Button variant="ghost" autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" data-project-remove-confirm disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove Project"}
          </Button>
        </>
      }
    >
      <InlineError size={12} className="mt-3">
        {error}
      </InlineError>
    </Dialog>
  );
}

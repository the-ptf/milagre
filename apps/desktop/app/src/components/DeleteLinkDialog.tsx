import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NamedLinkDeleteCheck, NamedLinkDeleted, NamedProjectLink } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { deleteLinkText, linkRunningText } from "@milagre/shared/worktree-link";
import { bridgeForKey } from "../lib/computer-bridge";

/**
 * Asks before a Named Link is deleted, saying how many Chats it archives. The daemon is asked first, so a Link with a
 * running Chat names it and can't be deleted until it stops; the delete itself checks again.
 */
export function DeleteLinkDialog({
  link,
  onClose,
  onDeleted,
}: {
  link: NamedProjectLink;
  onClose: () => void;
  onDeleted: (link: NamedProjectLink, result: NamedLinkDeleted) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [check, setCheck] = useState<NamedLinkDeleteCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let live = true;
    void (async () => {
      try {
        const result = await bridgeForKey(`milagre-link:${link.id}`).checkDeleteNamedLink(link.id);
        if (live) setCheck(result);
      } catch (failure) {
        if (live) setError(ipcErrorMessage(failure));
      }
    })();
    return () => {
      live = false;
      element?.close();
    };
  }, [link.id]);
  const text = deleteLinkText(link.name, check?.chats ?? 0);
  const running = check?.running.length ? linkRunningText(check.running) : "";
  async function remove() {
    if (busy || !check || running) return;
    setBusy(true);
    setError("");
    try {
      onDeleted(link, await bridgeForKey(`milagre-link:${link.id}`).deleteNamedLink(link.id));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      data-link-delete-dialog
      aria-labelledby="delete-link-title"
      aria-describedby="delete-link-description"
      aria-busy={!check && !error}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onClose();
      }}
      className="m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-window bg-surface p-5 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <h2 id="delete-link-title" className="break-words text-17 font-semibold">
        {text.title}
      </h2>
      <p id="delete-link-description" className="mt-2 text-13 text-ink-3">
        {check ? text.message : error ? "" : "Checking the Link's Chats…"}
      </p>
      {(running || error) && (
        <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-12 text-red-ink">
          {error || running}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" autoFocus disabled={busy} onClick={onClose} className="rounded-control px-3 py-2 text-13 hover:bg-hover-2">
          Cancel
        </button>
        <button
          type="button"
          data-link-delete-confirm
          disabled={busy || !check || !!running}
          onClick={() => void remove()}
          className="rounded-control bg-red px-3 py-2 text-13 font-medium text-white disabled:opacity-40"
        >
          {busy ? "Deleting…" : text.action}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

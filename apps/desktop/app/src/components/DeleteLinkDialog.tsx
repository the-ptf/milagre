import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NamedLinkDeleteCheck, NamedLinkDeleted, NamedProjectLink } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { computerOfKey, LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { deleteLinkText, isDeletedLinkState, linkDeleteFailure, linkRunningText } from "@milagre/shared/worktree-link";
import { bridgeForKey } from "../lib/computer-bridge";
import { computerNameOf } from "../lib/computers";
import { stateEvents } from "../lib/state-events";
import { useEvent } from "../lib/stable";

/** How often a Link with a running Chat is checked again, so Delete enables once the Chat stops. */
const RECHECK_MS = 2000;

/**
 * The Links this window is deleting now. Their link:state with `deletedAt` comes before link:delete answers; the
 * window leaves them when the answer comes, with the Worktrees it kept, not as a Link deleted on another device.
 */
export const linkDeletesInFlight = new Set<string>();

/**
 * Asks before a Named Link is deleted, saying how many Chats it archives. The daemon is asked first, so a Link with a
 * running Chat names it and can't be deleted until it stops: the check runs again every 2 s and on each change to the
 * Link while one runs. The delete itself checks again. A Link deleted elsewhere meanwhile closes this.
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
  const scope = `milagre-link:${link.id}`;
  const computerId = computerOfKey(scope);
  // A computer too old to delete Links is asked to update, by name.
  const failed = useEvent((cause: unknown) =>
    linkDeleteFailure(ipcErrorMessage(cause), { computer: computerId === LOCAL_COMPUTER ? "this Mac" : computerNameOf(computerId) }),
  );
  // Only the latest check lands, and none after the dialog closes.
  const checks = useRef(0);
  const read = useEvent(async () => {
    const asked = ++checks.current;
    try {
      const result = await bridgeForKey(scope).checkDeleteNamedLink(link.id);
      if (asked !== checks.current) return;
      setCheck(result);
      setError("");
    } catch (cause) {
      if (asked === checks.current) setError(failed(cause));
    }
  });
  useEffect(() => {
    const element = dialog.current;
    const asked = checks;
    element?.showModal();
    void read();
    return () => {
      asked.current++;
      element?.close();
    };
  }, [read]);
  const waiting = !!check?.running.length && !busy;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void read(), RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [waiting, read]);
  const changed = useEvent((deleted: boolean) => {
    if (busy) return;
    if (deleted) onClose();
    else if (waiting) void read();
  });
  useEffect(
    () =>
      stateEvents.onLinkState((update) => {
        if (update.linkId === link.id) changed(isDeletedLinkState(update.state));
      }),
    [link.id, changed],
  );
  const text = deleteLinkText(link.name, check?.chats ?? 0);
  const running = check?.running.length ? linkRunningText(check.running) : "";
  async function remove() {
    if (busy || !check || running) return;
    setBusy(true);
    setError("");
    linkDeletesInFlight.add(link.id);
    try {
      const result = await bridgeForKey(scope).deleteNamedLink(link.id);
      linkDeletesInFlight.delete(link.id);
      onDeleted(link, result);
    } catch (cause) {
      linkDeletesInFlight.delete(link.id);
      setError(failed(cause));
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

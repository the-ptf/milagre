import { useEffect, useRef, useState } from "react";
import type { NamedLinkDeleteCheck, NamedLinkDeleted, NamedProjectLink } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { computerOfKey, LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { deleteLinkText, isDeletedLinkState, linkDeleteFailure, linkRunningText } from "@milagre/shared/worktree-link";
import { bridgeForKey } from "../lib/computer-bridge";
import { computerNameOf } from "../lib/computers";
import { stateEvents } from "../lib/state-events";
import { useEvent } from "../lib/stable";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";

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
    const asked = checks;
    void read();
    return () => {
      asked.current++;
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
  return (
    <Dialog
      data-link-delete-dialog
      aria-busy={!check && !error}
      title={
        <span id="delete-link-title" className="break-words">
          {text.title}
        </span>
      }
      description={<span id="delete-link-description">{check ? text.message : error ? "" : "Checking the Link's Chats…"}</span>}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <Button variant="ghost" autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" data-link-delete-confirm disabled={busy || !check || !!running} onClick={() => void remove()}>
            {busy ? "Deleting…" : text.action}
          </Button>
        </>
      }
    >
      <InlineError size={12} className="mt-3 whitespace-pre-wrap break-words">
        {error || running}
      </InlineError>
    </Dialog>
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { PendingComputer } from "../electron";
import { ALLOW_DETAIL, allowQuestion } from "../lib/pending-computers";

/**
 * Asks this Mac's owner whether a computer pairing for the first time may drive it (spec "Allowing a new computer").
 * The daemon holds that computer's channel until Allow or Deny; two at once are asked oldest first. Escape answers
 * Deny at once, the choice that can't give anything away; the buttons wait ARM_MS after each new request. Not behind Settings › Devices › Other computers: the computer asking has the flag
 * on, this Mac may not.
 */
// A request's buttons stay off this long after it appears, so the second click of a double-click on the one before can't allow it unread.
const ARM_MS = 500;

export function ComputerAllowPrompt() {
  const [requests, setRequests] = useState<PendingComputer[]>([]);
  const [busy, setBusy] = useState(false);
  // Tied to the request it came from, so it goes with that request.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // How many devices:pending events arrived. The event is the newer word: an answer's own reply that lands after one is stale.
  const heardCount = useRef(0);
  useEffect(() => {
    let live = true;
    const off = window.milagre.onDevicesPending((payload) => {
      heardCount.current += 1;
      setRequests(Array.isArray(payload?.requests) ? payload.requests : []);
    });
    // A host from before Allow has no devices:pending; nothing ever asks there.
    void (async () => {
      try {
        const list = await window.milagre.listPendingDevices();
        if (live && !heardCount.current) setRequests(list ?? []);
      } catch {}
    })();
    return () => {
      live = false;
      off();
    };
  }, []);
  const request = requests[0];
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) element.showModal();
    if (!request && element.open) element.close();
  }, [request]);
  // The key of the request whose buttons work; any other request has just appeared.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const requestKey = request?.key;
  useEffect(() => {
    if (!requestKey) return;
    const timer = setTimeout(() => setArmedKey(requestKey), ARM_MS);
    return () => clearTimeout(timer);
  }, [requestKey]);
  const armed = requestKey !== undefined && armedKey === requestKey;
  const error = failure && failure.key === request?.key ? failure.message : null;

  async function answer(allow: boolean) {
    if (!request || busy) return;
    setBusy(true);
    setFailure(null);
    const heardBefore = heardCount.current;
    try {
      const left = await (allow ? window.milagre.allowDevice(request.key) : window.milagre.denyDevice(request.key));
      if (heardCount.current === heardBefore) setRequests(left);
    } catch (cause) {
      setFailure({ key: request.key, message: ipcErrorMessage(cause) });
      // Most often the computer gave up meanwhile: show what is still waiting.
      window.milagre.listPendingDevices().then(setRequests, () => {});
    } finally {
      setBusy(false);
    }
  }

  // Nothing is mounted until a computer waits: other screens look for the page's one open dialog.
  if (!request) return null;
  return createPortal(
    <dialog
      ref={dialog}
      data-computer-allow
      aria-labelledby="computer-allow-title"
      onCancel={(event) => {
        event.preventDefault();
        void answer(false);
      }}
      className="m-auto w-[400px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      {request && (
        <div key={request.key} className="flex flex-col p-5">
          <h2 id="computer-allow-title" className="text-[17px] font-semibold">
            {allowQuestion(request)}
          </h2>
          <p className="mt-1 text-[13px] text-ink-2">{ALLOW_DETAIL}</p>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-red">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy || !armed}
              onClick={() => void answer(false)}
              className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={busy || !armed}
              onClick={() => void answer(true)}
              className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
            >
              Allow
            </button>
          </div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}

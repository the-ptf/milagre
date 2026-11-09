import { useEffect, useRef, useState } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { PendingComputer } from "../electron";
import { ALLOW_DETAIL, allowQuestion } from "../lib/pending-computers";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";

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
  // No onClose: it must be answered. Esc answers Deny; the scrim does nothing.
  return (
    <Dialog
      data-computer-allow
      role="alertdialog"
      title={allowQuestion(request)}
      description={ALLOW_DETAIL}
      onEscape={() => void answer(false)}
      dismissOnScrim={false}
      width={400}
      actions={
        <>
          <Button variant="ghost" disabled={busy || !armed} onClick={() => void answer(false)}>
            Deny
          </Button>
          <Button disabled={busy || !armed} onClick={() => void answer(true)}>
            Allow
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

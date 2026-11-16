import { useEffect, useRef, useState } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { PendingComputer } from "../electron";
import { ALLOW_DETAIL, allowQuestion } from "../lib/pending-computers";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";

const ARM_MS = 500;

export function ComputerAllowPrompt() {
  const [requests, setRequests] = useState<PendingComputer[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const heardCount = useRef(0);
  useEffect(() => {
    let live = true;
    const off = window.milagre.onDevicesPending((payload) => {
      heardCount.current += 1;
      setRequests(Array.isArray(payload?.requests) ? payload.requests : []);
    });
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
      window.milagre.listPendingDevices().then(setRequests, () => {});
    } finally {
      setBusy(false);
    }
  }

  if (!request) return null;
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

import { useEffect, useState } from "react";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { bridgeFor, isRemoteKey } from "../lib/computer-bridge";
import { computerNameOf } from "../lib/computers";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";

const NEVER_ASK = "milagre.keep-awake-never-ask";

function neverAsked(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(NEVER_ASK) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Opening a paired computer's Chat asks to keep that computer awake while it lets itself sleep: asleep, it drops off the
 * relay and this Mac can't reach it. Asked on every Chat opened there until Keep awake turns it on or Don't ask again
 * says so for that computer. A computer that can't say (an older one) is never asked about.
 */
export function KeepAwakePrompt({ chatKey }: { chatKey: string | null }) {
  // The Chat it was asked for: opening another one drops the question until that Chat's own answer comes.
  const [question, setQuestion] = useState<{ chatKey: string; computerId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!chatKey || !isRemoteKey(chatKey)) return;
    const computerId = computerOfKey(chatKey);
    if (neverAsked().includes(computerId)) return;
    let live = true;
    void bridgeFor(computerId)
      .readKeepAwakeSettings?.()
      .then((value) => live && value?.enabled !== true && setQuestion({ chatKey, computerId }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatKey]);

  const asking = question && question.chatKey === chatKey ? question.computerId : null;
  if (!asking) return null;
  const close = () => setQuestion(null);
  async function keepAwake() {
    if (!asking) return;
    setBusy(true);
    try {
      await bridgeFor(asking).saveKeepAwakeSettings({ enabled: true });
    } catch {
      // The computer went away meanwhile; the next Chat opened there asks again.
    } finally {
      setBusy(false);
      close();
    }
  }
  function dontAskAgain() {
    if (asking) localStorage.setItem(NEVER_ASK, JSON.stringify([...neverAsked().filter((id) => id !== asking), asking]));
    close();
  }
  const name = computerNameOf(asking);
  return (
    <Dialog
      data-keep-awake-prompt
      title={`Keep ${name} awake?`}
      description={`When ${name} sleeps, this Mac can't reach it. Keep it awake while Milagre runs? Its screen can still turn off. Plugged in, it stays awake with the lid closed.`}
      onClose={close}
      width={420}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={dontAskAgain}>
            Don't ask again
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void keepAwake()}>
            Keep awake
          </Button>
        </>
      }
    />
  );
}

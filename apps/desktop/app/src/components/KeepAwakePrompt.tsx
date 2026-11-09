import { useEffect, useState } from "react";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeFor, isRemoteKey } from "../lib/computer-bridge";
import { computerNameOf } from "../lib/computers";
import { preferenceStorage } from "../lib/preference-storage";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { InlineError } from "./primitives/InlineError";

const NEVER_ASK = "milagre.keep-awake-never-ask";

type Question = { id: number; chatKey: string; computerId: string; busy: boolean; failure: string | null };
// Numbers each question, so a save's answer finds the question it was made from.
let asked = 0;

// Kept through preferenceStorage, so an update that moves the app to another file URL doesn't ask again.
function neverAsked(): string[] {
  try {
    const value = JSON.parse(preferenceStorage.getItem(NEVER_ASK) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Opening a paired computer's Chat (a Project's or a Named Link's) asks to keep that computer awake while it lets itself
 * sleep: asleep, it drops off the relay and this Mac can't reach it. Asked on every Chat opened there until Keep awake
 * turns it on or Don't ask again says so for that computer. A computer that can't say (an older one) is never asked
 * about. A save that fails says why and leaves Keep awake to try again.
 */
export function KeepAwakePrompt({ chatKey }: { chatKey: string | null }) {
  // The Chat it was asked for: opening another one drops the question until that Chat's own answer comes. A save
  // under way and its failure belong to their question: one that ends after another question opened leaves it alone.
  const [question, setQuestion] = useState<Question | null>(null);
  useEffect(() => {
    if (!chatKey || !isRemoteKey(chatKey)) return;
    const computerId = computerOfKey(chatKey);
    if (neverAsked().includes(computerId)) return;
    let live = true;
    void bridgeFor(computerId)
      .readKeepAwakeSettings?.()
      .then((value) => {
        // Only an answer of off asks: a computer that answers anything else (an older one) can't say.
        if (!live || value?.enabled !== false) return undefined;
        setQuestion({ id: ++asked, chatKey, computerId, busy: false, failure: null });
        return undefined;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatKey]);

  const shown = question && question.chatKey === chatKey ? question : null;
  if (!shown) return null;
  const asking = shown.computerId;
  const { busy, failure } = shown;
  const close = () => setQuestion(null);
  // Changes the question it was given, and only while that one is still asked.
  const update = (id: number, change: Partial<Question> | null) =>
    setQuestion((current) => (current?.id !== id ? current : change ? { ...current, ...change } : null));
  async function keepAwake() {
    if (!shown) return;
    const { id } = shown;
    update(id, { busy: true, failure: null });
    try {
      await bridgeFor(asking).saveKeepAwakeSettings({ enabled: true });
      update(id, null);
    } catch (cause) {
      update(id, { busy: false, failure: ipcErrorMessage(cause) });
    }
  }
  function dontAskAgain() {
    if (asking) {
      try {
        preferenceStorage.setItem(NEVER_ASK, JSON.stringify([...neverAsked().filter((id) => id !== asking), asking]));
      } catch {
        // Unsaved, the next Chat opened there asks again.
      }
    }
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
            {failure ? "Try again" : "Keep awake"}
          </Button>
        </>
      }
    >
      <InlineError size={12} className="mt-3">
        {failure && `Couldn't keep ${name} awake: ${failure}`}
      </InlineError>
    </Dialog>
  );
}

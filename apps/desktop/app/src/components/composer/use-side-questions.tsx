import { InlineError } from "../primitives/InlineError";
import { ipcErrorMessage } from "@milagre/shared/result";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { STORAGE_COMMAND } from "@milagre/shared/storage";
import { openStorage } from "../../lib/storage-open";
import { useEffect, useState } from "react";
import type { BtwRequest, ModelOption } from "@milagre/shared/model";
import { composerQuote, type ComposerQuote } from "@milagre/shared/prompt-parts";
import { sessionIdFromKey, projectOfKey } from "@milagre/shared/agent-runs";
import { BtwOverlay } from "../BtwOverlay";
import { useBtw } from "../../lib/use-btw";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useEvent } from "../../lib/stable";
import type { DraftStore } from "../../lib/draft-store";

export function useSideQuestions({
  chatId,
  blocked,
  offScreen,
  model,
  effort,
  store,
  openChat,
  quote,
  focus,
  onUndo,
}: {
  chatId: string | null;
  blocked: boolean;
  offScreen?: boolean;
  model: ModelOption;
  effort: BtwRequest["effort"];
  store: DraftStore;
  openChat?: (key: string) => void;
  quote: (quotes: readonly ComposerQuote[]) => void;
  focus: (atEnd?: boolean) => void;
  onUndo: () => void;
}) {
  const btw = useBtw(chatId);
  const [error, setError] = useState("");
  const intercept = useEvent((draft: string) => {
    if (chatId && draft.trim() === "/undo") {
      store.setText("");
      onUndo();
      return true;
    }
    if (draft.trim() === `/${STORAGE_COMMAND}`) {
      store.setText("");
      const computer = computerOfKey(chatId ?? "");
      openStorage(computer === LOCAL_COMPUTER ? null : computer);
      return true;
    }
    if (!/^\/btw(?:\s|$)/i.test(draft.trim())) return false;
    if (chatId && !blocked) {
      store.setText("");
      void btw.ask({
        prompt: draft
          .trim()
          .replace(/^\/btw\s*/i, "")
          .trim(),
        provider: model.provider,
        model: model.id,
        effort,
      });
    }
    return true;
  });
  const fork = useEvent(async (messageId: number) => {
    if (!chatId || blocked) return;
    try {
      setError("");
      const scope = projectOfKey(chatId);
      const result = await bridgeForKey(chatId).forkChat(scope, sessionIdFromKey(chatId), { messageId });
      openChat?.(`${scope}#${result.sessionId}`);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    }
  });
  const openQuestion = useEvent((event: Event) => {
    if (offScreen || blocked || (event as CustomEvent<string>).detail !== chatId) return;
    void btw.ask({ prompt: "" });
    if (!store.text().trim().startsWith("/btw")) store.setText(`/btw ${store.text()}`);
    focus(true);
  });
  useEffect(() => {
    window.addEventListener("milagre:side-question", openQuestion);
    return () => window.removeEventListener("milagre:side-question", openQuestion);
  }, [openQuestion]);
  const dismiss = useEvent(() => {
    btw.dismiss();
    focus(true);
  });
  useEffect(() => {
    if (!btw.state || offScreen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [btw.state, offScreen, dismiss]);
  return {
    intercept,
    fork: blocked ? undefined : fork,
    overlay: error ? (
      <InlineError variant="card">{error}</InlineError>
    ) : btw.state && !offScreen ? (
      <BtwOverlay
        state={btw.state}
        onDismiss={dismiss}
        onStop={btw.stop}
        onBringBack={() => {
          const value = composerQuote(btw.state!.text, "Side question");
          if (value) quote([value]);
          dismiss();
        }}
      />
    ) : null,
  };
}

export const sideQuestionsBlocked = (readOnly: boolean | undefined, offline: string | null | undefined) => Boolean(readOnly || offline);

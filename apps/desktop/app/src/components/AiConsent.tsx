import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AI_CONSENT_TITLE,
  AI_CONSENT_DESCRIPTION,
  AI_CONSENT_DETAIL,
  AI_RESET_DETAIL,
  AI_PROVIDER_POLICIES,
  PRIVACY_URL,
  SUPPORT_URL,
} from "@milagre/shared/ai-consent";
import { aiConsent, answerConsent, consentOpen, subscribeConsent } from "../lib/ai-consent";
import { ScrollArea } from "./primitives/ScrollArea";

const button = "rounded-control border border-line px-3 py-2 text-[13px] hover:bg-hover disabled:opacity-50";

function PolicyLinks() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
      {[{ name: "Milagre privacy policy", url: PRIVACY_URL }, ...AI_PROVIDER_POLICIES, { name: "Support", url: SUPPORT_URL }].map(({ name, url }) => (
        <a key={url} className="text-accent-ink underline underline-offset-4" href={url} target="_blank" rel="noreferrer">
          {name}
        </a>
      ))}
    </div>
  );
}

export function AiConsentDialog() {
  const open = useSyncExternalStore(subscribeConsent, consentOpen);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      cancel.current?.focus();
    } else dialog.current?.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="ai-consent-title"
      aria-describedby="ai-consent-description"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        answerConsent(false);
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex max-h-[85vh] flex-col p-6">
        <h2 id="ai-consent-title" className="text-lg font-semibold">
          {AI_CONSENT_TITLE}
        </h2>
        <ScrollArea className="my-4 space-y-4 text-[14px] leading-relaxed">
          <p id="ai-consent-description">{AI_CONSENT_DESCRIPTION}</p>
          <p className="text-ink-2">{AI_CONSENT_DETAIL}</p>
          <PolicyLinks />
        </ScrollArea>
        <div className="flex justify-end gap-2">
          <button ref={cancel} className={button} onClick={() => answerConsent(false)}>
            Not now
          </button>
          <button className={`${button} bg-ink text-surface`} onClick={() => answerConsent(true)}>
            Allow sharing
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function PrivacySettings() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void aiConsent.allowed().then(setAllowed, (failure) => setError(String(failure)));
  }, []);
  async function reset() {
    setBusy(true);
    setError("");
    try {
      await aiConsent.reset();
      setAllowed(false);
    } catch {
      setError("Could not reset AI sharing permission. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 space-y-5 text-[14px] leading-relaxed">
      <p>{AI_CONSENT_DESCRIPTION}</p>
      <p className="text-ink-2">{AI_CONSENT_DETAIL}</p>
      <p role="status">
        {allowed === null
          ? "Checking permission..."
          : allowed
            ? "AI sharing is allowed on this device."
            : "AI sharing will ask for permission before your next AI action."}
      </p>
      <button className={button} disabled={busy || allowed !== true} onClick={() => void reset()}>
        Reset AI sharing permission
      </button>
      <p className="text-ink-2">{AI_RESET_DETAIL}</p>
      {error && (
        <p role="alert" className="text-red">
          {error}
        </p>
      )}
      <PolicyLinks />
    </div>
  );
}

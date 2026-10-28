import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { AI_CONSENT_VERSION, createAiConsent } from "@milagre/shared/ai-consent";

const KEY = "milagre.ai-sharing-consent";
const listeners = new Set<() => void>();
let decision: ((allowed: boolean) => void) | null = null;
export const consentOpen = () => decision !== null;
export function subscribeConsent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function answerConsent(allowed: boolean) {
  const answer = decision;
  decision = null;
  answer?.(allowed);
  for (const listener of listeners) listener();
}
/**
 * This Mac's Routines follow its decision (there is no Routines switch): allowing lets them run, Reset stops them. A
 * failure here never blocks the decision; the Routines page offers Allow again while this Mac can't run them.
 */
function followDecision(value: string | null) {
  Promise.resolve()
    .then(() => window.milagre?.saveRoutinesEnabled?.(value === AI_CONSENT_VERSION, value === AI_CONSENT_VERSION ? value : undefined))
    .catch((failure: unknown) => console.warn("[routines] couldn't follow the AI sharing decision", failure));
}
export const aiConsent = createAiConsent({
  read: async () => localStorage.getItem(KEY),
  write: async (value) => {
    if (value === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
    followDecision(value);
  },
  ask: () =>
    new Promise<boolean>((resolve) => {
      decision = resolve;
      for (const listener of listeners) listener();
    }),
});

import { createAiConsent } from "@milagre/shared/ai-consent";

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
export const aiConsent = createAiConsent({
  read: async () => localStorage.getItem(KEY),
  write: async (value) => {
    if (value === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  },
  ask: () =>
    new Promise<boolean>((resolve) => {
      decision = resolve;
      for (const listener of listeners) listener();
    }),
});

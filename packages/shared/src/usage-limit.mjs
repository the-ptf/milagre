import { accountType, providerName } from "./providers.mjs";

export function usageLimitOf(message) {
  const context = message?.context;
  return typeof context === "object" && context !== null && context.kind === "limit" ? context : null;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Null when the time is unknown or past. */
export function resetTime(iso, now = new Date()) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || at <= now) return null;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay(at, now) ? time : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export function limitHeadline(limit, now = new Date()) {
  const reset = resetTime(limit.resetsAt, now);
  return {
    title: `${providerName(limit.provider)} hit its usage limit`,
    detail: reset ? `It resets at ${reset}.` : "It resets later.",
  };
}

/**
 * The Project's other accounts for the limit's provider (from accounts:scope); `disabled` ones are not signed in or
 * limited too.
 */
export function limitChoices(snapshot, limit, now = new Date()) {
  const group = snapshot?.providers?.find((item) => item.provider === limit.provider);
  if (!group) return [];
  return group.accounts
    .filter((account) => account.id !== group.effectiveId && !account.missing)
    .map((account) => {
      const limitedUntil = account.limitedUntil ? resetTime(account.limitedUntil, now) : null;
      const unavailable = account.state !== "ready" ? "Not signed in" : limitedUntil ? `Limited until ${limitedUntil}` : null;
      return {
        id: account.id,
        label: account.email || account.label,
        detail: unavailable ?? accountType(account.plan),
        disabled: Boolean(unavailable),
      };
    });
}

export function switchedText({ continued, label }) {
  return continued ? `Switched to ${label}. Continuing…` : `Switched to ${label}. Send your message again to continue.`;
}

export function isAccountSwitch(message) {
  return message?.context?.kind === "account-switch";
}

export function accountSwitchText(context) {
  return `Switched to ${context.label} after the usage limit`;
}

export function isLimitReset(message) {
  return message?.context?.kind === "limit-reset";
}

export function limitResetText() {
  return "Continued after the usage limit reset";
}

export function limitResumeLabel(pending, limit, now = new Date()) {
  if (pending) return resetTime(pending.at, now) ? `Continues at ${resetTime(pending.at, now)}` : "Continues shortly";
  const time = resetTime(limit.resetsAt, now);
  return time ? `Continue at ${time}` : null;
}

// The limit card under a reply the plan's usage limit stopped: what it says, and which accounts it offers.
import { accountType, providerName } from "./providers.mjs";

/** The limit's context when the message is a reply the usage limit stopped, else null. */
export function usageLimitOf(message) {
  const context = message?.context;
  return typeof context === "object" && context !== null && context.kind === "limit" ? context : null;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "4:10 PM" today, "Thu 4:10 PM" later, in the device's own time zone; null when the time is unknown or past. */
export function resetTime(iso, now = new Date()) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || at <= now) return null;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay(at, now) ? time : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** The card's heading and its line under it. */
export function limitHeadline(limit, now = new Date()) {
  const reset = resetTime(limit.resetsAt, now);
  return {
    title: `${providerName(limit.provider)} hit its usage limit`,
    detail: reset ? `It resets at ${reset}.` : "It resets later.",
  };
}

/**
 * The Project's other accounts for the limit's provider (from accounts:scope), each with why it can't be picked:
 * not signed in, or limited too. The detail otherwise is the account type, as Settings › Accounts shows it. `effectiveId` is the account the Project uses now.
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

/** What the card says once a switch went through. */
export function switchedText({ continued, label }) {
  return continued ? `Switched to ${label}. Continuing…` : `Switched to ${label}. Send your message again to continue.`;
}

/** The line a Chat shows where it continued on another account after the limit (context kind "account-switch"). */
export function isAccountSwitch(message) {
  return message?.context?.kind === "account-switch";
}

/** The line as text: the message body, and the label screen readers and the transcript use. */
export function accountSwitchText(context) {
  return `Switched to ${context.label} after the usage limit`;
}

/** A continuation on the same Account after its plan's usage limit reset. */
export function isLimitReset(message) {
  return message?.context?.kind === "limit-reset";
}

export function limitResetText() {
  return "Continued after the usage limit reset";
}

/** Pending schedules remain visible during the short allowance after the reported reset time. */
export function limitResumeLabel(pending, limit, now = new Date()) {
  if (pending) return resetTime(pending.at, now) ? `Continues at ${resetTime(pending.at, now)}` : "Continues shortly";
  const time = resetTime(limit.resetsAt, now);
  return time ? `Continue at ${time}` : null;
}

const HOUR = 60 * 60 * 1000;

/** The retention choices in hours, in the order Settings lists them; 0 is Never. */
export const DONE_RETENTION_OPTIONS = Object.freeze([1, 8, 24, 72, 168, 0]);

export const DONE_DEFAULTS = Object.freeze({ retentionHours: 24 });

export function normalizeDoneSettings(value) {
  const hours = value && typeof value === "object" ? value.retentionHours : undefined;
  return { retentionHours: DONE_RETENTION_OPTIONS.includes(hours) ? hours : DONE_DEFAULTS.retentionHours };
}

export function retentionLabel(hours) {
  if (!hours) return "Never";
  if (hours === 168) return "1 week";
  if (hours % 24 === 0 && hours > 24) return `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export const isDone = (session) => Boolean(session?.done_at) && !session.archived;

/** When a Done Chat is archived, in ms; null when it never is (Never, or not Done). */
export function doneDueAt(session, retentionHours) {
  if (!isDone(session) || !retentionHours) return null;
  return session.done_at + retentionHours * HOUR;
}

export function doneDue(session, retentionHours, now = Date.now()) {
  const due = doneDueAt(session, retentionHours);
  return due !== null && due <= now;
}

/** The countdown a Done row shows until it is archived, as hours:minutes ("21:14", "0:42"); null when it never is. */
export function doneCountdown(session, retentionHours, now = Date.now()) {
  const due = doneDueAt(session, retentionHours);
  if (due === null) return null;
  const minutes = Math.min(retentionHours * 60, Math.max(0, Math.ceil((due - now) / 60_000)));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Done Chats, most recently marked first: the order the Done list shows them in. */
export const byDoneAt = (a, b) => (b.done_at ?? 0) - (a.done_at ?? 0);

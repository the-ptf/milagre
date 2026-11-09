// Done: the light way to put a Chat away. Marking a Chat Done moves it to the Done list at the bottom of the sidebar at
// once; the host archives it (archive.mjs: hidden, a clean worktree removed, unsaved work kept) once it has been Done for
// the retention the user picked. Types: done.d.mts.

const HOUR = 60 * 60 * 1000;

/** The retention choices in hours, in the order Settings lists them; 0 is Never. */
export const DONE_RETENTION_OPTIONS = Object.freeze([1, 8, 24, 72, 168, 0]);

export const DONE_DEFAULTS = Object.freeze({ retentionHours: 24 });

/** The settings with anything unknown back at its default. */
export function normalizeDoneSettings(value) {
  const hours = value && typeof value === "object" ? value.retentionHours : undefined;
  return { retentionHours: DONE_RETENTION_OPTIONS.includes(hours) ? hours : DONE_DEFAULTS.retentionHours };
}

/** "1 hour", "24 hours", "3 days", "1 week", "Never". */
export function retentionLabel(hours) {
  if (!hours) return "Never";
  if (hours === 168) return "1 week";
  if (hours % 24 === 0 && hours > 24) return `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Whether a Chat is in the Done list: marked Done and not archived yet. */
export const isDone = (session) => Boolean(session?.done_at) && !session.archived;

/** When a Done Chat is archived, in ms; null when it never is (Never, or not Done). */
export function doneDueAt(session, retentionHours) {
  if (!isDone(session) || !retentionHours) return null;
  return session.done_at + retentionHours * HOUR;
}

/** Whether the host's sweep archives this Chat now. */
export function doneDue(session, retentionHours, now = Date.now()) {
  const due = doneDueAt(session, retentionHours);
  return due !== null && due <= now;
}

/** The countdown a Done row shows until it is archived, as hours:minutes ("21:14", "0:42"); null when it never is. */
export function doneCountdown(session, retentionHours, now = Date.now()) {
  const due = doneDueAt(session, retentionHours);
  if (due === null) return null;
  // A clock read just before the Mac stamped it (a phone's, a minute tick behind) never shows more than the retention.
  const minutes = Math.min(retentionHours * 60, Math.max(0, Math.ceil((due - now) / 60_000)));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Done Chats, most recently marked first: the order the Done list shows them in. */
export const byDoneAt = (a, b) => (b.done_at ?? 0) - (a.done_at ?? 0);

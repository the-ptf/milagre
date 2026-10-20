/**
 * The drafts after a send took `sent` from a Chat's composer. The draft clears only if it still reads what went: text
 * typed while the send waited (on the Mac checking a mention) stays. An issue start (`always`) clears it regardless.
 */
export function clearSentDraft(drafts: Record<string, string>, chatId: string, sent: string, always = false) {
  return always || drafts[chatId] === sent ? { ...drafts, [chatId]: "" } : drafts;
}

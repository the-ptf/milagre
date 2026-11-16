export function clearSentDraft(drafts: Record<string, string>, chatId: string, sent: string, always = false) {
  return always || drafts[chatId] === sent ? { ...drafts, [chatId]: "" } : drafts;
}

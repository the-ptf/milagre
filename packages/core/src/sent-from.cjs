// Where the user typed a message (ChatSendRequest.sentFrom): their phone, their iPad, or another computer's Milagre. A
// message with none was typed in this computer's own window. The agent is told after the message, so it doesn't ask
// someone texting from their phone to open a folder or an app on this computer.
const PLACES = { phone: "their phone", tablet: "their iPad", computer: "another computer" };
// Chats remembered as last written from another device, so the message that comes back to this computer says so.
const MAX_AWAY = 1000;

const awayNote = (place) =>
  `<milagre_note>The user sent this from ${place}, not from this computer. They can't open this computer's files, folders, apps or windows, so don't ask them to: show what they need in your reply, an artifact, a design or the Browser panel. If you can use this computer's screen yourself (computer use), do the step and show a screenshot; nobody is using it now.</milagre_note>`;
// Back at the screen, the user is using the mouse and keyboard computer use would take over.
const BACK_NOTE = "<milagre_note>The user is back at this computer. Ask before taking over its mouse, keyboard or screen with computer use.</milagre_note>";

/** The device a message names, or null for this computer's own window (anything unknown counts as this computer). */
function sentFromDevice(value) {
  return typeof value === "string" && Object.hasOwn(PLACES, value) ? value : null;
}

/** `enabled()`: Settings › Experimental › Device notes, off by default. While off, no message carries a note. */
function createSentFromNotes({ enabled = () => true } = {}) {
  const away = new Set();
  return {
    /**
     * The message as the agent gets it: its prompt with the device note after it (a leading slash command stays first),
     * and without `sentFrom`. `chatId` is the Chat it goes to, null for a new one.
     */
    message(request, chatId) {
      const { sentFrom, ...message } = request;
      if (!enabled()) return message;
      const device = sentFromDevice(sentFrom);
      const note = device ? awayNote(PLACES[device]) : chatId && away.has(chatId) ? BACK_NOTE : null;
      const prompt = message.prompt || message.body;
      return note && prompt ? { ...message, prompt: `${prompt}\n\n${note}` } : message;
    },
    /** Remembers where the Chat's latest message came from, once it was saved. */
    sent(chatId, sentFrom) {
      away.delete(chatId);
      if (!sentFromDevice(sentFrom)) return;
      away.add(chatId);
      if (away.size > MAX_AWAY) away.delete(away.values().next().value);
    },
  };
}

module.exports = { createSentFromNotes, sentFromDevice };

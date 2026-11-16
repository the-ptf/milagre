const PLACES = { phone: "their phone", tablet: "their iPad", computer: "another computer" };
const MAX_AWAY = 1000;

const awayNote = (place) =>
  `<milagre_note>The user sent this from ${place}, not from this computer. They can't open this computer's files, folders, apps or windows, so don't ask them to: show what they need in your reply, an artifact, a design or the Browser panel. If you can use this computer's screen yourself (computer use), do the step and show a screenshot; nobody is using it now.</milagre_note>`;
const BACK_NOTE = "<milagre_note>The user is back at this computer. Ask before taking over its mouse, keyboard or screen with computer use.</milagre_note>";

function sentFromDevice(value) {
  return typeof value === "string" && Object.hasOwn(PLACES, value) ? value : null;
}

function createSentFromNotes({ enabled = () => true } = {}) {
  const away = new Set();
  return {
    message(request, chatId) {
      const { sentFrom, ...message } = request;
      if (!enabled()) return message;
      const device = sentFromDevice(sentFrom);
      const note = device ? awayNote(PLACES[device]) : chatId && away.has(chatId) ? BACK_NOTE : null;
      const prompt = message.prompt || message.body;
      return note && prompt ? { ...message, prompt: `${prompt}\n\n${note}` } : message;
    },
    sent(chatId, sentFrom) {
      away.delete(chatId);
      if (!sentFromDevice(sentFrom)) return;
      away.add(chatId);
      if (away.size > MAX_AWAY) away.delete(away.values().next().value);
    },
  };
}

module.exports = { createSentFromNotes, sentFromDevice };

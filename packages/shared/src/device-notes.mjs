// Settings › Experimental › Device notes, the same words on desktop and phone. The note itself is written by the host
// (packages/core/src/sent-from.cjs); a test there keeps it within DEVICE_NOTE_TOKENS. Types: device-notes.d.mts.

/** At most what one note adds (a quarter of its characters, the usual estimate) to a message sent from a phone, an iPad or another computer, in tokens. */
export const DEVICE_NOTE_TOKENS = 100;
export const DEVICE_NOTES_LABEL = "Device notes";
export const DEVICE_NOTES_DESCRIPTION =
  "Tell a Chat's agent when you write from your phone, iPad or another computer, so it doesn't ask you to open files or apps on the Mac.";
export const DEVICE_NOTES_WARNING = `Adds about ${DEVICE_NOTE_TOKENS} tokens to every message you send from another device.`;

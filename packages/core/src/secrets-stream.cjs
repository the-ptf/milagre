const { REDACT_MIN_CHARS } = require("@milagre/shared/secrets");

const STREAMS = { "text-delta": () => "text", "step-output": (event) => `step:${event.id}` };

function mapStrings(value, change, depth = 0) {
  if (typeof value === "string") return change(value);
  if (!value || typeof value !== "object" || depth > 16) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapStrings(item, change, depth + 1);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  let next = null;
  for (const [key, item] of Object.entries(value)) {
    const mapped = mapStrings(item, change, depth + 1);
    if (mapped !== item) (next ??= { ...value })[key] = mapped;
  }
  return next ?? value;
}

const TURN_ENDS = new Set(["turn-completed", "turn-failed", "turn-cancelled"]);

/** Which held streams an event ends: its turn's end ends them all, a finished step ends its output, a new message ends the text. */
function ends(event, key) {
  if (TURN_ENDS.has(event?.type)) return true;
  if (event?.type === "step-completed") return key === `step:${event.id}`;
  return event?.type === "text-delta" && event.startsMessage === true && key === "text";
}

/**
 * Redacts a Chat's provider events before they are stored or shown. Streamed text arrives in chunks, so a value can
 * straddle two of them: the end of a chunk that could begin a secret waits for the next chunk of the same stream. A
 * stream that ends while holding such a tail lets it through when it's too short to be a secret, else masks it.
 */
function createSecretStream({ redactor }) {
  const held = new Map();

  function release(id, deliver) {
    const entry = held.get(id);
    held.delete(id);
    const masked = entry.text.length >= REDACT_MIN_CHARS ? "[secret]" : entry.text;
    deliver({ ...entry.event, text: masked });
  }

  function forward(chatId, event, deliver) {
    for (const [id, entry] of held) if (entry.chatId === chatId && ends(event, entry.key)) release(id, deliver);
    const redact = redactor();
    if (!redact) return deliver(event);
    const key = STREAMS[event?.type]?.(event) ?? null;
    if (!key || typeof event.text !== "string") return deliver(mapStrings(event, redact));
    const id = `${chatId}\n${key}`;
    const prior = held.get(id);
    held.delete(id);
    const text = redact((prior?.text ?? "") + event.text);
    const keep = redact.pending(text);
    const ready = text.slice(0, text.length - keep);
    const base = prior?.event ?? event;
    if (ready) deliver({ ...mapStrings(base, redact), text: ready });
    if (!keep) return;
    const { startsMessage: _starts, ...continued } = base;
    held.set(id, { chatId, key, event: ready ? continued : base, text: text.slice(ready.length) });
  }

  return { forward };
}

module.exports = { createSecretStream, mapStrings };

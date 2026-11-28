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

/**
 * Redacts a Chat's provider events before they are stored or shown. Streamed text arrives in chunks, so a value can
 * straddle two of them: the end of a chunk that could begin a secret waits for the next chunk of the same stream, or
 * for anything else from that Chat, or for `holdMs`.
 */
function createSecretStream({ redactor, holdMs = 1000 }) {
  const held = new Map();

  function flush(chatId, deliver) {
    const entry = held.get(chatId);
    if (!entry) return;
    held.delete(chatId);
    clearTimeout(entry.timer);
    const redact = redactor();
    deliver({ ...entry.event, text: redact ? redact(entry.text) : entry.text });
  }

  function forward(chatId, event, deliver) {
    const key = STREAMS[event?.type]?.(event) ?? null;
    const waiting = held.get(chatId);
    if (waiting && (waiting.key !== key || event.startsMessage)) flush(chatId, deliver);
    const redact = redactor();
    if (!redact) return deliver(event);
    if (!key || typeof event.text !== "string") return deliver(mapStrings(event, redact));
    const prior = held.get(chatId);
    if (prior) {
      held.delete(chatId);
      clearTimeout(prior.timer);
    }
    const text = redact((prior?.text ?? "") + event.text);
    const keep = redact.pending(text);
    const ready = text.slice(0, text.length - keep);
    const base = prior?.event ?? event;
    if (ready) deliver({ ...mapStrings(base, redact), text: ready });
    if (!keep) return;
    const { startsMessage: _starts, ...continued } = base;
    const timer = setTimeout(() => flush(chatId, deliver), holdMs);
    timer.unref?.();
    held.set(chatId, { key, event: ready ? continued : base, text: text.slice(ready.length), timer });
  }

  return { forward, flush, mapStrings };
}

module.exports = { createSecretStream, mapStrings };

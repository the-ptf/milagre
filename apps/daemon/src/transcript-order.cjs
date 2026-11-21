const { wholeTranscriptsReady, prepareWholeTranscripts } = require("@milagre/core/project-content");

const takesTranscripts = (form) => !form || form.transcripts;

/**
 * Sends to a client that takes whole subagent transcripts wait until those transcripts are read back from disk, off the
 * event loop, and leave in the order they were made; any other send goes out at once.
 */
function createTranscriptOrder({ onError }) {
  const held = new Map();
  function inOrder(key, form, states, send) {
    const wanted = takesTranscripts(form) ? states : [];
    const pending = held.get(key);
    if (!pending && wanted.every(wholeTranscriptsReady)) return send();
    const run = (pending ?? Promise.resolve())
      .catch(() => {})
      .then(() => prepareWholeTranscripts(wanted))
      .catch(onError)
      .then(send)
      .finally(() => {
        if (held.get(key) === run) held.delete(key);
      });
    held.set(key, run);
    return run;
  }
  async function prepare(form, states) {
    if (takesTranscripts(form)) await prepareWholeTranscripts(states);
  }
  async function latest(form, read) {
    let sent = read();
    while (takesTranscripts(form) && !wholeTranscriptsReady(sent.state)) {
      await prepareWholeTranscripts([sent.state]);
      sent = read();
    }
    return sent;
  }
  return { inOrder, prepare, latest };
}

module.exports = { createTranscriptOrder };

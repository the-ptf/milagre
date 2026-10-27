const { createFrameReader, createFrameWriter, MAX_FRAME_BYTES } = require("@milagre/shared/peer-frames");

// What a paired desktop may leave unsent before its channel is dropped. It counts the characters of the texts about to
// be sealed (a whole frame, or each part with its base64 data), so a frame past the limit costs more than its raw JSON;
// the carrier's own overhead is not counted. Twice the frame limit, as in wire() (protocol.cjs).
const PEER_BUDGET = 2 * MAX_FRAME_BYTES;
const PONG = new TextEncoder().encode('{"t":"pong"}');

/**
 * A paired desktop on an encrypted channel: one daemon connection (`openPeer`, which is acceptConnection with the
 * paired-desktop policy) whose frames travel as rpc / evt / part messages (@milagre/shared/peer-frames).
 * `deliver(encoded)` hands one message's UTF-8 JSON bytes to the carrier, which seals it (batched with its neighbours when
 * the desktop takes batches) and sends it; `queued()` is how many bytes the carrier holds unsent
 * toward this desktop; `isOpen()` says whether the channel stands; `drop()` closes the channel, after which the carrier
 * calls `close()`. `receive(message)` takes each opened message and throws on one the protocol has no place for, for
 * the carrier to drop the channel.
 */
function openPeerChannel({ openPeer, deliver, queued, isOpen, drop, budget = PEER_BUDGET }) {
  const reader = createFrameReader("rpc");
  const writer = createFrameWriter("evt");
  const connection = openPeer({
    // As wire()'s send: throws FRAME_TOO_LARGE past the frame limit; false once closed, or once dropped for falling behind.
    send(message, json) {
      if (!isOpen()) return false;
      const texts = writer.write(json ?? JSON.stringify(message));
      const size = texts.reduce((total, text) => total + text.length, 0);
      if (queued() + size > budget) {
        drop();
        return false;
      }
      for (const text of texts) deliver(text);
      return true;
    },
    end: drop,
    destroy: drop,
    isClosed: () => !isOpen(),
  });
  return {
    receive(message) {
      if (message?.t === "ping") {
        if (isOpen()) deliver(PONG);
        return;
      }
      if (message?.t !== "rpc" && message?.t !== "part") throw new Error("Unknown message");
      let read;
      try {
        read = reader.read(message);
      } catch (error) {
        // As a socket's framing error: the connection answers with the code, then ends.
        connection.invalid(error);
        return;
      }
      if (read) connection.receive(read.frame);
    },
    close: () => connection.close(),
  };
}

module.exports = { openPeerChannel, PEER_BUDGET };

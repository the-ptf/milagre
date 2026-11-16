const { createFrameReader, createFrameWriter, MAX_FRAME_BYTES } = require("@milagre/shared/peer-frames");
const { createPeerStreams, dialTcp } = require("./peer-streams.cjs");

const PEER_BUDGET = 2 * MAX_FRAME_BYTES;
const PONG = new TextEncoder().encode('{"t":"pong"}');

function openPeerChannel({ openPeer, deliver, queued, isOpen, drop, budget = PEER_BUDGET, dial = dialTcp }) {
  const reader = createFrameReader("rpc");
  const writer = createFrameWriter("evt");
  const encoder = new TextEncoder();
  const streams = createPeerStreams({
    dial,
    opener: "computer",
    send(message) {
      if (!isOpen()) return;
      const encoded = encoder.encode(JSON.stringify(message));
      if (queued() + encoded.length > budget) return drop();
      deliver(encoded);
    },
  });
  const connection = openPeer({
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
    openStream: (target, port) => streams.open(target, port),
  });
  return {
    receive(message) {
      if (message?.t === "ping") {
        if (isOpen()) deliver(PONG);
        return;
      }
      if (streams.isStreamMessage(message)) return streams.receive(message);
      if (message?.t !== "rpc" && message?.t !== "part") throw new Error("Unknown message");
      let read;
      try {
        read = reader.read(message);
      } catch (error) {
        connection.invalid(error);
        return;
      }
      if (read) connection.receive(read.frame);
    },
    close() {
      streams.close();
      connection.close();
    },
  };
}

module.exports = { openPeerChannel, PEER_BUDGET };

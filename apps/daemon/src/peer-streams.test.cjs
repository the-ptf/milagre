const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { createPeerStreams, dialTcp, WINDOW, MAX_STREAMS } = require("./peer-streams.cjs");

/** A desktop and a computer joined as a channel does: each message JSON round-tripped and delivered later, in order. */
function pair({ dial = dialTcp, dialMs, desktopDial } = {}) {
  const log = [];
  const ends = {};
  const carry = (to) => (message) => {
    log.push(message);
    const copy = JSON.parse(JSON.stringify(message));
    setImmediate(() => ends[to].receive(copy));
  };
  ends.computer = createPeerStreams({ send: carry("desktop"), dial, dialMs, opener: "computer" });
  ends.desktop = createPeerStreams({ send: carry("computer"), ...(desktopDial ? { dial: desktopDial } : {}) });
  return { ...ends, log };
}

async function server(t, onSocket) {
  const listener = net.createServer(onSocket);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  return listener.address().port;
}
const echo = (socket) => socket.pipe(socket);

/** Everything a stream gives until it ends. */
function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

test("a stream reaches the computer's localhost and carries bytes both ways, intact, past several windows", async (t) => {
  const port = await server(t, echo);
  const { desktop } = pair();
  const stream = await desktop.open("127.0.0.1", port);
  const sent = randomBytes(WINDOW * 5 + 123);
  const received = readAll(stream);
  stream.end(sent);
  assert.ok((await received).equals(sent));
});

test("a half close passes through: the server sees the end and still answers", async (t) => {
  const port = await server(t, (socket) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => socket.end(`got ${Buffer.concat(chunks).length} bytes`));
  });
  const { desktop } = pair();
  const stream = await desktop.open("localhost", port);
  const answer = readAll(stream);
  stream.end(Buffer.alloc(1000));
  assert.equal((await answer).toString(), "got 1000 bytes");
});

test("a refused or invalid dial says why, and a computer without dial refuses every stream", async (t) => {
  const port = await server(t, echo);
  await new Promise((resolve) => setImmediate(resolve));
  const closed = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = probe.address().port;
      probe.close(() => resolve(free));
    });
  });
  const { desktop } = pair();
  await assert.rejects(desktop.open("127.0.0.1", closed), { code: "refused" });
  await assert.rejects(desktop.open("bad host", port), /Invalid address/);
  await assert.rejects(desktop.open("127.0.0.1", 70000), /Invalid address/);
  // A desktop's own end has no dial: a computer can never open a stream toward it.
  const sent = [];
  const plain = createPeerStreams({ send: (message) => sent.push(message) });
  plain.receive({ t: "tcp-open", id: 1, host: "127.0.0.1", port });
  assert.deepEqual(sent, [{ t: "tcp-close", id: 1, code: "failed" }]);
});

test("a dial that never connects times out", async () => {
  const { desktop } = pair({ dial: () => new net.Socket(), dialMs: 50 });
  await assert.rejects(desktop.open("10.255.255.1", 80), { code: "timeout" });
});

test("a reader that stops reading stops its sender at one window instead of filling the channel", async (t) => {
  let accepted;
  const connected = new Promise((resolve) => {
    accepted = resolve;
  });
  const port = await server(t, (socket) => accepted(socket));
  const { desktop, log } = pair();
  const stream = await desktop.open("127.0.0.1", port);
  const serverSocket = await connected;
  stream.pause();
  // The server writes far more than a window; nobody reads it on the desktop.
  serverSocket.write(randomBytes(WINDOW * 8));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const carried = log.filter((message) => message.t === "tcp").reduce((total, message) => total + Buffer.from(message.data, "base64").length, 0);
  // The desktop's stream buffers to its high-water mark before it stops acking; then the computer holds the rest.
  assert.ok(carried <= WINDOW * 2 + 64 * 1024, `carried ${carried}`);
  assert.ok(carried >= WINDOW, `carried ${carried}`);
  const rest = readAll(stream);
  stream.resume();
  serverSocket.end();
  assert.equal((await rest).length, WINDOW * 8);
});

test("past the stream limit a computer answers busy, and the desktop refuses before asking", async (t) => {
  const port = await server(t, () => {});
  const { desktop } = pair();
  const streams = await Promise.all(Array.from({ length: MAX_STREAMS }, () => desktop.open("127.0.0.1", port)));
  await assert.rejects(desktop.open("127.0.0.1", port), { code: "busy" });
  for (const stream of streams) stream.destroy();
  const sent = [];
  const computer = createPeerStreams({ send: (message) => sent.push(message), dial: () => new net.Socket() });
  for (let id = 1; id <= MAX_STREAMS + 1; id++) computer.receive({ t: "tcp-open", id, host: "127.0.0.1", port });
  assert.deepEqual(sent.at(-1), { t: "tcp-close", id: MAX_STREAMS + 1, code: "busy" });
  computer.close();
});

test("a message that breaks the protocol throws for the carrier to drop the channel", () => {
  const end = createPeerStreams({ send: () => {} });
  assert.throws(() => end.receive({ t: "tcp", id: 0, data: "" }), /Bad stream/);
  assert.throws(() => end.receive({ t: "tcp", id: 1, data: "not base64!" }), /Bad stream data/);
  assert.throws(() => end.receive({ t: "tcp", id: 1, data: "A".repeat(50_000) }), /Bad stream data/);
  assert.throws(() => end.receive({ t: "tcp-ack", id: 1, n: -1 }), /Bad stream ack/);
  assert.throws(() => end.receive({ t: "tcp-opened", id: 9 }), /Bad stream/);
  // Late data for a stream this side already closed is dropped quietly.
  end.receive({ t: "tcp", id: 5, data: "AAAA" });
  end.receive({ t: "tcp-close", id: 5 });
});

test("closing the channel ends every stream on both sides: the computer's sockets close, the desktop's opens fail", async (t) => {
  let ended;
  const serverClosed = new Promise((resolve) => {
    ended = resolve;
  });
  const port = await server(t, (socket) => socket.on("close", ended));
  const { desktop, computer } = pair();
  const stream = await desktop.open("127.0.0.1", port);
  const desktopClosed = new Promise((resolve) => stream.on("close", resolve));
  const waiting = desktop.open("127.0.0.1", port);
  desktop.close();
  computer.close();
  await assert.rejects(waiting, { code: "lost" });
  await desktopClosed;
  await serverClosed;
  await assert.rejects(desktop.open("127.0.0.1", port), /channel closed/);
});

test("the computer reaches back to the desktop only where the desktop allows, and both sides' streams live side by side", async (t) => {
  const allowed = await server(t, echo);
  const elsewhere = await server(t, echo);
  const { desktop, computer, log } = pair({
    desktopDial: (target, port) => {
      if (target !== "127.0.0.1" || port !== allowed) throw Object.assign(new Error("no"), { code: "ECONNREFUSED" });
      return dialTcp(target, port);
    },
  });
  const forward = await desktop.open("127.0.0.1", elsewhere);
  const back = await computer.open("127.0.0.1", allowed);
  await assert.rejects(computer.open("127.0.0.1", elsewhere), { code: "refused" });
  const ids = log.filter((message) => message.t === "tcp-open").map((message) => message.id);
  assert.deepEqual(
    ids.map((id) => id % 2),
    [1, 0, 0],
    "the desktop's ids are odd, the computer's even",
  );
  const forwardEcho = readAll(forward);
  const backEcho = readAll(back);
  forward.end("there");
  back.end("and back");
  assert.equal((await forwardEcho).toString(), "there");
  assert.equal((await backEcho).toString(), "and back");
});

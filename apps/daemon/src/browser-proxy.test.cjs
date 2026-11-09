const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createBrowserProxies, parseRequest } = require("./browser-proxy.cjs");

/** A SOCKS5 client as Chromium speaks it: greeting with no authentication, then CONNECT. Resolves the reply's code. */
function socksConnect(port, { target, targetPort, methods = [0x00], command = 0x01 }) {
  const socket = net.connect(port, "127.0.0.1");
  const address = net.isIPv4(target)
    ? Buffer.from([0x01, ...target.split(".").map(Number)])
    : Buffer.concat([Buffer.from([0x03, target.length]), Buffer.from(target)]);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(targetPort);
  return new Promise((resolve, reject) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(Buffer.from([0x05, methods.length, ...methods])));
    socket.on("close", () => resolve({ socket, closed: true, stage, buffer }));
    socket.on("data", function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting" && buffer.length >= 2) {
        const chosen = buffer[1];
        buffer = buffer.subarray(2);
        if (chosen !== 0x00) return resolve({ socket, method: chosen });
        stage = "request";
        socket.write(Buffer.concat([Buffer.from([0x05, command, 0x00]), address, portBytes]));
      }
      if (stage === "request" && buffer.length >= 10) {
        const code = buffer[1];
        const rest = buffer.subarray(10);
        socket.off("data", onData);
        socket.pause();
        resolve({ socket, code, rest });
      }
    });
  });
}

async function echoServer(t) {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

test("a page's connection is opened from its computer, named as the page named it, and carries bytes both ways", async (t) => {
  const echo = await echoServer(t);
  const asked = [];
  const proxies = createBrowserProxies({
    openStream: async (computerId, target, port) => {
      asked.push([computerId, target, port]);
      return net.connect(echo, "127.0.0.1");
    },
  });
  t.after(() => proxies.close());
  const port = await proxies.port("studio");
  assert.equal(await proxies.port("studio"), port, "one proxy per computer");
  const { socket, code } = await socksConnect(port, { target: "localhost", targetPort: 5173 });
  assert.equal(code, 0x00);
  socket.resume();
  const echoed = new Promise((resolve) => socket.once("data", (data) => resolve(data.toString())));
  socket.write("GET / HTTP/1.1\r\n\r\n");
  assert.equal(await echoed, "GET / HTTP/1.1\r\n\r\n");
  socket.destroy();
  const second = await socksConnect(port, { target: "127.0.0.1", targetPort: 3000 });
  assert.equal(second.code, 0x00);
  second.socket.destroy();
  assert.deepEqual(asked, [
    ["studio", "localhost", 5173],
    ["studio", "127.0.0.1", 3000],
  ]);
});

test("a computer that can't connect answers with the SOCKS reason, and the proxy refuses what it doesn't speak", async (t) => {
  const failures = { 1: "refused", 2: "not-found", 3: "offline", 4: "timeout", 5: "weird" };
  const proxies = createBrowserProxies({
    openStream: async (_id, _target, port) => {
      throw Object.assign(new Error("no"), { code: failures[port] });
    },
  });
  t.after(() => proxies.close());
  const port = await proxies.port("studio");
  const codes = [];
  for (const targetPort of [1, 2, 3, 4, 5]) codes.push((await socksConnect(port, { target: "localhost", targetPort })).code);
  assert.deepEqual(codes, [0x05, 0x04, 0x03, 0x06, 0x01]);
  assert.equal((await socksConnect(port, { target: "localhost", targetPort: 80, methods: [0x02] })).method, 0xff, "username/password only");
  assert.equal((await socksConnect(port, { target: "localhost", targetPort: 80, command: 0x02 })).code, 0x07, "BIND");
});

test("requests parse across chunks and for every address type", () => {
  const greeting = Buffer.from([0x05, 0x01, 0x00]);
  assert.equal(parseRequest(Buffer.from([0x05])), null);
  assert.deepEqual(parseRequest(greeting), { greeting: 3 });
  const v6 = Buffer.alloc(16);
  v6[15] = 1;
  const request = Buffer.concat([greeting, Buffer.from([0x05, 0x01, 0x00, 0x04]), v6, Buffer.from([0x1f, 0x90]), Buffer.from("early")]);
  const parsed = parseRequest(request);
  assert.equal(parsed.target, "0:0:0:0:0:0:0:1");
  assert.equal(parsed.port, 8080);
  assert.equal(parsed.rest.toString(), "early");
  assert.deepEqual(parseRequest(Buffer.from([0x04, 0x01])), { error: "version" });
});

test("dropping a computer's proxy ends its connections, and a closed set takes no more", async (t) => {
  const echo = await echoServer(t);
  const proxies = createBrowserProxies({ openStream: async () => net.connect(echo, "127.0.0.1") });
  const port = await proxies.port("studio");
  const { socket } = await socksConnect(port, { target: "localhost", targetPort: 1 });
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.resume();
  await proxies.drop("studio");
  await closed;
  assert.notEqual(await proxies.port("studio"), port, "a new proxy after the drop");
  await proxies.close();
  await assert.rejects(proxies.port("studio"), /quitting/);
});

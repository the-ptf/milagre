const path = require("node:path");
const { nearestColour } = require("./simulator-metrics.cjs");

const root = path.resolve(__dirname, "../..");
const PALETTE = [
  [224, 0, 0],
  [0, 176, 0],
  [0, 48, 255],
  [255, 255, 255],
];
const THUMB = 32;

// Serialized into the receiver page ahead of the receiver script. It must not close over module state.
function probe(palette, nearest, size) {
  const now = () => performance.timeOrigin + performance.now();
  const state = { startedAt: now(), frames: [], taps: [], tapCount: 0, colour: -1 };
  let pending = null;
  const thumb = document.createElement("canvas");
  thumb.width = thumb.height = size;
  const context = thumb.getContext("2d", { willReadFrequently: true });
  const middle = size / 2;
  const paint = (source, width, height, kind) => {
    if (!width || !height) return;
    const decodedAt = now();
    context.drawImage(source, 0, 0, width, height, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] >> 3), 16777619);
      hash = Math.imul(hash ^ (data[i + 1] >> 3), 16777619);
      hash = Math.imul(hash ^ (data[i + 2] >> 3), 16777619);
    }
    const at = (x, y) => [0, 1, 2].map((c) => data[(y * size + x) * 4 + c]);
    const rgb = [0, 0, 0];
    for (let y = middle - 2; y < middle + 2; y++) for (let x = middle - 2; x < middle + 2; x++) at(x, y).forEach((value, c) => (rgb[c] += value / 16));
    const centre = nearest(rgb, palette);
    const spots = [at(middle - 6, middle), at(middle + 5, middle), at(middle, middle - 3), at(middle, middle + 2)];
    const colour = spots.every((spot) => nearest(spot, palette) === centre) ? centre : -1;
    requestAnimationFrame(() => {
      const paintedAt = now();
      state.frames.push({ decodedAt, paintedAt, hash: hash >>> 0, colour, kind, width, height });
      if (pending && colour === (pending.before + 1) % palette.length) {
        pending.decodedAt = decodedAt;
        pending.paintedAt = paintedAt;
        pending = null;
      }
      if (colour >= 0) state.colour = colour;
    });
  };
  document.addEventListener(
    "load",
    (event) => {
      if (event.target?.id === "image") paint(event.target, event.target.naturalWidth, event.target.naturalHeight, "image");
    },
    true,
  );
  const drawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const result = drawImage.apply(this, args);
    if (this.canvas.id === "canvas") paint(this.canvas, this.canvas.width, this.canvas.height, "canvas");
    return result;
  };
  const video = document.getElementById("video");
  const onVideoFrame = () => {
    paint(video, video.videoWidth, video.videoHeight, "video");
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback?.(onVideoFrame);
  document.getElementById("stage").addEventListener(
    "pointerdown",
    () => {
      state.tapCount++;
      pending = { at: now(), before: state.colour };
      state.taps.push(pending);
    },
    true,
  );
  window.benchTake = () => {
    const frames = state.frames.splice(0);
    return { startedAt: state.startedAt, colour: state.colour, frames, taps: state.tapCount, tapping: pending !== null };
  };
  window.benchTaps = () => state.taps.splice(0);
  window.benchTarget = () => {
    const rect = document.getElementById("screen").getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  };
}

function probeScript() {
  return `(${probe.toString()})(${JSON.stringify(PALETTE)},${nearestColour.toString()},${THUMB});`;
}

async function receiverHtml(device) {
  const { createSimulatorReceiverHtml } = await import(path.join(root, "packages/shared/src/simulator-receiver.mjs"));
  const html = createSimulatorReceiverHtml({ deviceId: device.id, device });
  const at = html.lastIndexOf("<script>");
  return `${html.slice(0, at)}<script>${probeScript()}</script>${html.slice(at)}`;
}

async function viewerHtml({ device, chatId }) {
  const { createSimulatorBridge } = await import(path.join(root, "packages/shared/src/simulator-receiver.mjs"));
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id="frame" sandbox="allow-scripts allow-same-origin" allow="autoplay"></iframe><script>
const createSimulatorBridge = ${createSimulatorBridge.toString()};
const chatId = ${JSON.stringify(chatId)};
const frame = document.getElementById("frame");
window.simState = "connecting";
const bridge = createSimulatorBridge(
  (method, args) => window.bench.invoke(method, method === "open" ? { ...args, chatId } : args),
  (reply) => frame.contentWindow.postMessage(reply, "*"),
);
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.channel === "milagre-simulator" && event.data.event === "state") return void (window.simState = event.data.state);
  if (event.data?.channel === "milagre-simulator" && event.data.event === "close") return;
  void bridge.receive(event.data);
});
frame.srcdoc = ${JSON.stringify(await receiverHtml(device)).replace(/</g, "\\u003c")};
</script></body></html>`;
}

const replySize = (result) => (typeof result?.data === "string" ? result.data.length + 256 : JSON.stringify(result ?? null).length);

async function openTransport({ path: route, host, relayUrl }) {
  const counters = { messages: 0, bytes: 0, wire: 0 };
  if (route === "desktop") {
    const { connect } = require(path.join(root, "apps/daemon/src/client.cjs"));
    const client = await connect({ dataDir: host.dataDir });
    return {
      counters,
      async call(method, request) {
        const result = await client.call(`simulator:${method}`, [request]);
        counters.messages++;
        counters.bytes += replySize(result);
        return result;
      },
      close: () => client.close(),
    };
  }
  const { createRelayTransport } = await import(path.join(root, "apps/mobile/src/relay-transport.ts"));
  const { boxKeyPair, b64url } = await import(path.join(root, "packages/shared/src/relay-crypto.mjs"));
  const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const identity = boxKeyPair(random);
  const answer = await fetch(`${host.localUrl}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, method: "phone:routes", args: [{ phoneKey: b64url(identity.publicKey) }] }),
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  if (answer.error) throw new Error(`phone:routes failed: ${JSON.stringify(answer.error)}`);
  const endpoint = route === "lan" ? answer.result.lan[0] : relayUrl;
  if (!endpoint) throw new Error(`No ${route} route to the host.`);
  const transport = createRelayTransport({
    relay: endpoint,
    hostId: answer.result.hostId,
    key: answer.result.key,
    token: host.token,
    identity,
    name: "Perf phone",
    random,
    create: (url) => {
      const socket = new WebSocket(url);
      socket.addEventListener("message", (event) => {
        counters.wire += event.data?.byteLength ?? event.data?.size ?? String(event.data).length;
      });
      return socket;
    },
  });
  await transport.ready();
  const decoder = new TextDecoder();
  return {
    counters,
    async call(method, request) {
      const response = await transport.request(
        "POST",
        "/rpc",
        { "Content-Type": "application/json" },
        JSON.stringify({ v: 1, method: `simulator:${method}`, args: [request] }),
      );
      counters.messages++;
      counters.bytes += response.body.length;
      const body = JSON.parse(decoder.decode(response.body));
      if (body.error) throw new Error(body.error.message ?? String(body.error));
      return body.result;
    },
    close: () => transport.close(),
  };
}

module.exports = { PALETTE, openTransport, viewerHtml };

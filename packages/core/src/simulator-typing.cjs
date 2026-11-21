const MAX_CLIPBOARD = 65536;
const SHIFT = 225;
const US_KEYS = new Map([
  ..."abcdefghijklmnopqrstuvwxyz".split("").flatMap((c, i) => [
    [c, [4 + i, false]],
    [c.toUpperCase(), [4 + i, true]],
  ]),
  ..."1234567890".split("").map((c, i) => [c, [30 + i, false]]),
  ..."!@#$%^&*()".split("").map((c, i) => [c, [30 + i, true]]),
  ...[
    ["\n", 40],
    ["\t", 43],
    [" ", 44],
    ["-", 45, "_"],
    ["=", 46, "+"],
    ["[", 47, "{"],
    ["]", 48, "}"],
    ["\\", 49, "|"],
    [";", 51, ":"],
    ["'", 52, '"'],
    ["`", 53, "~"],
    [",", 54, "<"],
    [".", 55, ">"],
    ["/", 56, "?"],
  ].flatMap(([plain, usage, shifted]) => [[plain, [usage, false]], ...(shifted ? [[shifted, [usage, true]]] : [])]),
]);
const ANDROID_KEYS = new Map([
  ...Array.from({ length: 26 }, (_, i) => [4 + i, 29 + i]),
  ...Array.from({ length: 9 }, (_, i) => [30 + i, 8 + i]),
  [39, 7],
  [40, 66],
  [41, 111],
  [42, 67],
  [43, 61],
  [44, 62],
  [45, 69],
  [46, 70],
  [47, 71],
  [48, 72],
  [49, 73],
  [51, 74],
  [52, 75],
  [53, 68],
  [54, 55],
  [55, 56],
  [56, 76],
  [74, 122],
  [75, 92],
  [76, 112],
  [77, 123],
  [78, 93],
  [79, 22],
  [80, 21],
  [81, 20],
  [82, 19],
  [224, 113],
  [225, 59],
  [226, 57],
  [227, 117],
  [228, 114],
  [229, 60],
  [230, 58],
  [231, 118],
]);
const ANDROID_META = new Map([
  [224, 0x3000],
  [225, 0x41],
  [226, 0x12],
  [227, 0x30000],
  [228, 0x5000],
  [229, 0x81],
  [230, 0x22],
  [231, 0x50000],
]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function readJson(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("oversized response");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Typed text, paste and clipboard reads for one helper input socket. Pending pastes fail when the socket closes. */
function createSimulatorTyping({ android, deviceId, socket, send, instance, ready }) {
  let keyboardUnavailable = false,
    androidMeta = 0,
    requestId = 0;
  const requests = new Map();
  socket.addEventListener("message", ({ data }) => {
    if (android || !(data instanceof ArrayBuffer) || data.byteLength > 65536) return;
    const bytes = Buffer.from(data);
    if (bytes[0] !== 0x82 && bytes[0] !== 0x92) return;
    try {
      const reply = JSON.parse(bytes.subarray(1).toString("utf8"));
      if (bytes[0] === 0x82) keyboardUnavailable = reply.keyboardUnavailable === true;
      else
        requests.get(reply.requestId)?.(
          reply.ok === true ? null : new Error(typeof reply.error === "string" ? reply.error.slice(0, 300) : "The simulator refused the input."),
        );
    } catch {}
  });
  socket.addEventListener("close", () => {
    for (const settle of Array.from(requests.values())) settle(new Error("Simulator viewer closed."));
  });
  const paced = async (tag, payload) => {
    while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 4096) await pause(10);
    if (!ready()) throw new Error("Simulator input is not ready.");
    send(tag, payload);
  };
  const typeKeys = async (text) => {
    for (const character of text) {
      const [usage, shifted] = US_KEYS.get(character);
      const key = character >= " " ? { key: character, shifted } : {};
      if (shifted) await paced(6, { type: "down", usage: SHIFT });
      await paced(6, { type: "down", usage, ...key });
      await paced(6, { type: "up", usage, ...key });
      if (shifted) await paced(6, { type: "up", usage: SHIFT });
      await pause(8);
    }
  };
  const request = (tag, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      const settle = (error) => {
        clearTimeout(timeout);
        requests.delete(id);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => settle(new Error("The simulator did not finish. Try again.")), 20000);
      requests.set(id, settle);
      try {
        send(tag, { ...payload, requestId: id });
      } catch (error) {
        settle(error);
      }
    });
  const readPasteboard = async (press) => {
    let body;
    try {
      const response = await fetch(`${instance.base}/vendor/serve-sim/api/pasteboard?device=${encodeURIComponent(deviceId)}${press ? "&copy=1" : ""}`, {
        method: "POST",
        headers: { authorization: `Bearer ${instance.token}`, origin: instance.base },
        signal: AbortSignal.any([instance.abort.signal, AbortSignal.timeout(20000)]),
        redirect: "error",
      });
      body = await readJson(response, MAX_CLIPBOARD * 4 + 4096);
    } catch {
      throw new Error("Could not read the simulator clipboard. Try again.");
    }
    if (body?.ok !== true) throw new Error(typeof body?.error === "string" ? body.error.slice(0, 300) : "Could not read the simulator clipboard.");
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > MAX_CLIPBOARD) throw new Error("The simulator clipboard holds more than 64 KB of text.");
    return text;
  };
  const typeAndroid = async (text) => {
    if (/[^\x20-\x7e\n\t]/.test(text)) throw new Error("Android emulators take plain ASCII text here. Type accents and emoji with the emulator's keyboard.");
    for (const part of text.split(/([\n\t])/)) {
      if (part === "\n" || part === "\t") {
        const keycode = part === "\n" ? 66 : 61;
        await paced({ type: "key", keycode, action: "down", metaState: 0 });
        await paced({ type: "key", keycode, action: "up", metaState: 0 });
      } else for (let at = 0; at < part.length; at += 300) await paced({ type: "text", text: part.slice(at, at + 300) });
    }
  };
  return {
    capabilities: () => (android ? { keyboard: true } : keyboardUnavailable ? {} : { keyboard: true, copy: true }),
    sendAndroid(event) {
      if (event.kind !== "key") throw new Error("Invalid simulator input event.");
      const keycode = ANDROID_KEYS.get(event.usage);
      if (keycode === undefined) return;
      const bit = ANDROID_META.get(event.usage) ?? 0;
      androidMeta = event.phase === "down" ? androidMeta | bit : androidMeta & ~bit;
      send({ type: "key", keycode, action: event.phase, metaState: androidMeta });
    },
    async clipboard(event) {
      if (!ready()) throw new Error("Simulator input is not ready.");
      if (event.kind === "copy") {
        if (android) throw new Error("Copy from Android emulators isn't available.");
        return readPasteboard(event.press);
      }
      if (android) return typeAndroid(event.text);
      if (event.kind === "text" && Array.from(event.text).every((character) => US_KEYS.has(character))) return typeKeys(event.text);
      return request(18, { text: event.text });
    },
  };
}
module.exports = { createSimulatorTyping, readJson };

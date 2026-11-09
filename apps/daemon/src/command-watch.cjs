const { once } = require("node:events");

/** Subscribe before taking the snapshot, then discard buffered events at or before its watermark. */
async function watch(client, { output = process.stdout, chat, channels = [], signal } = {}) {
  const queue = [];
  let bytes = 0;
  let wake;
  let stopped = false;
  let failure;
  const finish = (error) => {
    failure = error;
    stopped = true;
    wake?.();
  };
  const event = (value) => {
    const line = JSON.stringify({ type: "event", ...value }) + "\n";
    bytes += Buffer.byteLength(line);
    if (bytes > 16 * 1024 * 1024) return finish(new Error("Event consumer fell behind. Reconnect for a fresh snapshot."));
    queue.push({ value, line });
    wake?.();
  };
  const closed = () => finish(new Error("Daemon connection closed. Reconnect for a fresh snapshot."));
  const abort = () => finish();
  client.on("event", event);
  client.on("close", closed);
  signal?.addEventListener("abort", abort, { once: true });
  const write = async (line) => {
    if (!output.write(line)) await once(output, "drain", { signal });
  };
  try {
    if (signal?.aborted) return;
    const snapshot = await client.call("daemon:snapshot");
    await write(JSON.stringify({ type: "snapshot", ...snapshot }) + "\n");
    for (;;) {
      if (stopped) break;
      const item = queue.shift();
      if (!item) {
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      bytes -= Buffer.byteLength(item.line);
      if (item.value.seq <= snapshot.eventSeq) continue;
      if (chat && item.value.payload?.chatId !== chat) continue;
      if (channels.length && !channels.includes(item.value.channel)) continue;
      await write(item.line);
    }
    if (failure) throw failure;
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    client.off("event", event);
    client.off("close", closed);
    signal?.removeEventListener("abort", abort);
  }
}

module.exports = { watch };

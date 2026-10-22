/** A persistent owner connection for viewer controls and scripts. Requests and events share bounded NDJSON framing. */
async function session(client, { input = process.stdin, output = process.stdout } = {}) {
  const pending = new Set();
  const ids = new Set();
  let buffered = Buffer.alloc(0);
  let failure;
  const write = (value) => {
    if (output.writableLength > 16 * 1024 * 1024) throw new Error("Session output fell behind. Check state before retrying mutations.");
    output.write(JSON.stringify(value) + "\n");
  };
  const event = (value) => {
    try {
      write({ type: "event", ...value });
    } catch (error) {
      failure = error;
      input.destroy(error);
    }
  };
  const close = () => input.destroy(new Error("Daemon connection closed. Check state before retrying mutations."));
  client.on("event", event);
  client.on("close", close);
  async function request(line) {
    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      write({ id: null, error: { code: "INVALID_REQUEST", message: "Expected a JSON request" } });
      return;
    }
    const id = message?.id;
    if (!message || !["string", "number"].includes(typeof id) || typeof message.method !== "string" || !Array.isArray(message.args) || ids.has(id)) {
      write({
        id: typeof id === "string" || typeof id === "number" ? id : null,
        error: { code: "INVALID_REQUEST", message: "Expected a unique id, method and args array" },
      });
      return;
    }
    ids.add(id);
    try {
      write({ id, result: await client.call(message.method, message.args) });
    } catch (error) {
      write({ id, error: { code: error.code ?? "COMMAND_FAILED", message: error.message } });
    } finally {
      ids.delete(id);
    }
  }
  const submit = async (line) => {
    if (!line.toString("utf8").trim()) return;
    if (pending.size >= 32) await Promise.race(pending);
    const work = request(line);
    pending.add(work);
    // Observe failures immediately, including while no further input arrives.
    void work.then(
      () => pending.delete(work),
      (error) => {
        pending.delete(work);
        failure = error;
        input.destroy(error);
      },
    );
  };
  try {
    for await (const chunk of input) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (buffered.length + end - start > 16 * 1024 * 1024) throw new Error("Session request exceeds 16 MiB");
        buffered = Buffer.concat([buffered, chunk.subarray(start, end)]);
        if (newline < 0) break;
        await submit(buffered);
        buffered = Buffer.alloc(0);
        start = end + 1;
      }
    }
    if (buffered.length) await submit(buffered);
    await Promise.all(pending);
    if (failure) throw failure;
  } finally {
    client.off("event", event);
    client.off("close", close);
  }
}

module.exports = { session };

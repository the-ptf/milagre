// Claude Desktop's stdio transport connects to the already running owning host.
// This adapter has no host startup, Project access or network discovery capability.
const MAX_BODY = 6000000 + 64 * 1024;
const url = process.env.MILAGRE_MCP_URL;
const token = process.env.MILAGRE_MCP_TOKEN;
if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/mcp$/.test(url ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) {
  process.stderr.write("Milagre MCP needs a loopback connection configured in Milagre Settings.\n");
  process.exitCode = 1;
} else {
  let buffered = Buffer.alloc(0);
  let discarding = false;
  const pending = new Set();
  const reply = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
  const failure = (id, message) => reply({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  async function forward(line) {
    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      return failure(null, "Invalid MCP request.");
    }
    if (!message || Array.isArray(message) || typeof message.method !== "string") return failure(null, "Invalid MCP request.");
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: line,
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
      if (response.status === 202) return;
      if (!response.ok && response.status !== 413) throw Error();
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) throw Error();
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      reply(payload);
    } catch {
      if (id !== null) failure(id, "Milagre is unavailable or this connection was revoked. Open Milagre and check MCP settings.");
    }
  }
  process.stdin.on("data", (chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (!discarding && buffered.length + part.length > MAX_BODY) {
        buffered = Buffer.alloc(0);
        discarding = true;
        failure(null, "MCP request exceeds the design request limit.");
      }
      if (!discarding) buffered = Buffer.concat([buffered, part]);
      if (newline < 0) break;
      if (!discarding && buffered.length) {
        if (pending.size >= 8) failure(null, "Too many pending MCP requests.");
        else {
          const work = forward(buffered).finally(() => pending.delete(work));
          pending.add(work);
        }
      }
      buffered = Buffer.alloc(0);
      discarding = false;
      start = end + 1;
    }
  });
  process.stdin.on("end", () => {
    buffered = Buffer.alloc(0);
  });
}

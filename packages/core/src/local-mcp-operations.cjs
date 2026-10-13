const { privateJson, hash } = require("./local-mcp-store.cjs");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

function createLocalMcpOperations({ directory }) {
  const file = privateJson(directory, "operations.json", {});
  let records = file.read();
  const pending = new Map();
  const save = (id, record) => {
    const next = { ...records, [id]: record };
    file.write(next);
    records = next;
  };
  return {
    async run(connectionId, requestId, operation, input, execute, reconcile = async () => null) {
      if (typeof requestId !== "string" || !requestId.length || requestId.length > 128) throw Error("A requestId of 1 to 128 characters is required");
      const id = hash(JSON.stringify([connectionId, requestId]));
      const fingerprint = hash(JSON.stringify(canonical({ operation, input })));
      const previous = records[id];
      if (previous && previous.fingerprint !== fingerprint) throw Error("requestId was already used with different arguments");
      if (previous?.status === "complete") return structuredClone(previous.result);
      if (pending.has(id)) return pending.get(id);
      if (!previous) save(id, { fingerprint, status: "pending" });
      const work = Promise.resolve().then(async () => {
        if (previous) {
          const recovered = await reconcile(id);
          if (recovered === null)
            throw Error("Operation outcome is uncertain. Inspect progress in Milagre before taking further action; this request was not replayed.");
          save(id, { fingerprint, status: "complete", result: recovered });
          return recovered;
        }
        const result = await execute(id);
        save(id, { fingerprint, status: "complete", result });
        return result;
      });
      pending.set(id, work);
      try {
        return await work;
      } finally {
        pending.delete(id);
      }
    },
    idle: () => Promise.allSettled([...pending.values()]),
  };
}
module.exports = { createLocalMcpOperations };

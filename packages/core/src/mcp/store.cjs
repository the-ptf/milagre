const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

// Settings › MCP's own file: Everywhere servers (added to every provider at Chat start) and the off list
// (servers a provider account skips in Milagre Chats). Headers and env may hold tokens, hence 0600.

const EMPTY = () => ({ everywhere: [], off: {} });

function createMcpStore(file) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return { everywhere: Array.isArray(value.everywhere) ? value.everywhere : [], off: value.off && typeof value.off === "object" ? value.off : {} };
    } catch {
      return EMPTY();
    }
  }
  function write(value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const offFor = (provider, accountId) => read().off[`${provider}:${accountId}`] ?? [];
  return {
    read,
    offFor,
    setEverywhere(list) {
      write({ ...read(), everywhere: list });
    },
    setOff(provider, accountId, name, off) {
      const value = read();
      const key = `${provider}:${accountId}`;
      const names = new Set(value.off[key] ?? []);
      if (off) names.add(name);
      else names.delete(name);
      if (names.size) value.off[key] = [...names].sort();
      else delete value.off[key];
      write(value);
    },
  };
}

module.exports = { createMcpStore };

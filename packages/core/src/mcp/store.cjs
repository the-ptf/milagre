const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

// Settings › MCP's own file: Everywhere servers (added to every provider at Chat start) and the off list
// (servers a provider account skips in Milagre Chats). Headers and env may hold tokens, hence 0600. A file that
// can't be parsed reads as empty and is kept as mcp.json.corrupt-<time> at the next write.

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
  // A file that exists but doesn't parse is moved aside before it is replaced, so a hand edit gone wrong isn't lost.
  function keepCorrupt() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    }
  }
  function write(value) {
    keepCorrupt();
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

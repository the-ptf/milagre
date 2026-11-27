const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { preparePrivateDirectory } = require("../private-files.cjs");

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const isAddress = (value) => typeof value === "string" && value.length <= 254 && ADDRESS.test(value);

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const valid = (value) =>
  Boolean(value) &&
  isAddress(value.address) &&
  typeof value.host === "string" &&
  Number.isInteger(value.port) &&
  typeof value.username === "string" &&
  typeof value.password === "string";

/** Mailboxes signed in with an app password, one owner-only file each under `<dataDir>/email/mailboxes`. The address is the mailbox's id. */
function createEmailStore({ dataDir }) {
  const root = path.join(dataDir, "email");
  const dir = path.join(root, "mailboxes");
  const fileOf = (address) => path.join(dir, `${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 24)}.json`);
  function list() {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => read(path.join(dir, name)))
      .filter(valid)
      .sort((a, b) => (a.connectedAt ?? 0) - (b.connectedAt ?? 0) || a.address.localeCompare(b.address));
  }
  return {
    list,
    get: (address) => (isAddress(address) ? (list().find((item) => item.address === address.toLowerCase()) ?? null) : null),
    save(mailbox) {
      preparePrivateDirectory(root);
      preparePrivateDirectory(dir);
      const file = fileOf(mailbox.address);
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(mailbox), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
    remove: (address) => isAddress(address) && fs.rmSync(fileOf(address), { force: true }),
  };
}

module.exports = { createEmailStore, isAddress };

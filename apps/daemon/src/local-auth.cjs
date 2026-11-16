const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual, createHmac } = require("node:crypto");
const { preparePrivateDirectory, assertPrivate, windowsAcl } = require("@milagre/core/private-files");
const tokenPath = (dataDir) => path.join(dataDir, "daemon-private", "token");
function prepareToken(dataDir) {
  const file = tokenPath(dataDir);
  preparePrivateDirectory(path.dirname(file));
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
      if (process.platform === "win32") windowsAcl(temporary, { mode: "protect" });
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (/** @type {any} */ (error).code !== "EEXIST") throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return readToken(dataDir);
}

function readToken(dataDir) {
  const file = tokenPath(dataDir);
  // Before publication, ENOENT tells bootstrap to retry, rather than treating
  assertPrivate(file);
  assertPrivate(path.dirname(file));
  const token = fs.readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid local daemon authentication token");
  return token;
}
function validToken(expected, supplied) {
  return (
    typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  );
}
function authenticationProof(token, role, clientNonce, serverNonce) {
  return createHmac("sha256", token).update(`${role}:${clientNonce}:${serverNonce}`).digest("hex");
}
const authenticationNonce = () => randomBytes(32).toString("hex");
const validNonce = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
module.exports = { tokenPath, prepareToken, readToken, validToken, authenticationProof, authenticationNonce, validNonce };

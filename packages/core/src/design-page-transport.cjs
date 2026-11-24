const { openAsBlob } = require("node:fs");

const uploadTimeout = (size) => Math.max(45_000, Math.min(300_000, 30_000 + Math.ceil(size / 32768) * 1000));
const unreachable = () => Object.assign(Error("The sharing service could not be reached. Try again when it is available."), { unreachable: true });
async function boundedResponseText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error("Unexpected sharing service response.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const refused = (status, tooLarge, other) =>
  Object.assign(
    Error(status === 429 ? "The page sharing limit has been reached. Try again later." : status === 413 ? tooLarge : `${other} (${status}). Try again later.`),
    { status },
  );

/** Requests to the sharing service under a page's capability. Unreachable-service errors carry `unreachable: true`. */
function createPageTransport({ fetcher, assetPath }) {
  const healthy = async (origin) => {
    try {
      const response = await fetcher(`${origin}/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status === 200 && (await boundedResponseText(response, 64)).trim() === "ok") return true;
      await response.body?.cancel();
    } catch {}
    return false;
  };
  const send = async (entry, method, body) => {
    let response;
    try {
      response = await fetcher(`${entry.origin}/api/pages/${entry.id}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(body ? uploadTimeout(Buffer.byteLength(body)) : 45_000),
        headers: { authorization: `Bearer ${entry.secret}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body } : {}),
      });
    } catch {
      throw unreachable();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw refused(response.status, "This page is too large to publish.", "The sharing service refused this request");
    }
    if (method === "DELETE") {
      await response.body?.cancel();
      if (response.status !== 204) throw Error("The sharing service did not confirm revocation. The page may still be public.");
      return;
    }
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel();
      throw Error("The sharing service did not confirm publication. Check the saved link before retrying.");
    }
    let reply;
    try {
      reply = JSON.parse(await boundedResponseText(response, 4096));
    } catch {}
    if (reply?.id !== entry.id || reply?.path !== `/s/${entry.id}`)
      throw Error("The sharing service did not confirm publication. Check the saved link before retrying.");
  };
  const sendFile = async (entry, chatId, asset) => {
    const body = await openAsBlob(await assetPath({ chatId, hash: asset.hash }), { type: asset.type });
    if (body.size !== asset.size) throw Error("A file of this page changed while it was publishing. Share again.");
    let response;
    try {
      response = await fetcher(`${entry.origin}/api/pages/${entry.id}/files/${asset.hash}`, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(uploadTimeout(asset.size)),
        headers: { authorization: `Bearer ${entry.secret}`, "content-type": asset.type },
        body,
      });
    } catch {
      throw unreachable();
    }
    await response.body?.cancel();
    if (response.status === 200 || response.status === 201) return;
    throw refused(response.status, "A file on this page is too large to publish.", "The sharing service refused a file of this page");
  };
  return { healthy, send, sendFile };
}

module.exports = { createPageTransport, uploadTimeout };

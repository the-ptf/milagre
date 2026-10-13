const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { validateDesignPageSnapshot } = require("@milagre/shared/design-page");
const { embedPageImages } = require("./design-page-images.cjs");
const { publicPageContent } = require("./design-page-content.cjs");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const ID = /^[A-Za-z0-9_-]{43}$/;
const uploadTimeout = (size) => Math.max(45_000, Math.min(300_000, 30_000 + Math.ceil(size / 32768) * 1000));
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
const publicEntry = ({ id, url, title, createdAt, designCount, revoked, published }) => ({
  id,
  url,
  title,
  createdAt,
  designCount,
  ...(revoked ? { revoked: true } : {}),
  ...(!published && !revoked ? { pending: true } : {}),
});

function createDesignPageSharing({
  directory,
  artifacts,
  validateChat,
  origin = "https://share.milagre.cloud",
  fetch: fetcher = fetch,
  embedImages = embedPageImages,
}) {
  const endpoint = new URL(origin);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))
  )
    throw Error("Design sharing requires an HTTPS service origin.");
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const checkEnabled = () => {
    if (!artifacts.enabled()) throw Error("Designs are off in Settings > Experimental. Turn Designs on before sharing.");
  };
  const check = async (chatId) => {
    checkEnabled();
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("An existing Chat is required.");
    await validateChat(chatId);
  };
  const file = (chatId) => path.join(directory, `${hash(chatId)}.json`);
  const readFile = async (filename) => {
    try {
      const data = JSON.parse(await fs.readFile(filename, "utf8"));
      if (!Array.isArray(data)) throw Error("Invalid share history");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw Error("The saved page sharing history could not be read.", { cause: error });
    }
  };
  const read = (chatId) => readFile(file(chatId));
  const writeFile = async (filename, entries) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  const historyQueues = new Map();
  // Only disk read-modify-write operations hold a history lock, never network requests.
  const updateHistory = (filename, update) => {
    const result = (historyQueues.get(filename) ?? Promise.resolve()).then(async () => {
      const entries = await readFile(filename);
      const value = update(entries);
      await writeFile(filename, entries);
      return value;
    });
    const tail = result.catch(() => {});
    historyQueues.set(filename, tail);
    void tail.then(() => {
      if (historyQueues.get(filename) === tail) historyQueues.delete(filename);
    });
    return result;
  };
  const revokeEntry = async (filename, entry) => {
    if (entry.revoked) return;
    await send(entry, "DELETE");
    await updateHistory(filename, (entries) => {
      const current = entries.find((item) => item.id === entry.id);
      if (!current) throw Error("This published page is no longer in saved history.");
      current.revoked = true;
    });
  };
  const histories = async function* () {
    const names = await fs.readdir(directory).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{43}\.json$/.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        yield { filename, entries: await readFile(filename) };
      } catch {
        console.warn(`Skipping unreadable page sharing history: ${filename}`);
      }
    }
  };
  const status = async () => {
    if (!artifacts.enabled()) return { available: false, reason: "Designs are off in Settings > Experimental." };
    try {
      const response = await fetcher(`${endpoint.origin}/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status === 200 && (await boundedResponseText(response, 64)).trim() === "ok") return { available: true };
      await response.body?.cancel();
    } catch {
      /* A failed health check never creates a publication or capability. */
    }
    return { available: false, reason: "Publishing is unavailable. The sharing service is not reachable. Try again later." };
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
      throw Error("The sharing service could not be reached. Try again when it is available.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        response.status === 429
          ? "The page sharing limit has been reached. Try again later."
          : response.status === 413
            ? "This Designs page is too large to publish."
            : `The sharing service refused this request (${response.status}). Try again later.`,
      );
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
    } catch {
      /* Reject malformed or unbounded acknowledgements. */
    }
    if (reply?.id !== entry.id || reply?.path !== `/s/${entry.id}`)
      throw Error("The sharing service did not confirm publication. Check the saved link before retrying.");
  };
  return {
    status,
    listAll: async () => {
      checkEnabled();
      const entries = [];
      for await (const history of histories()) entries.push(...history.entries.map(publicEntry));
      checkEnabled();
      return entries.toSorted((a, b) => b.createdAt - a.createdAt);
    },
    // Owner-only RPC. A saved capability remains manageable after its original Chat is deleted.
    revokeSaved: async ({ id }) => {
      checkEnabled();
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      for await (const { filename, entries } of histories()) {
        const entry = entries.find((item) => item.id === id);
        if (!entry) continue;
        checkEnabled();
        await revokeEntry(filename, entry);
        return;
      }
      throw Error("This published page is not in this computer's saved history.");
    },
    // Atomic history files can be read while an upload is running. Pending links remain inspectable.
    list: async ({ chatId }) => {
      await check(chatId);
      const entries = await read(chatId);
      await check(chatId);
      return entries.map(publicEntry).reverse();
    },
    publish: (request) =>
      serial(async () => {
        const { chatId, title, acknowledgePublic } = request ?? {};
        await check(chatId);
        if (acknowledgePublic !== true) throw Error("Confirm that the entire Designs page will be public before publishing.");
        if (typeof title !== "string" || !title.trim() || title.length > 120) throw Error("A public page title must have 1 to 120 characters.");
        const availability = await status();
        if (!availability.available) throw Error(availability.reason);
        const snapshot = validateDesignPageSnapshot(await embedImages(publicPageContent(await artifacts.pageSnapshot({ chatId, title }))));
        const payload = JSON.stringify(snapshot);
        const digest = hash(payload);
        const filename = file(chatId);
        const entry = await updateHistory(filename, (entries) => {
          const pending = entries.find((item) => !item.published && !item.revoked && item.digest === digest && item.origin === endpoint.origin);
          if (pending) return pending;
          if (entries.length >= 200) throw Error("This Designs page has reached its limit of 200 published snapshots.");
          const secret = randomBytes(32);
          const id = hash(secret);
          const created = {
            id,
            secret: secret.toString("base64url"),
            origin: endpoint.origin,
            url: `${endpoint.origin}/s/${id}`,
            title: snapshot.title,
            createdAt: Date.now(),
            designCount: snapshot.designs.length,
            digest,
            published: false,
          };
          entries.push(created);
          // Save the capability before upload. A failed acknowledgement can retry the same immutable ID.
          return created;
        });
        await check(chatId);
        await send(entry, "PUT", payload);
        return updateHistory(filename, (entries) => {
          const current = entries.find((item) => item.id === entry.id);
          if (!current) throw Error("This published page is no longer in saved history.");
          current.published = true;
          return publicEntry(current);
        });
      }),
    revoke: async ({ chatId, id }) => {
      await check(chatId);
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      const entries = await read(chatId);
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw Error("This published page does not belong to this Chat.");
      await revokeEntry(file(chatId), entry);
    },
  };
}
module.exports = { createDesignPageSharing, uploadTimeout };

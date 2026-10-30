const fs = require("node:fs/promises");
const { openAsBlob } = require("node:fs");
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
const publicEntry = ({ id, url, title, createdAt, updatedAt, designCount, revoked, published, kind }) => ({
  id,
  url,
  title,
  createdAt,
  ...(updatedAt ? { updatedAt } : {}),
  designCount,
  ...(kind === "artifacts" ? { kind } : {}),
  ...(revoked ? { revoked: true } : {}),
  ...(!published && !revoked ? { pending: true } : {}),
});

function createDesignPageSharing({
  directory,
  artifacts,
  validateChat,
  // The Chat's own title (set by the user or generated from its first message), which names its public page.
  chatTitle = async () => null,
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
  const pageKind = (kind = "designs") => {
    if (kind !== "designs" && kind !== "artifacts") throw Error("Choose Designs or Artifacts to share.");
    return kind;
  };
  const check = async (chatId, kind) => {
    pageKind(kind);
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
  const live = (entries, kind) => entries.filter((entry) => !entry.revoked && pageKind(entry.kind) === kind);
  // The link a Chat page shares: its newest live link on this service. Links on another service origin
  // (a local preview) are never updated; the next publication creates one here and retires them.
  const currentLink = (entries, kind) => live(entries, kind).findLast((entry) => entry.origin === endpoint.origin);
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
  const status = async (request = {}) => {
    pageKind(request.kind);
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
      throw Object.assign(
        Error(
          response.status === 429
            ? "The page sharing limit has been reached. Try again later."
            : response.status === 413
              ? "This page is too large to publish."
              : `The sharing service refused this request (${response.status}). Try again later.`,
        ),
        { status: response.status },
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
  // One file of an Artifact page, uploaded under its hash before the snapshot that names it; the service keeps a
  // file it already has. A file is streamed from the store on disk, never read whole into memory.
  const sendFile = async (entry, chatId, asset) => {
    const body = await openAsBlob(await artifacts.assetPath({ chatId, hash: asset.hash }), { type: asset.type });
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
      throw Error("The sharing service could not be reached. Try again when it is available.");
    }
    await response.body?.cancel();
    if (response.status === 200 || response.status === 201) return;
    throw Object.assign(
      Error(
        response.status === 429
          ? "The page sharing limit has been reached. Try again later."
          : response.status === 413
            ? "A file on this page is too large to publish."
            : `The sharing service refused a file of this page (${response.status}). Try again later.`,
      ),
      { status: response.status },
    );
  };
  return {
    status,
    listAll: async () => {
      const entries = [];
      for await (const history of histories()) entries.push(...history.entries.map(publicEntry));
      return entries.toSorted((a, b) => b.createdAt - a.createdAt);
    },
    // Owner-only RPC. A saved capability remains manageable after its original Chat is deleted.
    revokeSaved: async ({ id }) => {
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      for await (const { filename, entries } of histories()) {
        const entry = entries.find((item) => item.id === id);
        if (!entry) continue;
        await revokeEntry(filename, entry);
        return;
      }
      throw Error("This published page is not in this computer's saved history.");
    },
    // Atomic history files can be read while an upload is running. A Chat page has one current link: the
    // newest one not revoked. Older live links from before updates existed stay in the file until the next
    // publication retires them, and remain manageable in the global list meanwhile.
    list: async ({ chatId, kind }) => {
      await check(chatId, kind);
      const entries = await read(chatId);
      await check(chatId, kind);
      const current = currentLink(entries, pageKind(kind));
      return current ? [publicEntry(current)] : [];
    },
    // Sharing again re-uploads to the current link with its saved capability, so the URL never changes.
    // A lost acknowledgement leaves the same capability in place, and the retry is an idempotent PUT.
    publish: (request) =>
      serial(async () => {
        const { chatId, acknowledgePublic, kind } = request ?? {};
        const selectedKind = pageKind(kind);
        await check(chatId, kind);
        if (acknowledgePublic !== true) throw Error("Confirm that the entire page will be public before publishing.");
        // The page is named after its Chat; a title the request carries (older phones send one) is ignored.
        const named = String((await chatTitle(chatId).catch(() => null)) ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const title = [...named].slice(0, 120).join("") || (selectedKind === "artifacts" ? "Artifact" : "Designs");
        const availability = await status({ kind });
        if (!availability.available) throw Error(availability.reason);
        const current = await artifacts.pageSnapshot({ chatId, title, kind: selectedKind });
        const snapshot = validateDesignPageSnapshot(selectedKind === "artifacts" ? current : await embedImages(publicPageContent(current)));
        const payload = JSON.stringify(snapshot);
        const digest = hash(payload);
        const filename = file(chatId);
        const details = {
          title: snapshot.title,
          designCount: selectedKind === "artifacts" ? 1 : snapshot.designs.length,
          digest,
        };
        let published;
        // At most two attempts: a link revoked on the service but not in local history is retired and replaced once.
        for (let attempt = 0; !published; attempt++) {
          const entry = await updateHistory(filename, (entries) => {
            const target = currentLink(entries, selectedKind);
            if (target) return target;
            const secret = randomBytes(32);
            const id = hash(secret);
            const created = {
              id,
              secret: secret.toString("base64url"),
              origin: endpoint.origin,
              url: `${endpoint.origin}/s/${id}`,
              createdAt: Date.now(),
              ...details,
              ...(selectedKind === "artifacts" ? { kind: selectedKind } : {}),
              published: false,
            };
            entries.push(created);
            // Save the capability before upload. A failed acknowledgement retries the same ID.
            return created;
          });
          await check(chatId, kind);
          try {
            for (const asset of new Map((snapshot.artifacts?.[0]?.assets ?? []).map((item) => [item.hash, item])).values())
              await sendFile(entry, chatId, asset);
            await send(entry, "PUT", payload);
          } catch (error) {
            if (error.status !== 410 || attempt > 0) throw error;
            // Revoked here while uploading: the person's revocation stands. Revoked only on the service
            // (its local record was lost): record that and publish under a fresh link.
            const revokedHere = await updateHistory(filename, (entries) => {
              const gone = entries.find((item) => item.id === entry.id);
              const already = !gone || gone.revoked === true;
              if (gone) gone.revoked = true;
              return already;
            });
            if (revokedHere) throw Error("This link was revoked while it was updating. Share again for a new link.", { cause: error });
            continue;
          }
          published = await updateHistory(filename, (entries) => {
            const saved = entries.find((item) => item.id === entry.id);
            if (!saved) throw Error("This published page is no longer in saved history.");
            // A revocation that finished while the upload was in flight wins over its late acknowledgement.
            if (saved.revoked) return saved;
            if (saved.published) saved.updatedAt = Date.now();
            Object.assign(saved, details, { published: true });
            return saved;
          });
        }
        if (published.revoked) return publicEntry(published);
        // Retire every older live link of this page. A failed revocation keeps its row, so the next
        // publication retries it and the global list can still revoke it; the result reports how many remain.
        const older = live(await read(chatId), selectedKind).filter((item) => item.id !== published.id);
        const results = await Promise.allSettled(older.map((entry) => send(entry, "DELETE")));
        const retired = new Set(older.filter((_, index) => results[index].status === "fulfilled").map((entry) => entry.id));
        if (retired.size) await updateHistory(filename, (entries) => entries.splice(0, entries.length, ...entries.filter((item) => !retired.has(item.id))));
        const remaining = older.length - retired.size;
        return { ...publicEntry(published), ...(remaining ? { olderLinks: remaining } : {}) };
      }),
    revoke: async ({ chatId, id, kind }) => {
      await check(chatId, kind);
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      const entries = await read(chatId);
      const entry = entries.find((item) => item.id === id && pageKind(item.kind) === pageKind(kind));
      if (!entry) throw Error("This published page does not belong to this Chat.");
      await revokeEntry(file(chatId), entry);
    },
  };
}
module.exports = { createDesignPageSharing, uploadTimeout };

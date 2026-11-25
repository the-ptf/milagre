const { createHash, randomBytes } = require("node:crypto");
const designPage = () => require("@milagre/shared/design-page");
const embedPageImages = (snapshot) => require("./design-page-images.cjs").embedPageImages(snapshot);
const publicPageContent = (snapshot) => require("./design-page-content.cjs").publicPageContent(snapshot);
const { createPageTransport, uploadTimeout } = require("./design-page-transport.cjs");
const { createLiveSchedule } = require("./design-page-live.cjs");
const { createShareHistory } = require("./design-page-history.cjs");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const ID = /^[A-Za-z0-9_-]{43}$/;
const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SELECTION = 100;
const UNTITLED = { workspace: "Artifacts", design: "Design", selection: "Designs", designs: "Designs", artifacts: "Artifact" };
const kindOf = (kind = "designs") => {
  if (!Object.hasOwn(UNTITLED, kind)) throw Error("Choose the workspace, one design, a selection of designs or the page to share.");
  return kind;
};
const selectionOf = (designIds) => {
  if (!Array.isArray(designIds) || !designIds.length) throw Error("Choose the designs to share.");
  if (designIds.length > MAX_SELECTION) throw Error(`Share at most ${MAX_SELECTION} designs in one link.`);
  if (!designIds.every((id) => typeof id === "string" && DESIGN_ID.test(id))) throw Error("Choose the designs to share.");
  if (new Set(designIds).size !== designIds.length) throw Error("Choose each design once.");
  return [...designIds];
};
const scopeOf = (request) => {
  const kind = kindOf(request?.kind);
  if (kind === "selection") return { kind, designIds: selectionOf(request.designIds) };
  if (kind !== "design") return { kind };
  if (typeof request.designId !== "string" || !DESIGN_ID.test(request.designId)) throw Error("Choose the design to share.");
  return { kind, designId: request.designId };
};
const scopeFields = ({ kind, designId, designIds }) => ({
  ...(kind === "design" ? { designId } : {}),
  ...(kind === "selection" ? { designIds } : {}),
});
const entryScope = (entry) => ({ kind: entry.kind ?? "designs", ...scopeFields(entry) });
const sameScope = (entry, scope) =>
  (entry.kind ?? "designs") === scope.kind &&
  (scope.kind !== "design" || entry.designId === scope.designId) &&
  (scope.kind !== "selection" || entry.designIds?.join(",") === scope.designIds.join(","));
const replaceable = (entries, scope) =>
  entries.filter((entry) => !entry.revoked && sameScope(entry, scope) && (scope.kind === "designs" || entry.live === true));
const transient = (error) => error?.unreachable === true || error?.status === 429 || error?.status >= 500;
const publicEntry = ({ id, url, title, createdAt, updatedAt, designCount, revoked, published, kind, designId, designIds, live, paused, stale, lastError }) => ({
  id,
  url,
  title,
  createdAt,
  ...(updatedAt ? { updatedAt } : {}),
  designCount,
  ...(kind && kind !== "designs" ? { kind } : {}),
  ...(designId ? { designId } : {}),
  ...(designIds ? { designIds: [...designIds] } : {}),
  ...(live ? { live: true } : {}),
  ...(live && paused ? { paused: true } : {}),
  ...(live && stale && !revoked ? { stale: true, ...(lastError ? { lastError } : {}) } : {}),
  ...(revoked ? { revoked: true } : {}),
  ...(!published && !revoked ? { pending: true } : {}),
});

/**
 * Publishes a Chat's workspace, one design, a selection of designs or its page under capability links kept in private per-Chat histories.
 * Links made by this version are live: `changed(chatId)` republishes each un-paused one a few seconds later under the
 * same capability. Links saved without `live` are frozen snapshots and only change when the owner shares again.
 */
function createDesignPageSharing({
  directory,
  artifacts,
  validateChat,
  chatTitle = async () => null,
  origin = "https://share.milagre.cloud",
  fetch: fetcher = fetch,
  embedImages = embedPageImages,
  timers,
  liveDelay,
  retryDelay,
  maxRetryDelay,
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
  const { availability, send, sendFile } = createPageTransport({ fetcher, assetPath: (request) => artifacts.assetPath(request) });
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const check = async (chatId) => {
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("An existing Chat is required.");
    await validateChat(chatId);
  };
  const { file, readFile, read, updateHistory, histories } = createShareHistory(directory);
  const updateEntry = (filename, id, update) =>
    updateHistory(filename, (entries) => {
      const saved = entries.find((item) => item.id === id);
      return saved ? update(saved) : undefined;
    });
  const revokeEntry = async (filename, entry) => {
    if (entry.revoked) return;
    await send(entry, "DELETE");
    await updateHistory(filename, (entries) => {
      const current = entries.find((item) => item.id === entry.id);
      if (!current) throw Error("This published page is no longer in saved history.");
      current.revoked = true;
    });
  };
  const live = (entries, scope) => entries.filter((entry) => !entry.revoked && sameScope(entry, scope));
  const currentLink = (entries, scope) => live(entries, scope).findLast((entry) => entry.origin === endpoint.origin);
  const status = async (request) => availability(endpoint.origin, kindOf(request?.kind));
  const capture = async (chatId, scope) => {
    const named = String((await chatTitle(chatId).catch(() => null)) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const title = [...named].slice(0, 120).join("") || UNTITLED[scope.kind];
    const availability = await status(scope);
    if (!availability.available) throw Object.assign(Error(availability.reason), { unreachable: true });
    const current = await artifacts.pageSnapshot({ chatId, title, ...scope });
    const snapshot = designPage().validateDesignPageSnapshot(current.kind === "artifacts" ? current : await embedImages(publicPageContent(current)));
    const payload = JSON.stringify(snapshot);
    const designCount = snapshot.kind === "artifacts" ? 1 : snapshot.designs.length + (snapshot.page ? 1 : 0);
    return { snapshot, payload, details: { title: snapshot.title, designCount, digest: hash(payload) } };
  };
  const upload = async (entry, chatId, { snapshot, payload }) => {
    for (const asset of new Map(
      designPage()
        .pageAssets(snapshot)
        .map((item) => [item.hash, item]),
    ).values())
      await sendFile(entry, chatId, asset);
    await send(entry, "PUT", payload);
  };
  const confirm = (filename, entry, details) =>
    updateHistory(filename, (entries) => {
      const saved = entries.find((item) => item.id === entry.id);
      if (!saved) throw Error("This published page is no longer in saved history.");
      if (saved.revoked) return saved;
      if (saved.published) saved.updatedAt = Date.now();
      Object.assign(saved, details, { published: true });
      delete saved.stale;
      delete saved.lastError;
      return saved;
    });
  const markRevoked = (filename, id) =>
    updateHistory(filename, (entries) => {
      const gone = entries.find((item) => item.id === id);
      const already = !gone || gone.revoked === true;
      if (gone) gone.revoked = true;
      return already;
    });
  const createEntry = (chatId, scope, details) => {
    const secret = randomBytes(32);
    const id = hash(secret);
    return {
      id,
      secret: secret.toString("base64url"),
      origin: endpoint.origin,
      url: `${endpoint.origin}/s/${id}`,
      createdAt: Date.now(),
      ...details,
      ...(scope.kind === "designs" ? {} : { kind: scope.kind, live: true, chatId }),
      ...scopeFields(scope),
      published: false,
    };
  };
  const refresh = async (filename, entry) => {
    try {
      const captured = await capture(entry.chatId, entryScope(entry));
      if (entry.published && !entry.stale && entry.digest === captured.details.digest) return false;
      await upload(entry, entry.chatId, captured);
      await confirm(filename, entry, captured.details);
      return false;
    } catch (error) {
      if (error.status === 410) {
        await markRevoked(filename, entry.id);
        return false;
      }
      const deleted = error.code === "DESIGN_DELETED";
      await updateEntry(filename, entry.id, (saved) => {
        if (!saved.revoked) Object.assign(saved, { stale: true, lastError: error.message }, deleted ? { designDeleted: true } : {});
      });
      return !deleted && transient(error);
    }
  };
  const following = (entries) => {
    const current = new Map();
    for (const entry of entries) if (!entry.revoked && entry.origin === endpoint.origin) current.set(JSON.stringify(entryScope(entry)), entry);
    return [...current.values()].filter((entry) => entry.live && entry.chatId && !entry.paused && !entry.designDeleted);
  };
  const schedule = createLiveSchedule({
    flush: (chatId) =>
      serial(async () => {
        const filename = file(chatId);
        let retry = false;
        for (const entry of following(await readFile(filename).catch(() => []))) if (entry.chatId === chatId && (await refresh(filename, entry))) retry = true;
        return retry;
      }),
    timers,
    delay: liveDelay,
    retryDelay,
    maxRetryDelay,
  });
  return {
    status,
    changed: (chatId) => {
      if (typeof chatId === "string" && chatId) schedule.changed(chatId);
    },
    resumeStale: async () => {
      for await (const { entries } of histories())
        for (const chatId of new Set(following(entries).flatMap((entry) => (entry.stale ? [entry.chatId] : [])))) schedule.now(chatId);
    },
    close: () => schedule.close(),
    listAll: async () => {
      const entries = [];
      for await (const history of histories()) entries.push(...history.entries.map(publicEntry));
      return entries.toSorted((a, b) => b.createdAt - a.createdAt);
    },
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
    list: async (request) => {
      const scope = scopeOf(request);
      await check(request?.chatId);
      const entries = await read(request.chatId);
      await check(request.chatId);
      const current = currentLink(entries, scope);
      return current ? [publicEntry(current)] : [];
    },
    publish: (request) =>
      serial(async () => {
        const scope = scopeOf(request);
        const { chatId, acknowledgePublic } = request ?? {};
        await check(chatId);
        if (acknowledgePublic !== true) throw Error("Confirm that the entire page will be public before publishing.");
        const captured = await capture(chatId, scope);
        const filename = file(chatId);
        let published;
        for (let attempt = 0; !published; attempt++) {
          const entry = await updateHistory(filename, (entries) => {
            const target = replaceable(entries, scope).findLast((item) => item.origin === endpoint.origin);
            if (target) return target;
            const created = createEntry(chatId, scope, captured.details);
            entries.push(created);
            return created;
          });
          await check(chatId);
          try {
            await upload(entry, chatId, captured);
          } catch (error) {
            if (error.status !== 410 || attempt > 0) throw error;
            if (await markRevoked(filename, entry.id))
              throw Error("This link was revoked while it was updating. Share again for a new link.", { cause: error });
            continue;
          }
          published = await confirm(filename, entry, captured.details);
        }
        if (published.revoked) return publicEntry(published);
        const older = replaceable(await read(chatId), scope).filter((item) => item.id !== published.id);
        const results = await Promise.allSettled(older.map((entry) => send(entry, "DELETE")));
        const retired = new Set(older.filter((_, index) => results[index].status === "fulfilled").map((entry) => entry.id));
        if (retired.size) await updateHistory(filename, (entries) => entries.splice(0, entries.length, ...entries.filter((item) => !retired.has(item.id))));
        const remaining = older.length - retired.size;
        return { ...publicEntry(published), ...(remaining ? { olderLinks: remaining } : {}) };
      }),
    setPaused: async (request) => {
      const { chatId, id, paused } = request ?? {};
      await check(chatId);
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      if (typeof paused !== "boolean") throw Error("Say whether to pause or resume the link.");
      const filename = file(chatId);
      const changed = await updateHistory(filename, (entries) => {
        const saved = entries.find((item) => item.id === id);
        if (!saved) throw Error("This published page does not belong to this Chat.");
        if (saved.revoked) throw Error("This link was revoked.");
        if (!saved.live) throw Error("This link is a snapshot that never updates on its own, so it can't be paused.");
        if (paused) saved.paused = true;
        else delete saved.paused;
        return { ...saved };
      });
      if (paused) return publicEntry(changed);
      return serial(async () => {
        const saved = (await read(chatId)).find((item) => item.id === id);
        if (!saved || saved.revoked || saved.paused) return publicEntry(saved ?? changed);
        if (await refresh(filename, saved)) schedule.retry(chatId);
        return publicEntry((await read(chatId)).find((item) => item.id === id) ?? saved);
      });
    },
    revoke: async (request) => {
      const kind = kindOf(request?.kind);
      const { chatId, id, designId } = request ?? {};
      await check(chatId);
      if (!ID.test(id ?? "")) throw Error("A published page id is required.");
      const entries = await read(chatId);
      const entry = entries.find((item) => item.id === id && (item.kind ?? "designs") === kind && (!designId || item.designId === designId));
      if (!entry) throw Error("This published page does not belong to this Chat.");
      await revokeEntry(file(chatId), entry);
    },
  };
}
module.exports = { createDesignPageSharing, uploadTimeout };

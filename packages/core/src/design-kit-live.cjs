const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const LAYOUT = new Set(["clipped-text", "overflow", "off-canvas"]);
const CACHE = /^v(\d+)\.kit\.[a-zA-Z0-9_.-]+\.json$/;
/** Tells two kits apart across owners: a Named Link's member and the Link before it can both have a "project" v1. */
const fingerprint = (kit) => createHash("sha256").update(JSON.stringify(kit)).digest("hex").slice(0, 16);

async function writeAtomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function createLiveDesigns({ readKit, kitOwner = async () => undefined, implementation }) {
  const read = (chatId, owner, id, version, cache) => {
    const key = `${owner ?? ""}\n${id}@${version ?? "latest"}`;
    if (!cache.has(key))
      cache.set(
        key,
        readKit({ chatId, owner, id, version }).catch(() => null),
      );
    return cache.get(key);
  };
  /**
   * The newer kit version a screen pinned to `pin` follows, or null: frozen, already latest, or pinned to a kit that isn't
   * in this scope's history (a Named Link that changed Projects). Both versions come from one resolved owner. A list entry
   * saved before fingerprints can't be checked without its document, so it keeps its saved version.
   */
  async function followable(chatId, pin, frozen, cache) {
    if (!readKit || !pin?.fingerprint || frozen) return null;
    const owner = await kitOwner(chatId).catch(() => null);
    if (owner === null) return null;
    const [pinned, latest] = await Promise.all([read(chatId, owner, pin.id, pin.version, cache), read(chatId, owner, pin.id, undefined, cache)]);
    if (!pinned || fingerprint(pinned) !== pin.fingerprint) return null;
    return latest && latest.version > pin.version ? latest : null;
  }
  return {
    fingerprint,
    /** `from` is the version the document came from: the design it was copied from, else its own previous document. */
    async verify(chatId, document, from, previous) {
      if (!document.kit || !readKit || isDeepStrictEqual(document.kit, (from?.document ?? previous)?.kit)) return;
      const kit = await readKit({ chatId, id: document.kit.id, version: document.kit.version });
      if (!isDeepStrictEqual(kit, document.kit))
        throw Error("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot.");
    },
    async entry(chatId, entry, cache) {
      const kit = await followable(chatId, entry?.kit, entry?.kitFrozen, cache);
      return kit ? { ...entry, kit: { ...entry.kit, version: kit.version }, kitFollowed: { from: entry.kit.version, to: kit.version } } : entry;
    },
    async follow(chatId, folder, current) {
      const pinned = current.document?.kit;
      if (current.version !== current.latest) return current;
      const kit = await followable(chatId, pinned && { ...pinned, fingerprint: fingerprint(pinned) }, current.document?.kitFrozen, new Map());
      if (!kit) return current;
      const file = path.join(folder, `v${current.version}.kit.${pinned.id}.${kit.version}.${fingerprint(kit)}.json`);
      let live;
      try {
        live = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!live) {
        try {
          const design = implementation();
          const rebased = design.rebaseDesignOnKit(current.document, kit);
          design.validateDesignConsistency(rebased.document);
          await design.loadDesignFonts(current.document);
          await design.loadDesignFonts(rebased.document);
          const layout = (document) =>
            design
              .designWarnings(document)
              .filter((warning) => LAYOUT.has(warning.kind))
              .map((warning) => warning.message);
          const before = new Set(layout(current.document));
          live = {
            document: rebased.document,
            html: design.designHtml(rebased.document),
            local: rebased.local,
            layout: layout(rebased.document).filter((message) => !before.has(message)),
          };
        } catch (error) {
          return { ...current, kitBroken: { version: kit.version, message: error.message } };
        }
        await writeAtomic(file, JSON.stringify(live));
      }
      return {
        ...current,
        html: live.html,
        document: live.document,
        kit: { id: kit.id, version: kit.version, title: kit.title },
        kitFollowed: {
          from: pinned.version,
          to: kit.version,
          ...(live.local.length ? { local: live.local } : {}),
          ...(live.layout.length ? { layout: live.layout } : {}),
        },
      };
    },
    async prune(folder, keepVersion) {
      const names = await fs.readdir(folder).catch(() => []);
      await Promise.all(
        names
          .filter((name) => CACHE.test(name) && Number(CACHE.exec(name)[1]) !== keepVersion)
          .map((name) => fs.rm(path.join(folder, name), { force: true }).catch(() => {})),
      );
    },
  };
}

module.exports = { createLiveDesigns };

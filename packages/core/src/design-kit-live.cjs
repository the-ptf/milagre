const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const LAYOUT = new Set(["clipped-text", "overflow", "off-canvas"]);
const CACHE = /^v(\d+)\.kit\.[a-zA-Z0-9_.-]+\.(\d+)\.json$/;

async function writeAtomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function createLiveDesigns({ readKit, implementation }) {
  async function latestKit(chatId, id, cache) {
    if (!cache.has(id))
      cache.set(
        id,
        readKit({ chatId, id }).catch(() => null),
      );
    return cache.get(id);
  }
  return {
    async verify(chatId, document) {
      if (!document.kit || !readKit) return;
      const kit = await readKit({ chatId, id: document.kit.id, version: document.kit.version });
      if (!isDeepStrictEqual(kit, document.kit))
        throw Error("The pinned kit differs from this Project's saved version. Read it with design_kit_read and use that snapshot.");
    },
    async entry(chatId, entry, cache) {
      if (!readKit || !entry?.kit || entry.kitFrozen) return entry;
      const kit = await latestKit(chatId, entry.kit.id, cache);
      return kit && kit.version > entry.kit.version
        ? { ...entry, kit: { ...entry.kit, version: kit.version }, kitFollowed: { from: entry.kit.version, to: kit.version } }
        : entry;
    },
    async follow(chatId, folder, current) {
      const pinned = current.document?.kit;
      if (!readKit || !pinned || current.document.kitFrozen || current.version !== current.latest) return current;
      const kit = await latestKit(chatId, pinned.id, new Map());
      if (!kit || kit.version <= pinned.version) return current;
      const file = path.join(folder, `v${current.version}.kit.${pinned.id}.${kit.version}.json`);
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

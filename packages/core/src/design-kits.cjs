const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { designKitDataSchema, validateDesignKit } = require("@milagre/shared/design");
const ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;

/** Project-owned immutable snapshots. No update ever rewrites a screen's pinned kit. */
function createDesignKits({ directory, projectForChat }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  async function file(chatId, id) {
    if (typeof id !== "string" || !ID.test(id)) throw Error("Invalid design kit id.");
    const project = await projectForChat(chatId);
    if (typeof project !== "string" || !project) throw Error("This Chat has no design kit scope.");
    return path.join(directory, createHash("sha256").update(project).digest("hex"), `${id}.json`);
  }
  async function versions(target) {
    try {
      const value = JSON.parse(await fs.readFile(target, "utf8"));
      if (!Array.isArray(value)) throw Error("Invalid kit history.");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  return {
    read: ({ chatId, id = "project", version }) =>
      serial(async () => {
        const all = await versions(await file(chatId, id));
        const found = version === undefined ? all.at(-1) : all.find((kit) => kit.version === version);
        if (!found && version !== undefined) throw Error(`Kit "${id}" version ${version} does not exist in this Project.`);
        return found ? validateDesignKit(found) : null;
      }),
    save: ({ chatId, id = "project", expectedVersion, kit }, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const target = await file(chatId, id);
        const all = await versions(target);
        const actual = all.at(-1)?.version ?? 0;
        if (!Number.isInteger(expectedVersion) || expectedVersion !== actual)
          throw Error(`Kit version conflict: expected ${expectedVersion}, latest ${actual}. Read the kit again.`);
        if (all.length >= 100) throw Error("This kit has 100 immutable versions. Create a new kit id.");
        const saved = validateDesignKit({ ...designKitDataSchema.parse(kit), id, version: actual + 1 });
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify([...all, saved]), { mode: 0o600 });
          await assertActive?.();
          await fs.rename(temporary, target);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        return saved;
      }),
    close: () => queue,
  };
}
function designKitToolDefinitions(chatId, kits) {
  return [
    {
      name: "design_kit_read",
      description:
        "Read this Project's shared visual kit (default id project), latest or a pinned version. Read before designing or taking over another model. Returns colors, text styles, spacing, radii, component templates and references. null means no kit has been established. Pass the returned snapshot as document.kit; existing screens keep their pinned version.",
      input: { id: z.string().regex(ID).optional(), version: z.number().int().positive().optional() },
      readOnly: true,
      run: async (args) => JSON.stringify(await kits.read({ chatId, ...args })),
    },
    {
      name: "design_kit_save",
      description:
        "Create or revise this Project's shared visual kit. Use the app's existing identity and confirmed decisions. expectedVersion is 0 for a new kit, otherwise read the latest first. Saves an immutable version without changing existing designs. To adopt it on a screen, explicitly apply a document patch with the returned kit snapshot and inspect the result. Components are ordinary layer arrays, each with one main frame whose id matches its map key.",
      input: { id: z.string().regex(ID).optional(), expectedVersion: z.number().int().nonnegative(), kit: designKitDataSchema },
      readOnly: false,
      run: async (args) => JSON.stringify(await kits.save({ chatId, ...args })),
    },
  ];
}
module.exports = { createDesignKits, designKitToolDefinitions };

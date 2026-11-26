const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { z } = require("zod");
const { designFontToolDefinitions } = require("./design-font-tools.cjs");
const { designKitDataSchema } = require("@milagre/shared/design-schemas");
const ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
const DECISION = z
  .object({
    summary: z.string().trim().min(1).max(300).describe('What changed, in the user\'s words, such as "Primary buttons use a 12 px radius".'),
    reason: z.string().trim().max(600).optional().describe("Why the user decided it."),
  })
  .strict();

function createDesignKits({ directory, projectForChat }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  function projectFile(project, id) {
    if (typeof id !== "string" || !ID.test(id)) throw Error("Invalid design kit id.");
    if (typeof project !== "string" || !project) throw Error("This Chat has no design kit scope.");
    return path.join(projectFolder(project), `${id}.json`);
  }
  const file = async (chatId, id, project) => projectFile(project ?? (await projectForChat(chatId)), id);
  const readKit = async (target, id, version) => {
    const all = await versions(target);
    const found = version === undefined ? all.at(-1) : all.find((kit) => kit.version === version);
    if (!found && version !== undefined) throw Error(`Kit "${id}" version ${version} does not exist in this Project.`);
    return found ? require("@milagre/shared/design").validateDesignKit(found) : null;
  };
  const decisionsFile = (target) => path.join(directory, "decisions", path.basename(path.dirname(target)), path.basename(target));
  async function writeAtomic(target, content, assertActive) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await assertActive?.();
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
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
  const projectFolder = (project) => path.join(directory, createHash("sha256").update(project).digest("hex"));
  /** Copies the kits `from` holds and `to` lacks, with their decision logs; a kit `to` already has stays its own. */
  async function adopt(from, to) {
    const source = projectFolder(from);
    const names = (await fs.readdir(source).catch(() => [])).filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)));
    for (const name of names) {
      const target = path.join(projectFolder(to), name);
      if (
        await fs.stat(target).then(
          () => true,
          () => false,
        )
      )
        continue;
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.copyFile(source + path.sep + name, target, fs.constants.COPYFILE_EXCL).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const log = decisionsFile(path.join(source, name));
      const copied = decisionsFile(target);
      if (
        await fs.stat(log).then(
          () => true,
          () => false,
        )
      ) {
        await fs.mkdir(path.dirname(copied), { recursive: true, mode: 0o700 });
        await fs.copyFile(log, copied).catch(() => {});
      }
    }
  }
  return {
    adopt,
    read: ({ chatId, id = "project", version }) => serial(async () => readKit(await file(chatId, id), id, version)),
    readProject: ({ project, id = "project", version }) => serial(() => readKit(projectFile(project, id), id, version)),
    history: ({ chatId, project, id = "project" }) =>
      serial(async () => {
        const target = await file(chatId, id, project);
        const log = new Map((await versions(decisionsFile(target))).map((entry) => [entry.version, entry]));
        return (await versions(target)).map((kit) => {
          const { savedAt, decision } = log.get(kit.version) ?? {};
          return { version: kit.version, title: kit.title, ...(savedAt ? { savedAt } : {}), ...(decision ? { decision } : {}) };
        });
      }),
    owner: (chatId) => projectForChat(chatId),
    recordDecision: ({ chatId, project, id = "project", version, decision }) =>
      serial(async () => {
        const target = decisionsFile(await file(chatId, id, project));
        const record = { version, savedAt: Date.now(), ...(decision ? { decision: DECISION.parse(decision) } : {}) };
        const log = (await versions(target)).filter((entry) => entry.version !== version);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeAtomic(target, JSON.stringify([...log, record]));
      }),
    save: ({ chatId, project, id = "project", expectedVersion, kit }, { assertActive } = {}) =>
      serial(async () => {
        await assertActive?.();
        const target = await file(chatId, id, project);
        const all = await versions(target);
        const actual = all.at(-1)?.version ?? 0;
        if (!Number.isInteger(expectedVersion) || expectedVersion !== actual)
          throw Error(`Kit version conflict: expected ${expectedVersion}, latest ${actual}. Read the kit again.`);
        if (all.length >= 100) throw Error("This kit has 100 immutable versions. Create a new kit id.");
        const saved = require("@milagre/shared/design").validateDesignKit({ ...designKitDataSchema.parse(kit), id, version: actual + 1 });
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeAtomic(target, JSON.stringify([...all, saved]), assertActive);
        return saved;
      }),
    close: () => queue,
  };
}
function designKitToolDefinitions(chatId, kits, { report, changed } = {}) {
  return [
    {
      name: "design_kit_read",
      description:
        "Read this Project's shared visual kit (default id project), latest or a pinned version. Read before designing or taking over another model, after the Project's DESIGN.md if it has one. Returns colors, text styles, spacing, radii, component templates and references. null means no kit has been established. Pass the returned snapshot as document.kit. Every screen on this kit follows its latest version, except screens frozen with kitFrozen.",
      input: { id: z.string().regex(ID).optional(), version: z.number().int().positive().optional() },
      readOnly: true,
      run: async (args) => JSON.stringify(await kits.read({ chatId, ...args })),
    },
    {
      name: "design_kit_save",
      description:
        "Create or revise this Project's design system (its kit). Use the app's existing identity (its DESIGN.md first, when it has one) and confirmed decisions. expectedVersion is 0 for a new kit, otherwise read the latest first. Saves an immutable version that every screen on this kit follows live, in every Chat of the Project and its library: colors, text styles, bindings and the kit components a screen holds unchanged. Frozen screens (kitFrozen) keep their version. Returns the kit and a report of the screens: how many follow it, which are frozen, which can't follow it (a removed style or token: they stay on their old version until fixed), which gained layout problems and which keep a changed copy of a kit component. Tell the user about broken and layout screens; fix them only when asked. Components are ordinary layer arrays, each with one main frame whose id matches its map key.",
      input: {
        id: z.string().regex(ID).optional(),
        expectedVersion: z.number().int().nonnegative(),
        kit: designKitDataSchema,
        decision: DECISION.describe("The decision this version records, shown in the design system's decision log."),
      },
      readOnly: false,
      run: async ({ decision, ...args }) => {
        const checked = decision === undefined ? undefined : DECISION.parse(decision);
        const project = await kits.owner(chatId);
        const kit = await kits.save({ chatId, project, ...args });
        const logged = await kits
          .recordDecision({ chatId, project, id: kit.id, version: kit.version, decision: checked })
          .then(() => null)
          .catch((error) => `Version ${kit.version} is saved, but its decision wasn't recorded: ${error.message}`);
        await changed?.(chatId, kit, project);
        const screens = report ? await report(chatId, kit, project) : undefined;
        return JSON.stringify(screens || logged ? { kit, ...(screens ? { screens } : {}), ...(logged ? { decisionLog: logged } : {}) } : kit);
      },
    },
    {
      name: "design_kit_history",
      description:
        "Read the decision log of this Project's design system: every saved version with what changed and why. Read it before proposing a change, so you don't reopen a decision the user already made.",
      input: { id: z.string().regex(ID).optional() },
      readOnly: true,
      run: async (args) => JSON.stringify(await kits.history({ chatId, ...args })),
    },
    ...designFontToolDefinitions(),
  ];
}
module.exports = { createDesignKits, designKitToolDefinitions };

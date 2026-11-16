const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeFilesToCopy(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line) => typeof line === "string")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeSetupCommand(value) {
  return typeof value === "string" ? value.trim() : "";
}

const MAX_ICON = 600_000;
function normalizeIcon(value) {
  return typeof value === "string" && value.length <= MAX_ICON && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : null;
}

const SYNC_OUTCOMES = new Set(["updated", "up-to-date", "skipped", "failed"]);
function normalizeMainSync(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.at) || !SYNC_OUTCOMES.has(value.outcome) || typeof value.branch !== "string") return null;
  return {
    at: value.at,
    outcome: value.outcome,
    branch: value.branch,
    ...(typeof value.commit === "string" ? { commit: value.commit } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function createProjectSettings(file) {
  let queue = Promise.resolve();

  async function read({ strict }) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || !strict) return { projects: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object" ? parsed : { projects: {} };
    } catch (error) {
      if (error instanceof SyntaxError) return { projects: {} };
      throw error;
    }
  }

  function save(change) {
    const next = queue
      .catch(() => {})
      .then(async () => {
        const data = await read({ strict: true });
        change(data);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(data, null, 2));
        await fs.rename(temporary, file);
      });
    queue = next;
    return next;
  }

  function update(projectPath, change) {
    return save((data) => {
      const key = path.resolve(projectPath);
      const entry = { ...data.projects[key] };
      change(entry);
      if (Object.keys(entry).length > 0) data.projects[key] = entry;
      else delete data.projects[key];
    });
  }

  async function readMainSync(projectPath) {
    const data = await read({ strict: false });
    const entry = data.projects[path.resolve(projectPath)] ?? {};
    const override = typeof entry.syncMain === "boolean" ? entry.syncMain : null;
    const defaultValue = data.defaults?.syncMain === true;
    return { override, defaultValue, enabled: override ?? defaultValue, last: normalizeMainSync(entry.mainSync) };
  }

  return {
    async getGit(projectPath) {
      return (await read({ strict: true })).projects[path.resolve(projectPath)]?.git ?? {};
    },
    async setGit(projectPath, value) {
      const { branchPolicyFields } = require("@milagre/shared/branch-policy");
      const fields = branchPolicyFields(value);
      await update(projectPath, (entry) => {
        if (Object.keys(fields).length) entry.git = fields;
        else delete entry.git;
      });
    },
    async get(projectPath) {
      const entry = (await read({ strict: false })).projects[path.resolve(projectPath)] ?? {};
      return { filesToCopy: normalizeFilesToCopy(entry.filesToCopy), setupCommand: normalizeSetupCommand(entry.setupCommand), icon: normalizeIcon(entry.icon) };
    },
    async hiddenPaths() {
      const { projects } = await read({ strict: false });
      return new Set(Object.keys(projects).filter((key) => projects[key]?.hidden === true));
    },
    async setHidden(projectPath, hidden) {
      await update(projectPath, (entry) => {
        if (hidden === true) entry.hidden = true;
        else delete entry.hidden;
      });
      return { hidden: hidden === true };
    },
    async getDetectRepositories() {
      const data = await read({ strict: false });
      return { detectRepositories: data.defaults?.detectRepositories !== false };
    },
    async setDetectRepositories(value) {
      await save((data) => {
        const defaults = data.defaults && typeof data.defaults === "object" ? data.defaults : {};
        data.defaults = { ...defaults, detectRepositories: value !== false };
      });
      return { detectRepositories: value !== false };
    },
    async setFilesToCopy(projectPath, filesToCopy) {
      const lines = normalizeFilesToCopy(filesToCopy);
      await update(projectPath, (entry) => {
        if (lines.length > 0) entry.filesToCopy = lines;
        else delete entry.filesToCopy;
      });
      return { filesToCopy: lines };
    },
    async setSetupCommand(projectPath, setupCommand) {
      const command = normalizeSetupCommand(setupCommand);
      await update(projectPath, (entry) => {
        if (command) entry.setupCommand = command;
        else delete entry.setupCommand;
      });
      return { setupCommand: command };
    },
    async isSetupTrusted(projectPath, command) {
      const entry = (await read({ strict: false })).projects[path.resolve(projectPath)];
      return !!command && entry?.trustedSetupCommand === command;
    },
    async trustSetup(projectPath, command) {
      if (typeof command !== "string" || !command) throw new Error("A setup command is required.");
      await update(projectPath, (entry) => {
        entry.trustedSetupCommand = command;
      });
    },
    async setIcon(projectPath, icon) {
      const value = icon === null ? null : normalizeIcon(icon);
      if (icon !== null && !value) throw new Error("Choose a PNG, JPEG, WebP or GIF image under 450 KB.");
      await update(projectPath, (entry) => {
        if (value) entry.icon = value;
        else delete entry.icon;
      });
      return { icon: value };
    },
    getMainSync: readMainSync,
    async setMainSyncOverride(projectPath, value) {
      await update(projectPath, (entry) => {
        if (typeof value === "boolean") entry.syncMain = value;
        else delete entry.syncMain;
      });
      return readMainSync(projectPath);
    },
    async getMainSyncDefault() {
      const data = await read({ strict: false });
      return { syncMain: data.defaults?.syncMain === true };
    },
    async setMainSyncDefault(value) {
      await save((data) => {
        const defaults = data.defaults && typeof data.defaults === "object" ? data.defaults : {};
        data.defaults = { ...defaults, syncMain: value === true };
      });
      return { syncMain: value === true };
    },
    async recordMainSync(projectPath, result) {
      const value = normalizeMainSync(result);
      await update(projectPath, (entry) => {
        if (value) entry.mainSync = value;
        else delete entry.mainSync;
      });
    },
  };
}

module.exports = { createProjectSettings };

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parse } = require("yaml");
const { BUNDLED_SKILLS_DIRECTORY } = require("./bundled-skills.cjs");
const { promptSkillTokens, promptSkillParts } = require("@milagre/shared/prompt-skills");

const SKILL_DIRECTORIES = [".agents", ".claude", ".gemini", ".codex"];
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DIRECTORIES = 2000;

async function readSkill(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("Skill must be a file smaller than 256 KiB");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function metadata(content, file) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let data = {};
  if (match) {
    // Provider-specific fields (such as argument-hint) are not catalog metadata.
    const fields = match[1]
      .split(/\r?\n(?=[^\s#])/)
      .filter((field) => /^(name|description):/.test(field))
      .join("\n");
    try {
      data = parse(fields, { maxAliasCount: 0 });
    } catch {
      // Common hand-written skills use unquoted colons in a one-line description.
      // Keep full YAML support, but treat that field as text on this retry.
      const repaired = fields.replace(/^description:[ \t]+([^\r\n]+)$/m, (line, value) => {
        if (/^["'|>[{]/.test(value.trim())) return line;
        return `description: ${JSON.stringify(value.trim())}`;
      });
      data = parse(repaired, { maxAliasCount: 0 });
    }
  }
  const name = typeof data?.name === "string" ? data.name.trim() : path.basename(path.dirname(file));
  if (!/^[a-zA-Z0-9][\w.:-]*$/.test(name)) throw new Error("Invalid skill name");
  const description = typeof data?.description === "string" ? data.description.replace(/\s+/g, " ").trim() : "Use this skill";
  return { name, description };
}

// `projectPath` null lists the user and bundled skills only (no open Project).
async function discoverSkills(projectPath, { home = os.homedir(), bundledDirectory = BUNDLED_SKILLS_DIRECTORY } = {}) {
  if (projectPath !== null && (typeof projectPath !== "string" || !path.isAbsolute(projectPath))) throw new Error("An absolute workspace path is required");
  const skills = new Map();
  // Same-named skills found after the winner: the `/` menu ignores them, Settings shows them.
  const shadowed = [];
  const visited = new Set();
  const warnings = [];
  let directories = 0;

  async function walk(directory, scope, provider, depth = 0) {
    if (depth > 8 || directories >= MAX_DIRECTORIES) {
      warnings.push(`Skill discovery limit reached at ${directory}`);
      return;
    }
    let real;
    let entries;
    try {
      real = await fs.realpath(directory);
      if (visited.has(real)) return;
      visited.add(real);
      directories++;
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") warnings.push(`Cannot read skills in ${directory}: ${error.message}`);
      return;
    }
    const skillFile = entries.find((entry) => entry.name === "SKILL.md");
    if (skillFile) {
      const file = path.join(directory, "SKILL.md");
      try {
        const info = metadata(await readSkill(file), file);
        const key = info.name.toLowerCase();
        const winner = skills.get(key);
        if (winner) shadowed.push({ ...info, path: file, scope, provider, shadowedBy: winner.path });
        else skills.set(key, { ...info, path: file, scope, provider });
      } catch (error) {
        warnings.push(`Cannot read ${file}: ${error.message}`);
      }
      // A skill's references and scripts are not additional skills.
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isSymbolicLink()) await walk(path.join(directory, entry.name), scope, provider, depth + 1);
    }
  }

  for (const [base, scope] of [...(projectPath === null ? [] : [[projectPath, "workspace"]]), [home, "user"]]) {
    for (const directory of SKILL_DIRECTORIES) await walk(path.join(base, directory, "skills"), scope, directory.slice(1));
  }
  if (bundledDirectory) await walk(bundledDirectory, "bundled", "milagre");
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), shadowed, warnings };
}

// One discovered SKILL.md (a winner or a shadowed one), read with the same size limit. Only a file discovery
// returned is read, so the caller can't name any other file.
async function readDiscoveredSkill(projectPath, file, options) {
  const { skills, shadowed } = await discoverSkills(projectPath, options);
  if (typeof file !== "string" || !file || ![...skills, ...shadowed].some((skill) => skill.path === file))
    throw new Error("That skill is no longer there. Reload the list.");
  return readSkill(file);
}

// A fence of text from outside Milagre (routine-prompt.mjs): a Linear issue's or a webhook's text a Routine's message
// carries as data. Its text has every "<" escaped, so the first closing tag ends it.
const UNTRUSTED_FENCE = /<untrusted-data source="[^"\n]*">[\s\S]*?<\/untrusted-data>/g;
// The prompt with every fence blanked out (same length, line breaks kept): a /skill written inside one is data, never an
// invocation. Only the words around the fences (a Routine's own prompt, what the user typed) can call a skill.
const outsideFences = (prompt) => String(prompt ?? "").replace(UNTRUSTED_FENCE, (fence) => fence.replace(/[^\n]/g, " "));

function skillCommands(prompt) {
  return new Set(promptSkillTokens(outsideFences(prompt)).map((token) => token.name.toLowerCase()));
}

async function expandSkillPrompt(projectPath, prompt, options) {
  const visible = outsideFences(prompt);
  const commands = skillCommands(prompt);
  if (!commands.size) return prompt;
  const { skills } = await discoverSkills(projectPath, options);
  const invoked = new Set(
    promptSkillParts(
      visible,
      skills.map((skill) => skill.name),
    )
      .filter((part) => part.skill)
      .map((part) => part.text.slice(1).toLowerCase()),
  );
  const selected = skills.filter((skill) => invoked.has(skill.name.toLowerCase()));
  if (!selected.length) return prompt;
  const sections = [];
  let totalBytes = 0;
  for (const skill of selected) {
    const content = await readSkill(skill.path);
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_SKILL_BYTES) throw new Error("Selected skills are too large for one request. Use fewer skills.");
    sections.push(`Skill /${skill.name}\nSource: ${skill.path}\nResolve relative references from: ${path.dirname(skill.path)}\n\n${content}`);
  }
  // Claude Code runs a message that starts with `/name` as its own slash command, and when it has no such command
  // it tells the model the skill is not installed and did not run. Only skills in .claude folders are its own,
  // so a message led by any other skill gets a first line that doesn't start with a slash.
  const leading = promptSkillTokens(visible)[0];
  const lead = leading && !visible.slice(0, leading.start).trim() ? selected.find((skill) => skill.name.toLowerCase() === leading.name.toLowerCase()) : null;
  const intro = lead && lead.provider !== "claude" ? `The user invoked the skill /${lead.name} with this message:\n\n` : "";
  return `${intro}${prompt}\n\nThe user invoked the following skills. Read and apply their instructions for this request, subject to the user's instructions and the current permission mode.\n\n${sections.join("\n\n")}`;
}

module.exports = { discoverSkills, expandSkillPrompt, readDiscoveredSkill, skillCommands };

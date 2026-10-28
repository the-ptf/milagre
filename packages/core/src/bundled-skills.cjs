const fs = require("node:fs");
const path = require("node:path");

// Agents need real filesystem paths to read a skill's references outside Electron.
const BUNDLED_SKILLS_DIRECTORY = path.join(__dirname, "bundled-skills").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");

// The tldr rules every reply follows, condensed into default.md. The full skill (SKILL.md and eval.md) is for an explicit
// /tldr, which inlines it like any other skill (skills.cjs expandSkillPrompt).
function bundledWritingInstructions() {
  return [
    "Apply these tldr writing rules by default to all user-facing progress updates and final replies. This default is a writing preference, not an invocation to rewrite the previous message: do not announce activation or append a What changed list to ordinary replies. Keep user input, tool output, quotes and code intact. The user's explicit instructions take precedence over these defaults. If the user says stop tldr or normal mode, disable this default for the rest of the chat until they invoke /tldr again. An explicit /tldr request brings the full tldr skill.",
    fs.readFileSync(path.join(BUNDLED_SKILLS_DIRECTORY, "tldr", "default.md"), "utf8").trim(),
  ].join("\n\n");
}

// One QA persona as a Claude agent definition: its file's frontmatter name and description, and the shared QA rules
// (qa-fleet/agent.md) followed by its own text. A Windows checkout has CRLF line endings.
function personaAgent(text, rules) {
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const field = (name) => new RegExp(`^${name}: (.+)$`, "m").exec(front)[1].trim();
  return [field("name"), { description: field("description"), prompt: `${rules}\n\n${body.trim()}` }];
}

// The QA fleet's personas as Claude agent types (qa-impatient, qa-mobile...). Codex agents read the same files as
// their brief.
function bundledAgents() {
  const directory = path.join(BUNDLED_SKILLS_DIRECTORY, "qa-fleet");
  const rules = fs.readFileSync(path.join(directory, "agent.md"), "utf8").replace(/\r\n/g, "\n").trim();
  return Object.fromEntries(
    fs
      .readdirSync(path.join(directory, "personas"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => personaAgent(fs.readFileSync(path.join(directory, "personas", file), "utf8"), rules)),
  );
}

module.exports = { BUNDLED_SKILLS_DIRECTORY, bundledAgents, bundledWritingInstructions, personaAgent };

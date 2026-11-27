const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");

// Claude Code keeps the uuid Milagre gives each prompt. Its parentUuid is the last entry of the turn before it: the point a
// rewind resumes at, so the prompt and everything after it are left out.
async function claudeRewindPoint({ sessionId, prompt, env = process.env, home = os.homedir() }) {
  const { findClaudeTranscript } = require("../ade-import/transcripts.cjs");
  const file = findClaudeTranscript(sessionId, { env, home });
  if (!file || typeof prompt !== "string" || !prompt) return null;
  const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(prompt)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.uuid === prompt) return typeof entry.parentUuid === "string" && entry.parentUuid ? entry.parentUuid : null;
    }
  } finally {
    lines.close();
  }
  return null;
}

const REWIND_REJECTED = "Resume rejected by --resume-drops-turn:";

module.exports = { claudeRewindPoint, REWIND_REJECTED };

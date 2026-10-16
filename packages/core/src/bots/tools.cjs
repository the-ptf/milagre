const { z } = require("zod");
const { MEMORY_LINE_CAP } = require("@milagre/shared/bots");
const { readMemory, writeMemory } = require("./memory.cjs");

// Milagre tools for a bot's thread session, the same for every provider (definitions like chat-plan-tools.cjs).
// The memory tools only need the bot's home.

function createBotTools({ now = Date.now } = {}) {
  function definitions(chatKey, bot) {
    return [
      {
        name: "memory_read",
        description: `Read your MEMORY.md: what you noted in earlier sessions, under ## section headings. Lines ending in <!-- victor --> were written by the user. It holds at most ${MEMORY_LINE_CAP} lines.`,
        input: {},
        readOnly: true,
        run: async () => {
          const { text, lines } = await readMemory(bot.homePath);
          return `${text.replace(/\n$/, "")}\n\n(${lines} of ${MEMORY_LINE_CAP} lines)`;
        },
      },
      {
        name: "memory_write",
        description:
          "Note something worth keeping across sessions in MEMORY.md, under a section. append adds lines to the section; replace swaps its lines for yours but keeps the ones the user wrote. Tokens and passwords are redacted. Keep notes short: a line each.",
        input: {
          section: z.string().min(1).max(80).describe("The section heading, without ##, e.g. 'Flaky tests'."),
          text: z.string().min(1).max(4000).describe("Markdown lines, usually '- ' bullets."),
          mode: z.enum(["append", "replace"]),
        },
        readOnly: false,
        run: async (input) => {
          const { lines } = await writeMemory(bot.homePath, input, { now: now() });
          return `Saved. MEMORY.md has ${lines} of ${MEMORY_LINE_CAP} lines.`;
        },
      },
    ];
  }
  return { definitions };
}

module.exports = { createBotTools };

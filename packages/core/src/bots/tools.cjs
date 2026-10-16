const { z } = require("zod");
const { BOT_RUNNING_CHAT_CAP, MEMORY_LINE_CAP } = require("@milagre/shared/bots");
const { readMemory, writeMemory } = require("./memory.cjs");

// Milagre tools for a bot's thread session, the same for every provider (definitions like chat-plan-tools.cjs).
// The memory tools only need the bot's home; the Chat tools (given with `bots`, the bots service) reach the Chats the
// bot opens, in the Projects it watches.

const chatLine = (chat) => `- ${chat.chatKey}: ${chat.title} (${chat.status})`;

function chatTools(bots, bot) {
  return [
    {
      name: "chat_open",
      description: `Open a Milagre Chat for code work: a new worktree in one of your Projects, from base (default the main branch), and an agent started there on the prompt. It runs under your gates; you hear back in this thread when its turn ends. At most ${BOT_RUNNING_CHAT_CAP} of your Chats run at once.`,
      input: {
        project: z.string().min(1).describe("One of your Projects, by name or path."),
        title: z.string().min(1).max(120).describe("What the Chat is for, in a few words."),
        prompt: z.string().min(1).max(20_000).describe("The task for the Chat's agent, with everything it needs to know."),
        base: z.string().min(1).max(200).optional().describe("The branch to start from. Default: the main branch."),
      },
      readOnly: false,
      run: async (input) => {
        const opened = await bots.chatOpen(bot.id, input);
        return `Opened ${opened.chatKey}: ${opened.title}, in ${opened.project} from ${opened.baseBranch}. You'll hear here when its turn ends.`;
      },
    },
    {
      name: "chat_status",
      description: "How a Chat you opened stands: its state, last reply, branch, pull requests, changed files and the sign-offs it waits for.",
      input: { chat: z.string().min(1).describe("The Chat's id, as chat_open or chat_list_mine gave it.") },
      readOnly: true,
      run: async ({ chat }) => JSON.stringify(await bots.chatStatus(bot.id, chat), null, 2),
    },
    {
      name: "chat_send",
      description: "Steer a Chat you opened while it runs, or continue it after its turn ended. Not once the user took it over.",
      input: {
        chat: z.string().min(1).describe("The Chat's id, as chat_open or chat_list_mine gave it."),
        text: z.string().min(1).max(20_000),
      },
      readOnly: false,
      run: async ({ chat, text }) => {
        await bots.chatSend(bot.id, chat, text);
        return "Sent.";
      },
    },
    {
      name: "chat_list_mine",
      description: "The Chats you opened, with their state: running, done, failed, or taken-over (the user's now).",
      input: {},
      readOnly: true,
      run: async () => {
        const mine = bots.chatsMine(bot.id);
        return mine.length ? mine.map(chatLine).join("\n") : "You haven't opened any Chats.";
      },
    },
  ];
}

function createBotTools({ now = Date.now, bots } = {}) {
  function definitions(chatKey, bot) {
    return [
      {
        name: "memory_read",
        description: `Read your MEMORY.md: what you noted in earlier sessions, under ## section headings. Lines ending in <!-- user --> were written by the user. It holds at most ${MEMORY_LINE_CAP} lines.`,
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
      ...(bots ? chatTools(bots, bot) : []),
    ];
  }
  return { definitions };
}

module.exports = { createBotTools };

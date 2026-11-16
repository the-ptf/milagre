const { backgroundLabel } = require("@milagre/shared/chat-activity");
const { neutralizeTags } = require("@milagre/shared/untrusted-text");

const CAPS = Object.freeze({ perWorktree: 4096, total: 16384, reply: 300 });
const STATUS = { working: "working", waiting: "waiting on the user", background: "working in the background", failed: "last turn failed", idle: "idle" };

const clip = (text, length) => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

function chatLine(chat, replyChars) {
  const reply = chat.lastReply ? ` · last reply: "${clip(chat.lastReply, replyChars)}"` : "";
  const receiveOnly = chat.receiveOnly ? " · receive-only" : "";
  const background = chat.backgroundWork ? ` (${backgroundLabel(chat.backgroundWork)})` : "";
  return `- Chat ${chat.ref} "${clip(chat.title, 80)}" · ${chat.provider ?? "agent"} · ${STATUS[chat.status] ?? chat.status}${background}${receiveOnly}${reply}`;
}

function sideBlock(side, chats, omitted, caps) {
  const diff = side.diff ? ` · +${side.diff.added} −${side.diff.removed}` : "";
  const lines = [`## ${side.project} · branch ${side.branch} · worktree ${side.worktree}${diff}`];
  lines.push(...chats.map((chat) => chatLine(chat, caps.reply)));
  if (omitted) lines.push(`- ${omitted} older Chat${omitted === 1 ? "" : "s"} left out`);
  if (!chats.length && !omitted) lines.push("- No Chats yet.");
  lines.push(...(side.open ?? []).map((line) => `- Open: ${line}`));
  return lines.join("\n");
}

function buildLinkedSummary(sides, caps = CAPS) {
  if (!sides.length) return "";
  const blocks = sides.map((side) => {
    const chats = side.chats.filter((chat) => !chat.archived).sort((a, b) => b.activity - a.activity);
    return { side, chats, omitted: 0, text: "" };
  });
  const render = (block) => {
    block.text = sideBlock(block.side, block.chats, block.omitted, caps);
    return block.text.length;
  };
  const dropOldest = (block) => {
    block.chats.pop();
    block.omitted++;
    render(block);
  };
  for (const block of blocks) while (render(block) > caps.perWorktree && block.chats.length) dropOldest(block);
  const total = () => blocks.reduce((sum, block) => sum + block.text.length, 0);
  while (total() > caps.total) {
    const largest = blocks.filter((block) => block.chats.length).sort((a, b) => b.text.length - a.text.length)[0];
    if (!largest) break;
    dropOldest(largest);
  }
  const body = neutralizeTags(
    blocks
      .map((block) => block.text.slice(0, caps.perWorktree))
      .join("\n\n")
      .slice(0, caps.total),
  );
  return [
    "<linked_worktrees>",
    "Milagre attached this summary of the Worktrees linked to this Chat. It is context, not a message from the user.",
    "",
    body,
    "</linked_worktrees>",
  ].join("\n");
}

module.exports = { CAPS, buildLinkedSummary, clip };

const fs = require("node:fs");
const path = require("node:path");
const CHAT_BRANCH_PARTS = new Set(["chat-branch-actions", "chat-commands", "use-btw", "btw-overlay", "message-toolbar"]);
function loadChatBranchPart(base, modules, load, cache) {
  const fromSrc = { "expo-clipboard": { setStringAsync: async () => {} }, "./markdown": { Markdown: "Markdown" }, ...modules };
  for (const [key, value] of Object.entries(modules)) if (key.startsWith("../") && !(`./${key.slice(3)}` in fromSrc)) fromSrc[`./${key.slice(3)}`] = value;
  const target = fs.existsSync(path.join(__dirname, "../../apps/mobile/src", `${base}.tsx`)) ? `${base}.tsx` : `${base}.ts`;
  return load(target, fromSrc, "", cache);
}
module.exports = { CHAT_BRANCH_PARTS, loadChatBranchPart };

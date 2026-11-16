import { STORAGE_COMMAND, STORAGE_COMMAND_HINT } from "@milagre/shared/storage";
export const UNDO_COMMAND = {
  key: "undo",
  name: "/undo",
  desc: "Undo a task's file changes",
};

export const COMMANDS = [
  { key: "btw", name: "/btw", desc: "Ask a side question without adding to the chat" },
  { key: STORAGE_COMMAND, name: `/${STORAGE_COMMAND}`, desc: STORAGE_COMMAND_HINT },
  { key: "summarize", name: "/summarize", desc: "Digest the thread so far" },
  {
    key: "blockers",
    name: "/blockers",
    desc: "Find blockers across worktrees",
  },
  { key: "plan", name: "/plan", desc: "Draft the next steps" },
  { key: "review", name: "/review", desc: "Review the current agent output" },
];

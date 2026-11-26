import { BROWSER_MENTION, ORCHESTRATOR_MENTION } from "@milagre/shared/prompt-parts";
import { orchestratorEnabled } from "./orchestrator-store";

const ROWS = [
  { key: "orchestrator", name: "Orchestrator", desc: "Hand this to the Orchestrator", mention: ORCHESTRATOR_MENTION, shown: orchestratorEnabled },
  { key: "browser", name: "Browser", desc: "Use Milagre's Browser panel", mention: BROWSER_MENTION, shown: () => true },
];

/** The @ menu's Milagre rows (Orchestrator while it is on, Browser) whose name fits the typed query. */
export function milagreMentionRows(open: boolean, query: string) {
  if (!open) return [];
  const needle = query.trim().toLowerCase();
  return ROWS.filter((row) => row.name.toLowerCase().startsWith(needle) && row.shown()).map(({ key, name, desc }) => ({
    key,
    name,
    desc,
    computer: undefined,
    group: "Milagre",
  }));
}

/** The text a Milagre row inserts, or undefined for any other row. */
export const milagreMention = (row: { key: string }) => ROWS.find((item) => item.key === row.key)?.mention;

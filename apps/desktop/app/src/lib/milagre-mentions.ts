import { BROWSER_MENTION, PARADISE_MENTION, ORCHESTRATOR_MENTION, PARADISE_NAME, matchesParadiseMention } from "@milagre/shared/prompt-parts";
import { orchestratorEnabled } from "./orchestrator-store";

const ROWS = [
  { key: "orchestrator", name: "Orchestrator", desc: "Hand this to the Orchestrator", mention: ORCHESTRATOR_MENTION, shown: orchestratorEnabled },
  { key: "paradise", name: PARADISE_NAME, desc: PARADISE_MENTION, mention: PARADISE_MENTION, shown: () => true },
  { key: "browser", name: "Browser", desc: "Use Milagre's Browser panel", mention: BROWSER_MENTION, shown: () => true },
];

/** The @ menu's Milagre rows whose name fits the typed query. */
export function milagreMentionRows(open: boolean, query: string) {
  if (!open) return [];
  const needle = query.trim().toLowerCase();
  return ROWS.filter((row) => (row.key === "paradise" ? matchesParadiseMention(needle) : row.name.toLowerCase().startsWith(needle)) && row.shown()).map(
    ({ key, name, desc }) => ({
      key,
      name,
      desc,
      computer: undefined,
      group: "Milagre",
    }),
  );
}

/** The text a Milagre row inserts, or undefined for any other row. */
export const milagreMention = (row: { key: string }) => ROWS.find((item) => item.key === row.key)?.mention;

// The /docs page's command reference, read at build time from the CLI itself so the page can't drift from `milagre help`:
// the built-in commands from apps/daemon/src/command-help.cjs, and the generated families from the same offline catalogue
// `milagre help <family>` prints without a running server.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type Row = [string, string];
export interface BuiltinCommand {
  name: string;
  description: string;
  usage: string;
  arguments?: Row[];
  commands?: Row[];
  flags?: Row[];
  examples?: string[];
  note?: string;
}
export interface Family {
  name: string;
  commands: string[];
  desktopOnly: boolean;
}

// Astro builds from apps/site, but the Lighthouse check and npm workspaces can start it elsewhere: find the repository.
function repoRoot() {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "apps/daemon/src/command-help.cjs"))) return dir;
    if (path.dirname(dir) === dir) throw new Error("cli-reference: apps/daemon not found above " + process.cwd());
  }
}

const root = repoRoot();
const load = createRequire(path.join(root, "apps/daemon/package.json"));
const help = load("./src/command-help.cjs") as { COMMANDS: Record<string, Omit<BuiltinCommand, "name">> };
const products = load("./src/product-commands.cjs") as { offlineCatalogue(): { name: string; command: string; requires?: string[] }[] };
const daemonPackage = load("./package.json") as { cliVersion: string };

export const CLI_VERSION = daemonPackage.cliVersion;

// Every built-in command, in the order `milagre help` lists them, with help last.
export const BUILTIN_COMMANDS: BuiltinCommand[] = Object.entries(help.COMMANDS).map(([name, info]) => ({ name, ...info }));

// Owner commands grouped by family (`project:open` is `milagre project open`). Native desktop actions are their own group.
export const FAMILIES: Family[] = (() => {
  const families = new Map<string, Family>();
  for (const item of products.offlineCatalogue()) {
    const desktop = item.requires?.includes("desktop") ?? false;
    const words = item.command.split(" ");
    const key = desktop ? `desktop ${words[1]}` : words[0];
    const family = families.get(key) ?? { name: key, commands: [], desktopOnly: desktop };
    family.commands.push(words.slice(desktop ? 2 : 1).join(" "));
    families.set(key, family);
  }
  return [...families.values()].sort((a, b) => Number(a.desktopOnly) - Number(b.desktopOnly) || a.name.localeCompare(b.name));
})();

export const OWNER_COMMAND_COUNT = FAMILIES.reduce((sum, family) => sum + family.commands.length, 0);

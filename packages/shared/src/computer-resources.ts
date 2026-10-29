// A computer's memory and disk as the desktop's Settings › Devices, a paired desktop's Computer page and the phone's
// computer page show them. The host measures (core computer-resources.cjs); this turns bytes into the same meters
// everywhere.

export type ComputerResources = {
  memory: { total: number; available: number; milagre: number | null };
  /** Null when the host couldn't read its disk. `milagre` is null until the first measure of its folders ends. */
  disk: { total: number; available: number; milagre: number | null; measuredAt: number | null; measuring: boolean } | null;
};

export type ResourceMeter = {
  label: "Memory" | "Disk";
  /** "13.1 GB free of 24 GB" */
  summary: string;
  /** "Milagre 3 GB", "Milagre: measuring…", or null when the host can't tell. */
  milagre: string | null;
  /** Shares of the total, adding up to 1: Milagre's, everything else in use, and free. */
  shares: { milagre: number; other: number; free: number };
};

export const RESOURCES_TITLE = "Memory and disk";
export const RESOURCES_HINT = "Milagre counts the app, its agents and terminals, and its worktrees and data on disk.";

function format(bytes: number, unit: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / unit;
  let index = 0;
  while (value >= unit && index < units.length - 1) {
    value /= unit;
    index += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[index]}`;
}

/** Memory in binary units, as Activity Monitor shows it: 24 GB for a 24 GB Mac. */
export const formatMemory = (bytes: number) => format(Math.max(0, bytes), 1024);
/** Disk in decimal units, as Finder shows it. */
export const formatDisk = (bytes: number) => format(Math.max(0, bytes), 1000);

function shares(total: number, available: number, milagre: number | null) {
  if (!(total > 0)) return { milagre: 0, other: 0, free: 1 };
  const free = Math.min(Math.max(available, 0), total);
  // Worktrees made with APFS clones count in full, so Milagre's measure can pass what is really in use.
  const ours = Math.min(Math.max(milagre ?? 0, 0), total - free);
  return { milagre: ours / total, other: (total - free - ours) / total, free: free / total };
}

export function resourceMeters(resources: ComputerResources): ResourceMeter[] {
  const { memory, disk } = resources;
  const meters: ResourceMeter[] = [
    {
      label: "Memory",
      summary: `${formatMemory(memory.available)} free of ${formatMemory(memory.total)}`,
      milagre: memory.milagre === null ? null : `Milagre ${formatMemory(memory.milagre)}`,
      shares: shares(memory.total, memory.available, memory.milagre),
    },
  ];
  if (disk)
    meters.push({
      label: "Disk",
      summary: `${formatDisk(disk.available)} free of ${formatDisk(disk.total)}`,
      milagre: disk.milagre !== null ? `Milagre ${formatDisk(disk.milagre)}` : disk.measuring ? "Milagre: measuring…" : null,
      shares: shares(disk.total, disk.available, disk.milagre),
    });
  return meters;
}

/** How often an open page reads again: memory moves, and the first disk measure lands within a minute. */
export const RESOURCES_REFRESH_MS = 15_000;

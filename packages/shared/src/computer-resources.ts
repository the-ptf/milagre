// A computer's memory and disk as the desktop's Settings › Devices, a paired desktop's Computer page and the phone's
// computer page show them. The host measures (core computer-resources.cjs); this turns bytes into the same rows,
// tooltips and breakdowns everywhere.

/** What a part of Milagre's share is: an agent provider, terminals, the app itself, or on disk worktrees and data. */
export type ResourcePartKind = "claude" | "codex" | "antigravity" | "kiro" | "terminals" | "app" | "worktrees" | "data";
/** `count`: agents or terminals running, or worktrees on disk; 0 where nothing is counted. */
export type ResourcePart = { kind: ResourcePartKind; bytes: number; count: number };

export type ComputerResources = {
  /** `parts` is missing from a host that predates the breakdown. */
  memory: { total: number; available: number; milagre: number | null; parts?: ResourcePart[] | null };
  /** Null when the host couldn't read its disk. `milagre` and `parts` are null until the first measure of its folders ends. */
  disk: {
    total: number;
    available: number;
    milagre: number | null;
    parts?: ResourcePart[] | null;
    measuredAt: number | null;
    measuring: boolean;
  } | null;
};

export type GaugePart = {
  kind: ResourcePartKind;
  /** "Claude · 3 agents" */
  label: string;
  /** "1.4 GB" */
  value: string;
  /** Its share of the whole gauge, for its slice of the row's bar. */
  share: number;
  /** Its share of Milagre's amount alone, for a bar that shows only Milagre. */
  portion: number;
};

export type ResourceGauge = {
  kind: "memory" | "disk";
  /** "11 GB" */
  free: string;
  /** "free of 24 GB" */
  of: string;
  /** Under a tenth free: the row turns orange, and load balancing will skip the computer. */
  low: boolean;
  /** Milagre's disk share isn't measured yet. */
  measuring: boolean;
  /** Shares of the total, adding up to 1: Milagre's, everything else in use, and free. */
  shares: { milagre: number; other: number; free: number };
  /** The bar's hover: "Milagre 3.6 GB · Other apps 9.4 GB", or that its folders are being measured. */
  tooltip: string;
  /** Milagre's amount, "3.6 GB", or null when the host can't tell. */
  milagre: string | null;
  /** "of 24 GB memory", beside Milagre's amount in the breakdown. */
  context: string;
  /** Milagre's share split by what uses it, largest first. Empty before the host measures it. */
  parts: GaugePart[];
};

export const BREAKDOWN_TITLE = "What Milagre uses";
export const MEASURING_TOOLTIP = "Measuring Milagre's folders";
/** What a row says when the host's answer can't be read. */
export const UNREADABLE = "Couldn't read this computer's memory and disk.";
const LOW_SHARE = 0.1;

function format(bytes: number, unit: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / unit;
  let index = 0;
  while (value >= unit && index < units.length - 1) {
    value /= unit;
    index += 1;
  }
  let rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  // 999.96 MB rounds to 1000: that is 1 GB.
  if (rounded >= unit && index < units.length - 1) {
    index += 1;
    rounded = Math.round((value / unit) * 10) / 10;
  }
  return `${rounded} ${units[index]}`;
}

/** Memory in binary units, as Activity Monitor shows it: 24 GB for a 24 GB Mac. */
export const formatMemory = (bytes: number) => format(Number.isFinite(bytes) ? Math.max(0, bytes) : 0, 1024);
/** Disk in decimal units, as Finder shows it. */
export const formatDisk = (bytes: number) => format(Number.isFinite(bytes) ? Math.max(0, bytes) : 0, 1000);

function shares(total: number, available: number, milagre: number | null) {
  if (!(total > 0)) return { milagre: 0, other: 0, free: 1 };
  const free = Math.min(Math.max(available, 0), total);
  // Worktrees made with APFS clones count in full, so Milagre's measure can pass what is really in use.
  const ours = Math.min(Math.max(milagre ?? 0, 0), total - free);
  return { milagre: ours / total, other: (total - free - ours) / total, free: free / total };
}

const PART_KINDS = new Set<string>(["claude", "codex", "antigravity", "kiro", "terminals", "app", "worktrees", "data"]);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function partLabel({ kind, count }: ResourcePart): string {
  switch (kind) {
    case "claude":
      return count ? `Claude · ${plural(count, "agent")}` : "Claude";
    case "codex":
      return count ? `Codex · ${plural(count, "agent")}` : "Codex";
    case "antigravity":
      return count ? `Antigravity · ${plural(count, "agent")}` : "Antigravity";
    case "kiro":
      return count ? `Kiro · ${plural(count, "agent")}` : "Kiro";
    case "terminals":
      return count ? `Terminals · ${count}` : "Terminals";
    case "app":
      return "Milagre app";
    case "worktrees":
      return count ? `Worktrees · ${count}` : "Worktrees";
    case "data":
      return "App data";
  }
}

function gaugeParts(parts: ResourcePart[] | null | undefined, milagreShare: number, formatBytes: (bytes: number) => string): GaugePart[] {
  const known = (Array.isArray(parts) ? parts : []).filter(
    (part): part is ResourcePart => Boolean(part) && PART_KINDS.has(part.kind) && Number.isFinite(part.bytes) && part.bytes > 0,
  );
  const sum = known.reduce((total, part) => total + part.bytes, 0);
  if (!sum) return [];
  const sorted = [...known];
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy; toSorted crashes on the phone (Hermes)
  sorted.sort((a, b) => b.bytes - a.bytes);
  return sorted.map((part) => ({
    kind: part.kind,
    label: partLabel(part),
    value: formatBytes(part.bytes),
    share: (part.bytes / sum) * milagreShare,
    portion: part.bytes / sum,
  }));
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The rows for one answer, or null when the answer isn't one this version can read (a broken or newer host): the row
 * then says it couldn't read, instead of the page failing.
 */
export function resourceGauges(resources: ComputerResources | null | undefined): { memory: ResourceGauge; disk: ResourceGauge | null } | null {
  const memory = resources?.memory;
  if (!memory || !finite(memory.total) || !finite(memory.available) || (memory.milagre !== null && !finite(memory.milagre))) return null;
  const disk = resources.disk && finite(resources.disk.total) && finite(resources.disk.available) ? resources.disk : null;
  const memoryShares = shares(memory.total, memory.available, memory.milagre);
  const memoryGauge: ResourceGauge = {
    kind: "memory",
    free: formatMemory(memory.available),
    of: `free of ${formatMemory(memory.total)}`,
    low: memory.total > 0 && memory.available / memory.total < LOW_SHARE,
    measuring: false,
    shares: memoryShares,
    tooltip:
      memory.milagre === null
        ? `Other apps ${formatMemory(memory.total - memory.available)}`
        : `Milagre ${formatMemory(memory.milagre)} · Other apps ${formatMemory(memoryShares.other * memory.total)}`,
    milagre: memory.milagre === null ? null : formatMemory(memory.milagre),
    context: `of ${formatMemory(memory.total)} memory`,
    parts: gaugeParts(memory.parts, memoryShares.milagre, formatMemory),
  };
  if (!disk) return { memory: memoryGauge, disk: null };
  const diskMilagre = finite(disk.milagre) ? disk.milagre : null;
  const diskShares = shares(disk.total, disk.available, diskMilagre);
  const measuring = diskMilagre === null;
  return {
    memory: memoryGauge,
    disk: {
      kind: "disk",
      free: formatDisk(disk.available),
      of: `free of ${formatDisk(disk.total)}`,
      low: disk.total > 0 && disk.available / disk.total < LOW_SHARE,
      measuring,
      shares: diskShares,
      tooltip: measuring ? MEASURING_TOOLTIP : `Milagre ${formatDisk(diskMilagre ?? 0)} · Everything else ${formatDisk(diskShares.other * disk.total)}`,
      milagre: measuring ? null : formatDisk(diskMilagre ?? 0),
      context: `of ${formatDisk(disk.total)} disk`,
      parts: gaugeParts(disk.parts, diskShares.milagre, formatDisk),
    },
  };
}

/** The opacity of a part's slice of the accent colour, largest first, so the slices tell apart on any theme. */
export const PART_OPACITY = [1, 0.7, 0.5, 0.35, 0.22, 0.14] as const;
export const partOpacity = (index: number) => PART_OPACITY[Math.min(index, PART_OPACITY.length - 1)];

/** How often an open page reads again: memory moves, and the first disk measure lands within a minute. */
export const RESOURCES_REFRESH_MS = 15_000;

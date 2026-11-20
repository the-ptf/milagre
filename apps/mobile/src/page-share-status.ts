import type { ArtifactPageKind, DesignPageShare } from "@milagre/shared/artifact";

function ago(at: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** What a published page holds, as its row in Published pages names it. A link without a kind is from before kinds. */
export function shareScopeLabel(kind: ArtifactPageKind | undefined): string {
  if (kind === "workspace") return "Workspace";
  if (kind === "design") return "Design";
  if (kind === "artifacts") return "Page";
  return "Designs";
}

export function shareStateLabel(share: DesignPageShare): "Revoked" | "Paused" | "Live" | "Snapshot" {
  if (share.revoked) return "Revoked";
  if (!share.live) return "Snapshot";
  return share.paused ? "Paused" : "Live";
}

/** The line under a Chat's current link: following the agent, paused, retrying an update, or a frozen snapshot. */
export function shareStatusLine(share: DesignPageShare, now: number): string {
  const changed = `${share.updatedAt ? "updated" : "published"} ${ago(share.updatedAt ?? share.createdAt, now)}`;
  if (share.revoked) return "Revoked";
  if (!share.live) return `Snapshot · ${changed}`;
  if (share.paused) return "Paused";
  if (share.stale) return share.lastError ? `Couldn't update: ${share.lastError.trim().replace(/\.$/, "")}. Retrying.` : "Couldn't update yet. Retrying.";
  return `Live · ${changed}`;
}

/** What anyone with the link sees, and whether it follows the agent: `snapshot` when the current link is frozen. */
export function sharePublicNotice(kind: ArtifactPageKind, snapshot = false): string {
  const what = kind === "design" ? "this design" : kind === "artifacts" ? "the page, hidden HTML included" : "every design and the page, hidden HTML included";
  return `Anyone with the link can see ${what}. ${snapshot ? "Share again for a link that keeps updating as the agent works." : "The link keeps updating as the agent works."}`;
}

export function shareSheetTitle(kind: ArtifactPageKind): string {
  if (kind === "design") return "Share this design";
  if (kind === "artifacts") return "Share this page";
  return "Share";
}

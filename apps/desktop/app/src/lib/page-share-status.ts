import type { ArtifactPageKind, DesignPageShare, PageShareScope } from "@milagre/shared/artifact";
import { ago } from "@milagre/shared/main-sync";

export type ShareState = "Live" | "Paused" | "Snapshot" | "Revoked";

const SCOPES: Record<ArtifactPageKind, string> = { workspace: "Workspace", design: "Design", artifacts: "Page", designs: "Designs" };

export const scopeLabel = (share: Pick<DesignPageShare, "kind">) => SCOPES[share.kind ?? "designs"];

export function shareState(share: DesignPageShare): ShareState {
  if (share.revoked) return "Revoked";
  if (!share.live) return "Snapshot";
  return share.paused ? "Paused" : "Live";
}

const lastChange = (share: DesignPageShare, now: number) => `${share.updatedAt ? "updated" : "published"} ${ago(share.updatedAt ?? share.createdAt, now)}`;

/** One line on where a link stands: following the agent, paused, retrying an update, or a frozen snapshot. */
export function shareStatusLine(share: DesignPageShare, now: number): string {
  if (share.revoked) return "Revoked";
  if (!share.live) return `Snapshot · ${lastChange(share, now)}`;
  if (share.paused) return "Paused";
  if (share.stale) return share.lastError ? `Couldn't update: ${share.lastError.trim().replace(/\.$/, "")}. Retrying.` : "Couldn't update yet. Retrying.";
  return `Live · ${lastChange(share, now)}`;
}

export function shareTone(share: DesignPageShare): "green" | "red" | "muted" {
  if (share.revoked || !share.live || share.paused) return "muted";
  return share.stale ? "red" : "green";
}

export function shareTitle(scope: PageShareScope): string {
  if (scope.kind === "design") return "Share this design";
  if (scope.kind === "artifacts") return "Share this page";
  return "Share";
}

/** What anyone with the link sees, and whether it follows the agent: `snapshot` when the current link is frozen. */
export function shareNotice(scope: PageShareScope, snapshot = false): string {
  const what =
    scope.kind === "design" ? "this design" : scope.kind === "artifacts" ? "the page, hidden HTML included" : "every design and the page, hidden HTML included";
  return `Anyone with the link can see ${what}. ${snapshot ? "Share again for a link that keeps updating as the agent works." : "The link keeps updating as the agent works."}`;
}

import type { ArtifactRef } from "./model.ts";
import type { DesignDocument, DesignOperation } from "./design.mjs";
import type { ArtifactAsset } from "./artifact-assets.mjs";
export { createDesignFontReader, restoreDesignFonts } from "./design-font-cache.mjs";

export type { ArtifactAsset };

/** A design as `artifact:list` returns it: its newest version, and the screen it is laid out on. */
export type ArtifactSummary = ArtifactRef & { versions: number; width: number; height: number; format: "design" | "html" };

/** One version of a design an agent showed, as `artifact:get` returns it. */
export type DesignArtifact = ArtifactSummary & {
  format: "design";
  latest: number;
  html: string;
  document: DesignDocument;
  /** Opt-in transport: HTML omits this block; fontCss is absent when the caller already holds fontKey. */
  fontKey?: string;
  fontCss?: string;
};
/** One tab of an Artifact page: a page of its own, under a title in the page's tab bar. */
export type ArtifactTab = { id: string; title: string; html: string };
/** `html` is the page, or its first tab when the agent split it into `tabs`. `assets` are the files its HTML shows as `assets/<name>`. */
export type HtmlArtifact = ArtifactSummary & {
  format: "html";
  latest: number;
  html: string;
  tabs?: ArtifactTab[];
  assets?: ArtifactAsset[];
  document?: never;
};
/** Part of a file of the Chat's Artifact page, as `artifact:asset` returns it: up to 256 KB from `offset`, in base64. */
export type ArtifactAssetChunk = ArtifactAsset & { offset: number; base64: string };
export type Artifact = DesignArtifact | HtmlArtifact;
export type ArtifactPageKind = "designs" | "artifacts";

/** A public link to a Chat page. Sharing the page again updates the snapshot behind the same link. */
export interface DesignPageShare {
  kind?: ArtifactPageKind;
  id: string;
  url: string;
  title: string;
  /** When the link was first published. */
  createdAt: number;
  /** When the snapshot behind the link was last replaced; absent until the first update. */
  updatedAt?: number;
  designCount: number;
  revoked?: boolean;
  /** The upload was never confirmed. Sharing again retries the same link. */
  pending?: boolean;
  /** Set by sharePage: older links of this page that could not be revoked yet. They stay public, are listed in
   * Published pages, and the next share retries them. */
  olderLinks?: number;
}

export interface ArtifactApi {
  sharingStatus(request?: { kind?: ArtifactPageKind }): Promise<{ available: boolean; reason?: string }>;
  allPageShares(): Promise<DesignPageShare[]>;
  revokeSavedPageShare(request: { id: string }): Promise<void>;
  /** The page's current link, or none: at most one entry. */
  pageShares(request: { chatId: string; kind?: ArtifactPageKind }): Promise<DesignPageShare[]>;
  /** The page is named after its Chat on the host; `title` only satisfies hosts from before that, which require one. */
  sharePage(request: { chatId: string; title?: string; acknowledgePublic: true; kind?: ArtifactPageKind }): Promise<DesignPageShare>;
  revokePageShare(request: { chatId: string; id: string; kind?: ArtifactPageKind }): Promise<void>;
  get(request: { chatId: string; id: string; version?: number; fonts?: { have: string[] } }): Promise<Artifact>;
  /** Part of a file of the Chat's Artifact page, by its name; `length` caps the bytes (256 KB at most). */
  asset(request: { chatId: string; name: string; offset?: number; length?: number }): Promise<ArtifactAssetChunk>;
  list(request: { chatId: string; format?: "design" | "html" }): Promise<ArtifactSummary[]>;
  /** Saves an atomic batch against the version the editor loaded. A stale version leaves the design unchanged. */
  apply(request: { chatId: string; id: string; expectedVersion: number; operations: DesignOperation[] }): Promise<DesignArtifact>;
  /** Deletes a design with every version and the comments on it. Its id is never reused. */
  delete(request: { chatId: string; id: string }): Promise<{ id: string }>;
  /** Records comments the user is sending; returns them with their ids. */
  addComments(request: { chatId: string; comments: DesignComment[] }): Promise<ArtifactComment[]>;
  comments(request: { chatId: string }): Promise<ArtifactComment[]>;
}

/**
 * Designs as the canvas lays them out: one row per group, the groups and the designs in each in the order they first
 * appear. Designs without a group share a row of their own, where the first of them appears.
 */
export function designGroups<T extends { group?: string }>(designs: readonly T[]): { group: string | null; designs: T[] }[] {
  const rows = new Map<string | null, T[]>();
  for (const design of designs) {
    const group = design.group?.trim() || null;
    const row = rows.get(group);
    if (row) row.push(design);
    else rows.set(group, [design]);
  }
  return [...rows].map(([group, members]) => ({ group, designs: members }));
}

/**
 * A comment on a design: where on it (fractions of its screen) when it was pinned, and what the user wrote. On an
 * Artifact page the fractions are of the whole page; `anchor` is the element it was pinned on and the point in it
 * (ARTIFACT_PAGE_SCRIPT finds it again after the page reflows), and `near` the text there, for the agent to find it by.
 */
export type DesignComment = {
  design: ArtifactRef;
  x?: number;
  y?: number;
  nodeId?: string;
  near?: string;
  anchor?: string;
  /** On an Artifact page split into tabs: the tab it was pinned on. */
  tab?: { id: string; title: string };
  text: string;
  id?: string;
};

/** The tab of an Artifact page to show: the one named, else its first; a page without tabs is its one tab, id "". */
export function artifactTab(page: { title: string; html: string; tabs?: ArtifactTab[] }, id?: string | null): ArtifactTab {
  return page.tabs?.find((tab) => tab.id === id) ?? page.tabs?.[0] ?? { id: "", title: page.title, html: page.html };
}

/** Whether a pin belongs on this tab: one pinned on another tab waits there; one from before tabs sits on the first. */
export function onArtifactTab(pin: { tab?: { id: string } }, page: { tabs?: ArtifactTab[] }, tab: ArtifactTab): boolean {
  return (pin.tab?.id ?? page.tabs?.[0]?.id ?? "") === tab.id;
}

/** The text near a pin as a comment carries it: one line, no double quotes (the message quotes it), at most 80 characters. */
export function nearText(text: string | undefined | null): string {
  const line = (text ?? "").replace(/["\s]+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}\u2026` : line;
}

/** Sent comments are numbered within the message that carried them (the comments the host recorded at once). */
export function sentNumbers(comments: { id: string; createdAt: number }[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const batches = new Map<number, number>();
  for (const comment of comments) {
    const next = (batches.get(comment.createdAt) ?? 0) + 1;
    batches.set(comment.createdAt, next);
    numbers.set(comment.id, next);
  }
  return numbers;
}

/**
 * A new comment's id, named by the app so the message that carries it can be sent before the host records it: a send
 * that fails then leaves nothing recorded, and the host keeps a comment it is given twice once.
 */
export const newCommentId = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/** A comment as the host keeps it: with its id, and, once the agent has addressed it, its note on what it did. */
export type ArtifactComment = DesignComment & { id: string; createdAt: number; resolved?: { note: string; at: number } };

// Plain text: the message shows in the user's bubble as typed, without markdown.
const designName = (design: ArtifactRef) =>
  design.format === "html" ? `the artifact "${design.title}" (${design.id})` : `the design "${design.title}" (${design.id}, version ${design.version})`;

const CHOICE = /^I chose the design ".*?" \(([a-z0-9-]+), version (\d+)\)\. Continue from this one\.(?:\n|$)/;

/**
 * The message that sends the user's feedback on designs to the agent: the design they chose, if they chose one, then
 * their comments. The choice comes first, on a line of its own, where chosenDesign reads it back.
 */
export function designFeedbackMessage({ choice, comments }: { choice?: ArtifactRef | null; comments: DesignComment[] }): string {
  const parts: string[] = [];
  if (choice) parts.push(`I chose ${designName(choice)}. Continue from this one.`);
  if (comments.length) {
    const lines = comments.map((comment, index) => {
      const at = comment.x === undefined || comment.y === undefined ? "" : `, ${Math.round(comment.x * 100)}% across and ${Math.round(comment.y * 100)}% down`;
      const layer = comment.nodeId ? `, layer "${comment.nodeId}"` : "";
      const tab = comment.design.format === "html" && comment.tab ? `, on the tab ${comment.tab.id} ("${nearText(comment.tab.title)}")` : "";
      const near = comment.design.format === "html" && nearText(comment.near) ? `, near "${nearText(comment.near)}"` : "";
      // The id lets the agent resolve the comment; a message from before ids has none.
      return `${index + 1}. ${comment.id ? `(comment ${comment.id}) ` : ""}On ${designName(comment.design)}${at}${layer}${tab}${near}: ${comment.text.trim()}`;
    });
    const htmlOnly = comments.every((comment) => comment.design.format === "html");
    const mixed = !htmlOnly && comments.some((comment) => comment.design.format === "html");
    const revise = htmlOnly ? REVISE_ARTIFACT : mixed ? REVISE_MIXED : REVISE;
    parts.push(
      `${comments.length === 1 ? "A comment" : "Comments"} on the ${htmlOnly ? "artifact" : mixed ? "designs and artifact" : "designs"}:\n\n${lines.join("\n")}\n\n${comments.some((comment) => comment.id) ? `${revise}${RESOLVE_SUFFIX}` : revise}`,
    );
  }
  return parts.join("\n\n");
}

/** Preserve the person's feedback in history when design cards are unavailable. */
export function designFeedbackText({ choice, comments }: { choice?: ArtifactRef | null; comments: DesignComment[] }): string {
  const parts: string[] = [];
  if (choice) parts.push(`Chose ${choice.title} (version ${choice.version}).`);
  for (const comment of comments)
    parts.push(`${comment.design.title}${comment.design.format === "html" ? "" : ` (version ${comment.design.version})`}: ${comment.text}`);
  return parts.join("\n\n");
}

const REVISE = "Read the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id.";
const REVISE_ARTIFACT = "Read the current page with artifact_read, then update it in place with artifact_show. Keep one Artifact page for this Chat.";
const REVISE_MIXED = `${REVISE} ${REVISE_ARTIFACT}`;
const RESOLVE_SUFFIX = " Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.";
const RESOLVE = `${REVISE}${RESOLVE_SUFFIX}`;
// Historical messages remain readable; these instructions are never emitted for new feedback.
const LEGACY_REVISE = "Revise them with artifact_show and keep their ids.";
const LEGACY_REVISE_LAYERS =
  "Read the latest editable design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id. Use artifact_read and artifact_show for HTML designs.";
const FEEDBACK_ENDINGS = new Set([
  REVISE,
  RESOLVE,
  REVISE_ARTIFACT,
  REVISE_MIXED,
  `${REVISE_ARTIFACT}${RESOLVE_SUFFIX}`,
  `${REVISE_MIXED}${RESOLVE_SUFFIX}`,
  LEGACY_REVISE,
  LEGACY_REVISE_LAYERS,
  ...[LEGACY_REVISE, LEGACY_REVISE_LAYERS].map(
    (text) => `${text} Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.`,
  ),
]);
const COMMENT =
  /^(\d+)\. (?:\(comment ([a-f0-9]{8})\) )?On the design "(.*)" \(([a-z0-9-]+), version (\d+)\)(?:, (\d+)% across and (\d+)% down)?(?:, layer "([a-zA-Z][a-zA-Z0-9_.-]{0,95})")?: (.*)$/;
const ARTIFACT_COMMENT =
  /^(\d+)\. (?:\(comment ([a-f0-9]{8})\) )?On the artifact "(.*)" \(([a-z0-9-]+)\)(?:, (\d+)% across and (\d+)% down)?(?:, on the tab ([a-z0-9-]+) \("([^"]*)"\))?(?:, near "([^"]*)")?: (.*)$/;

/**
 * The feedback a message designFeedbackMessage wrote carries, read back to show it as a card instead of its text; null
 * for any other message. Only the exact shape it writes reads back, so a message the user typed stays text.
 */
export function parseDesignFeedback(body: string): { choice: ArtifactRef | null; comments: DesignComment[] } | null {
  const blocks = body.split("\n\n");
  let choice: ArtifactRef | null = null;
  const chose = /^I chose the design "(.*)" \(([a-z0-9-]+), version (\d+)\)\. Continue from this one\.$/.exec(blocks[0] ?? "");
  if (chose) {
    choice = { title: chose[1]!, id: chose[2]!, version: Number(chose[3]) };
    blocks.shift();
  }
  if (!blocks.length) return choice ? { choice, comments: [] } : null;
  const [heading, list, closing, ...rest] = blocks;
  if (rest.length || !/^(A comment|Comments) on the (designs|artifact|designs and artifact):$/.test(heading ?? "") || !FEEDBACK_ENDINGS.has(closing ?? ""))
    return null;
  const comments: DesignComment[] = [];
  for (const line of (list ?? "").split("\n")) {
    const artifact = ARTIFACT_COMMENT.exec(line);
    if (artifact) {
      const [, , commentId, title, id, x, y, tabId, tabTitle, near, text] = artifact;
      comments.push({
        design: { id: id!, title: title!, version: 1, format: "html" },
        text: text!,
        ...(commentId ? { id: commentId } : {}),
        ...(x === undefined || y === undefined ? {} : { x: Number(x) / 100, y: Number(y) / 100 }),
        ...(tabId ? { tab: { id: tabId, title: tabTitle! } } : {}),
        ...(near ? { near } : {}),
      });
      continue;
    }
    const match = COMMENT.exec(line);
    if (!match) return null;
    const [, , commentId, title, id, version, x, y, nodeId, text] = match;
    comments.push({
      design: { id: id!, version: Number(version), title: title! },
      ...(x === undefined || y === undefined ? {} : { x: Number(x) / 100, y: Number(y) / 100 }),
      text: text!,
      ...(commentId ? { id: commentId } : {}),
      ...(nodeId ? { nodeId } : {}),
    });
  }
  return { choice, comments };
}

/** The design the user last chose in these messages, read back from the message designFeedbackMessage wrote. */
export function chosenDesign(bodies: string[]): { id: string; version: number } | null {
  for (const body of bodies.toReversed()) {
    const [, id, version] = CHOICE.exec(body) ?? [];
    if (id && version) return { id, version: Number(version) };
  }
  return null;
}

export {
  ARTIFACT_CSP,
  ARTIFACT_ESCAPE,
  ARTIFACT_SEND,
  artifactCsp,
  ARTIFACT_ESCAPE_SCRIPT,
  ARTIFACT_PAGE,
  ARTIFACT_PAGE_SCRIPT,
  ARTIFACT_SHELL_SCRIPT,
  DESIGNS_CANVAS_SCRIPT,
  artifactDocument,
  artifactShell,
  designsCanvasShell,
  hasDiagrams,
} from "./artifact-document.mjs";

/** The step the transcript shows for the agent resolving a design comment (core's agents/steps.cjs names it). */
export const RESOLVED_STEP = "Resolved a design comment";

/** The agent's notes on the comments it resolved, by comment id. */
export function resolutionNotes(comments: ArtifactComment[]): Map<string, string> {
  return new Map(comments.flatMap((comment) => (comment.resolved ? [[comment.id, comment.resolved.note] as const] : [])));
}

/**
 * Changes when the Chat's design comments may have: a comment resolved (its step done) or feedback sent. Resolutions
 * are read again only then, not on every step or message.
 */
export function designActivity(steps: { title: string; status?: string }[], userBodies: string[]): number {
  return steps.filter((step) => step.title === RESOLVED_STEP && step.status === "done").length + userBodies.filter((body) => parseDesignFeedback(body)).length;
}

/** A pin an Artifact page draws (ARTIFACT_PAGE_SCRIPT): its key, its spot, the number on it and its colours. */
export type PagePin = { k: string; x: number; y: number; a?: string; n: number | string; fill: string; ink: string; label: string; hide?: boolean };

/** What an Artifact page's helper tells its viewer (ARTIFACT_PAGE_SCRIPT); screen points are in the page's pixels. */
export type ArtifactPageMessage =
  | { t: "ready" }
  | { t: "size"; sw: number; cw: number }
  | { t: "press"; x: number; y: number; a: string; near: string; sx: number; sy: number }
  | { t: "pin"; k: string; sx: number; sy: number }
  | { t: "anchor"; k: string; sx: number; sy: number; shown: boolean }
  | { t: "zoom"; dy: number; cx: number; cy: number }
  | { t: "fit" }
  | { t: "key"; key: string };

/**
 * A message from an Artifact page's helper, by its shape, or null. The page runs the agent's code too, so anything
 * else it posts (or a message that only looks like the helper's) gets no further than this.
 */
export function readPageMessage(data: unknown): ArtifactPageMessage | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const number = (key: string) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : null);
  const text = (key: string, limit = 600) => (typeof value[key] === "string" ? (value[key] as string).slice(0, limit) : null);
  const unit = (key: string) => {
    const found = number(key);
    return found === null ? null : Math.min(1, Math.max(0, found));
  };
  switch (value.t) {
    case "ready":
    case "fit":
      return { t: value.t };
    case "size": {
      const sw = number("sw"),
        cw = number("cw");
      return sw === null || cw === null ? null : { t: "size", sw, cw };
    }
    case "press": {
      const x = unit("x"),
        y = unit("y"),
        sx = number("sx"),
        sy = number("sy");
      if (x === null || y === null || sx === null || sy === null) return null;
      return { t: "press", x, y, a: text("a") ?? "", near: nearText(text("near")), sx, sy };
    }
    case "pin":
    case "anchor": {
      const k = text("k", 64),
        sx = number("sx"),
        sy = number("sy");
      if (!k || sx === null || sy === null) return null;
      return value.t === "pin" ? { t: "pin", k, sx, sy } : { t: "anchor", k, sx, sy, shown: value.shown !== false };
    }
    case "zoom": {
      const dy = number("dy"),
        cx = number("cx"),
        cy = number("cy");
      return dy === null || cx === null || cy === null ? null : { t: "zoom", dy, cx, cy };
    }
    case "key": {
      const key = text("key", 8);
      return key ? { t: "key", key } : null;
    }
  }
  return null;
}

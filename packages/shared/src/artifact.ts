import type { ArtifactRef } from "./model.ts";
import type { DesignDocument } from "./design.mjs";
import type { ArtifactAsset } from "./artifact-assets.mjs";
import { ago } from "./main-sync.ts";
import { projectOfKey, sessionIdFromKey } from "./agent-runs.mjs";
import { formatImageMention } from "./prompt-parts.mjs";
export { createDesignFontReader, restoreDesignFonts } from "./design-font-cache.mjs";

export type { ArtifactAsset };

export type ArtifactSummary = ArtifactRef & {
  versions: number;
  width: number;
  height: number;
  format: "design" | "html";
  interactive?: boolean;
  /** The design system version the screen is drawn with: its latest, unless `kitFrozen` keeps the one it was saved on. */
  kit?: { id: string; version: number; title: string };
  kitFrozen?: boolean;
  /** The screen's saved version is on `from` and is drawn on the design system's newer `to`. */
  kitFollowed?: { from: number; to: number; local?: string[]; layout?: string[] };
  /** The design system's `version` removed something the screen uses, so it stays drawn on the version it was saved on. */
  kitBroken?: { version: number; message: string };
  consistency?: { mode: "advisory" | "strict" };
  /** On a Project library design: who saved each version kept. */
  edits?: DesignLibraryEdit[];
};

/** What a shared page with designs draws instead of the fonts and symbols licensed for local previews only. */
export const DESIGN_PAGE_FONT_NOTE = "Apple's SF fonts, New York and SF Symbols show as Inter, Source Serif and Lucide icons on the shared page.";

export const isInteractiveDesign = (design: { format?: string; interactive?: boolean } | null | undefined): boolean =>
  design?.format === "design" && design.interactive === true;

export function designKitLabel(design: Pick<ArtifactSummary, "kit" | "kitFrozen" | "kitBroken" | "consistency"> | null | undefined): string {
  if (!design?.kit) return "";
  const state = design.kitFrozen ? " · frozen" : design.kitBroken ? ` · can't follow v${design.kitBroken.version}` : "";
  return `${design.consistency?.mode === "strict" ? "Strict · " : ""}${design.kit.title} · kit v${design.kit.version}${state}`;
}

/** Whether a loaded screen already shows design system version `kitVersion`: drawn on it, or found unable to follow it. */
export const designShowsKit = (design: Pick<ArtifactSummary, "kit" | "kitBroken">, kitVersion: number | undefined): boolean =>
  design.kit?.version === kitVersion || design.kitBroken?.version === kitVersion;

export type LayerDesignArtifact = ArtifactSummary & {
  format: "design";
  interactive?: false;
  latest: number;
  html: string;
  document: DesignDocument;
  /** Opt-in transport: HTML omits this block; fontCss is absent when the caller already holds fontKey. */
  fontKey?: string;
  fontCss?: string;
};
export type InteractiveDesignArtifact = ArtifactSummary & {
  format: "design";
  interactive: true;
  latest: number;
  html: string;
  document?: never;
  fontKey?: never;
  fontCss?: never;
};
export type DesignArtifact = LayerDesignArtifact | InteractiveDesignArtifact;
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
/**
 * What a published page holds. `workspace` is the Artifact panel's Share: every design and the HTML page. `design` is
 * one design (`designId`), `selection` the designs the user picked on the canvas (`designIds`, in that order), shown
 * one at a time as a presentation, `artifacts` the HTML page alone. `designs` (every design, no page) is only for links
 * made before workspaces; it is never created again.
 */
export type ArtifactPageKind = "workspace" | "design" | "selection" | "designs" | "artifacts";
export type PageShareScope = { kind?: ArtifactPageKind; designId?: string; designIds?: string[] };
/** The most designs one `selection` link presents. */
export const MAX_SHARED_SELECTION = 100;

export interface DesignPageShare {
  kind?: ArtifactPageKind;
  /** For `kind: "design"`: the design the link shows. */
  designId?: string;
  /** For `kind: "selection"`: the designs the link presents, in order. */
  designIds?: string[];
  id: string;
  url: string;
  title: string;
  createdAt: number;
  /** When the page behind the link was last replaced; absent until the first update. */
  updatedAt?: number;
  designCount: number;
  /** The link follows the agent's saves: each one republishes it a few seconds later. Links without it are frozen
   * snapshots and never change on their own. */
  live?: boolean;
  /** A live link whose updates the owner paused. Resuming publishes the current state at once. */
  paused?: boolean;
  /** A live link has saves it has not published yet (offline, or the last attempt failed). It keeps retrying. */
  stale?: boolean;
  /** Why the last automatic update failed, while `stale`. */
  lastError?: string;
  revoked?: boolean;
  /** The upload was never confirmed. Sharing again retries the same link. */
  pending?: boolean;
  /** Set by sharePage: older links of this page that could not be revoked yet. They stay public, are listed in
   * Published pages, and the next share retries them. */
  olderLinks?: number;
}

export interface ArtifactApi {
  sharingStatus(request?: PageShareScope & { chatId?: string }): Promise<{ available: boolean; reason?: string }>;
  allPageShares(): Promise<DesignPageShare[]>;
  revokeSavedPageShare(request: { id: string }): Promise<void>;
  /** The scope's current link, or none: at most one entry. */
  pageShares(request: { chatId: string } & PageShareScope): Promise<DesignPageShare[]>;
  /** Publishes the scope now, under its current link when it has one; a new link is live. The page is named after its
   * Chat on the host; `title` only satisfies hosts from before that, which require one. */
  sharePage(request: { chatId: string; title?: string; acknowledgePublic: true } & PageShareScope): Promise<DesignPageShare>;
  /** Pauses or resumes a live link's automatic updates. Resuming publishes the current state at once. */
  setPageSharePaused(request: { chatId: string; id: string; paused: boolean }): Promise<DesignPageShare>;
  revokePageShare(request: { chatId: string; id: string } & PageShareScope): Promise<void>;
  /** A Chat's design, or a Project library design (`library:<id>`) by the Chat or the Project's path. */
  get(request: DesignScope & { id: string; version?: number; fonts?: { have: string[] } }): Promise<Artifact>;
  /** Part of a file of the Chat's Artifact page, by its name; `length` caps the bytes (256 KB at most). */
  asset(request: { chatId: string; name: string; offset?: number; length?: number }): Promise<ArtifactAssetChunk>;
  list(request: { chatId: string; format?: "design" | "html" }): Promise<ArtifactSummary[]>;
  /** Deletes a design with every version and the comments on it. Its id is never reused. */
  delete(request: DesignScope & { id: string }): Promise<{ id: string }>;
  /** Records comments the user is sending; returns them with their ids. */
  addComments(request: { chatId: string; comments: DesignComment[] }): Promise<ArtifactComment[]>;
  comments(request: { chatId: string }): Promise<ArtifactComment[]>;
  /** The design library of the Chat's Project, or of the Project at `projectPath`: its pages and the latest version of each design on them. */
  library(request: DesignScope): Promise<DesignLibrary>;
  /** Every Chat of the Project (a Named Link's own Chats for a Link) that has designs, archived ones last. */
  libraryChats(request: DesignScope): Promise<DesignLibraryChat[]>;
  /** The design system the Project's screens follow, drawn as one board, and its decision log, newest first. */
  designSystem(request: DesignScope): Promise<DesignSystemView>;
  /** Copies one of the Chat's designs, or its HTML page (one `tab`), onto the library page named `page`; a new name makes it. */
  addToLibrary(request: { chatId: string; designId: string; page: string; tab?: string }): Promise<DesignLibraryEntry>;
  /** Renames a library design (a new version), moves it to the page named `page` (a new name makes it), or both. */
  updateLibraryDesign(request: DesignScope & { id: string; title?: string; page?: string }): Promise<DesignLibraryEntry>;
  /** Renames a library page; `page` is its id or current name. */
  renameLibraryPage(request: DesignScope & { page: string; name: string }): Promise<{ id: string; name: string }>;
  /** The Project's library changed, or with `kit`, its design system, which every screen on it follows. */
  onLibraryChanged(callback: (payload: { projectPath: string; kit?: boolean }) => void): () => void;
}

export type DesignLibraryChat = { chatId: string; title: string; archived: boolean; designs: ArtifactSummary[] };
export type DesignDecision = { version: number; title: string; savedAt?: number; decision?: { summary: string; reason?: string } };
/**
 * A Project's design system for its Designs page: none yet, frozen (its Named Link's chosen Project left the Link), or
 * ready with its boards as SVG (drawn with the platform's own fonts) and its decision log, newest first. `owner` is the
 * member Project's path when the scope is a Named Link.
 */
export type DesignSystemView =
  | { state: "none"; owner?: string }
  | { state: "frozen" }
  | {
      state: "ready";
      kit: { id: string; version: number; title: string };
      history: DesignDecision[];
      /** The board, split into as many as the screen limit needs. */
      boards: { svg: string; width: number; height: number }[];
      owner?: string;
    };

/** Whose designs: a Chat's, or, for Project library designs, the Project's own by its path. */
export type DesignScope = { chatId: string } | { projectPath: string };

const isChatKey = (key: string) => Number.isSafeInteger(sessionIdFromKey(key));
/** The scope a canvas key names: a Chat's key, or a Project's key on its Design library page. */
export const designScope = (key: string): DesignScope => (isChatKey(key) ? { chatId: key } : { projectPath: key });
/** The Project whose library a Chat or Project key reads. */
export const libraryProject = (key: string) => (isChatKey(key) ? projectOfKey(key) : key);

/** One saved version of a Project library design: the Chat that saved it, that Chat's title and its agent then. No
 * `chatId` when it was saved from the Design library page itself. */
export type DesignLibraryEdit = { version: number; chatId?: string; chat?: string; agent?: string; at: number };
/** A design in the Project library. `id` is `library:<id>`, its address for `get`, `delete` and the agents' design tools. */
/** `from` is the Chat design it was first added from, when it came from a Chat. */
export type DesignLibraryEntry = ArtifactSummary & { page: string; edits: DesignLibraryEdit[]; from?: { chatId: string; id: string } };
/** A named page of the library ("iPhone", "Kit"), the designs on it in the order they were added. */
export type DesignLibraryPage = { id: string; name: string; designs: DesignLibraryEntry[] };
export type DesignLibrary = { pages: DesignLibraryPage[] };
/** Who saved the version shown, for a library frame's caption: "Edited in Login flow · Codex", or "Edited here" when
 * `chatId` (the open Chat) saved it. */
export function libraryEditLabel(design: Pick<ArtifactSummary, "edits"> | null | undefined, version?: number, chatId?: string | null): string {
  const edit = design?.edits?.findLast((item) => version === undefined || item.version === version);
  if (!edit) return "";
  if (!edit.chatId) return "Edited in Designs";
  const where = chatId && edit.chatId === chatId ? "Edited here" : `Edited in ${edit.chat ?? "another Chat"}`;
  return [where, edit.agent].filter(Boolean).join(" · ");
}

/** A library design's card caption on the Design library page: "v3 · Edited in Login flow · Codex · 2 h ago". */
export function libraryCardLine(design: Pick<DesignLibraryEntry, "version" | "edits">, now: number): string {
  const edit = design.edits.findLast((item) => item.version === design.version) ?? design.edits.at(-1);
  return [`v${design.version}`, libraryEditLabel(design, edit?.version), edit ? ago(edit.at, now) : ""].filter(Boolean).join(" · ");
}

/** A Recent edits row's caption on the Design library page: "Codex in Login flow · 2 h ago", "Designs · just now". */
export function libraryRecentLine(design: Pick<DesignLibraryEntry, "edits">, now: number): string {
  const edit = design.edits.at(-1);
  if (!edit) return "";
  const who = !edit.chatId ? "Designs" : edit.agent && edit.chat ? `${edit.agent} in ${edit.chat}` : (edit.agent ?? edit.chat ?? "Another Chat");
  return `${who} · ${ago(edit.at, now)}`;
}

/** The library's designs by their last edit, newest first, at most `limit`, with the page each is on: the Design library page's Recent edits. */
export function libraryRecent(library: DesignLibrary | null | undefined, limit: number): { design: DesignLibraryEntry; page: DesignLibraryPage }[] {
  const at = (design: DesignLibraryEntry) => design.edits.at(-1)?.at ?? 0;
  return (library?.pages ?? [])
    .flatMap((page) => page.designs.filter((design) => design.edits.length).map((design) => ({ design, page })))
    .sort((a, b) => at(b.design) - at(a.design))
    .slice(0, limit);
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
  /** The images attached to it: their numbers among the message's images, from 1. */
  images?: number[];
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

export type ArtifactComment = DesignComment & { id: string; createdAt: number; resolved?: { note: string; at: number } };

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
      const said = [comment.text.trim(), ...(comment.images ?? []).map(formatImageMention)].filter(Boolean).join(" ");
      return `${index + 1}. ${comment.id ? `(comment ${comment.id}) ` : ""}On ${designName(comment.design)}${at}${layer}${tab}${near}: ${said}`;
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

function withImages(said: string): { text: string; images?: number[] } {
  const [, text = said, tokens] = /^(.*?)((?:\s*\[Image #\d+\])+)$/.exec(said) ?? [];
  const images = tokens ? [...tokens.matchAll(/\[Image #(\d+)\]/g)].map((token) => Number(token[1])) : [];
  return images.length ? { text, images } : { text };
}

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
      const [, , commentId, title, id, x, y, tabId, tabTitle, near, said] = artifact;
      comments.push({
        design: { id: id!, title: title!, version: 1, format: "html" },
        ...withImages(said!),
        ...(commentId ? { id: commentId } : {}),
        ...(x === undefined || y === undefined ? {} : { x: Number(x) / 100, y: Number(y) / 100 }),
        ...(tabId ? { tab: { id: tabId, title: tabTitle! } } : {}),
        ...(near ? { near } : {}),
      });
      continue;
    }
    const match = COMMENT.exec(line);
    if (!match) return null;
    const [, , commentId, title, id, version, x, y, nodeId, said] = match;
    comments.push({
      design: { id: id!, version: Number(version), title: title! },
      ...(x === undefined || y === undefined ? {} : { x: Number(x) / 100, y: Number(y) / 100 }),
      ...withImages(said!),
      ...(commentId ? { id: commentId } : {}),
      ...(nodeId ? { nodeId } : {}),
    });
  }
  return { choice, comments };
}

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
  DESIGN_CODE_CSP,
  artifactDocument,
  artifactShell,
  designsCanvasShell,
  hasDiagrams,
} from "./artifact-document.mjs";

export const RESOLVED_STEP = "Resolved a design comment";

export function resolutionNotes(comments: ArtifactComment[]): Map<string, string> {
  return new Map(comments.flatMap((comment) => (comment.resolved ? [[comment.id, comment.resolved.note] as const] : [])));
}

export function designActivity(steps: { title: string; status?: string }[], userBodies: string[]): number {
  return steps.filter((step) => step.title === RESOLVED_STEP && step.status === "done").length + userBodies.filter((body) => parseDesignFeedback(body)).length;
}

export type PagePin = { k: string; x: number; y: number; a?: string; n: number | string; fill: string; ink: string; label: string; hide?: boolean };

/** What an Artifact page's helper tells its viewer (ARTIFACT_PAGE_SCRIPT); screen points are in the page's pixels. */
export type ArtifactPageMessage =
  | { t: "ready" }
  | { t: "download"; href: string; name: string }
  | { t: "size"; sw: number; cw: number }
  | { t: "press"; x: number; y: number; a: string; near: string; sx: number; sy: number }
  | { t: "pin"; k: string; sx: number; sy: number }
  | { t: "anchor"; k: string; sx: number; sy: number; shown: boolean }
  | { t: "zoom"; dy: number; cx: number; cy: number }
  | { t: "fit" }
  | { t: "key"; key: string };

/** Resolve a download against the current page's manifest, including links built after the viewer rewrote its HTML. */
export function artifactDownload(
  assets: ArtifactAsset[] | undefined,
  message: Extract<ArtifactPageMessage, { t: "download" }>,
  urlFor: (asset: ArtifactAsset) => string | undefined,
) {
  const asset = assets?.find((item) => message.href === `assets/${item.name}` || message.href === `./assets/${item.name}` || message.href === urlFor(item));
  if (!asset) return null;
  const name = message.name.trim();
  return { asset, name: name && !/^[.]|[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name) ? name : asset.name };
}

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
    case "download": {
      const href = text("href");
      return href ? { t: "download", href, name: text("name", 255) ?? "" } : null;
    }
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

/** The Designs page's words, the same on desktop and phone. */
export const DESIGNS_COPY = {
  title: "Designs",
  designSystem: "Design system",
  chats: "Chats",
  archived: "Archived",
  decisions: "Decisions",
  noSystemTitle: "No design system yet",
  noSystemBody: "Ask an agent in a Chat to create one from this Project's code, its DESIGN.md or a design system you name. Every screen then follows it.",
  failed: "Couldn't load the design system.",
  frozenTitle: "This Link's screens are frozen.",
  frozenBody: "Its design system Project left the Link.",
  chooseProject: "Choose a Project",
  frozenHint: "Choose another member in the Link's settings.",
  noChatsTitle: "No designs in this Project's Chats yet",
  noChatsBody: "Designs an agent draws in any Chat show here.",
  noMatch: (query: string) => `No designs match "${query}"`,
  addToLibrary: "Add to library",
  inLibrary: (page: string) => `In ${page}`,
  openChat: "Open Chat",
} as const;

/** A decision log row: what changed, or that nothing was recorded for that version. */
export const designDecisionSummary = (entry: DesignDecision): string => entry.decision?.summary ?? "No decision recorded";

/** A decision log row's caption: "v7 · 2 h ago". */
export const designDecisionLine = (entry: DesignDecision, now: number): string =>
  [`v${entry.version}`, entry.savedAt ? ago(entry.savedAt, now) : ""].filter(Boolean).join(" · ");

/** Which library page each Chat design is already on, by `<chatId>\n<design id>`. */
export function libraryPagesBySource(library: DesignLibrary | null | undefined): Map<string, string> {
  const pages = new Map<string, string>();
  for (const page of library?.pages ?? []) for (const design of page.designs) if (design.from) pages.set(`${design.from.chatId}\n${design.from.id}`, page.name);
  return pages;
}

/** The Designs page's Chats narrowed to the designs whose title, or whose Chat's title, holds `query`. */
export function filterDesignChats(chats: DesignLibraryChat[], query: string): DesignLibraryChat[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return chats;
  return chats
    .map((chat) =>
      chat.title.toLowerCase().includes(needle) ? chat : { ...chat, designs: chat.designs.filter((design) => design.title.toLowerCase().includes(needle)) },
    )
    .filter((chat) => chat.designs.length);
}

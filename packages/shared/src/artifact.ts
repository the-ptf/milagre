import type { ArtifactRef } from "./model.ts";
import type { DesignDocument, DesignOperation } from "./design.mjs";

/** A design as `artifact:list` returns it: its newest version, and the screen it is laid out on. */
export type ArtifactSummary = ArtifactRef & { versions: number; width: number; height: number; format: "design" };

/** One version of a design an agent showed, as `artifact:get` returns it. */
export type Artifact = ArtifactSummary & { latest: number; html: string; document: DesignDocument };

export interface DesignPageShare {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  designCount: number;
  revoked?: boolean;
  pending?: boolean;
}

export interface ArtifactApi {
  sharingStatus(): Promise<{ available: boolean; reason?: string }>;
  allPageShares(): Promise<DesignPageShare[]>;
  revokeSavedPageShare(request: { id: string }): Promise<void>;
  pageShares(request: { chatId: string }): Promise<DesignPageShare[]>;
  sharePage(request: { chatId: string; title: string; acknowledgePublic: true }): Promise<DesignPageShare>;
  revokePageShare(request: { chatId: string; id: string }): Promise<void>;
  get(request: { chatId: string; id: string; version?: number }): Promise<Artifact>;
  list(request: { chatId: string }): Promise<ArtifactSummary[]>;
  /** Saves an atomic batch against the version the editor loaded. A stale version leaves the design unchanged. */
  apply(request: { chatId: string; id: string; expectedVersion: number; operations: DesignOperation[] }): Promise<Artifact>;
  /** Records comments the user is sending; returns them with their ids. */
  addComments(request: { chatId: string; comments: DesignComment[] }): Promise<ArtifactComment[]>;
  comments(request: { chatId: string }): Promise<ArtifactComment[]>;
}

/** A comment on a design: where on it (fractions of its screen) when it was pinned, and what the user wrote. */
export type DesignComment = { design: ArtifactRef; x?: number; y?: number; nodeId?: string; text: string; id?: string };

/**
 * A new comment's id, named by the app so the message that carries it can be sent before the host records it: a send
 * that fails then leaves nothing recorded, and the host keeps a comment it is given twice once.
 */
export const newCommentId = () => Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/** A comment as the host keeps it: with its id, and, once the agent has addressed it, its note on what it did. */
export type ArtifactComment = DesignComment & { id: string; createdAt: number; resolved?: { note: string; at: number } };

// Plain text: the message shows in the user's bubble as typed, without markdown.
const designName = (design: ArtifactRef) => `the design "${design.title}" (${design.id}, version ${design.version})`;

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
      // The id lets the agent resolve the comment; a message from before ids has none.
      return `${index + 1}. ${comment.id ? `(comment ${comment.id}) ` : ""}On ${designName(comment.design)}${at}${layer}: ${comment.text.trim()}`;
    });
    parts.push(
      `${comments.length === 1 ? "A comment" : "Comments"} on the designs:\n\n${lines.join("\n")}\n\n${comments.some((comment) => comment.id) ? RESOLVE : REVISE}`,
    );
  }
  return parts.join("\n\n");
}

/** Preserve the person's feedback in history when design cards are unavailable. */
export function designFeedbackText({ choice, comments }: { choice?: ArtifactRef | null; comments: DesignComment[] }): string {
  const parts: string[] = [];
  if (choice) parts.push(`Chose ${choice.title} (version ${choice.version}).`);
  for (const comment of comments) parts.push(`${comment.design.title} (version ${comment.design.version}): ${comment.text}`);
  return parts.join("\n\n");
}

const REVISE = "Read the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id.";
const RESOLVE = `${REVISE} Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.`;
// Historical messages remain readable; these instructions are never emitted for new feedback.
const LEGACY_REVISE = "Revise them with artifact_show and keep their ids.";
const LEGACY_REVISE_LAYERS =
  "Read the latest editable design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id. Use artifact_read and artifact_show for HTML designs.";
const FEEDBACK_ENDINGS = [
  REVISE,
  RESOLVE,
  LEGACY_REVISE,
  LEGACY_REVISE_LAYERS,
  ...[LEGACY_REVISE, LEGACY_REVISE_LAYERS].map(
    (text) => `${text} Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.`,
  ),
];
const COMMENT =
  /^(\d+)\. (?:\(comment ([a-f0-9]{8})\) )?On the design "(.*)" \(([a-z0-9-]+), version (\d+)\)(?:, (\d+)% across and (\d+)% down)?(?:, layer "([a-zA-Z][a-zA-Z0-9_.-]{0,95})")?: (.*)$/;

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
  if (rest.length || !/^(A comment|Comments) on the designs:$/.test(heading ?? "") || !FEEDBACK_ENDINGS.includes(closing ?? "")) return null;
  const comments: DesignComment[] = [];
  for (const line of (list ?? "").split("\n")) {
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
  for (const body of [...bodies].reverse()) {
    const [, id, version] = CHOICE.exec(body) ?? [];
    if (id && version) return { id, version: Number(version) };
  }
  return null;
}

/**
 * Generated previews need inline interaction code and image resources. Remote scripts and evaluation are blocked.
 * The desktop also sandboxes each preview in an iframe with no same origin.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The design's HTML with the policy as the first thing the parser meets after the doctype, before anything the design
 * wrote: searching for its <head> could land inside a comment or a script string and leave the design without one. A
 * <meta> ahead of <html> still goes into the head, and applies to everything after it.
 */
export function artifactDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  // Leading comments and whitespace, then the doctype; without one the design gets standards mode.
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  // A bare fragment (no <html> of its own) also gets the charset and a phone-sized viewport a page would set.
  const page = /<html[\s>]/i.test(html) ? "" : '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  return `${doctype ? html.slice(0, at) : "<!doctype html>"}${policy}${page}${ESCAPE_OUT}${html.slice(at)}`;
}

/** What a design posts its embedder when Escape is pressed in it: a key the design has the focus for is the design's. */
export const ARTIFACT_ESCAPE = "milagre:artifact-escape";
// Escape with the focus in a design still leaves it, then closes the canvas, as it does outside: the design tells its
// embedder. Captured first, so a design that stops the key's propagation still lets go of it.
export const ARTIFACT_ESCAPE_SCRIPT = `addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage("${ARTIFACT_ESCAPE}","*")},true)`;
const ESCAPE_OUT = `<script>${ARTIFACT_ESCAPE_SCRIPT}</script>`;

/** Escapes text for an HTML attribute value in double quotes. */
const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * A page that shows the design in a sandboxed frame, for a web view with no sandbox of its own (the phone's). The
 * frame runs the design's scripts but has no same origin and no say over the page around it, so it can't navigate
 * it. The frame inherits the page's policy, so the page carries the design's (the page itself has no script), plus
 * frame-src 'none': the frame loads nothing but the design, so the design can't navigate it away either. With an
 * opaque origin, the design can't read the files beside the page, whatever the web view lets the page itself read.
 */
export function artifactShell(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}; frame-src 'none'"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(artifactDocument(html))}"></iframe></body></html>`;
}

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

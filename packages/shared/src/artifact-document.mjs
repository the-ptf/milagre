// Preview documents for designs and artifacts. Plain JavaScript: the packaged Electron main process loads it from
// node_modules, where Node does not strip TypeScript types.
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
export function artifactDocument(html) {
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
const attribute = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * A page that shows the design in a sandboxed frame, for a web view with no sandbox of its own (the phone's). The
 * frame runs the design's scripts but has no same origin and no say over the page around it, so it can't navigate
 * it. The frame inherits the page's policy, so the page carries the design's (the page itself has no script), plus
 * frame-src 'none': the frame loads nothing but the design, so the design can't navigate it away either. With an
 * opaque origin, the design can't read the files beside the page, whatever the web view lets the page itself read.
 */
export function artifactShell(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}; frame-src 'none'"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(artifactDocument(html))}"></iframe></body></html>`;
}

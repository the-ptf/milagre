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
/** ⌘Enter (Ctrl+Enter) pressed in an artifact or design, which keeps the key: the page beneath sends the feedback waiting. */
export const ARTIFACT_SEND = "milagre:artifact-send";
// Escape with the focus in a design still leaves it, then closes the canvas, as it does outside: the design tells its
// embedder, and so does ⌘Enter, which sends the feedback. Captured first, so a design that stops the key's
// propagation still lets go of it.
export const ARTIFACT_ESCAPE_SCRIPT = `addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage("${ARTIFACT_ESCAPE}","*");else if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))parent.postMessage("${ARTIFACT_SEND}","*")},true)`;
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

/**
 * The phone's canvas for a design: drag to pan (with a glide on release), pinch to zoom, double-tap to fit or zoom in.
 * A third finger is ignored; reduced motion drops the glide and the animated zoom. Fixed text, so the page's policy can
 * allow it by hash and nothing else; the board's size comes from its attributes.
 */
export const DESIGN_CANVAS_SCRIPT = `(function(){
var port=document.getElementById("port"),board=document.getElementById("board");
var W=+board.getAttribute("data-width"),H=+board.getAttribute("data-height"),EDGE=48,still=matchMedia("(prefers-reduced-motion: reduce)");
var x=0,y=0,s=1,moved=false,glide=0,points=new Map(),track=[],down=null,lastTap=null;
function fit(){return Math.max(.01,Math.min((port.clientWidth-32)/W,(port.clientHeight-32)/H))}
function paint(){var w=port.clientWidth,h=port.clientHeight;x=Math.min(w-EDGE,Math.max(EDGE-W*s,x));y=Math.min(h-EDGE,Math.max(EDGE-H*s,y));board.style.transform="translate("+x+"px,"+y+"px) scale("+s+")"}
function zoomAt(next,px,py){var f=fit();next=Math.min(Math.max(4,f*2),Math.max(Math.min(f,1)/2,next));x=px-(px-x)*next/s;y=py-(py-y)*next/s;s=next}
function reset(){s=fit();x=(port.clientWidth-W*s)/2;y=(port.clientHeight-H*s)/2}
function animate(change){if(!still.matches)board.style.transition="transform .25s cubic-bezier(.2,.8,.2,1)";change();paint();setTimeout(function(){board.style.transition=""},260)}
function stop(){cancelAnimationFrame(glide);board.style.transition=""}
function fling(at){var a=track[0],b=track[track.length-1];if(still.matches||!a||b.t<=a.t||at-b.t>60)return;var vx=(b.x-a.x)/(b.t-a.t),vy=(b.y-a.y)/(b.t-a.t),prev=performance.now();if(Math.hypot(vx,vy)<.2)return;
function step(now){var dt=Math.min(now-prev,32),k=Math.pow(.996,dt);prev=now;x+=vx*dt;y+=vy*dt;vx*=k;vy*=k;paint();if(Math.hypot(vx,vy)>.03)glide=requestAnimationFrame(step)}glide=requestAnimationFrame(step)}
port.addEventListener("pointerdown",function(e){if(points.size>=2)return;stop();port.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY});track=[];down=points.size===1?{x:e.clientX,y:e.clientY,t:e.timeStamp,far:false}:null});
port.addEventListener("pointermove",function(e){var old=points.get(e.pointerId);if(!old)return;
if(points.size===1){x+=e.clientX-old.x;y+=e.clientY-old.y;track.push({x:e.clientX,y:e.clientY,t:e.timeStamp});if(track.length>5)track.shift()}
else{var other=null;points.forEach(function(p,id){if(id!==e.pointerId)other=p});var before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y);if(before>0)zoomAt(s*after/before,(old.x+other.x)/2,(old.y+other.y)/2);x+=(e.clientX-old.x)/2;y+=(e.clientY-old.y)/2}
if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>10)down.far=true;if(!down||down.far)moved=true;points.set(e.pointerId,{x:e.clientX,y:e.clientY});paint()});
function up(e){if(!points.delete(e.pointerId))return;track=points.size?[]:track;if(points.size)return;
if(e.type==="pointerup"&&down&&!down.far&&e.timeStamp-down.t<300){if(lastTap&&e.timeStamp-lastTap.t<300&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<40){lastTap=null;var f=fit(),px=e.clientX,py=e.clientY;moved=true;animate(Math.abs(s/f-1)>.05?reset:function(){zoomAt(Math.max(1,f*2),px,py)})}else lastTap={x:e.clientX,y:e.clientY,t:e.timeStamp}}
else if(e.type==="pointerup")fling(e.timeStamp);down=null}
port.addEventListener("pointerup",up);port.addEventListener("pointercancel",up);port.addEventListener("lostpointercapture",up);
document.addEventListener("gesturestart",function(e){e.preventDefault()});
new ResizeObserver(function(){stop();track=[];if(!moved)reset();paint()}).observe(port);
reset();paint()})()`;
// Hash of DESIGN_CANVAS_SCRIPT; artifact.test.ts checks it.
const DESIGN_CANVAS_HASH = "sha256-NOOMwx6JFeJGTc7CmGU0Coov0JqtPKoSyhoP47n2JTs=";
const CANVAS_BACKGROUND = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;

/**
 * A design on the phone, on a canvas to pan and zoom. As in artifactShell, the design is in a sandboxed frame, here
 * one that can't run scripts at all, and the touches go to the canvas around it. The page runs only the canvas script.
 */
export function designCanvasShell(html, size, background = "#f2f2f2") {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const color = CANVAS_BACKGROUND.test(background) ? background : "#f2f2f2";
  const policy = `${ARTIFACT_CSP.replace("script-src 'unsafe-inline'", `script-src '${DESIGN_CANVAS_HASH}'`)}; frame-src 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;height:100%;overflow:hidden;background:${color}}#port{position:fixed;inset:0;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#board{position:absolute;left:0;top:0;transform-origin:0 0;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.18)}iframe{display:block;border:0;pointer-events:none}</style></head><body><main id="port" aria-label="Design canvas. Pinch to zoom, drag to pan, double-tap to fit."><div id="board" data-width="${width}" data-height="${height}" style="width:${width}px;height:${height}px"><iframe sandbox="" referrerpolicy="no-referrer" width="${width}" height="${height}" style="width:${width}px;height:${height}px" srcdoc="${attribute(artifactDocument(html))}"></iframe></div></main><script>${DESIGN_CANVAS_SCRIPT}</script></body></html>`;
}

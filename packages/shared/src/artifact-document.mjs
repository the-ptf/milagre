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
 * The policy with `assets` (a source, such as the desktop's preview scheme or the phone's file:) also allowed for
 * images, media and fonts: where the viewer keeps the page's files.
 */
export function artifactCsp(assets = "") {
  if (!assets) return ARTIFACT_CSP;
  return ARTIFACT_CSP.replace(/(^|; )(img-src|media-src|font-src) ([^;]*)/g, `$1$2 $3 ${assets}`);
}

/**
 * The design's HTML with the policy as the first thing the parser meets after the doctype, before anything the design
 * wrote: searching for its <head> could land inside a comment or a script string and leave the design without one. A
 * <meta> ahead of <html> still goes into the head, and applies to everything after it.
 *
 * An Artifact page (`page`) also gets ARTIFACT_PAGE_SCRIPT, which its viewer drives for pins, comments and zoom; with
 * `diagrams` (Pele's browser build, pele/global) a page that has Mermaid blocks gets it too, and they render in place.
 * `assets` is the source its files load from (artifactCsp).
 */
export function artifactDocument(html, { page = false, diagrams = "", assets = "" } = {}) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${artifactCsp(assets)}">`;
  // Leading comments and whitespace, then the doctype; without one the design gets standards mode.
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  // A bare fragment (no <html> of its own) also gets the charset and a phone-sized viewport a page would set.
  const bare = /<html[\s>]/i.test(html) ? "" : '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  const pele = diagrams && hasDiagrams(html) ? `<script>${diagrams}</script>` : "";
  const helper = page ? `<script>${ARTIFACT_PAGE_SCRIPT}</script>` : "";
  return `${doctype ? html.slice(0, at) : "<!doctype html>"}${policy}${bare}${ESCAPE_OUT}${pele}${helper}${html.slice(at)}`;
}

/** Whether the HTML has a Mermaid block, the way Mermaid's own pages write one: `<pre class="mermaid">` or a fenced `language-mermaid`. */
export function hasDiagrams(html) {
  return /\sclass\s*=\s*["']?[^"'>]*\b(?:mermaid|language-mermaid)\b/i.test(html);
}

/** The key every message between an Artifact page (ARTIFACT_PAGE_SCRIPT) and its viewer carries, as `milagre`. */
export const ARTIFACT_PAGE = "milagre:artifact-page";

/**
 * The helper inside an Artifact page. It renders the page's Mermaid blocks with Pele when the document carries it,
 * coloured from the page around them unless the page sets --pele-* itself. For the viewer that sends `mode` it also:
 *
 * - draws the pinned comments (`pins`) inside the page, so they scroll with it, each at its anchor (an element path and
 *   a point in its box, which survives the page reflowing) or else at its fractions of the page; `watch` names the
 *   one whose screen position it reports (`anchor`) as the page scrolls or changes;
 * - with the mouse, in comment mode a click pins (`press`: fractions of the page, the anchor, the text near it and the
 *   screen point), ctrl-wheel or a trackpad pinch asks to zoom (`zoom`), a double-click away from text and controls
 *   asks to fit (`fit`), and C outside a field asks to toggle comment mode (`key`);
 * - by touch, a hold pins, and the hold's tap, callout and selection are swallowed;
 * - reports its scroll width against its viewport's (`size`), so a viewer can fit a page wider than itself.
 *
 * `scale` is the viewer's zoom (pins keep their size on screen, and with a point the page keeps it in place);
 * `reveal` scrolls a pin near the top. Pins and the comment cover live in a closed shadow root, out of the page's CSS.
 */
export const ARTIFACT_PAGE_SCRIPT = String.raw`(function(){
if(window.__milagrePage)return;window.__milagrePage=1;
var KEY="${ARTIFACT_PAGE}",d=document,root=d.documentElement,P=null;
var pins=[],watch=null,input="",commenting=false,cursor="",scale=1,host=null,shadow=null,cover=null,nodes=new Map(),frame=0,lastSize="",lastAnchor="",observing=false,hold=0,held=null,swallow=0;
function post(m){m.milagre=KEY;try{parent.postMessage(m,"*")}catch(e){}}
function unit(v){v=+v;return v>0?(v<1?v:1):0}
function later(){if(!frame)frame=requestAnimationFrame(paint)}
function backdrop(el){for(var n=el;n&&n.nodeType===1;n=n.parentElement){var c=getComputedStyle(n).backgroundColor;if(c&&c!=="transparent"&&!/^rgba\(.*,\s*0\)$/.test(c))return c}return "#ffffff"}
function theme(el){var s=getComputedStyle(el);if(!el.__themed){if(s.getPropertyValue("--pele-bg").trim())return;el.__themed=1;el.__font=!s.getPropertyValue("--pele-font").trim()}
var fg=s.color,bg=backdrop(el),mix=function(p){return "color-mix(in srgb, "+fg+" "+p+"%, "+bg+")"},set=function(k,v){el.style.setProperty(k,v)};
set("--pele-bg",bg);set("--pele-fg",fg);set("--pele-line",fg);set("--pele-muted",mix(62));set("--pele-surface",mix(6));set("--pele-surface-alt",mix(11));set("--pele-border",mix(38));if(el.__font)set("--pele-font",s.fontFamily)}
var drawn=[];
function diagrams(){P=window.pele;if(!P||!P.mount)return;var found=d.querySelectorAll("pre.mermaid,div.mermaid,code.language-mermaid");
for(var i=0;i<found.length;i++){var el=found[i],box=el.localName==="code"&&el.parentElement&&el.parentElement.localName==="pre"?el.parentElement:el;if(el.__milagre||box.__milagre)continue;el.__milagre=box.__milagre=1;var text=el.textContent||"";if(!text.trim())continue;
var holder=d.createElement("div"),cs=getComputedStyle(box);holder.className=box===el?el.className:"mermaid";holder.__milagre=1;holder.setAttribute("data-milagre-diagram","");if(box.id)holder.id=box.id;holder.style.marginTop=cs.marginTop;holder.style.marginBottom=cs.marginBottom;box.replaceWith(holder);theme(holder);drawn.push(holder);
try{P.mount(holder,text)}catch(e){holder.textContent=text}}}
function retheme(){for(var i=0;i<drawn.length;i++)if(drawn[i].__themed)theme(drawn[i])}
function size(){var sw=root.scrollWidth,cw=root.clientWidth,key=sw+"x"+cw;if(key!==lastSize){lastSize=key;post({t:"size",sw:sw,cw:cw})}}
function extent(){var b=d.body;return {w:Math.max(root.scrollWidth,b?b.scrollWidth:0)||1,h:Math.max(root.scrollHeight,b?b.scrollHeight:0)||1}}
function find(a){var at=a.lastIndexOf("@");if(at<0)return null;var steps=a.slice(0,at).split("/").filter(Boolean),f=a.slice(at+1).split(","),cur=d.body,i=0;
if(steps[0]&&steps[0].charAt(0)==="#"){cur=d.getElementById(steps[0].slice(1));i=1}
for(;cur&&i<steps.length;i++){var m=/^([A-Za-z][A-Za-z0-9-]*):(\d+)$/.exec(steps[i]);if(!m)return null;var n=+m[2],next=null;for(var c=cur.firstElementChild;c;c=c.nextElementSibling)if(c.localName===m[1]&&--n===0){next=c;break}cur=next}
return cur?{el:cur,fx:unit(f[0]),fy:unit(f[1])}:null}
function spot(p){if(typeof p.a==="string"&&p.a){var hit=find(p.a);if(hit){var r=hit.el.getBoundingClientRect();if(r.width||r.height)return {x:r.left+scrollX+hit.fx*r.width,y:r.top+scrollY+hit.fy*r.height}}}var e=extent();return {x:unit(p.x)*e.w,y:unit(p.y)*e.h}}
function anchor(el,cx,cy){var r=el.getBoundingClientRect();if(!r.width||!r.height)return "";var steps=[],n=el;
while(n&&n!==d.body&&n!==root&&steps.length<40){if(n.id&&/^[A-Za-z][\w-]{0,63}$/.test(n.id)&&d.querySelectorAll("#"+n.id).length===1){steps.unshift("#"+n.id);break}var i=1;for(var s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.localName===n.localName)i++;if(!/^[A-Za-z][A-Za-z0-9-]*$/.test(n.localName))return "";steps.unshift(n.localName+":"+i);n=n.parentElement}
if(!steps.length||(n!==d.body&&steps[0].charAt(0)!=="#"))return "";var k=function(v){return Math.round(unit(v)*1e4)/1e4};return steps.join("/")+"@"+k((cx-r.left)/r.width)+","+k((cy-r.top)/r.height)}
function words(s){return String(s||"").replace(/["\s]+/g," ").trim()}
function near(el){var block=el.closest?el.closest("h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,caption,figcaption,blockquote,label,button,a,summary,[data-id]"):null,t=words(block?block.textContent:"");
if(!t){var own=words(el.textContent);t=own.length<=200?own:""}if(!t&&el.getAttribute)t=words(el.getAttribute("aria-label")||el.getAttribute("alt")||el.getAttribute("title"));
return t.length>80?t.slice(0,79).replace(/\s+\S*$/,"")+"\u2026":t}
function under(cx,cy){if(host)host.style.display="none";var el=d.elementFromPoint(cx,cy);if(host)host.style.display="";return el}
function press(cx,cy){var el=under(cx,cy);if(!el)return;var e=extent(),inner=el!==d.body&&el!==root;post({t:"press",x:unit((cx+scrollX)/e.w),y:unit((cy+scrollY)/e.h),a:inner?anchor(el,cx,cy):"",near:inner?near(el):"",sx:cx,sy:cy})}
function mount(){if(host&&host.isConnected)return;if(!host){host=d.createElement("milagre-pins");host.style.cssText="all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none";shadow=host.attachShadow({mode:"closed"});
shadow.innerHTML='<style>.cover{position:fixed;inset:0;display:none;pointer-events:auto;background:transparent}.pin{position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:24px;height:24px;border-radius:0 12px 12px 12px;font:600 11px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 0 0 1.5px #fff,0 1px 3px rgba(0,0,0,.3);transform-origin:0 0;cursor:pointer;pointer-events:auto;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}</style><div class="cover"></div>';
cover=shadow.querySelector(".cover");cover.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();press(e.clientX,e.clientY)})}root.appendChild(host)}
function tapped(e){e.preventDefault();e.stopPropagation();var r=this.getBoundingClientRect();post({t:"pin",k:this.__k,sx:r.left,sy:r.top})}
function paint(){frame=0;if(!pins.length&&!commenting&&!host)return;mount();cover.style.display=commenting&&input==="mouse"?"block":"none";cover.style.cursor=cursor||"crosshair";var seen={};
for(var i=0;i<pins.length;i++){var p=pins[i],k=String(p.k),el=nodes.get(k);seen[k]=1;if(!el){el=d.createElement("div");el.className="pin";el.setAttribute("role","button");el.addEventListener("click",tapped);shadow.appendChild(el);nodes.set(k,el)}
el.__k=k;el.textContent=String(p.n==null?"":p.n);el.setAttribute("aria-label",String(p.label||"Comment"));el.style.background=String(p.fill||"#007df3");el.style.color=String(p.ink||"#ffffff");var at=spot(p);el.__at=at;el.style.display=p.hide?"none":"flex";el.style.transform="translate("+at.x+"px,"+at.y+"px) scale("+1/scale+")"}
nodes.forEach(function(el,k){if(!seen[k]){el.remove();nodes.delete(k)}});report()}
function report(){if(watch===null)return;var el=nodes.get(watch);if(!el||!el.__at)return;var sx=el.__at.x-scrollX,sy=el.__at.y-scrollY,key=Math.round(sx*2)+","+Math.round(sy*2);if(key===lastAnchor)return;lastAnchor=key;post({t:"anchor",k:watch,sx:sx,sy:sy,shown:sx>=0&&sy>=0&&sx<=innerWidth&&sy<=innerHeight})}
function observe(){if(observing)return;observing=true;var ro=new ResizeObserver(function(){size();later()});ro.observe(root);if(d.body)ro.observe(d.body);new MutationObserver(later).observe(root,{childList:true,subtree:true,attributes:true,characterData:true});if(d.fonts&&d.fonts.ready)d.fonts.ready.then(later);setInterval(function(){if(pins.length)later()},1000)}
function reveal(k){var el=nodes.get(k);if(!el||!el.__at)return;var still=matchMedia("(prefers-reduced-motion: reduce)").matches;scrollTo({top:Math.max(0,el.__at.y-innerHeight*.14),behavior:still?"auto":"smooth"});lastAnchor="";setTimeout(report,still?0:450)}
function touchStyle(){if(d.getElementById("milagre-touch"))return;var s=d.createElement("style");s.id="milagre-touch";s.textContent="html{-webkit-touch-callout:none!important;-webkit-user-select:none!important;user-select:none!important}input,textarea,select,[contenteditable],[contenteditable] *{-webkit-user-select:text!important;user-select:text!important}";(d.head||root).appendChild(s)}
addEventListener("message",function(e){if(e.source!==parent)return;var m=e.data;if(!m||typeof m!=="object"||m.milagre!==KEY)return;
if(m.t==="mode"){input=m.input==="touch"?"touch":"mouse";commenting=!!m.comment;cursor=typeof m.cursor==="string"?m.cursor:"";if(input==="touch")touchStyle();later()}
else if(m.t==="pins"){pins=Array.isArray(m.pins)?m.pins.filter(function(p){return p&&(typeof p.k==="string"||typeof p.k==="number")}):[];watch=m.watch==null?null:String(m.watch);lastAnchor="";observe();later()}
else if(m.t==="scale"){var from=scale;scale=Math.min(8,Math.max(.05,+m.s||1));if(typeof m.cx==="number"&&typeof m.cy==="number"){var px=scrollX+m.cx,py=scrollY+m.cy,nx=m.cx*from/scale,ny=m.cy*from/scale;requestAnimationFrame(function(){requestAnimationFrame(function(){scrollTo(px-nx,py-ny)})})}later()}
else if(m.t==="reveal"){paint();reveal(String(m.k))}});
addEventListener("scroll",report,{passive:true});
addEventListener("resize",function(){size();later()});
addEventListener("wheel",function(e){if(!e.ctrlKey)return;e.preventDefault();post({t:"zoom",dy:e.deltaY,cx:e.clientX,cy:e.clientY})},{passive:false,capture:true});
addEventListener("dblclick",function(e){if(input!=="mouse"||commenting)return;var t=e.target;if(t&&t.closest&&t.closest("a,button,input,textarea,select,label,summary,video,audio,[contenteditable],[role=button],[onclick],[tabindex]"))return;var s=getSelection();if(s&&!s.isCollapsed&&String(s).trim())return;post({t:"fit"})},true);
addEventListener("keydown",function(e){if(e.key!=="c"&&e.key!=="C")return;if(e.metaKey||e.ctrlKey||e.altKey||e.shiftKey||e.repeat||e.isComposing||e.defaultPrevented||!input)return;var t=e.target;if(t&&t.closest&&t.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])"))return;post({t:"key",key:"c"})},true);
d.addEventListener("touchstart",function(e){if(input!=="touch")return;clearTimeout(hold);held=null;if(e.touches.length!==1||e.target===host)return;var t=e.touches[0];held={x:t.clientX,y:t.clientY};hold=setTimeout(function(){var h=held;held=null;if(!h)return;swallow=Date.now();try{getSelection().removeAllRanges()}catch(x){}press(h.x,h.y)},450)},{passive:true,capture:true});
d.addEventListener("touchmove",function(e){if(!held)return;var t=e.touches[0];if(e.touches.length!==1||!t||Math.abs(t.clientX-held.x)>10||Math.abs(t.clientY-held.y)>10){clearTimeout(hold);held=null}},{passive:true,capture:true});
function release(){clearTimeout(hold);held=null}
d.addEventListener("touchend",release,{passive:true,capture:true});d.addEventListener("touchcancel",release,{passive:true,capture:true});
d.addEventListener("click",function(e){if(swallow&&Date.now()-swallow<800){swallow=0;e.preventDefault();e.stopPropagation()}},true);
d.addEventListener("contextmenu",function(e){if(input==="touch")e.preventDefault()},true);
function boot(){diagrams();size();if(window.pele)new MutationObserver(diagrams).observe(d.body||root,{childList:true,subtree:true});post({t:"ready"})}
addEventListener("load",function(){retheme();size();later()});
if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",boot);else boot();
})()`;

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
 * The phone's go-between for an Artifact page in artifactShell: what the page's helper posts (ARTIFACT_PAGE_SCRIPT)
 * reaches the app through ReactNativeWebView, as known fields only, its screen points moved into the web view's
 * pinch zoom; `milagreArtifact.run(command)` hands the app's commands to the page.
 */
export const ARTIFACT_SHELL_SCRIPT = String.raw`(function(){
var frame=document.querySelector("iframe"),KEY="${ARTIFACT_PAGE}",NUMBERS=["x","y","sx","sy","sw","cw","dy","cx","cy"],TEXTS=["t","k","a","near","key"];
function app(m){var b=window.ReactNativeWebView;if(b&&b.postMessage)b.postMessage(JSON.stringify(m))}
addEventListener("message",function(e){if(!frame||e.source!==frame.contentWindow)return;var d=e.data;if(!d||typeof d!=="object"||d.milagre!==KEY||typeof d.t!=="string")return;var m={};
NUMBERS.forEach(function(n){if(typeof d[n]==="number"&&isFinite(d[n]))m[n]=d[n]});TEXTS.forEach(function(n){if(typeof d[n]==="string")m[n]=d[n].slice(0,600)});if(typeof d.shown==="boolean")m.shown=d.shown;
var v=window.visualViewport;if(v&&typeof m.sx==="number"&&typeof m.sy==="number"){m.sx=(m.sx-v.offsetLeft)*v.scale;m.sy=(m.sy-v.offsetTop)*v.scale}app(m)});
window.milagreArtifact={run:function(c){if(!frame||!c||typeof c!=="object")return;c.milagre=KEY;frame.contentWindow.postMessage(c,"*")}};
})()`;

/**
 * A page that shows the design in a sandboxed frame, for a web view with no sandbox of its own (the phone's). The
 * frame runs the design's scripts but has no same origin and no say over the page around it, so it can't navigate
 * it. The frame inherits the page's policy, so the page carries the design's, plus frame-src 'none': the frame loads
 * nothing but the design, so the design can't navigate it away either. With an opaque origin, the design can't read
 * the files beside the page, whatever the web view lets the page itself read. The page's one script is
 * ARTIFACT_SHELL_SCRIPT, which passes plain messages between the app and the Artifact page's helper.
 */
export function artifactShell(html, { diagrams = "", assets = "" } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactCsp(assets)}; frame-src 'none'"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(artifactDocument(html, { page: true, diagrams, assets }))}"></iframe><script>${ARTIFACT_SHELL_SCRIPT}</script></body></html>`;
}

/**
 * The phone's canvas of a Chat's designs: every design on one board, a row per group as on the desktop canvas. A
 * design opens as the camera fitting it; pinching out past it, or the overview command, flies out to the whole board,
 * and a tap on a design there flies back in. Drag pans (a swipe at a design's fit pages to its neighbour in the row),
 * pinch zooms, double-tap fits or zooms in, and a hold on a design reports the spot for a comment. A design as wide as
 * the board (a desktop page) already fits there, so a tap on it zooms in, centred on the spot and filling the screen. A third finger is
 * ignored; reduced motion drops the flights and the glide.
 *
 * Fixed text, so the page's policy allows it by hash and nothing else. The app drives it through
 * `milagreCanvas.run(command)` (set, html, pins, focus, overview, reveal) and hears back through ReactNativeWebView:
 * ready, view (which design, or the whole board), press (a hold, as fractions of the design), pin (a tapped pin and
 * where it sits on screen), anchor (where a revealed spot landed) and painted (a design's frame finished loading; until
 * then the design icon draws itself in its place). Each design is a frame that runs no script.
 */
export const DESIGNS_CANVAS_SCRIPT = `(function(){
var port=document.getElementById("port"),world=document.getElementById("world"),marks=document.getElementById("marks");
var still=matchMedia("(prefers-reduced-motion: reduce)");
var GAP=80,EDGE=48,PAD=16,HOLD=450;
var boards=new Map(),fonts=new Map(),order=[],rows=[],W=1,H=1,pins=[],pinNodes=new Map(),labels=[];
var x=0,y=0,s=1,pad={top:0,bottom:0},ink="#888",accent="#888",current=null,mode="design",sent="",placed=false;
var flight=0,glide=0,points=new Map(),track=[],down=null,lastTap=null,hold=0,pinched=false;
var ring=document.createElement("div");ring.className="ring";marks.appendChild(ring);
var DRAW='<div class="draw" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path pathLength="100" d="M22 12C22 6.477 17.523 2 12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C12.842 22 14 22.116 14 21C14 20.391 13.683 19.921 13.369 19.454C12.908 18.772 12.452 18.095 13 17C13.667 15.667 14.778 15.667 16.481 15.667C17.333 15.667 18.333 15.667 19.5 15.5C21.601 15.2 22 13.908 22 12Z"/><circle pathLength="100" cx="9.5" cy="8.5" r="1.5"/><circle pathLength="100" cx="16.5" cy="9.5" r="1.5"/><path pathLength="100" d="M7.25 15C7.25 15.138 7.138 15.25 7 15.25C6.862 15.25 6.75 15.138 6.75 15C6.75 14.862 6.862 14.75 7 14.75C7.138 14.75 7.25 14.862 7.25 15Z"/></svg></div>';
function post(m){var b=window.ReactNativeWebView;if(b&&b.postMessage)b.postMessage(JSON.stringify(m))}
function pw(){return port.clientWidth}
function room(){return Math.max(1,port.clientHeight-pad.top-pad.bottom)}
function unit(v){return Math.min(1,Math.max(0,v))}
function layout(next){
var seen=new Set(),width=0;rows=[];order=[];
next.forEach(function(row){var left=0,items=[];(Array.isArray(row.designs)?row.designs:[]).forEach(function(d){var id=String(d.id),b=boards.get(id);
if(!b){var el=document.createElement("div");el.className="board";el.innerHTML=DRAW;world.appendChild(el);b={id:id,el:el,frame:null,doc:""};boards.set(id,b)}
b.w=Math.max(1,+d.w||1);b.h=Math.max(1,+d.h||1);b.x=left;left+=b.w+GAP;items.push(b);order.push(b);seen.add(id)});
rows.push({group:row.group?String(row.group):"",items:items});width=Math.max(width,left-GAP)});
boards.forEach(function(b,id){if(!seen.has(id)){b.el.remove();boards.delete(id)}});
W=Math.max(1,width);var gap=Math.max(160,44*W/Math.max(1,pw()-2*PAD)),top=0;
rows.forEach(function(row){var tall=0;row.y=top;row.items.forEach(function(b){b.y=top;tall=Math.max(tall,b.h);
b.el.style.left=b.x+"px";b.el.style.top=b.y+"px";b.el.style.width=b.w+"px";b.el.style.height=b.h+"px";
if(b.frame){b.frame.width=b.w;b.frame.height=b.h;b.frame.style.width=b.w+"px";b.frame.style.height=b.h+"px"}});top+=tall+gap});
H=Math.max(1,top-gap);
labels.forEach(function(l){l.el.remove()});labels=[];
rows.forEach(function(row){if(!row.group)return;var el=document.createElement("div");el.className="label";el.textContent=row.group;el.style.color=ink;marks.insertBefore(el,ring);labels.push({el:el,row:row})});
if(current&&!boards.has(current))current=null}
function setDoc(id,doc,font){var b=boards.get(id);if(!b)return;
if(font){var at=doc.toLowerCase().indexOf("</head>");if(!fonts.has(font)||at<0)return;doc=doc.slice(0,at)+"<style>"+fonts.get(font)+"</style>"+doc.slice(at)}
if(!b.frame){var f=document.createElement("iframe");f.setAttribute("sandbox","");f.setAttribute("referrerpolicy","no-referrer");f.setAttribute("tabindex","-1");f.width=b.w;f.height=b.h;f.style.width=b.w+"px";f.style.height=b.h+"px";f.addEventListener("load",function(){if(!b.doc)return;b.el.classList.add("ready");post({t:"painted",id:b.id})});b.el.appendChild(f);b.frame=f}
if(b.doc!==doc){b.doc=doc;b.el.classList.remove("ready");b.frame.srcdoc=doc}}
function setPins(next){pinNodes.forEach(function(el){el.remove()});pinNodes.clear();pins=Array.isArray(next)?next:[];
pins.forEach(function(p){var el=document.createElement("div"),k=String(p.k);el.className="pin";el.setAttribute("data-k",k);el.setAttribute("role","button");el.setAttribute("aria-label",String(p.label||"Comment"));el.textContent=String(p.n);el.style.background=String(p.fill||accent);el.style.color=String(p.ink||"#fff");marks.appendChild(el);pinNodes.set(k,el)});place()}
function fitOf(b){return Math.max(.01,Math.min((pw()-2*PAD)/b.w,(room()-2*PAD)/b.h))}
function focusView(b){var f=fitOf(b);return {s:f,x:(pw()-b.w*f)/2-b.x*f,y:pad.top+(room()-b.h*f)/2-b.y*f}}
function overview(keep){var o=Math.max(.01,(pw()-2*PAD)/W),tall=H*o,v={s:o,x:(pw()-W*o)/2,y:pad.top+(room()>tall+2*PAD+24?(room()-tall)/2:PAD+24)};
if(keep&&tall>room()){var cy=(pad.top+room()/2-y)/s;v.y=Math.min(v.y,Math.max(pad.top+room()-PAD-tall,pad.top+room()/2-cy*o))}return v}
function closeView(b,z,wx,wy){var w=b.w*z,h=b.h*z,cy=pad.top+room()/2,v={s:z,x:pw()/2-wx*z,y:cy-wy*z};
v.x=w<=pw()?(pw()-w)/2-b.x*z:Math.min(-b.x*z,Math.max(pw()-(b.x+b.w)*z,v.x));
v.y=h<=room()?pad.top+(room()-h)/2-b.y*z:Math.min(pad.top-b.y*z,Math.max(pad.top+room()-(b.y+b.h)*z,v.y));return v}
function zoomView(next,px,py){return {s:next,x:px-(px-x)*next/s,y:py-(py-y)*next/s}}
function bounds(v){var lo=overview().s*.6,hi=4;order.forEach(function(b){hi=Math.max(hi,fitOf(b)*2)});return Math.min(hi,Math.max(lo,v))}
function boardAt(px,py){for(var i=order.length-1;i>=0;i--){var b=order[i],l=x+b.x*s,t=y+b.y*s;if(px>=l&&py>=t&&px<=l+b.w*s&&py<=t+b.h*s)return b}return null}
function nearest(px,py){var best=null,far=Infinity;order.forEach(function(b){var l=x+b.x*s,t=y+b.y*s,r=l+b.w*s,d=t+b.h*s,dx=px<l?l-px:px>r?px-r:0,dy=py<t?t-py:py>d?py-d:0;if(dx*dx+dy*dy<far){far=dx*dx+dy*dy;best=b}});return best}
function rowOf(b){for(var i=0;i<rows.length;i++)if(rows[i].items.indexOf(b)>=0)return rows[i];return null}
function judge(){var b=nearest(pw()/2,pad.top+room()/2);if(!b)return;var next=s>=fitOf(b)*.7?"design":"canvas";if(next==="design"||!current)current=b.id;
var key=next+"|"+current;if(key!==sent){sent=key;mode=next;post({t:"view",mode:mode,id:current})}}
function place(){var canvas=mode==="canvas";
labels.forEach(function(l){var first=l.row.items[0];l.el.style.transform="translate("+(x+(first?first.x:0)*s)+"px,"+(y+l.row.y*s-24)+"px)";l.el.style.opacity=canvas?"1":"0";l.el.style.visibility=canvas?"visible":"hidden"});
var b=boards.get(current);if(b&&canvas){ring.style.display="block";ring.style.borderColor=accent;ring.style.transform="translate("+(x+b.x*s-4)+"px,"+(y+b.y*s-4)+"px)";ring.style.width=(b.w*s+8)+"px";ring.style.height=(b.h*s+8)+"px"}else ring.style.display="none";
pins.forEach(function(p){var at=boards.get(String(p.id)),el=pinNodes.get(String(p.k));if(!el)return;if(!at||p.hide){el.style.display="none";return}el.style.display="flex";el.style.transform="translate("+(x+(at.x+unit(+p.x)*at.w)*s)+"px,"+(y+(at.y+unit(+p.y)*at.h)*s)+"px)"})}
function paint(){var w=pw(),h=port.clientHeight;x=Math.min(w-EDGE,Math.max(EDGE-W*s,x));y=Math.min(h-EDGE,Math.max(EDGE-H*s,y));world.style.transform="translate("+x+"px,"+y+"px) scale("+s+")";judge();place()}
function stop(){cancelAnimationFrame(flight);cancelAnimationFrame(glide);flight=glide=0}
function fly(v,done){stop();if(still.matches){x=v.x;y=v.y;s=v.s;paint();if(done)done();return}
var cx=pw()/2,cy=pad.top+room()/2,a={x:(cx-x)/s,y:(cy-y)/s,s:s},z={x:(cx-v.x)/v.s,y:(cy-v.y)/v.s,s:v.s},t0=performance.now();
function frame(now){var k=Math.min(1,(now-t0)/360),e=1-Math.pow(1-k,3);s=a.s*Math.pow(z.s/a.s,e);x=cx-(a.x+(z.x-a.x)*e)*s;y=cy-(a.y+(z.y-a.y)*e)*s;paint();if(k<1)flight=requestAnimationFrame(frame);else{flight=0;if(done)done()}}
flight=requestAnimationFrame(frame)}
function velocity(at){var a=track[0],b=track[track.length-1];if(!a||b.t<=a.t||at-b.t>60)return null;return {x:(b.x-a.x)/(b.t-a.t),y:(b.y-a.y)/(b.t-a.t)}}
function fling(at){var v=velocity(at);if(still.matches||!v||Math.hypot(v.x,v.y)<.2)return;var vx=v.x,vy=v.y,prev=performance.now();
function step(now){var dt=Math.min(now-prev,32),k=Math.pow(.996,dt);prev=now;x+=vx*dt;y+=vy*dt;vx*=k;vy*=k;paint();if(Math.hypot(vx,vy)>.03)glide=requestAnimationFrame(step)}glide=requestAnimationFrame(step)}
function settle(at){var b=nearest(pw()/2,pad.top+room()/2);
if(b&&mode==="design"&&s<=fitOf(b)*1.15){var v=velocity(at),row=rowOf(b);if(v&&Math.abs(v.x)>.3&&Math.abs(v.x)>Math.abs(v.y)&&row){var i=row.items.indexOf(b),n=row.items[i+(v.x<0?1:-1)];if(n&&!pinched)b=n}current=b.id;fly(focusView(b));return}
if(mode==="canvas"&&pinched){fly(overview(true));return}
fling(at)}
function tapAt(px,py,at){var hit=document.elementFromPoint(px,py),pin=hit&&hit.closest?hit.closest(".pin"):null;
if(pin){var r=pin.getBoundingClientRect();lastTap=null;post({t:"pin",k:pin.getAttribute("data-k"),sx:r.left,sy:r.top});return}
var b=boardAt(px,py);
if(mode==="canvas"){lastTap=null;if(b){current=b.id;var v=focusView(b);if(v.s<s*1.3)v=closeView(b,bounds(Math.max(v.s,Math.min((room()-2*PAD)/b.h,s*3))),(px-x)/s,(py-y)/s);fly(v)}return}
if(lastTap&&at-lastTap.t<300&&Math.hypot(px-lastTap.x,py-lastTap.y)<40){lastTap=null;b=b||boards.get(current);if(!b)return;var f=fitOf(b);fly(Math.abs(s/f-1)>.05?focusView(b):zoomView(bounds(Math.max(1,f*2)),px,py));return}
lastTap={x:px,y:py,t:at}}
port.addEventListener("pointerdown",function(e){if(points.size>=2)return;stop();port.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY});track=[];clearTimeout(hold);
if(points.size===1){pinched=false;down={x:e.clientX,y:e.clientY,t:e.timeStamp,far:false,held:false};hold=setTimeout(function(){var d=down;if(!d||d.far||points.size!==1)return;d.held=true;var b=boardAt(d.x,d.y);if(b)post({t:"press",id:b.id,x:unit((d.x-x-b.x*s)/(b.w*s)),y:unit((d.y-y-b.y*s)/(b.h*s))})},HOLD)}
else{down=null;pinched=true}});
port.addEventListener("pointermove",function(e){var old=points.get(e.pointerId);if(!old)return;
if(points.size===1){if(down&&down.held)return;x+=e.clientX-old.x;y+=e.clientY-old.y;track.push({x:e.clientX,y:e.clientY,t:e.timeStamp});if(track.length>5)track.shift()}
else{var other=null;points.forEach(function(p,id){if(id!==e.pointerId)other=p});var before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y);if(before>0){var v=zoomView(bounds(s*after/before),(old.x+other.x)/2,(old.y+other.y)/2);x=v.x;y=v.y;s=v.s}x+=(e.clientX-old.x)/2;y+=(e.clientY-old.y)/2}
if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>10){down.far=true;clearTimeout(hold)}points.set(e.pointerId,{x:e.clientX,y:e.clientY});paint()});
function up(e){if(!points.delete(e.pointerId))return;clearTimeout(hold);if(points.size){track=[];return}
var d=down;down=null;if(d&&d.held)return;
if(e.type==="pointerup"&&d&&!d.far&&e.timeStamp-d.t<300){tapAt(e.clientX,e.clientY,e.timeStamp);return}
settle(e.timeStamp)}
port.addEventListener("pointerup",up);port.addEventListener("pointercancel",up);port.addEventListener("lostpointercapture",up);
document.addEventListener("gesturestart",function(e){e.preventDefault()});
new ResizeObserver(function(){if(!placed)return;stop();track=[];var b=boards.get(current),v=mode==="design"&&b?focusView(b):overview();x=v.x;y=v.y;s=v.s;paint()}).observe(port);
window.milagreCanvas={run:function(c){if(!c||typeof c!=="object")return;
if(c.t==="set"){if(c.ink)ink=String(c.ink);if(c.accent)accent=String(c.accent);if(c.pad)pad={top:+c.pad.top||0,bottom:+c.pad.bottom||0};var was=boards.get(current),wx=was&&was.x,wy=was&&was.y;layout(Array.isArray(c.rows)?c.rows:[]);if(was&&boards.get(current)===was){x-=(was.x-wx)*s;y-=(was.y-wy)*s}if(Array.isArray(c.pins))setPins(c.pins);
var b=boards.get(String(c.focus||""))||boards.get(current)||order[0];if(b&&(!placed||!boards.has(current))){current=b.id;var v=focusView(b);x=v.x;y=v.y;s=v.s;placed=true}paint()}
else if(c.t==="fonts"){if(typeof c.key==="string"&&typeof c.css==="string"&&c.css)fonts.set(c.key,c.css)}
else if(c.t==="html")setDoc(String(c.id),String(c.doc||""),c.font);
else if(c.t==="pins")setPins(c.pins);
else if(c.t==="focus"){var f=boards.get(String(c.id));if(f){current=f.id;fly(focusView(f))}}
else if(c.t==="overview")fly(overview());
else if(c.t==="reveal"){var r=boards.get(String(c.id));if(!r)return;var rx=unit(+c.x),ry=unit(+c.y),px=x+(r.x+rx*r.w)*s,py=y+(r.y+ry*r.h)*s,tx=Math.min(Math.max(px,PAD),pw()-280),ty=pad.top+Math.max(PAD,room()*.14);
fly({s:s,x:x+tx-px,y:y+ty-py},function(){post({t:"anchor",sx:x+(r.x+rx*r.w)*s,sy:y+(r.y+ry*r.h)*s})})}}};
post({t:"ready"})})()`;
// Hash of DESIGNS_CANVAS_SCRIPT; artifact.test.ts checks it.
const DESIGNS_CANVAS_HASH = "sha256-MDgC7d0mQR7sb+NREt9ONsNGcLF0EteM54SI3rSQbQ0=";
const CANVAS_BACKGROUND = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\))$/i;

/**
 * The page for DESIGNS_CANVAS_SCRIPT, empty until the app sends the designs. As in artifactShell, each design goes in a
 * sandboxed frame, here one that can't run scripts at all, and the touches go to the canvas around it. The page runs
 * only the canvas script.
 */
export function designsCanvasShell(background = "#f2f2f2") {
  const color = CANVAS_BACKGROUND.test(background) ? background : "#f2f2f2";
  const policy = `${ARTIFACT_CSP.replace("script-src 'unsafe-inline'", `script-src '${DESIGNS_CANVAS_HASH}'`)}; frame-src 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;height:100%;overflow:hidden;background:${color}}#port{position:fixed;inset:0;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#world{position:absolute;left:0;top:0;transform-origin:0 0}.board{position:absolute;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.18);overflow:hidden}iframe{display:block;border:0;pointer-events:none;opacity:0;transition:opacity .25s}.board.ready iframe{opacity:1}.draw{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c4c7cf;transition:opacity .2s}.board.ready .draw{opacity:0}.board.ready .draw *{animation:none;stroke-dashoffset:0}.draw svg{width:18%;min-width:28px;max-width:96px}.draw *{stroke-dasharray:100;stroke-dashoffset:100;animation:draw 1.8s ease-in-out infinite}@keyframes draw{0%{stroke-dashoffset:100;opacity:1}55%{stroke-dashoffset:0;opacity:1}85%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}@media (prefers-reduced-motion:reduce){.draw *{animation:none;stroke-dashoffset:0}iframe{transition:none}}#marks{position:absolute;inset:0;pointer-events:none}#marks>*{position:absolute;left:0;top:0}.label{font:600 11px/14px -apple-system,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;transition:opacity .2s}.ring{display:none;box-sizing:border-box;border:2px solid;border-radius:12px}.pin{pointer-events:auto;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:0 12px 12px 12px;font:700 11px -apple-system,system-ui,sans-serif;box-shadow:0 0 0 1.5px #fff,0 1px 3px rgba(0,0,0,.3)}</style></head><body><main id="port" aria-label="Designs canvas. Pinch to zoom, drag to pan, double-tap to fit, hold a design to comment."><div id="world"></div><div id="marks"></div></main><script>${DESIGNS_CANVAS_SCRIPT}</script></body></html>`;
}

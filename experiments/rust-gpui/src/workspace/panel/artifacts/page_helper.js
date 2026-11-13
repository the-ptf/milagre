(function(){
if(window.__milagrePage)return;window.__milagrePage=1;
var KEY="milagre:artifact-page",d=document,root=d.documentElement,P=null;
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
function paint(){frame=0;if(!pins.length&&!commenting&&!host)return;mount();cover.style.display=commenting?"block":"none";cover.style.cursor=cursor||"crosshair";var seen={};
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
d.addEventListener("touchstart",function(e){if(input!=="touch"||commenting)return;clearTimeout(hold);held=null;if(e.touches.length!==1||e.target===host)return;var t=e.touches[0];held={x:t.clientX,y:t.clientY};hold=setTimeout(function(){var h=held;held=null;if(!h)return;swallow=Date.now();try{getSelection().removeAllRanges()}catch(x){}press(h.x,h.y)},450)},{passive:true,capture:true});
d.addEventListener("touchmove",function(e){if(!held)return;var t=e.touches[0];if(e.touches.length!==1||!t||Math.abs(t.clientX-held.x)>10||Math.abs(t.clientY-held.y)>10){clearTimeout(hold);held=null}},{passive:true,capture:true});
function release(){clearTimeout(hold);held=null}
d.addEventListener("touchend",release,{passive:true,capture:true});d.addEventListener("touchcancel",release,{passive:true,capture:true});
d.addEventListener("click",function(e){if(swallow&&Date.now()-swallow<800){swallow=0;e.preventDefault();e.stopPropagation()}},true);
d.addEventListener("contextmenu",function(e){if(input==="touch")e.preventDefault()},true);
function boot(){diagrams();size();if(window.pele)new MutationObserver(diagrams).observe(d.body||root,{childList:true,subtree:true});post({t:"ready"})}
addEventListener("load",function(){retheme();size();later()});
if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",boot);else boot();
})()
import { artifactDocument, ARTIFACT_CSP } from "./artifact-document.mjs";

export const HTML_RENDER_MESSAGE = "milagre:html-render";
/** Bounds for a reply's height in pixels: what html_render accepts and what the transcript reserves or grows to. */
export const HTML_RENDER_MIN_HEIGHT = 24;
export const HTML_RENDER_MAX_HEIGHT = 2000;
const attribute = (value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
export const htmlRenderHeight = (height) =>
  Number.isFinite(height) ? Math.max(HTML_RENDER_MIN_HEIGHT, Math.min(HTML_RENDER_MAX_HEIGHT, Math.ceil(height))) : 400;

/**
 * Milagre Blue, the default theme, for previews and first paint. Desktop and phone pass the reader's live theme:
 * the transcript's background, ink ramp, controls, status colors and chat text font.
 */
export const HTML_RENDER_THEMES = {
  light: {
    scheme: "light",
    background: "#f4f9fe",
    surface: "#ffffff",
    field: "#f5f5f5",
    ink: "#1c222b",
    ink2: "#616770",
    muted: "#6e737b",
    line: "#edeeee",
    lineStrong: "#e0e1e3",
    accent: "#007df3",
    accentInk: "#0068cd",
    accentTint: "#e3f0fe",
    onAccent: "#ffffff",
    green: "#199a4d",
    orange: "#ef720d",
    red: "#e3474c",
    purple: "#a855f7",
    font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    size: 13,
    leading: 1.55,
  },
  dark: {
    scheme: "dark",
    background: "#0d1624",
    surface: "#172232",
    field: "#212c3c",
    ink: "#e9eff7",
    ink2: "#9199a4",
    muted: "#808996",
    line: "#273242",
    lineStrong: "#303b4a",
    accent: "#3e9afd",
    accentInk: "#80b9fd",
    accentTint: "#3e9afd29",
    onAccent: "#ffffff",
    green: "#3cbb72",
    orange: "#f68f3c",
    red: "#ee5c61",
    purple: "#c084fc",
    font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    size: 13,
    leading: 1.55,
  },
};

/**
 * The reader theme as CSS custom properties, run inside the isolated page (source text: Hermes keeps no function
 * source). Values that are not a plain color, font list or number are dropped.
 */
const THEME_ENTRIES = `(value)=>{
 if(!value||typeof value!=='object')return [];
 const colors={background:'background',surface:'surface',field:'field',ink:'ink',ink2:'ink-2',muted:'muted',line:'line',lineStrong:'line-strong',accent:'accent',accentInk:'accent-ink',accentTint:'accent-tint',onAccent:'on-accent',green:'green',orange:'orange',red:'red',purple:'purple'};
 const color=/^(transparent|#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|color)\\([0-9a-z.,%\\s/+-]{1,80}\\))$/i;
 const entries=[];
 for(const [key,name] of Object.entries(colors))if(typeof value[key]==='string'&&color.test(value[key].trim()))entries.push([name,value[key].trim()]);
 for(const key of ['font','mono'])if(typeof value[key]==='string'&&/^[\\w\\s"',.-]{1,300}$/.test(value[key]))entries.push([key,value[key]]);
 if(Number.isFinite(value.size)&&value.size>=10&&value.size<=28)entries.push(['text-size',value.size+'px']);
 if(Number.isFinite(value.leading)&&value.leading>=1&&value.leading<=2.2)entries.push(['leading',String(value.leading)]);
 if(Number.isFinite(value.tracking)&&Math.abs(value.tracking)<=0.05)entries.push(['tracking',value.tracking+'em']);
 if(value.scheme==='light'||value.scheme==='dark')entries.push(['scheme',value.scheme]);
 return entries;
}`;

/** Only these messages cross the isolated document boundary. Never forward tool calls or arbitrary bridge data. */
export function readHtmlRenderMessage(value) {
  try {
    const data = typeof value === "string" ? JSON.parse(value) : value;
    if (data?.channel !== HTML_RENDER_MESSAGE) return null;
    if (data.type === "size" && Number.isFinite(data.height) && data.height > 0) return { type: "size", height: htmlRenderHeight(data.height) };
    if (data.type === "ready") return { type: "ready" };
    if (data.type === "escape") return { type: "escape" };
    if (data.type === "link" && typeof data.url === "string" && data.url.length <= 4096 && /^https?:\/\//i.test(data.url)) {
      const url = new URL(data.url);
      if (!url.username && !url.password) return { type: "link", url: url.href };
    }
  } catch {
    /* Invalid messages have no effect. */
  }
  return null;
}

// The page's own script runs first: it applies the initial theme before anything paints.
const bootstrap = (theme) => `(()=>{
 const channel='${HTML_RENDER_MESSAGE}';
 const post=(type,extra={})=>parent.postMessage({channel,type,...extra},'*');
 for(const level of ['log','info','warn','error']){const original=console[level];console[level]=(...args)=>{post('console',{level,text:args.map(x=>String(x)).join(' ').slice(0,2000)});original.apply(console,args)}};
 addEventListener('error',e=>post('console',{level:'error',text:String(e.message).slice(0,2000)}));
 const entries=${THEME_ENTRIES};
 const theme=(value)=>{for(const [name,color] of entries(value))document.documentElement.style.setProperty('--'+name,color)};
 theme(${JSON.stringify(theme).replace(/</g, "\\u003c")});
 addEventListener('message',e=>{if(e.source===parent&&e.data?.channel===channel&&e.data.type==='theme'){theme(e.data.theme);dispatchEvent(new Event('themechange'))}});
 addEventListener('click',e=>{const a=e.target?.closest?.('a');if(!a)return;const href=a.getAttribute('href')||'';if(href.startsWith('#'))return;e.preventDefault();if(e.isTrusted&&/^https?:\\/\\//i.test(href))post('link',{url:href})},true);
 addEventListener('keydown',e=>{if(e.key==='Escape')post('escape')});
 // Recheck the natural table layout after resize/content changes; wide replies retain the author's table layout.
 const containTables=()=>{
  const width=document.documentElement.clientWidth;
  for(const table of document.querySelectorAll('table')){
   const left=table.scrollLeft;
   table.removeAttribute('data-milagre-overflow-table');
   // Collapsed borders can round scrollWidth up by one CSS pixel without clipping content.
   if(table.getBoundingClientRect().right>width+1||table.scrollWidth>width+1){
    let contained=false;
    for(let p=table.parentElement;p&&p!==document.body;p=p.parentElement){if(/auto|scroll/.test(getComputedStyle(p).overflowX)&&p.getBoundingClientRect().right<=width+.5){contained=true;break}}
    if(!contained){table.setAttribute('data-milagre-overflow-table','');table.scrollLeft=left}
   }
  }
 };
 const measure=()=>{
  if(!document.documentElement||!document.body)return;
  containTables();
  const width=document.documentElement.clientWidth;
  const overflowX=Math.max(0,document.documentElement.scrollWidth-width,(document.body?.scrollWidth||0)-width);
  let overflowSelector=null;
  if(overflowX>0){const el=[...document.querySelectorAll('body *')].find(el=>el.getBoundingClientRect().right>width+.5);if(el)overflowSelector=el.id?'#'+CSS.escape(el.id):el.localName}
  post('overflow',{overflowX,overflowSelector});
  post('size',{height:Math.ceil(document.documentElement.getBoundingClientRect().height)});
 };
 let pending=false;
 const schedule=()=>{if(!pending){pending=true;requestAnimationFrame(()=>{pending=false;measure()})}};
 addEventListener('DOMContentLoaded',()=>{new ResizeObserver(schedule).observe(document.documentElement);new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,characterData:true});measure()});
 addEventListener('resize',schedule);
 addEventListener('themechange',schedule);
 addEventListener('load',measure);
 document.fonts?.ready.then(measure);
})();`;

/**
 * Plain HTML looks like the chat around it: chat text, compact headings, Markdown-style tables, and buttons, fields,
 * selects, sliders and disclosures in Milagre's control style, light and dark. All of it is zero-specificity (:where),
 * so any rule the page writes wins. The page itself has no frame: no outer margin, padding, background or height of its
 * own, so its first line sits where the reply's text would start.
 */
const BASE_STYLE = `
:root{--background:#f4f9fe;--surface:#fff;--field:#f5f5f5;--ink:#1c222b;--ink-2:#616770;--muted:#6e737b;--line:#edeeee;--line-strong:#e0e1e3;--accent:#007df3;--accent-ink:#0068cd;--accent-tint:#e3f0fe;--on-accent:#fff;--green:#199a4d;--orange:#ef720d;--red:#e3474c;--purple:#a855f7;--font:system-ui,sans-serif;--mono:ui-monospace,Menlo,monospace;--text-size:13px;--leading:1.55;--scheme:light;--chart-1:var(--accent);--chart-2:var(--orange);--chart-3:var(--green);--chart-4:var(--purple);--chart-5:var(--red);--radius:8px;--control-height:30px;color-scheme:var(--scheme)}
@media (pointer:coarse){:root{--control-height:36px}}
html,body{margin:0!important;padding:0!important;border:0!important;background:var(--background)!important;box-shadow:none!important;min-height:0!important;height:auto!important;max-width:none!important;width:auto!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{display:flow-root;overflow-x:hidden}
:where(body){font-family:var(--font);font-size:var(--text-size);line-height:var(--leading);letter-spacing:var(--tracking,normal);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-wrap:break-word;-webkit-tap-highlight-color:transparent}
:where(*,*::before,*::after){box-sizing:border-box}
:where(body > :first-child,body > :first-child > :first-child){margin-top:0}
:where(body > :last-child,body > :last-child > :last-child){margin-bottom:0}
:where(h1,h2,h3,h4,h5,h6){margin:1em 0 .4em;font-weight:600;line-height:1.35;color:var(--ink);letter-spacing:-.005em;text-wrap:balance}
:where(h1){font-size:calc(var(--text-size) + 3px)}
:where(h2){font-size:calc(var(--text-size) + 2px)}
:where(h3){font-size:calc(var(--text-size) + 1px)}
:where(h4,h5,h6){font-size:var(--text-size)}
:where(p,ul,ol,dl,blockquote,figure,table,pre,details,fieldset,form){margin:.6em 0}
:where(ul,ol){padding-left:1.35em}
:where(li){margin:.2em 0}
:where(li)::marker{color:var(--muted)}
:where(strong,b){font-weight:600}
:where(small,figcaption,caption,.muted){color:var(--muted)}
:where(small,figcaption,caption){font-size:.88em}
:where(figure){margin-inline:0}
:where(figcaption){margin-top:.4em}
:where(blockquote){margin-inline:0;padding-left:.8em;border-left:2px solid var(--line-strong);color:var(--ink-2)}
:where(hr){border:0;border-top:1px solid var(--line);margin:1em 0}
:where(a){color:var(--accent-ink);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:2px}
:where(code,kbd,samp,pre){font-family:var(--mono);font-size:.92em}
:where(code,kbd){padding:.1em .35em;border-radius:4px;background:var(--field)}
:where(pre){padding:10px 12px;border-radius:var(--radius);background:var(--field);overflow-x:auto;line-height:1.5}
:where(pre code){padding:0;background:none}
:where(img,video,canvas,svg){max-width:100%}
:where(img,video){height:auto;border-radius:6px}
:where(table){border-collapse:collapse;font-variant-numeric:tabular-nums;max-width:100%}
table[data-milagre-overflow-table]{display:block!important;overflow-x:auto!important;max-width:100%!important}
:where(th,td){padding:.35em .7em;border:1px solid var(--line);text-align:left;vertical-align:top}
:where(th){font-weight:600;background:var(--field)}
:where(caption){text-align:left;padding-bottom:.4em}
:where(output,data,meter){font-variant-numeric:tabular-nums}
:where(label){display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
:where(fieldset){min-width:0;margin-inline:0;padding:0;border:0}
:where(legend){padding:0;margin-bottom:.4em;font-weight:600}
:where(button,input,select,textarea){margin:0;font:inherit;color:inherit;letter-spacing:inherit}
:where(button,input:is([type=button],[type=submit],[type=reset])){appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--control-height);padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);color:var(--ink);font-weight:500;line-height:1.2;white-space:nowrap;cursor:pointer;touch-action:manipulation;transition:background-color .12s,border-color .12s,color .12s}
:where(button,input:is([type=button],[type=submit],[type=reset])):hover{background:var(--field)}
:where(button[type=submit],input[type=submit],button[aria-pressed=true],button[aria-selected=true],button[aria-current]:not([aria-current=false])){border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
:where(button[type=submit],input[type=submit],button[aria-pressed=true],button[aria-selected=true],button[aria-current]:not([aria-current=false])):hover{background:var(--accent-ink);border-color:var(--accent-ink)}
:where(button,input,select,textarea,summary,a):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
:where(button,input,select,textarea):disabled{opacity:.5;cursor:default}
:where(select,textarea,input:is(:not([type]),[type=text],[type=number],[type=search],[type=email],[type=url],[type=tel],[type=password],[type=date],[type=time],[type=datetime-local],[type=month],[type=week])){appearance:none;min-height:var(--control-height);padding:0 10px;border:1px solid var(--line-strong);border-radius:var(--radius);background-color:var(--surface);color:var(--ink);max-width:100%}
:where(textarea){min-height:72px;padding:6px 10px;resize:vertical}
:where(select){padding-right:28px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px;background-repeat:no-repeat}
:where(input,textarea)::placeholder{color:var(--muted)}
:where(input:is([type=checkbox],[type=radio])){width:15px;height:15px;margin:0;accent-color:var(--accent);vertical-align:-.15em}
:where(progress,meter){accent-color:var(--accent);vertical-align:middle}
:where(input[type=range]){-webkit-appearance:none;appearance:none;width:180px;max-width:100%;height:22px;margin:0;padding:0;background:transparent;vertical-align:middle;cursor:pointer;touch-action:pan-y}
:where(input[type=range])::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--line-strong)}
:where(input[type=range])::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border:2px solid var(--surface);border-radius:50%;background:var(--accent);box-shadow:0 0 0 1px var(--line-strong),0 1px 2px rgb(0 0 0/.2)}
:where(input[type=range])::-moz-range-track{height:4px;border-radius:2px;background:var(--line-strong)}
:where(input[type=range])::-moz-range-thumb{width:12px;height:12px;border:2px solid var(--surface);border-radius:50%;background:var(--accent)}
:where(details){margin:.6em 0}
:where(summary){display:flex;align-items:center;gap:8px;width:fit-content;list-style:none;font-weight:500;cursor:pointer}
:where(summary)::-webkit-details-marker{display:none}
:where(summary)::before{content:"";flex:none;width:6px;height:6px;margin:0 2px 0 1px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .15s}
:where(details[open] > summary)::before{transform:rotate(45deg) translate(-1px,-1px)}
:where(details[open] > summary){margin-bottom:.4em}
`;

/** A sealed outer page is used on desktop, native WebViews and in the screenshot browser alike. */
export function htmlRenderShell(html, theme = {}) {
  const document = artifactDocument(
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><script>${bootstrap(theme)}</script><style>${BASE_STYLE}</style>${html}`,
  );
  const initialTheme = JSON.stringify(theme).replace(/</g, "\\u003c");
  // The outer page paints the reader's background too, so nothing flashes before the inner page loads.
  // Every frame level shares the reader's color scheme: Chromium paints an opaque backdrop under a transparent page
  // whose scheme differs from its frame's.
  const background = typeof theme.background === "string" && /^[#a-z0-9(),.%\s/+-]{1,80}$/i.test(theme.background) ? theme.background : "transparent";
  const scheme = theme.scheme === "dark" ? "dark" : "light";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}; frame-src 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}html{background:${background};color-scheme:${scheme}}body{overflow:hidden}</style></head><body><iframe title="HTML reply" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(document)}"></iframe><script>(()=>{
 const frame=document.querySelector('iframe'),channel='${HTML_RENDER_MESSAGE}';

 let theme=${initialTheme};
 const sendTheme=()=>frame.contentWindow.postMessage({channel,type:'theme',theme},'*');frame.addEventListener('load',()=>{sendTheme();const ready={channel,type:'ready'};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(ready));else parent.postMessage(ready,'*')});
 window.htmlRenderConsole=[];
 addEventListener('message',e=>{
  if(e.source===parent&&e.data?.channel===channel&&e.data.type==='theme'){theme=e.data.theme;const root=document.documentElement.style;if(typeof theme?.background==='string'&&/^[#a-z0-9(),.%\\s/+-]{1,80}$/i.test(theme.background))root.background=theme.background;if(theme?.scheme==='light'||theme?.scheme==='dark')root.colorScheme=theme.scheme;sendTheme();return}
  if(e.source!==frame.contentWindow||e.data?.channel!==channel)return;
  if(e.data.type==='console'&&typeof e.data.text==='string'&&window.htmlRenderConsole.length<50){window.htmlRenderConsole.push({level:String(e.data.level).slice(0,20),text:e.data.text.slice(0,2000)});return}
  if(e.data.type==='overflow'&&Number.isFinite(e.data.overflowX)&&e.data.overflowX>=0){window.htmlRenderOverflow={overflowX:e.data.overflowX,overflowSelector:typeof e.data.overflowSelector==='string'?e.data.overflowSelector.slice(0,300):null};return}
  const dataIn=e.data;let message;
  if(dataIn.type==='size'&&Number.isFinite(dataIn.height)&&dataIn.height>0)message={type:'size',height:Math.max(${HTML_RENDER_MIN_HEIGHT},Math.min(${HTML_RENDER_MAX_HEIGHT},Math.ceil(dataIn.height)))};
  if(dataIn.type==='escape')message={type:'escape'};
  if(dataIn.type==='link'&&typeof dataIn.url==='string'&&dataIn.url.length<=4096){try{const url=new URL(dataIn.url);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)message={type:'link',url:url.href}}catch{}}
  if(!message)return;
  if(message.type==='size')window.htmlRenderContentHeight=message.height;
  const data={channel,...message};
  if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));else parent.postMessage(data,'*');
 });
})();</script></body></html>`;
}

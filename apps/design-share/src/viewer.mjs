/**
 * The public page viewer. The service adds it to every page when the page is read, so a page published before a
 * viewer change gets the current one. It takes over whatever the stored page holds: frames are always `figure`
 * elements with a `figcaption` and an `img` (layers) or `iframe.live` (interactive) inside `#canvas`, grouped in
 * `section`s since group blocks, and an Artifact page is a `main` holding one `iframe`. Older chrome (headers,
 * footers, docks, inline styles and the old pan/zoom script) is dropped.
 *
 * The browser runs these functions from their source (`Function.prototype.toString`), so they use only browser
 * globals and each other, never module bindings. Wrangler must not wrap them in `__name` (`keep_names = false`).
 */
import { mvPresent, PRESENT_ICONS, PRESENT_STYLE } from "./presentation.mjs";

const icon = (size, paths) =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;

const MILAGRE_MARK =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 146 145" fill="currentColor"><path d="M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z"/><path d="M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z"/><path d="M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z"/></svg>';

const ICONS = {
  minus: icon(14, ["M20 12L4 12"]),
  plus: icon(14, ["M12 4V20M20 12H4"]),
  fit: icon(13, [
    "M3 4V20",
    "M21 4V20",
    "M15.6216 9L16.5002 9.87868C17.5002 10.8787 18.0002 11.3787 18.0002 12C18.0002 12.6213 17.5002 13.1213 16.5002 14.1213L15.6216 15M8.37892 9L7.50024 9.87868C6.50024 10.8787 6.00024 11.3787 6.00024 12C6.00024 12.6213 6.50024 13.1213 7.50024 14.1213L8.37892 15M6.37892 12H17.6216",
  ]),
  more: icon(14, ["M12 12h.01", "M6 12h.01", "M18 12h.01"]),
  logo: MILAGRE_MARK,
};

const STYLE = `
html,body{margin:0;height:100%;background:#111922;color:#e5edf3;font-family:system-ui,-apple-system,sans-serif}
body.mv{overflow:hidden;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#mv-port{position:fixed;inset:0;overflow:hidden;touch-action:none;cursor:grab;outline:none;background-image:radial-gradient(#304052 1px,transparent 1px);background-size:20px 20px}
#mv-port.grabbing{cursor:grabbing}
#mv-port:focus-visible{box-shadow:inset 0 0 0 2px #91bdff}
#mv-canvas{position:absolute;left:0;top:0;display:flex;align-items:flex-start;gap:80px;transform-origin:0 0}
#mv-canvas.grouped{flex-direction:column}
#mv-canvas.moving{will-change:transform}
#mv-canvas section{display:flex;flex-direction:column;align-items:flex-start}
#mv-canvas .name{position:relative;flex-shrink:0;height:calc(30px*var(--inv,1))}
#mv-canvas .name>div{position:absolute;bottom:0;left:0;display:flex;align-items:baseline;gap:8px;padding-bottom:8px;white-space:nowrap;font:500 13px/1.35 system-ui,sans-serif;color:#e5edf3;transform:scale(var(--inv,1));transform-origin:bottom left}
#mv-canvas .name .none{color:#9199a4}#mv-canvas .name b{font-weight:400;color:#9199a4;font-variant-numeric:tabular-nums}
#mv-canvas .block{display:flex;align-items:flex-start;gap:80px;padding:48px;border-radius:40px;background:rgb(255 255 255/.05)}
#mv-canvas figure{margin:0;flex-shrink:0;outline:none}
#mv-canvas figcaption{position:relative;height:calc(30px*var(--inv,1))}
.mv-cap{position:absolute;left:0;bottom:0;display:flex;align-items:center;gap:6px;width:calc(100% / var(--inv,1));height:30px;padding-bottom:6px;box-sizing:border-box;transform:scale(var(--inv,1));transform-origin:0 100%;font:500 12px/1 system-ui,sans-serif;color:#9199a4;white-space:nowrap}
.mv-cap span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.mv-cap .tag{flex-shrink:0;padding:3px 6px;border-radius:5px;background:rgb(145 189 255/.14);color:#91bdff;font-size:11px}
.mv-cap button{flex-shrink:0;display:flex;align-items:center;justify-content:center;height:22px;min-width:22px;margin-left:auto;padding:0 6px;border:0;border-radius:6px;background:none;color:#9199a4;font:500 12px/1 system-ui,sans-serif;cursor:pointer;opacity:0;transition:opacity .15s,color .15s,background-color .15s}
.mv-cap button+button{margin-left:0}
figure:hover .mv-cap button,figure:focus-within .mv-cap button,figure.menu .mv-cap button,figure.on .mv-cap button{opacity:1}
.mv-cap button:hover{color:#e9eff7;background:rgb(255 255 255/.08)}
.mv-cap button:focus-visible{opacity:1;outline:2px solid #91bdff}
@media (hover:none){.mv-cap button{opacity:1}}
.mv-surface{position:relative;box-shadow:0 4px 24px #0005;background:white}
.mv-surface>img,.mv-surface>iframe{display:block;border:0;pointer-events:none}
figure.on .mv-surface>iframe{pointer-events:auto}
figure:hover .mv-surface,figure:focus-visible .mv-surface,figure.menu .mv-surface{box-shadow:0 4px 24px #0005,0 0 0 calc(1.5px*var(--inv,1)) rgb(145 189 255/.7)}
figure.on .mv-surface{box-shadow:0 4px 24px #0005,0 0 0 calc(2px*var(--inv,1)) #91bdff}
.mv-shield{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
figure.on .mv-shield{display:none}
.mv-shield span{padding:8px 12px;border-radius:999px;background:#172232;color:#e9eff7;font:500 12px/1 system-ui,sans-serif;box-shadow:0 0 0 1px rgb(255 255 255/.11),0 2px 6px rgb(0 0 0/.3);transform:scale(var(--inv,1));opacity:0;transition:opacity .15s;white-space:nowrap}
figure:hover .mv-shield span{opacity:1}
.mv-dock{position:fixed;left:16px;right:16px;bottom:16px;z-index:2;display:flex;align-items:center;gap:8px;pointer-events:none}
.mv-dock>*{pointer-events:auto}
.mv-bar,.mv-logo{height:32px;border-radius:8px;background:#172232;box-shadow:0 0 0 1px rgb(255 255 255/.11),0 1px 2px rgb(0 0 0/.2),0 2px 6px rgb(0 0 0/.2)}
.mv-bar{display:flex;align-items:center}
.mv-bar button{height:32px;display:flex;align-items:center;justify-content:center;border:0;padding:0;background:none;color:#e9eff7;font:500 12px/1 system-ui,sans-serif;cursor:pointer;transition:color .15s}
.mv-bar .step{width:32px;color:#9199a4}.mv-bar .step:hover{color:#e9eff7}
#mv-zoom{width:44px;font-variant-numeric:tabular-nums}
.mv-bar i{width:1px;height:16px;background:#273242}
#mv-fit{gap:6px;padding:0 10px}#mv-fit:hover{color:#9199a4}
.mv-logo{width:32px;margin-left:auto;display:flex;align-items:center;justify-content:center;color:#9199a4;transition:color .15s,background-color .15s}
.mv-logo:hover{color:#e9eff7;background:#202b3b}
.mv-dock svg{display:block}.mv-dock :focus-visible{outline:2px solid #91bdff;outline-offset:2px}
#mv-menu{position:fixed;z-index:4;min-width:200px;max-width:min(280px,calc(100vw - 16px));padding:4px;border-radius:10px;background:#172232;box-shadow:0 0 0 1px rgb(255 255 255/.11),0 8px 24px rgb(0 0 0/.45);font:400 13px/1 system-ui,sans-serif}
#mv-menu[hidden],#mv-scrim[hidden]{display:none}
#mv-menu .head{padding:10px 10px 8px;color:#9199a4;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mv-menu button{display:flex;align-items:center;width:100%;height:32px;padding:0 10px;border:0;border-radius:6px;background:none;color:#e9eff7;font:inherit;text-align:left;cursor:pointer}
#mv-menu button:hover,#mv-menu button:focus{background:#24324a;outline:none}
#mv-menu button kbd{margin-left:auto;padding-left:16px;color:#9199a4;font:inherit}
#mv-menu hr{height:1px;margin:4px 6px;border:0;background:#273242}
#mv-menu.sheet{left:8px!important;right:8px;top:auto!important;bottom:8px;max-width:none;padding:6px;border-radius:14px;font-size:15px}
#mv-menu.sheet button{height:46px;padding:0 12px}
#mv-scrim{position:fixed;inset:0;z-index:3;background:rgb(0 0 0/.35)}
#mv-toast{position:fixed;left:50%;bottom:64px;z-index:5;padding:9px 14px;border-radius:8px;background:#e9eff7;color:#111922;font:500 13px/1.2 system-ui,sans-serif;transform:translate(-50%,8px);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:calc(100vw - 32px);text-align:center}
#mv-toast.shown{opacity:1;transform:translate(-50%,0)}
body.mv-artifact main{position:fixed;inset:0;background:white}
body.mv-artifact main iframe{display:block;width:100%;height:100%;border:0}
@media (prefers-reduced-motion:reduce){#mv-toast,.mv-cap button,.mv-shield span{transition:none}}
`;

function mvStart(config) {
  const run = () => {
    const legacy = [...document.querySelectorAll("header, footer, .dock, style:not(#mv-style)")];
    for (const element of legacy) element.remove();
    if (!document.querySelector("h1")) {
      const heading = document.createElement("h1");
      heading.className = "sr";
      heading.textContent = document.title.replace(/ \| Milagre (Designs|Artifact)$/, "");
      document.body.prepend(heading);
    } else document.querySelector("h1").className = "sr";
    document.body.classList.add("mv");
    if (document.querySelector("#canvas[data-present]")) mvPresent(config);
    else if (document.querySelector("#canvas")) mvDesigns(config);
    else mvArtifact(config);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

function mvArtifact(config) {
  document.body.classList.add("mv-artifact");
  const dock = document.createElement("div");
  dock.className = "mv-dock";
  dock.innerHTML = `<a class="mv-logo" href="https://milagre.cloud" target="_blank" rel="noopener noreferrer" aria-label="Made with Milagre">${config.icons.logo}</a>`;
  document.body.append(dock);
}

function mvDesigns(config) {
  const old = document.getElementById("canvas");
  const port = document.createElement("main");
  port.id = "mv-port";
  port.tabIndex = 0;
  port.setAttribute("aria-label", "Designs canvas. Drag to pan, pinch or use plus and minus to zoom. Right-click a frame to download it.");
  const canvas = document.createElement("div");
  canvas.id = "mv-canvas";
  canvas.append(...old.childNodes);
  canvas.classList.toggle("grouped", !!canvas.querySelector(":scope > section"));
  port.append(canvas);
  (old.closest("main") ?? old).replaceWith(port);
  const view = { config, port, canvas, x: 0, y: 0, scale: 1, moved: false, active: null, menu: null };
  view.frames = mvFrames(view);
  mvCamera(view);
  mvActions(view);
  mvMenu(view);
  mvDock(view);
  mvGestures(view);
  mvKeys(view);
  const target = view.frameFromHash();
  if (target) view.zoomToFrame(target, false);
  else view.fit(false);
  new ResizeObserver(() => {
    if (!view.moved) view.fit(false);
  }).observe(port);
  window.addEventListener("hashchange", () => {
    const frame = view.frameFromHash();
    if (frame) view.zoomToFrame(frame, true);
  });
  mvHint(view);
}

function mvFrames(view) {
  const slugs = new Map();
  return [...view.canvas.querySelectorAll("figure")].map((fig, index) => {
    const caption = fig.querySelector("figcaption");
    const name = (caption?.textContent ?? "").trim() || `Frame ${index + 1}`;
    const element = fig.querySelector("img, iframe");
    const live = element?.tagName === "IFRAME";
    const base =
      name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "") || "frame";
    const count = (slugs.get(base) ?? 0) + 1;
    slugs.set(base, count);
    const frame = { fig, name, live, element, index, slug: count > 1 ? `${base}-${count}` : base };
    const label = document.createElement("div");
    label.className = "mv-cap";
    const title = document.createElement("span");
    title.textContent = name;
    label.append(title);
    if (live) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Live";
      label.append(tag);
      const done = document.createElement("button");
      done.type = "button";
      done.className = "mv-done";
      done.textContent = "Done";
      done.hidden = true;
      label.append(done);
      frame.done = done;
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "mv-more";
    more.setAttribute("aria-label", `More for ${name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.innerHTML = view.config.icons.more;
    label.append(more);
    frame.more = more;
    const newCaption = document.createElement("figcaption");
    newCaption.append(label);
    if (caption) caption.replaceWith(newCaption);
    else fig.prepend(newCaption);
    const surface = document.createElement("div");
    surface.className = "mv-surface";
    if (element) {
      element.replaceWith(surface);
      surface.append(element);
      element.setAttribute("draggable", "false");
      element.removeAttribute("style");
    }
    if (live) {
      element.setAttribute("tabindex", "-1");
      const shield = document.createElement("div");
      shield.className = "mv-shield";
      shield.innerHTML = "<span>Click to interact</span>";
      surface.append(shield);
    }
    frame.surface = surface;
    fig.removeAttribute("style");
    fig.style.width = `${element?.getAttribute("width") ?? element?.width ?? 0}px`;
    fig.tabIndex = 0;
    fig.dataset.frame = String(index);
    fig.setAttribute("aria-label", live ? `${name}, interactive` : name);
    return frame;
  });
}

function mvCamera(view) {
  const { port, canvas } = view;
  const label = () => document.getElementById("mv-zoom");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let inverse = 1;
  canvas.style.setProperty("--inv", "1");
  let idle = 0;
  let animation = 0;
  const clamp = (value) => Math.max(0.0005, Math.min(8, value));
  view.paint = () => {
    canvas.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`;
    if (inverse !== 1 / view.scale) {
      inverse = 1 / view.scale;
      canvas.style.setProperty("--inv", String(inverse));
    }
    const text = label();
    if (text) text.textContent = `${view.scale < 0.1 ? Math.round(view.scale * 1000) / 10 : Math.round(view.scale * 100)}%`;
  };
  view.moving = () => {
    canvas.classList.add("moving");
    clearTimeout(idle);
    idle = setTimeout(() => canvas.classList.remove("moving"), 160);
  };
  view.stop = () => {
    cancelAnimationFrame(animation);
    delete canvas.dataset.animating;
  };
  view.set = (next, animate) => {
    view.stop();
    if (!animate || reduced.matches) {
      Object.assign(view, next);
      view.paint();
      return;
    }
    canvas.dataset.animating = "";
    const from = { x: view.x, y: view.y, scale: view.scale };
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 260);
      const e = 1 - (1 - t) ** 3;
      const scale = from.scale * (next.scale / from.scale) ** e;
      const k = from.scale === next.scale ? e : (scale - from.scale) / (next.scale - from.scale);
      view.scale = scale;
      view.x = from.x + (next.x - from.x) * k;
      view.y = from.y + (next.y - from.y) * k;
      view.paint();
      view.moving();
      if (t < 1) animation = requestAnimationFrame(step);
      else delete canvas.dataset.animating;
    };
    animation = requestAnimationFrame(step);
  };
  view.zoomAt = (factor, px = port.clientWidth / 2, py = port.clientHeight / 2, animate = false) => {
    const scale = clamp(view.scale * factor);
    view.moved = true;
    view.set({ scale, x: px - ((px - view.x) * scale) / view.scale, y: py - ((py - view.y) * scale) / view.scale }, animate);
  };
  view.pan = (dx, dy) => {
    view.stop();
    view.moved = true;
    view.x += dx;
    view.y += dy;
    view.paint();
    view.moving();
  };
  const measure = (scale, box) => {
    const saved = inverse;
    canvas.style.setProperty("--inv", String(1 / scale));
    const size = box();
    canvas.style.setProperty("--inv", String(saved));
    return size;
  };
  const solve = (box, room, cap) => {
    let scale = view.scale;
    for (let i = 0; i < 4; i++) {
      const size = measure(scale, box);
      scale = clamp(Math.min(cap, room.width / Math.max(1, size.w), room.height / Math.max(1, size.h)));
    }
    return { scale, size: measure(scale, box) };
  };
  const room = () => {
    const pad = port.clientWidth < 600 ? 16 : 48;
    return { left: pad, top: pad, width: Math.max(1, port.clientWidth - 2 * pad), height: Math.max(1, port.clientHeight - pad - 64) };
  };
  view.fit = (animate = true) => {
    const space = room();
    const { scale, size } = solve(() => ({ x: 0, y: 0, w: canvas.offsetWidth, h: canvas.offsetHeight }), space, 1);
    view.moved = false;
    view.set({ scale, x: space.left + (space.width - size.w * scale) / 2, y: space.top + (space.height - size.h * scale) / 2 }, animate);
  };
  const frameBox = (frame) => () => {
    let x = 0;
    let y = 0;
    for (let node = frame.surface; node && node !== canvas; node = node.offsetParent) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { x, y, w: frame.surface.offsetWidth, h: frame.surface.offsetHeight };
  };
  view.zoomToFrame = (frame, animate = true) => {
    const space = room();
    space.top += 24;
    space.height -= 24;
    const { scale, size } = solve(frameBox(frame), space, 2);
    view.moved = true;
    view.set(
      { scale, x: space.left + (space.width - size.w * scale) / 2 - size.x * scale, y: space.top + (space.height - size.h * scale) / 2 - size.y * scale },
      animate,
    );
  };
  view.frameFromHash = () => {
    const slug = decodeURIComponent(/^#frame=(.+)$/.exec(location.hash)?.[1] ?? "");
    return slug ? view.frames.find((frame) => frame.slug === slug) : undefined;
  };
}

function mvActions(view) {
  const toast = document.createElement("div");
  toast.id = "mv-toast";
  toast.setAttribute("role", "status");
  document.body.append(toast);
  let hide = 0;
  view.toast = (text, long = false) => {
    toast.textContent = text;
    toast.classList.add("shown");
    clearTimeout(hide);
    hide = setTimeout(() => toast.classList.remove("shown"), long ? 4200 : 1800);
  };
  const file = (frame, extension) => `${frame.slug}.${extension}`;
  const save = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const png = (frame) =>
    new Promise((resolve, reject) => {
      const image = frame.element;
      const width = image.naturalWidth || Number(image.getAttribute("width"));
      const height = image.naturalHeight || Number(image.getAttribute("height"));
      const density = Math.max(0.1, Math.min(2, Math.sqrt(16_000_000 / Math.max(1, width * height))));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * density);
      canvas.height = Math.round(height * density);
      const context = canvas.getContext("2d");
      if (!context) return reject(Error("No canvas"));
      try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(Error("Empty image"))), "image/png");
      } catch (error) {
        reject(error);
      }
    });
  const svg = (frame) => {
    const source = frame.element.getAttribute("src") ?? "";
    const comma = source.indexOf(",");
    const data = source.slice(comma + 1);
    const text = /;base64,/.test(source.slice(0, comma + 1)) ? atob(data) : decodeURIComponent(data);
    return new Blob([text], { type: "image/svg+xml" });
  };
  const link = (frame) => {
    const url = new URL(location.href);
    url.hash = frame ? `frame=${encodeURIComponent(frame.slug)}` : "";
    return url.href;
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const field = document.createElement("textarea");
      field.value = text;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      return copied;
    }
  };
  view.actions = {
    async downloadPng(frame) {
      try {
        save(await png(frame), file(frame, "png"));
      } catch {
        view.toast("This browser can't make a PNG of this frame. Download the SVG instead.", true);
      }
    },
    downloadSvg(frame) {
      save(svg(frame), file(frame, "svg"));
    },
    downloadHtml(frame) {
      save(new Blob([frame.element.getAttribute("srcdoc") ?? ""], { type: "text/html" }), file(frame, "html"));
    },
    async copyImage(frame) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png(frame) })]);
        view.toast("Image copied");
      } catch {
        view.toast("This browser can't copy images. Download the PNG instead.", true);
      }
    },
    async copyLink(frame) {
      view.toast((await copyText(link(frame))) ? "Link copied" : "Couldn't copy the link");
    },
  };
  view.activate = (frame) => {
    if (view.active === frame) return;
    view.deactivate();
    view.active = frame;
    frame.fig.classList.add("on");
    frame.done.hidden = false;
    frame.element.removeAttribute("tabindex");
    frame.element.focus();
  };
  view.deactivate = () => {
    const frame = view.active;
    if (!frame) return;
    view.active = null;
    frame.fig.classList.remove("on");
    frame.done.hidden = true;
    frame.element.setAttribute("tabindex", "-1");
  };
  for (const frame of view.frames) {
    if (!frame.done) continue;
    frame.done.addEventListener("click", (event) => {
      event.stopPropagation();
      view.deactivate();
      frame.fig.focus({ preventScroll: true });
    });
  }
}

function mvMenu(view) {
  const menu = document.createElement("div");
  menu.id = "mv-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const scrim = document.createElement("div");
  scrim.id = "mv-scrim";
  scrim.hidden = true;
  document.body.append(scrim, menu);
  let returnFocus = null;
  const entries = (frame) => {
    const { actions } = view;
    if (!frame)
      return [
        ["Fit everything", () => view.fit(), "0"],
        ["Zoom to 100%", () => view.zoomAt(1 / view.scale, undefined, undefined, true), "1"],
        null,
        ["Copy link", () => actions.copyLink()],
      ];
    const common = [null, ["Zoom to frame", () => view.zoomToFrame(frame), "Double-click"], ["Copy link to frame", () => actions.copyLink(frame)]];
    if (frame.live) return [["Interact", () => view.activate(frame)], ["Download HTML", () => actions.downloadHtml(frame)], ...common];
    return [
      ["Download PNG", () => actions.downloadPng(frame)],
      ["Download SVG", () => actions.downloadSvg(frame)],
      ["Copy image", () => actions.copyImage(frame)],
      ...common,
    ];
  };
  view.menuOpen = () => !menu.hidden;
  view.closeMenu = (restore = true) => {
    if (menu.hidden) return;
    menu.hidden = true;
    scrim.hidden = true;
    view.menu?.fig.classList.remove("menu");
    view.menu = null;
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };
  view.openMenu = (frame, x, y, sheet) => {
    view.closeMenu(false);
    returnFocus = document.activeElement;
    view.menu = frame ? { fig: frame.fig } : null;
    frame?.fig.classList.add("menu");
    menu.replaceChildren();
    menu.className = sheet ? "sheet" : "";
    menu.setAttribute("aria-label", frame ? frame.name : "Canvas");
    if (sheet) {
      const head = document.createElement("div");
      head.className = "head";
      head.textContent = frame ? frame.name : "Canvas";
      menu.append(head);
    }
    for (const entry of entries(frame)) {
      if (!entry) {
        menu.append(document.createElement("hr"));
        continue;
      }
      const [text, run, key] = entry;
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = text;
      if (key && !sheet) {
        const hint = document.createElement("kbd");
        hint.textContent = key;
        item.append(hint);
      }
      item.addEventListener("click", () => {
        view.closeMenu(!frame?.live || text !== "Interact");
        run();
      });
      menu.append(item);
    }
    menu.hidden = false;
    scrim.hidden = !sheet;
    if (!sheet) {
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
      menu.style.top = `${Math.max(8, y + box.height > innerHeight - 8 ? y - box.height : y)}px`;
    }
    menu.querySelector("button")?.focus({ preventScroll: true });
  };
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      view.closeMenu();
    }
    event.stopPropagation();
  });
  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  scrim.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    view.closeMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !event.target.closest?.(".mv-more")) view.closeMenu(false);
  });
  for (const frame of view.frames)
    frame.more.addEventListener("click", (event) => {
      event.stopPropagation();
      if (view.menu?.fig === frame.fig) return view.closeMenu();
      const box = frame.more.getBoundingClientRect();
      view.openMenu(frame, box.left, box.bottom + 4, matchMedia("(hover: none)").matches);
    });
}

function mvDock(view) {
  const { icons } = view.config;
  const dock = document.createElement("div");
  dock.className = "mv-dock";
  dock.innerHTML = `<nav class="mv-bar" aria-label="Canvas zoom"><button id="mv-out" class="step" type="button" aria-label="Zoom out">${icons.minus}</button><button id="mv-zoom" type="button" aria-label="Zoom to 100%"></button><button id="mv-in" class="step" type="button" aria-label="Zoom in">${icons.plus}</button><i aria-hidden="true"></i><button id="mv-fit" type="button" aria-label="Fit everything">${icons.fit}Fit</button></nav><a class="mv-logo" href="https://milagre.cloud" target="_blank" rel="noopener noreferrer" aria-label="Made with Milagre">${icons.logo}</a>`;
  document.body.append(dock);
  document.getElementById("mv-in").addEventListener("click", () => view.zoomAt(1.25, undefined, undefined, true));
  document.getElementById("mv-out").addEventListener("click", () => view.zoomAt(0.8, undefined, undefined, true));
  document.getElementById("mv-zoom").addEventListener("click", () => view.zoomAt(1 / view.scale, undefined, undefined, true));
  document.getElementById("mv-fit").addEventListener("click", () => view.fit());
}

function mvGestures(view) {
  const { port } = view;
  const points = new Map();
  let drag = null;
  let lastTap = null;
  let press = 0;
  let pressed = 0;
  let glide = 0;
  let gesture = 1;
  const frameAt = (target) => {
    const fig = target?.closest?.("figure[data-frame]");
    return fig ? view.frames[Number(fig.dataset.frame)] : undefined;
  };
  const local = (event) => {
    const box = port.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const tap = (target, event) => {
    const frame = frameAt(target);
    const now = performance.now();
    const double = lastTap && now - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 24;
    lastTap = double ? null : { time: now, x: event.clientX, y: event.clientY };
    if (double) {
      if (frame) view.zoomToFrame(frame);
      else view.fit();
      return;
    }
    if (frame?.live && target.closest(".mv-shield")) view.activate(frame);
  };
  const fling = (vx, vy) => {
    const step = () => {
      vx *= 0.94;
      vy *= 0.94;
      if (Math.hypot(vx, vy) < 0.02) return;
      view.pan(vx * 16, vy * 16);
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };
  port.addEventListener("pointerdown", (event) => {
    cancelAnimationFrame(glide);
    view.stop();
    if (view.active && !view.active.fig.contains(event.target)) view.deactivate();
    if (event.target.closest("button, a, iframe")) return;
    if (event.button !== 0 && event.button !== 1) return;
    port.setPointerCapture(event.pointerId);
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size === 1) {
      drag = {
        x: event.clientX,
        y: event.clientY,
        target: event.target,
        moved: false,
        samples: [[performance.now(), event.clientX, event.clientY]],
        type: event.pointerType,
      };
      if (event.pointerType !== "mouse") {
        const frame = frameAt(event.target);
        const [x, y] = [event.clientX, event.clientY];
        press = setTimeout(() => {
          if (!drag || drag.moved) return;
          drag.moved = true;
          pressed = performance.now();
          view.openMenu(frame, x, y, true);
        }, 480);
      }
    } else {
      clearTimeout(press);
      if (drag) drag.moved = true;
    }
  });
  port.addEventListener("pointermove", (event) => {
    const old = points.get(event.pointerId);
    if (!old) return;
    if (points.size === 1 && drag) {
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
        drag.moved = true;
        clearTimeout(press);
        port.classList.add("grabbing");
      }
      if (drag.moved && !pressed) view.pan(event.clientX - old.x, event.clientY - old.y);
      drag.samples.push([performance.now(), event.clientX, event.clientY]);
      if (drag.samples.length > 6) drag.samples.shift();
    } else if (points.size === 2) {
      const other = [...points].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(old.x - other.x, old.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      const box = port.getBoundingClientRect();
      if (before > 0) view.zoomAt(after / before, (old.x + other.x) / 2 - box.left, (old.y + other.y) / 2 - box.top);
      view.pan((event.clientX - old.x) / 2, (event.clientY - old.y) / 2);
    }
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });
  const release = (event) => {
    if (!points.delete(event.pointerId)) return;
    clearTimeout(press);
    port.classList.remove("grabbing");
    if (points.size || !drag) return;
    const ended = drag;
    drag = null;
    if (pressed) {
      pressed = 0;
      return;
    }
    if (event.type === "pointerup" && !ended.moved) return tap(ended.target, event);
    const [first, last] = [ended.samples[0], ended.samples.at(-1)];
    const span = last[0] - first[0];
    if (ended.type === "touch" && span > 0 && performance.now() - last[0] < 60) fling((last[1] - first[1]) / span, (last[2] - first[2]) / span);
  };
  port.addEventListener("pointerup", release);
  port.addEventListener("pointercancel", release);
  port.addEventListener("lostpointercapture", release);
  port.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      cancelAnimationFrame(glide);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? port.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const [x, y] = local(event);
        view.zoomAt(Math.exp(-event.deltaY * unit * 0.01), x, y);
        view.moving();
      } else view.pan(-event.deltaX * unit, -event.deltaY * unit);
    },
    { passive: false },
  );
  port.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    gesture = 1;
  });
  port.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    const [x, y] = local(event);
    view.zoomAt(event.scale / gesture, x, y);
    view.moving();
    gesture = event.scale;
  });
  port.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (pressed || view.menuOpen()) return;
    view.openMenu(frameAt(event.target), event.clientX, event.clientY, false);
  });
  port.addEventListener("scroll", () => {
    if (!port.scrollLeft && !port.scrollTop) return;
    const [dx, dy] = [port.scrollLeft, port.scrollTop];
    port.scrollLeft = 0;
    port.scrollTop = 0;
    view.pan(-dx, -dy);
  });
}

function mvKeys(view) {
  const typing = (target) => target?.closest?.("input, textarea, [contenteditable]");
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || typing(event.target) || event.altKey) return;
    const fig = event.target?.closest?.("figure[data-frame]");
    const frame = fig ? view.frames[Number(fig.dataset.frame)] : undefined;
    const command = event.ctrlKey || event.metaKey;
    const step = event.shiftKey ? 400 : 80;
    const keys = {
      Escape: () => (view.menuOpen() ? view.closeMenu() : view.deactivate()),
      "+": () => view.zoomAt(1.25, undefined, undefined, true),
      "=": () => view.zoomAt(1.25, undefined, undefined, true),
      "-": () => view.zoomAt(0.8, undefined, undefined, true),
      0: () => view.fit(),
      1: () => view.zoomAt(1 / view.scale, undefined, undefined, true),
      ArrowLeft: () => view.pan(step, 0),
      ArrowRight: () => view.pan(-step, 0),
      ArrowUp: () => view.pan(0, step),
      ArrowDown: () => view.pan(0, -step),
      Enter: frame && event.target === fig ? () => view.zoomToFrame(frame) : undefined,
      ContextMenu: () => openAt(frame),
      F10: event.shiftKey ? () => openAt(frame) : undefined,
    };
    function openAt(target) {
      const box = (target?.surface ?? view.port).getBoundingClientRect();
      view.openMenu(target, box.left + Math.min(box.width / 2, 120), box.top + Math.min(box.height / 2, 120), false);
    }
    const run = keys[event.key];
    if (!run || command) return;
    event.preventDefault();
    run();
  });
}

function mvHint(view) {
  try {
    if (localStorage.getItem("mv-hint")) return;
    localStorage.setItem("mv-hint", "1");
  } catch {
    return;
  }
  const touch = matchMedia("(hover: none)").matches;
  setTimeout(() => view.toast(touch ? "Press and hold a frame to download it" : "Right-click a frame to download it", true), 600);
}

const FUNCTIONS = [mvStart, mvArtifact, mvDesigns, mvFrames, mvCamera, mvActions, mvMenu, mvDock, mvGestures, mvKeys, mvHint, mvPresent];

const SCRIPT = `(()=>{${FUNCTIONS.map(String).join("\n")}\n${mvStart.name}(${JSON.stringify({ icons: ICONS, present: PRESENT_ICONS })})})()`.replaceAll(
  "</",
  "<\\/",
);

/** The `<style>` and `<script>` the service inserts into a page's `<head>` when the page is read. */
export const VIEWER_HEAD = `<style id="mv-style">${(STYLE + PRESENT_STYLE).replace(/\n/g, "")}</style><script>${SCRIPT}</script>`;

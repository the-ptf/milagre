/**
 * The viewer for a `selection` page: the designs the user picked, one at a time in their order. The stored page is the
 * same canvas markup with `#canvas[data-present]`; this takes over its `figure`s. Interactive designs take clicks
 * directly, so moving between screens is the arrows, the keyboard and a swipe outside the screen.
 *
 * Like `viewer.mjs`, the browser runs these functions from their source, so they use only browser globals and each other.
 */

export const PRESENT_STYLE = `
body.mv-present{background:#0d141c}
#mv-stage{position:fixed;inset:0;display:flex;flex-direction:column;touch-action:pan-y}
.mvp-top{display:flex;align-items:center;gap:12px;height:52px;padding:0 20px;flex-shrink:0;font:500 13px/1 system-ui,sans-serif;color:#9199a4;white-space:nowrap}
.mvp-top b{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e5edf3;font-weight:600}
.mvp-top span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.mvp-top i{width:1px;height:14px;background:#273242;flex-shrink:0}
#mvp-slides{position:relative;flex:1;min-height:0}
.mvp-slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.mvp-slide[hidden]{display:none}
.mvp-screen{flex-shrink:0;transform-origin:center;box-shadow:0 8px 40px #0007;background:white}
.mvp-screen>img,.mvp-screen>iframe{display:block;border:0}
.mvp-dock{display:flex;align-items:center;justify-content:center;gap:8px;height:64px;flex-shrink:0;padding:0 16px}
.mvp-bar{display:flex;align-items:center;height:36px;border-radius:10px;background:#172232;box-shadow:0 0 0 1px rgb(255 255 255/.11),0 2px 6px rgb(0 0 0/.25)}
.mvp-bar button{display:flex;align-items:center;justify-content:center;width:40px;height:36px;border:0;padding:0;background:none;color:#e9eff7;cursor:pointer}
.mvp-bar button:disabled{color:#4a5666;cursor:default}
.mvp-bar button:not(:disabled):hover{background:rgb(255 255 255/.06)}
#mvp-count{min-width:64px;text-align:center;font:500 12px/1 system-ui,sans-serif;color:#e9eff7;font-variant-numeric:tabular-nums}
.mvp-dock .mv-logo{position:absolute;right:16px;margin:0}
.mvp-dock :focus-visible{outline:2px solid #91bdff;outline-offset:2px}
@media (max-width:600px){.mvp-top{padding:0 12px;height:44px}.mvp-dock .mv-logo{display:none}}
`;

export const PRESENT_ICONS = {
  prev: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};

/** Imported by the viewer, not called by name from a string, so a bundler that renames it renames the call too. */
export function mvPresent(config) {
  const old = document.getElementById("canvas");
  const title = document.querySelector("h1")?.textContent ?? "";
  const stage = document.createElement("main");
  stage.id = "mv-stage";
  stage.setAttribute("aria-label", "Designs presentation. Use the arrow keys or swipe to move between screens.");
  const top = document.createElement("header");
  top.className = "mvp-top";
  const name = document.createElement("b");
  name.textContent = title;
  const divider = document.createElement("i");
  const screenName = document.createElement("span");
  screenName.setAttribute("aria-live", "polite");
  top.append(name, divider, screenName);
  const slides = document.createElement("div");
  slides.id = "mvp-slides";
  const frames = [...old.querySelectorAll("figure")].map((fig, index) => {
    const caption = (fig.querySelector("figcaption")?.textContent ?? "").trim() || `Screen ${index + 1}`;
    const media = fig.querySelector("img, iframe");
    const width = Number(media?.getAttribute("width")) || 390;
    const height = Number(media?.getAttribute("height")) || 844;
    const slide = document.createElement("section");
    slide.className = "mvp-slide";
    slide.setAttribute("aria-label", caption);
    const screen = document.createElement("div");
    screen.className = "mvp-screen";
    screen.style.width = `${width}px`;
    screen.style.height = `${height}px`;
    if (media) {
      if (media.tagName === "IFRAME") media.removeAttribute("class");
      screen.append(media);
    }
    slide.append(screen);
    slides.append(slide);
    return { slide, screen, caption, width, height };
  });
  const dock = document.createElement("nav");
  dock.className = "mvp-dock";
  dock.setAttribute("aria-label", "Screens");
  dock.innerHTML = `<div class="mvp-bar"><button id="mvp-prev" type="button" aria-label="Previous screen">${config.present.prev}</button><span id="mvp-count"></span><button id="mvp-next" type="button" aria-label="Next screen">${config.present.next}</button></div><a class="mv-logo" href="https://milagre.cloud" target="_blank" rel="noopener noreferrer" aria-label="Made with Milagre">${config.icons.logo}</a>`;
  stage.append(top, slides, dock);
  (old.closest("main") ?? old).replaceWith(stage);
  document.body.classList.add("mv-present");
  const prev = document.getElementById("mvp-prev");
  const next = document.getElementById("mvp-next");
  const count = document.getElementById("mvp-count");
  let current = -1;
  const fit = () => {
    const pad = slides.clientWidth < 600 ? 12 : 32;
    const room = { width: Math.max(1, slides.clientWidth - 2 * pad), height: Math.max(1, slides.clientHeight - 2 * pad) };
    for (const frame of frames) frame.screen.style.transform = `scale(${Math.min(2, room.width / frame.width, room.height / frame.height)})`;
  };
  const show = (index, push = true) => {
    const target = Math.max(0, Math.min(frames.length - 1, index));
    if (target === current) return;
    current = target;
    frames.forEach((frame, at) => (frame.slide.hidden = at !== target));
    screenName.textContent = frames[target].caption;
    count.textContent = `${target + 1} of ${frames.length}`;
    prev.disabled = target === 0;
    next.disabled = target === frames.length - 1;
    const hash = `#screen=${target + 1}`;
    if (push && location.hash !== hash) history.replaceState(null, "", hash);
  };
  const fromHash = () => Number(/^#screen=(\d+)$/.exec(location.hash)?.[1] ?? 1) - 1;
  prev.addEventListener("click", () => show(current - 1));
  next.addEventListener("click", () => show(current + 1));
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const keys = { ArrowLeft: -1, ArrowUp: -1, PageUp: -1, ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1 };
    if (event.key === "Home") show(0);
    else if (event.key === "End") show(frames.length - 1);
    else if (keys[event.key]) show(current + keys[event.key]);
    else return;
    event.preventDefault();
  });
  let swipe = null;
  slides.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") swipe = { x: event.clientX, y: event.clientY };
  });
  slides.addEventListener("pointerup", (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) show(current + (dx < 0 ? 1 : -1));
  });
  slides.addEventListener("pointercancel", () => (swipe = null));
  window.addEventListener("hashchange", () => show(fromHash(), false));
  new ResizeObserver(fit).observe(slides);
  fit();
  show(fromHash());
}

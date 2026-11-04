// Scripts the Browser panel runs inside a page (webview executeJavaScript, later CDP Runtime.evaluate for the phone).
// They run in the page's own world, so they can read React's fibers off the DOM; everything they draw lives in a closed
// shadow root on a custom element, so the page's styles can't reach it and its scripts can't read it.

// Computed styles worth sending: what decides an element's size, place and look.
const STYLES = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "border-radius",
];

/** The page background covers the whole document, including blank space below a short body. */
// Keep injected functions as source: Hermes does not preserve Function.prototype.toString() bodies.
const BOUNDS = `function bounds(el) {
  return el === document.documentElement
    ? { left: -scrollX, top: -scrollY, width: Math.max(innerWidth, el.scrollWidth), height: Math.max(innerHeight, el.scrollHeight) }
    : el.getBoundingClientRect();
}`;

/** Reads an element into the shape PageElement describes. Runs in the page; kept as source for the scripts below. */
const DESCRIBE = `function describe(el, styleNames, bounds) {
  const DEBUG_SOURCE = "_debugSource";
  const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|auth|session|cookie|signature/i;
  const SECRET_VALUE = /^(?:[A-Za-z0-9+/_-]{32,}={0,2}|eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+)$/;
  const clip = (text, max) => (text || "").replace(/\\s+/g, " ").trim().slice(0, max);
  const tag = el.tagName.toLowerCase();
  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\\w-]/g, "\\\\$&"));
  // An id that is unique and doesn't look generated, else a path of tags (with a class or two) and nth-of-type.
  const selector = (() => {
    if (el.id && !/\\d{3,}|:/.test(el.id) && document.querySelectorAll(\`#\${cssEscape(el.id)}\`).length === 1) return \`#\${cssEscape(el.id)}\`;
    const steps = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && steps.length < 6; node = node.parentElement) {
      let step = node.tagName.toLowerCase();
      if (node.id && !/\\d{3,}|:/.test(node.id) && document.querySelectorAll(\`#\${cssEscape(node.id)}\`).length === 1) {
        steps.unshift(\`#\${cssEscape(node.id)}\`);
        break;
      }
      const classes = [...node.classList].filter((name) => /^[a-zA-Z][\\w-]{1,30}$/.test(name) && !/\\d{3,}|^css-|^sc-|^_/.test(name)).slice(0, 2);
      if (classes.length) step += classes.map((name) => \`.\${cssEscape(name)}\`).join("");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) step += \`:nth-of-type(\${same.indexOf(node) + 1})\`;
      }
      steps.unshift(step);
    }
    return steps.join(" > ") || "html";
  })();
  const implicitRole = {
    a: "link",
    button: "button",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    img: "img",
    nav: "navigation",
    h1: "heading",
    h2: "heading",
    h3: "heading",
  };
  const role = el.getAttribute("role") || implicitRole[tag] || undefined;
  const name = clip(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.innerText, 80) || undefined;
  // React development builds hang their fiber on the node: the components around it, and where the nearest was written.
  let components;
  let source;
  const fiberKey = Object.keys(el).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
  if (fiberKey) {
    const names = [];
    for (let fiber = el[fiberKey]; fiber && names.length < 4; fiber = fiber.return) {
      const type = fiber.type;
      const component =
        typeof type === "function"
          ? type.displayName || type.name
          : type && typeof type === "object"
            ? type.displayName || type.render?.displayName || type.render?.name
            : null;
      if (component && /^[A-Z]/.test(component)) {
        names.unshift(component);
        // React's own field name (development builds before React 19).
        const debug = fiber[DEBUG_SOURCE];
        if (!source && debug?.fileName) {
          const file = String(debug.fileName).replace(/^.*?\\/(?=(src|app|pages|components|lib)\\/)/, "");
          source = \`\${file}:\${debug.lineNumber}\`;
        }
      }
    }
    if (names.length) components = names;
  }
  const label =
    el === document.documentElement
      ? "Page background"
      : \`\${components ? \`<\${components.at(-1)}> \` : ""}\${tag}\${name ? \` "\${clip(name, 40).replace(/"/g, "'")}"\` : ""}\`;
  // The HTML with values that look like secrets taken out, and form values never included.
  const copy = el.cloneNode(true);
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- a copy: setAttribute below changes the live attribute list
    for (const attribute of [...node.attributes]) {
      if (attribute.name === "value" || SECRET_NAME.test(attribute.name) || SECRET_VALUE.test(attribute.value)) node.setAttribute(attribute.name, "[redacted]");
      else if (attribute.value.length > 200) node.setAttribute(attribute.name, \`\${attribute.value.slice(0, 200)}…\`);
    }
    if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "SVG" || node.tagName === "svg") node.replaceChildren();
  }
  let html = copy.outerHTML.replace(/\\s+/g, " ");
  if (html.length > 1500) html = \`\${html.slice(0, 1500)}…\`;
  const computed = getComputedStyle(el);
  const styles = {};
  for (const style of styleNames) {
    const value = computed.getPropertyValue(style);
    if (value && value !== "normal" && value !== "none" && value !== "0px" && value !== "rgba(0, 0, 0, 0)") styles[style] = value;
  }
  const rect = bounds(el);
  return {
    selector,
    tag,
    label,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(clip(el.innerText, 200) ? { text: clip(el.innerText, 200) } : {}),
    html,
    styles,
    box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
    viewport: { width: innerWidth, height: innerHeight },
    ...(components ? { components } : {}),
    ...(source ? { source } : {}),
  };
}`;

/**
 * Arms the picker in the page: the element under the pointer is outlined and labelled, a click (or Enter) picks it, and
 * Escape cancels. Evaluates to a promise of the picked PageElement, null when cancelled (by Escape, by PAGE_PICK_CANCEL,
 * by the page navigating), or undefined when a newer picker replaced it. The page doesn't see the click.
 */
export function pagePickScript(accent = "#007df3") {
  return `(() => new Promise((resolve) => {
  const bounds = ${BOUNDS};
  const describe = ${DESCRIBE};
  // A picker already on the page ends quietly: it was replaced, not cancelled.
  window.__milagrePick?.replace?.();
  const host = document.createElement("milagre-pick");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:block;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = \`<style>
    :host{all:initial}
    .catch{position:fixed;inset:0;cursor:crosshair}
    .box{position:fixed;pointer-events:none;border:2px solid ${accent};border-radius:4px;background:${accent}14;display:none}
    .label{position:fixed;pointer-events:none;display:none;max-width:420px;padding:3px 7px;border-radius:5px;background:#1c222b;color:#fff;font:500 11px/14px -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style><div class="catch"></div><div class="box"></div><div class="label"></div>\`;
  const [catcher, box, label] = [root.querySelector(".catch"), root.querySelector(".box"), root.querySelector(".label")];
  let target = null;
  // What a person calls the element: its role and its text ("Button “Pay now”"), else its kind.
  const KINDS = { a: "Link", button: "Button", input: "Field", textarea: "Field", select: "Menu", img: "Image", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", p: "Text", li: "List item", ul: "List", ol: "List", nav: "Navigation", form: "Form", label: "Label", table: "Table", svg: "Icon", video: "Video" };
  const name = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const kind = role ? role[0].toUpperCase() + role.slice(1) : KINDS[tag] || (/^(div|section|article|main|header|footer|aside|span)$/.test(tag) ? "Box" : tag);
    const text = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.innerText || "").replace(/\\s+/g, " ").trim();
    return text ? kind + " “" + (text.length > 40 ? text.slice(0, 39) + "…" : text) + "”" : kind;
  };
  // Where the pointer last was: a comment pins there, as fractions of the picked element's box.
  let pointer = null;
  // The layer and the comment pins step aside while the page is asked what is under the pointer: Milagre's own
  // elements are never something to comment on.
  const under = (x, y) => {
    const pins = document.querySelector("milagre-pins");
    host.style.pointerEvents = "none";
    if (pins) pins.style.visibility = "hidden";
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    host.style.pointerEvents = "";
    if (pins) pins.style.visibility = "";
    return el && !/^MILAGRE-/.test(el.tagName) ? (el === document.body ? document.documentElement : el) : document.documentElement;
  };
  const show = (el) => {
    target = el;
    if (!el) { box.style.display = label.style.display = "none"; return; }
    const r = bounds(el);
    Object.assign(box.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" });
    const fiberKey = Object.keys(el).find((key) => key.startsWith("__reactFiber$"));
    let component = "";
    for (let fiber = fiberKey && el[fiberKey]; fiber && !component; fiber = fiber.return) {
      const name = typeof fiber.type === "function" ? fiber.type.displayName || fiber.type.name : "";
      if (name && /^[A-Z]/.test(name)) component = name;
    }
    label.textContent = name(el) + (component ? "  ·  " + component : "");
    label.style.display = "block";
    const top = r.top - 24 >= 0 ? r.top - 24 : Math.min(innerHeight - 22, r.top + r.height + 6);
    Object.assign(label.style, { left: Math.max(4, Math.min(r.left - 2, innerWidth - 220)) + "px", top: top + "px" });
  };
  const finish = (value) => {
    removeEventListener("keydown", onKey, true);
    removeEventListener("pagehide", cancel, true);
    removeEventListener("scroll", onScroll, true);
    host.remove();
    if (window.__milagrePick === handle) delete window.__milagrePick;
    resolve(value);
  };
  const cancel = () => finish(null);
  const pick = () => {
    if (!target) return;
    let value = null;
    try {
      value = describe(target, ${JSON.stringify(STYLES)}, bounds);
      const r = bounds(target);
      const at = (p, start, size) => size > 0 ? Math.round(Math.min(1, Math.max(0, (p - start) / size)) * 1000) / 1000 : 0.5;
      value.point = pointer ? { x: at(pointer.x, r.left, r.width), y: at(pointer.y, r.top, r.height) } : { x: 0.5, y: 0.5 };
    } catch (error) { value = null; }
    finish(value);
  };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    else if (event.key === "Enter" && target) { event.preventDefault(); event.stopImmediatePropagation(); pick(); }
  };
  const onScroll = () => target && show(target);
  catcher.addEventListener("pointermove", (event) => { pointer = { x: event.clientX, y: event.clientY }; show(under(event.clientX, event.clientY)); });
  catcher.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); pointer = { x: event.clientX, y: event.clientY }; show(under(event.clientX, event.clientY)); });
  catcher.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); pick(); });
  // A wheel scrolls the page under the layer.
  catcher.addEventListener("wheel", () => { host.style.pointerEvents = "none"; requestAnimationFrame(() => { host.style.pointerEvents = ""; }); }, { passive: true });
  addEventListener("keydown", onKey, true);
  addEventListener("pagehide", cancel, true);
  addEventListener("scroll", onScroll, true);
  const handle = { cancel, replace: () => finish(undefined) };
  window.__milagrePick = handle;
  (document.body || document.documentElement).append(host);
}))()`;
}

/**
 * The element at a point of the page, as fractions of the viewport (a tap on the phone's view of it), read like a pick:
 * evaluates to its PageElement with the point on it, or null when there is nothing to comment on there.
 */
export function pageDescribeAtScript(x, y) {
  const fraction = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);
  return `(() => {
  const bounds = ${BOUNDS};
  const describe = ${DESCRIBE};
  const px = ${fraction(x)} * innerWidth, py = ${fraction(y)} * innerHeight;
  const layers = [...document.querySelectorAll("milagre-pins, milagre-pick")];
  for (const layer of layers) layer.style.visibility = "hidden";
  let el = document.elementFromPoint(px, py);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(px, py);
    if (!inner || inner === el) break;
    el = inner;
  }
  for (const layer of layers) layer.style.visibility = "";
  if (!el || el === document.body || /^MILAGRE-/.test(el.tagName)) el = document.documentElement;
  const value = describe(el, ${JSON.stringify(STYLES)}, bounds);
  const r = bounds(el);
  const at = (p, start, size) => size > 0 ? Math.round(Math.min(1, Math.max(0, (p - start) / size)) * 1000) / 1000 : 0.5;
  value.point = { x: at(px, r.left, r.width), y: at(py, r.top, r.height) };
  return value;
})()`;
}

/** Ends a picker the page is showing, if any; its promise resolves to null. */
export const PAGE_PICK_CANCEL = "window.__milagrePick?.cancel(); true";

/**
 * Shows unresolved `pins` on the page: a numbered or sent pin on each element its selector finds, at the spot
 * the comment was left (`point`, fractions of the element's box; else its top-right corner), its tip on that spot,
 * following it as the page scrolls and changes. Resolved comments remain in Chat history. Pins whose
 * element is gone are hidden. Running it again replaces the pins; an empty list removes the layer.
 * Each pin: { n, id?, selector, point?, text, state: "pending" | "open" | "resolved", note? }. When the page defines
 * window.__milagrePinTap, tapping a pin calls it with the pin's id (or its number) instead of showing the tip.
 */
export function pagePinsScript(pins, { accent = "#007df3", green = "#199a4d", ink = "#4b5563", onInk = "#fff", showResolved = false } = {}) {
  return `(() => {
  const bounds = ${BOUNDS};
  const pins = ${JSON.stringify(pins.filter((pin) => showResolved || pin.state !== "resolved"))};
  let layer = window.__milagrePins;
  if (!layer) {
    const host = document.createElement("milagre-pins");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = \`<style>
      :host{all:initial}
      .pin{position:fixed;width:24px;height:24px;border-radius:0 12px 12px 12px;box-shadow:0 0 0 1.5px #fff,0 1px 3px rgb(0 0 0/.3);color:#fff;font:600 11px/24px -apple-system,system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:default;display:none}
      .pin svg{width:12px;height:12px;margin-top:5px}
      .tip{position:fixed;display:none;box-sizing:border-box;max-width:min(260px,calc(100vw - 8px));padding:7px 10px;border-radius:10px;background:#fff;color:#1c222b;border:1px solid #e0e1e3;box-shadow:0 4px 16px rgb(0 0 0/.12);font:400 12px/16px -apple-system,system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none}
      .tip .text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;overflow:hidden}
      .tip b{display:block;font-weight:500;color:${green};margin-top:3px}
      .tip i{display:block;font-style:normal;color:#6b7280;margin-top:3px}
    </style><div class="tip"></div>\`;
    const tip = root.querySelector(".tip");
    let items = [];
    let frame = 0, lastPositions = "";
    const place = () => {
      frame = 0;
      const positions = [];
      for (const item of items) {
        let el = null;
        try { el = document.querySelector(item.pin.selector); } catch {}
        const r = el ? bounds(el) : null;
        if (!r || (!r.width && !r.height)) { item.node.style.display = "none"; continue; }
        item.node.style.display = item.pin.hide ? "none" : "block";
        const point = item.pin.point;
        const x = point ? r.left + point.x * r.width : r.left + r.width - 12;
        const y = point ? r.top + point.y * r.height : r.top - 4;
        // An explicit point stays exactly where it was placed. Older comments without a point sit above the element.
        const top = !point && r.height <= 48 ? r.top : y;
        if (point && (x < 0 || x > innerWidth || y < 0 || y > innerHeight)) { item.node.style.display = "none"; continue; }
        item.node.style.left = Math.min(innerWidth - 24, Math.max(2, x + item.offset * 24)) + "px";
        item.node.style.top = Math.min(innerHeight - 24, Math.max(2, top)) + "px";
        positions.push({ id: item.pin.id, x, y: top, width: innerWidth, height: innerHeight });
      }
      const key = JSON.stringify(positions);
      if (key !== lastPositions) { lastPositions = key; window.__milagrePinPositions?.(positions); }
    };
    const schedule = () => { if (!frame && items.length) frame = requestAnimationFrame(place); };
    addEventListener("scroll", schedule, true);
    addEventListener("resize", schedule);
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    layer = window.__milagrePins = {
      hidden: false,
      set(next, colors) {
        tip.style.display = "none";
        for (const item of items) item.node.remove();
        const seen = new Map();
        items = next.map((pin) => {
          const offset = pin.point ? 0 : (seen.get(pin.selector) ?? 0);
          seen.set(pin.selector, offset + 1);
          const node = document.createElement("div");
          node.className = "pin";
          node.style.background = pin.state === "resolved" ? colors.green : pin.state === "open" ? colors.ink : colors.accent;
          node.style.color = pin.state === "pending" ? "#fff" : colors.onInk;
          node.textContent = String(pin.n);
          node.setAttribute("role", "button");
          node.setAttribute("aria-label", "Comment " + pin.n + ": " + pin.text);
          node.addEventListener("pointerenter", () => {
            if (window.__milagrePinTap) return;
            const text = document.createElement("span");
            text.className = "text";
            text.textContent = pin.text;
            tip.replaceChildren(text);
            if (pin.note) { const note = document.createElement("b"); note.textContent = "Resolved · " + pin.note; tip.append(note); }
            else if (pin.state === "open") { const wait = document.createElement("i"); wait.textContent = "Sent · waiting on the agent"; tip.append(wait); }
            const r = node.getBoundingClientRect();
            tip.style.display = "block";
            const right = r.right + 6 + tip.offsetWidth <= innerWidth - 4;
            tip.style.left = Math.max(4, right ? r.right + 6 : r.left - 6 - tip.offsetWidth) + "px";
            tip.style.top = Math.max(4, Math.min(innerHeight - tip.offsetHeight - 4, r.top)) + "px";
          });
          node.addEventListener("pointerleave", () => { tip.style.display = "none"; });
          // The phone's view opens a tapped pin's comment in its own box.
          node.addEventListener("click", (event) => {
            if (!window.__milagrePinTap) return;
            event.preventDefault();
            event.stopPropagation();
            tip.style.display = "none";
            window.__milagrePinTap(pin.id ?? String(pin.n));
          });
          root.append(node);
          return { pin, node, offset };
        });
        host.style.display = items.length && !this.hidden ? "block" : "none";
        if (items.length && !host.isConnected) (document.body || document.documentElement).append(host);
        place();
      },
      hide(hidden) { this.hidden = hidden; tip.style.display = "none"; host.style.display = items.length && !hidden ? "block" : "none"; },
    };
  }
  layer.set(pins, ${JSON.stringify({ accent, green, ink, onInk })});
  return pins.length;
})()`;
}

/** Hides the pins (true) or shows them again (false), for a screenshot of the page without them. */
export const pagePinsHidden = (hidden) => `window.__milagrePins?.hide(${hidden ? "true" : "false"}); true`;

/** Screen positions for native/React comment bubbles, using the same element bounds as the page picker. */
export function pagePinPositionsScript(pins) {
  return `(() => {
    const bounds = ${BOUNDS};
    return ${JSON.stringify(pins)}.flatMap(pin => {
      let el; try { el = document.querySelector(pin.selector); } catch {}
      if (!el) return [];
      const r = bounds(el);
      if (!r || (!r.width && !r.height)) return [];
      const x = r.left + (pin.point?.x ?? 0.5) * r.width;
      const y = r.top + (pin.point?.y ?? 0.5) * r.height;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return [];
      return [{ id: pin.id, x, y, width: innerWidth, height: innerHeight }];
    });
  })()`;
}

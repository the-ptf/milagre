// Milagre's agent cursor (design cu-cursor, option A): while an agent operates an app on this computer (computer use),
// a blue arrow travels to the element it acts on, outlines it, and shows the step beside it. It is drawn in a
// transparent, click-through window above everything, one per display, so the user's own pointer and focus never move.
// The host says where (computer-use:cursor, with the element's screen bounds) and when to hide.

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif}
#cursor{position:absolute;left:0;top:0;opacity:0;transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .2s ease}
#cursor svg{display:block;filter:drop-shadow(0 0 3px rgba(47,107,255,.85)) drop-shadow(0 1px 2px rgba(0,0,0,.25))}
#label{position:absolute;left:24px;top:24px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;background:#0B1B4D;color:#fff;padding:5px 11px;border-radius:13px;box-shadow:0 2px 8px rgba(11,27,77,.35)}
#label:empty{display:none}
#ring{position:absolute;border:2px solid #2F6BFF;border-radius:6px;opacity:0;box-shadow:0 0 0 4px rgba(47,107,255,.18);transition:opacity .25s ease}
@media (prefers-reduced-motion: reduce){#cursor{transition:opacity .2s ease}}
</style></head><body>
<div id="ring"></div>
<div id="cursor"><svg width="32" height="32" viewBox="0 0 32 32"><path d="M5 3 L5 25 L10.5 19.8 L14.2 28.4 L17.9 26.8 L14.3 18.4 L21.8 18.4 Z" fill="#2F6BFF" stroke="#FFFFFF" stroke-width="1.8" stroke-linejoin="round"/></svg><div id="label"></div></div>
</body></html>`;
// The arrow's tip in the 32 px drawing: it sits on the element's center.
const TIP = { x: 5, y: 3 };

/**
 * `show({ bounds, label })` moves the cursor to the element (screen points, top-left origin, as agent-desktop reports
 * them) or, without bounds, only changes the step; `hide()` fades it out.
 */
function createAgentCursor({ BrowserWindow, screen }) {
  const windows = new Map();
  let current = null;
  let last = null;

  function windowFor(display) {
    let entry = windows.get(display.id);
    if (entry && !entry.window.isDestroyed()) return entry;
    const window = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      // macOS keeps ordinary windows below the menu bar; the cursor needs the whole display.
      enableLargerThanScreen: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setBounds(display.bounds);
    const ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
    entry = { window, display, ready };
    windows.set(display.id, entry);
    return entry;
  }

  const run = (entry, script) =>
    entry.ready.then(() => (entry.window.isDestroyed() ? null : entry.window.webContents.executeJavaScript(script, true))).catch(() => {});

  function show({ bounds, label }) {
    const point = bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : last;
    if (!point) return;
    last = point;
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    const entry = windowFor(display);
    if (current && current !== entry) hideIn(current);
    current = entry;
    if (!entry.window.isVisible()) entry.window.showInactive();
    // Positions are in screen points; the page's origin is where the window really is, which macOS may have moved.
    const origin = entry.window.getContentBounds();
    const x = point.x - origin.x - TIP.x;
    const y = point.y - origin.y - TIP.y;
    const ring = bounds ? { left: bounds.x - origin.x - 3, top: bounds.y - origin.y - 3, width: bounds.width + 6, height: bounds.height + 6 } : null;
    void run(
      entry,
      `(() => {
        const cursor = document.getElementById("cursor");
        cursor.style.opacity = "1";
        cursor.style.transform = "translate(${x}px, ${y}px)";
        document.getElementById("label").textContent = ${JSON.stringify(label ?? "")};
        const ring = document.getElementById("ring");
        ${
          ring
            ? `Object.assign(ring.style, { left: "${ring.left}px", top: "${ring.top}px", width: "${ring.width}px", height: "${ring.height}px", opacity: "1" });
        clearTimeout(window.ringTimer);
        window.ringTimer = setTimeout(() => { ring.style.opacity = "0"; }, 900);`
            : ""
        }
      })()`,
    );
  }

  function hideIn(entry) {
    void run(entry, `document.getElementById("cursor").style.opacity = "0"; document.getElementById("ring").style.opacity = "0";`).then(() =>
      setTimeout(() => {
        if (!entry.window.isDestroyed() && entry !== current) entry.window.hide();
      }, 250),
    );
  }

  function hide() {
    if (!current) return;
    const entry = current;
    current = null;
    last = null;
    hideIn(entry);
  }

  function dispose() {
    for (const { window } of windows.values()) if (!window.isDestroyed()) window.destroy();
    windows.clear();
    current = null;
  }

  return { show, hide, dispose };
}

module.exports = { createAgentCursor };

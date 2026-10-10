const fs = require("node:fs");
const clamp = (value, min, max) => Math.min(Math.max(min, max), Math.max(min, value));
// Separate small windows keep transparent areas from intercepting the user's other apps.
function createFloatingInbox({ BrowserWindow, screen, preload, load, positionFile }) {
  let dock = null;
  let inbox = null;
  let preview = null;
  let previewReady = false;
  let hover = null;
  let hoverTimer;
  let springTimer;
  let inboxResizeTimer;
  let dockMorphTimer;
  let drag = null;
  const settleSpring = () => {
    clearInterval(springTimer);
    springTimer = undefined;
    if (!drag && dock && !dock.isDestroyed()) dock.setAlwaysOnTop(true, "floating");
  };
  const overlays = new Map();
  let position = null;
  const edges = ["left", "right", "bottom"];
  const nearest = (x, y, area) => {
    const points = { left: [0, area.height / 2], right: [area.width, area.height / 2], bottom: [area.width / 2, area.height] };
    return edges.reduce((best, edge) =>
      Math.hypot(x - points[edge][0], y - points[edge][1]) < Math.hypot(x - points[best][0], y - points[best][1]) ? edge : best,
    );
  };
  try {
    const saved = JSON.parse(fs.readFileSync(positionFile, "utf8"));
    if (edges.includes(saved.edge)) position = { displayId: saved.displayId, edge: saved.edge };
    else if (Number.isFinite(saved.x) && Number.isFinite(saved.y))
      position = { displayId: saved.displayId, edge: nearest(saved.x, saved.y, { width: 1, height: 1 }) };
  } catch {}
  let count = 0;
  let inboxHeight = 540;
  let expanded = false;
  let dockExpanded = false;
  let selectedKey = null;
  const display = () => screen.getAllDisplays().find((item) => item.id === position?.displayId) || screen.getPrimaryDisplay();
  const edge = () => position?.edge || "right";
  const boundsFor = (placement, target) => {
    const area = target.workArea;
    const horizontal = placement === "bottom";
    const slots = Math.min(count || 1, 5) + (count > 5 ? 1 : 0);
    const length = (dockExpanded ? 150 : 60) + slots * 31;
    const width = horizontal ? Math.min(area.width, length) : 54;
    const height = horizontal ? 54 : Math.min(area.height, length);
    return {
      x: Math.round(horizontal ? area.x + (area.width - width) / 2 : placement === "left" ? area.x : area.x + area.width - width),
      y: Math.round(horizontal ? area.y + area.height - height : area.y + (area.height - height) / 2),
      width,
      height,
    };
  };
  const hit = (point) => {
    for (const target of screen.getAllDisplays())
      for (const placement of edges) {
        const bounds = boundsFor(placement, target);
        if (point.x >= bounds.x - 20 && point.x <= bounds.x + bounds.width + 20 && point.y >= bounds.y - 20 && point.y <= bounds.y + bounds.height + 20)
          return { displayId: target.id, edge: placement };
      }
    return null;
  };
  const beside = (bounds, width, height, y) => {
    const area = display().workArea;
    if (edge() === "bottom")
      return {
        x: Math.round(clamp(y - width / 2, area.x, area.x + area.width - width)),
        y: Math.round(clamp(bounds.y - height - 8, area.y, area.y + area.height - height)),
        width,
        height,
      };
    const left = bounds.x - width - 8;
    return {
      x: Math.round(clamp(left >= area.x ? left : bounds.x + bounds.width + 8, area.x, area.x + area.width - width)),
      y: Math.round(clamp(y - height / 2, area.y, area.y + area.height - height)),
      width,
      height,
    };
  };
  const inboxBounds = () => {
    const bounds = dock.getBounds(),
      area = display().workArea;
    return beside(
      bounds,
      Math.min(410, area.width),
      Math.min(inboxHeight, area.height - (edge() === "bottom" ? 86 : 24)),
      edge() === "bottom" ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2,
    );
  };
  const placePanels = () => {
    clearInterval(inboxResizeTimer);
    inboxResizeTimer = undefined;
    if (!dock || dock.isDestroyed()) return;
    const bounds = dock.getBounds();
    const area = display().workArea;
    if (inbox && !inbox.isDestroyed()) inbox.setBounds(inboxBounds());
    if (preview && !preview.isDestroyed() && hover)
      preview.setBounds(beside(bounds, Math.min(280, area.width), 136, edge() === "bottom" ? bounds.x + hover.y : bounds.y + hover.y));
  };
  const place = () => {
    if (!dock || dock.isDestroyed() || drag) return;
    clearInterval(dockMorphTimer);
    dockMorphTimer = undefined;
    settleSpring();
    dock.setBounds(boundsFor(edge(), display()));
    dock.webContents.send("floating-inbox:placement", edge());
    placePanels();
  };
  const save = () => {
    if (!positionFile || !position) return;
    try {
      fs.writeFileSync(positionFile + ".tmp", JSON.stringify(position), { mode: 0o600 });
      fs.renameSync(positionFile + ".tmp", positionFile);
    } catch (error) {
      console.error("Could not save floating bar position:", error instanceof Error ? error.message : String(error));
    }
  };
  const overlayState = (window) => {
    const entry = [...overlays.values()].find((item) => item.window === window);
    if (!entry) return null;
    const target = screen.getAllDisplays().find((item) => item.id === entry.displayId);
    if (!target) return null;
    return {
      targets: edges.map((placement) => {
        const bounds = boundsFor(placement, target);
        return {
          edge: placement,
          x: bounds.x - target.bounds.x,
          y: bounds.y - target.bounds.y,
          width: bounds.width,
          height: bounds.height,
          active: drag?.target?.displayId === target.id && drag.target.edge === placement,
        };
      }),
    };
  };
  const updateOverlays = () => {
    for (const { window } of overlays.values()) window.webContents.send("floating-inbox:drag-overlay", overlayState(window));
  };
  const beginDrag = (reducedMotion = false) => {
    if (!dock || drag) return;
    clearInterval(dockMorphTimer);
    dockMorphTimer = undefined;
    settleSpring();
    hidePreview();
    close();
    const point = screen.getCursorScreenPoint();
    // A tall native window is constrained by the work area, so its top grip cannot
    // reach the bottom target. Keep a compact grip and logo under the pointer.
    drag = { offset: { x: 27, y: 17 }, previous: position, reducedMotion, target: hit(point) };
    dock.setBounds({ x: point.x - 27, y: point.y - 17, width: 54, height: 70 });
    dock.setAlwaysOnTop(true, "screen-saver", 1);
    for (const target of screen.getAllDisplays()) {
      let entry = overlays.get(target.id);
      if (!entry) {
        const window = make("drag");
        entry = { window, displayId: target.id, ready: false };
        overlays.set(target.id, entry);
        window.once("ready-to-show", () => {
          entry.ready = true;
          if (drag) window.showInactive();
        });
      }
      entry.window.setBounds(target.bounds);
      entry.window.setAlwaysOnTop(true, "screen-saver");
      if (entry.ready) entry.window.showInactive();
    }
    updateOverlays();
  };
  const moveDrag = () => {
    if (!drag || !dock) return;
    const point = screen.getCursorScreenPoint();
    dock.setBounds({ x: Math.round(point.x - drag.offset.x), y: Math.round(point.y - drag.offset.y) });
    const next = hit(point);
    if (next?.edge !== drag.target?.edge || next?.displayId !== drag.target?.displayId) {
      drag.target = next;
      updateOverlays();
    }
  };
  const endDrag = (cancel = false) => {
    if (!drag || !dock) return;
    const finished = drag;
    position = (!cancel && hit(screen.getCursorScreenPoint())) || finished.previous;
    drag = null;
    for (const { window } of overlays.values()) window.hide();
    const target = boundsFor(edge(), display()),
      current = dock.getBounds();
    dock.webContents.send("floating-inbox:placement", edge());
    save();
    if (finished.reducedMotion) {
      place();
      return;
    }
    let x = current.x,
      y = current.y,
      vx = 0,
      vy = 0,
      steps = 0;
    dock.setBounds({ ...current, width: target.width, height: target.height });
    springTimer = setInterval(() => {
      if (!dock || dock.isDestroyed()) {
        settleSpring();
        return;
      }
      vx += ((target.x - x) * 240 - vx * 24) * 0.016;
      vy += ((target.y - y) * 240 - vy * 24) * 0.016;
      x += vx * 0.016;
      y += vy * 0.016;
      dock.setBounds({ x: Math.round(x), y: Math.round(y) });
      if (++steps >= 70 || (Math.hypot(target.x - x, target.y - y) < 0.5 && Math.hypot(vx, vy) < 4)) {
        place();
      }
    }, 16);
  };
  const hidePreview = () => {
    clearTimeout(hoverTimer);
    hover = null;
    preview?.hide();
  };
  const close = () => {
    expanded = false;
    dock?.webContents.send("floating-inbox:open", false);
    hidePreview();
    inbox?.hide();
    placePanels();
  };
  const make = (view) => {
    const window = new BrowserWindow({
      width: view === "dock" ? 54 : view === "preview" ? 280 : 410,
      height: view === "dock" ? 118 : view === "preview" ? 136 : 700,
      title:
        view === "dock" ? "Milagre floating bar" : view === "preview" ? "Milagre Chat preview" : view === "drag" ? "Milagre snap positions" : "Milagre inbox",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      // The renderer draws the rounded surface's shadow. A native shadow outlines
      // the transparent window and leaves a dark halo around its margins on macOS.
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      ...(process.platform === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
      ...(view !== "inbox" ? { focusable: false } : {}),
      ...(view === "drag" && process.platform === "darwin" ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
      ...(view === "drag" && process.platform === "win32" ? { backgroundMaterial: "acrylic" } : {}),
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.once("ready-to-show", () => {
      if (view === "dock" && !window.isDestroyed()) window.showInactive();
      if (view === "preview" && !window.isDestroyed()) {
        previewReady = true;
        if (hover) window.showInactive();
      }
    });
    if (view === "preview" || view === "drag") window.setIgnoreMouseEvents(true);
    load(window, view);
    return window;
  };
  const displaysChanged = () => {
    if (drag) endDrag(true);
    for (const { window } of overlays.values()) window.destroy();
    overlays.clear();
    place();
  };
  screen.on("display-metrics-changed", displaysChanged);
  screen.on("display-added", displaysChanged);
  screen.on("display-removed", displaysChanged);
  return {
    setEnabled(on) {
      if (on && !dock) {
        dock = make("dock");
        inbox = make("inbox");
        inbox.on("blur", close);
        // The system Close shortcut dismisses this panel; the dock can open it again.
        inbox.on("close", (event) => {
          event.preventDefault();
          close();
        });
        place();
      } else if (!on) {
        expanded = false;
        drag = null;
        clearInterval(springTimer);
        clearInterval(inboxResizeTimer);
        clearInterval(dockMorphTimer);
        dockMorphTimer = undefined;
        inboxResizeTimer = undefined;
        for (const { window } of overlays.values()) window.destroy();
        overlays.clear();
        hidePreview();
        save();
        const old = [dock, inbox, preview];
        dock = null;
        inbox = null;
        preview = null;
        previewReady = false;
        for (const window of old) if (window && !window.isDestroyed()) window.destroy();
      }
    },
    setCount(next) {
      if (count !== next) {
        count = next;
        place();
      }
    },
    setDockExpanded(on, reducedMotion = false) {
      on = on || expanded;
      if (dockExpanded === on) {
        if (reducedMotion && dockMorphTimer) place();
        return;
      }
      dockExpanded = on;
      clearInterval(dockMorphTimer);
      dockMorphTimer = undefined;
      if (!dock || dock.isDestroyed() || drag) return;
      if (reducedMotion) {
        place();
        return;
      }
      const current = dock.getBounds(),
        target = boundsFor(edge(), display()),
        duration = on ? 240 : 180,
        started = Date.now();
      dockMorphTimer = setInterval(() => {
        if (!dock || dock.isDestroyed()) {
          clearInterval(dockMorphTimer);
          dockMorphTimer = undefined;
          return;
        }
        const progress = Math.min(1, (Date.now() - started) / duration),
          eased = 1 - Math.pow(1 - progress, 3);
        dock.setBounds(Object.fromEntries(Object.keys(target).map((key) => [key, Math.round(current[key] + (target[key] - current[key]) * eased)])));
        if (progress === 1) {
          clearInterval(dockMorphTimer);
          dockMorphTimer = undefined;
          dock.setBounds(target);
          placePanels();
        }
      }, 16);
    },
    openItem(key) {
      if (typeof key !== "string" || !key || !inbox || inbox.isDestroyed()) return;
      selectedKey = key;
      hidePreview();
      inbox.webContents.send("floating-inbox:selection", key);
      if (!expanded) {
        placePanels();
        expanded = true;
        dock?.webContents.send("floating-inbox:open", true);
        inbox.showInactive();
      }
      inbox.focus();
    },
    selectedKey: () => selectedKey,
    isOpen: () => expanded,
    setInboxHeight(height, reducedMotion = false) {
      if (!Number.isFinite(height)) return;
      const next = Math.round(clamp(height, 180, 700));
      if (next === inboxHeight && !inboxResizeTimer) return;
      inboxHeight = next;
      clearInterval(inboxResizeTimer);
      inboxResizeTimer = undefined;
      if (!inbox || inbox.isDestroyed() || !dock) return;
      const target = inboxBounds();
      if (!expanded || reducedMotion || drag) {
        inbox.setBounds(target);
        return;
      }
      const current = inbox.getBounds(),
        started = Date.now();
      inboxResizeTimer = setInterval(() => {
        if (!inbox || inbox.isDestroyed()) {
          clearInterval(inboxResizeTimer);
          inboxResizeTimer = undefined;
          return;
        }
        const progress = Math.min(1, (Date.now() - started) / 240),
          eased = 1 - Math.pow(1 - progress, 3);
        inbox.setBounds(Object.fromEntries(Object.keys(target).map((key) => [key, Math.round(current[key] + (target[key] - current[key]) * eased)])));
        if (progress === 1) {
          clearInterval(inboxResizeTimer);
          inboxResizeTimer = undefined;
          inbox.setBounds(target);
        }
      }, 16);
    },
    toggle() {
      hidePreview();
      if (!inbox || inbox.isDestroyed()) return;
      if (expanded) close();
      else {
        placePanels();
        expanded = true;
        dock?.webContents.send("floating-inbox:open", true);
        inbox.showInactive();
        inbox.focus();
      }
    },
    close,
    showPreview(key, y = 0) {
      hidePreview();
      if (!dock || typeof key !== "string" || !key) return;
      hover = { key, y: Number.isFinite(y) ? y : 0 };
      hoverTimer = setTimeout(() => {
        if (!hover || !dock) return;
        if (!preview) preview = make("preview");
        placePanels();
        preview.webContents.send("floating-inbox:preview", hover.key);
        if (previewReady) preview.showInactive();
      }, 180);
    },
    previewKey: () => hover?.key ?? null,
    placement: edge,
    beginDrag,
    moveDrag,
    endDrag,
    overlayState,
    owns: (window) => !!window && (window === dock || window === inbox || window === preview || [...overlays.values()].some((item) => item.window === window)),
    isEnabled: () => !!dock && !dock.isDestroyed(),
    dispose() {
      this.setEnabled(false);
      screen.removeListener("display-metrics-changed", displaysChanged);
      screen.removeListener("display-added", displaysChanged);
      screen.removeListener("display-removed", displaysChanged);
    },
  };
}
module.exports = { createFloatingInbox };

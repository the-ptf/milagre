// oxlint-disable eslint/no-underscore-dangle -- Tauri globals and the explicit smoke diagnostic contract.
// The production preload owns the renderer contract; this adapter replaces Electron IPC only.
const listeners = new Map();
let preferences = Object.create(null);
let preferenceWrites = Promise.resolve();
let ready;

const diagnostics = (window.__rustDiagnostics = {
  ready: false,
  startedAt: performance.now(),
  errors: [],
  calls: [],
  events: 0,
  preferencesPending: 0,
});

Object.defineProperty(diagnostics, "document", {
  enumerable: true,
  get() {
    if (typeof document === "undefined") return null;
    const root = document.getElementById("root");
    const style = root ? getComputedStyle(root) : null;
    return {
      visibility: document.visibilityState,
      rootChildren: root?.children.length,
      rootHtml: root?.innerHTML.slice(0, 5000),
      text: document.body?.textContent.slice(0, 2000),
      rootStyle: style && { display: style.display, visibility: style.visibility, opacity: style.opacity, width: style.width, height: style.height },
      animations: document
        .getAnimations()
        .slice(0, 12)
        .map((animation) => ({ name: animation.animationName, state: animation.playState, time: animation.currentTime })),
    };
  },
});

function errorOf(value) {
  if (value instanceof Error) return value;
  return Object.assign(new Error(typeof value === "string" ? value : value?.message || JSON.stringify(value)), value && typeof value === "object" ? value : {});
}
function recordError(error, method) {
  diagnostics.errors.push({ method, message: errorOf(error).message, stack: errorOf(error).stack, code: error?.code, at: performance.now() });
  if (diagnostics.errors.length > 100) diagnostics.errors.shift();
}
window.addEventListener("error", (event) => recordError(event.error || event.message, "window:error"));
window.addEventListener("unhandledrejection", (event) => recordError(event.reason, "window:unhandledrejection"));

export function dispatch(channel, payload) {
  for (const listener of Array.from(listeners.get(channel) || [])) listener({}, payload);
}

// These calls are implemented by the Rust shell, not the shared daemon. Unsupported
// user actions reject explicitly in native_call instead of reporting pretend success.
export const nativeMethods = new Set([
  "app:version",
  "app:open-keybindings-file",
  "app:set-keep-awake",
  "app:retry-quit",
  "app:terminal-focused",
  "window:start-drag",
  "window:toggle-maximize",
  "shell:open-external",
  "clipboard:write-text",
  "clipboard:read-text",
  "runtime:connection",
  "runtime:restart-host",
  "linear:connect",
  "project:open",
  "project:choose-folder",
  "project:open-at",
  "project:reveal",
  "skills:open",
  "skills:reveal",
  "editor:list",
  "editor:open",
  "artifact-preview:register",
  "artifact-preview:release",
  "image:copy",
  "image:save",
  "image:menu",
  "settings:notify-when-waiting",
  "settings:notification-chime",
  "settings:notification-schedule",
  "settings:window-background",
  "settings:floating-inbox",
  "notification:state",
  "notification:completed",
]);
const nativePrefixes = ["update:", "floating-inbox:", "browser-panel:", "app:dictation-"];

async function invoke(method, ...args) {
  if (method === "app:host-ready") return ready;
  const call = { method, at: performance.now(), pending: true };
  diagnostics.calls.push(call);
  if (diagnostics.calls.length > 300) diagnostics.calls.shift();
  try {
    await ready;
    const result = await window.__TAURI__.core.invoke(
      nativeMethods.has(method) || nativePrefixes.some((prefix) => method.startsWith(prefix)) ? "native_call" : "daemon",
      { method, args },
    );
    call.ms = performance.now() - call.at;
    return result;
  } catch (value) {
    const error = errorOf(value);
    recordError(error, method);
    call.error = error.message;
    throw error;
  } finally {
    call.pending = false;
  }
}

export const contextBridge = {
  exposeInMainWorld(name, value) {
    Object.defineProperty(window, name, { value, configurable: false });
  },
};
const attachmentPaths = new WeakMap();
export const webUtils = {
  // WKWebView does not expose disk paths. Use the renderer's existing staged-file
  // path convention; prepareLocalFileUploads uploads File bytes before a send.
  getPathForFile(file) {
    if (typeof file?.path === "string" && file.path) return file.path;
    if (!file || typeof file !== "object") return "";
    let path = attachmentPaths.get(file);
    if (!path) {
      path = `/.milagre-offline-attachments/${crypto.randomUUID()}/${String(file.name || "attachment").replaceAll("/", "_")}`;
      attachmentPaths.set(file, path);
    }
    return path;
  },
};
export const ipcRenderer = {
  invoke,
  on(channel, listener) {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return this;
  },
  removeListener(channel, listener) {
    listeners.get(channel)?.delete(listener);
    return this;
  },
  send(channel, ...args) {
    void invoke(channel, ...args).catch((error) => console.warn(channel, error.message));
  },
  sendSync(channel, operation, key, value) {
    if (channel !== "preferences:storage" || !/^milagre[.:-]/.test(key)) return { error: "Unsupported synchronous shell operation" };
    if (operation === "get") return { value: preferences[key] };
    if (operation !== "set" || !(value === null || typeof value === "string")) return { error: "Invalid preference" };
    preferences[key] = value;
    diagnostics.preferencesPending++;
    // Electron's synchronous contract is served by the hydrated cache. Disk writes
    // are ordered; errors remain visible rather than silently dropping preferences.
    preferenceWrites = preferenceWrites.then(() => persistPreference(key, value));
    return {};
  },
};

async function persistPreference(key, value) {
  try {
    await window.__TAURI__.core.invoke("preferences_write", { key, value });
  } catch (error) {
    recordError(error, "preferences_write");
    dispatch("preferences:error", { message: errorOf(error).message });
    console.error("Could not persist Rust preferences", error);
  } finally {
    diagnostics.preferencesPending--;
  }
}

async function followPreferences() {
  if (diagnostics.preferencesPending) return;
  try {
    const next = await window.__TAURI__.core.invoke("preferences_read");
    const previous = preferences;
    preferences = next;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (next[key] !== previous[key]) dispatch("preferences:changed", { key, value: next[key] ?? null });
    }
  } catch (error) {
    recordError(error, "preferences_read");
  }
}

export function initializeBridge() {
  return (ready ??= (async () => {
    preferences = await window.__TAURI__.core.invoke("preferences_read");
    await window.__TAURI__.event.listen("daemon-event", ({ payload }) => {
      diagnostics.events++;
      dispatch(payload.channel, payload.payload);
    });
    // Native window/preferences events use the same event envelope as the daemon.
    await window.__TAURI__.event.listen("native-event", ({ payload }) => dispatch(payload.channel, payload.payload));
    window.addEventListener("focus", () => void followPreferences());
    window.setInterval(() => {
      if (!document.hidden) void followPreferences();
    }, 3000);
  })());
}

export function installBrowserCompatibility() {
  // External links leave the app through a validated native opener; WKWebView must
  // never navigate the privileged application document to agent-provided pages.
  const external = (value) => {
    let url;
    try {
      url = new URL(String(value), location.href);
    } catch {
      return;
    }
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
    void invoke("shell:open-external", url.href).catch((error) => console.warn(error.message));
  };
  window.open = (value) => {
    external(value);
    return null;
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download") || event.defaultPrevented) return;
    const url = new URL(anchor.href, location.href);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
    event.preventDefault();
    external(url.href);
  });
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text) => invoke("clipboard:write-text", String(text)),
        readText: () => invoke("clipboard:read-text"),
      },
    });
  }
}

export function installWindowChrome() {
  // Electron's -webkit-app-region is not implemented by WKWebView. Respect the
  // same shared drag strips and popover/interactive exclusions before asking the
  // native window to begin a drag (or maximize on the second mouse press).
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
    if (document.documentElement.hasAttribute("data-popover-open")) return;
    const target = event.target;
    if (!target.closest(".title-drag")) return;
    if (
      target.closest(
        '.no-drag,button,a,input,textarea,select,summary,[role="button"],[role="slider"],[role="textbox"],[role="combobox"],[contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    event.preventDefault();
    void invoke(event.detail === 2 ? "window:toggle-maximize" : "window:start-drag").catch((error) => console.warn(error.message));
  });
}

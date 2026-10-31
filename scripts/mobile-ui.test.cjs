const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Execute the actual hook/screen handlers without loading native modules in Node.
// Effects are driven explicitly so request ordering is deterministic.
function hookHost({ effects = false } = {}) {
  const slots = [];
  const queuedEffects = [];
  let cursor = 0;
  return {
    begin() {
      cursor = 0;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useId() {
      const index = cursor++;
      return (slots[index] ??= { id: `:r${index}:` }).id;
    },
    useCallback(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useMemo(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { value: fn(), deps };
      return slots[index].value;
    },
    // Off by default; when on, an effect runs during the render whose deps changed, after its previous cleanup.
    useEffect(fn, deps) {
      if (!effects) return;
      const index = cursor++;
      const previous = slots[index];
      // No dependency list runs every render, as in React.
      if (previous && deps && deps.every((value, i) => value === previous.deps[i])) return;
      previous?.cleanup?.();
      slots[index] = { deps, cleanup: fn() };
    },
    // Like React, a context read with no Provider above gives the context's default value.
    createContext(defaultValue) {
      return { defaultValue };
    },
    useContext(context) {
      return context?.defaultValue;
    },
    effect(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous.deps?.[i])) {
        slots[index] = { deps, cleanup: previous?.cleanup };
        queuedEffects.push(() => {
          slots[index].cleanup?.();
          slots[index].cleanup = fn();
        });
      }
    },
    flush() {
      for (const effect of queuedEffects.splice(0)) effect();
    },
    cleanup() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
// Every palette key reads back as its own name, so a test can tell which color a component picked.
const fakePalette = new Proxy({}, { get: (_target, key) => (typeof key === "string" ? key : undefined) });
const fakeStyles = new Proxy({}, { get: () => ({}) });
const themeHooks = {
  useTheme: () => ({ colors: fakePalette, scheme: "light", settings: {}, set() {} }),
  createStylesHook: (make) => () => make(fakePalette),
  fonts: { mono: "mono" },
};
const uiHooks = { useStyles: () => fakeStyles, makeStyles: () => fakeStyles };
const designsOn = {
  enabled: true,
  saving: false,
  stale: false,
  error: "",
  refresh: async () => {},
  save: async () => {},
  connectionChanged() {},
};
/** The split layout on a phone (split-context.tsx): the Chats list is a page or slides over, never pinned. */
const phoneSplit = { widthClass: "compact", available: true, dockable: false, pinned: false, hidden: false, toggle() {} };
/** A Chat with no listening ports (useChatPorts in ports.tsx). */
const noPorts = { ports: [], error: "", refresh: () => {}, drop: () => {} };
function load(file, modules, extra = "", cache = new Map(), reactCompiler = false) {
  if (cache.has(file)) return cache.get(file);
  // These helpers stay private in production; the source harness exposes them only to tests.
  const locals = {
    "floating-inbox-button.tsx": ["landInboxButton"],
    "inbox.tsx": ["usePhoneInbox", "PhoneInboxPages"],
  };
  let source = fs.readFileSync(path.join(__dirname, "..", "apps/mobile/src", file), "utf8") + extra + `\nexport { ${(locals[file] ?? []).join(",")} };`;
  if (reactCompiler)
    source = require("@babel/core").transformSync(source, {
      filename: file,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [[require.resolve("babel-plugin-react-compiler"), { target: "19" }]],
    }).code;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  cache.set(file, exports);
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      if (/^\.\.?\/offline-tray$/.test(id) && !(id in modules))
        return { ComposerTray: ({ children }) => children, OfflineTray: "OfflineTray", WaitingLabel: () => null };
      if (/^\.\.?\/outbox$/.test(id) && !(id in modules))
        return {
          hasQueuedChat: () => false,
          outbox: {
            ready: Promise.resolve(),
            getSnapshot: () => ({ loaded: true }),
            enqueue: async () => {
              throw new Error("Unexpected offline enqueue");
            },
            flush: async () => {},
          },
          outboxAttachments: (items) => items,
          useOutbox: () => ({ loaded: true, items: [], error: "" }),
        };
      if (id === "expo-haptics" && !(id in modules)) return { selectionAsync: async () => {} };
      if (id === "@sbaiahmed1/react-native-blur" && !(id in modules)) return { LiquidGlassView: "LiquidGlassView", BlurView: "BlurView" };
      if (file === "prompt-field.tsx" && id === "expo-router" && !(id in modules)) return { useFocusEffect() {} };
      // Follow the real primitive graph, including the compatibility barrel; keep native modules at the boundary.
      const relative = id.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) : null;
      if (relative === "design-tokens") return require("../apps/mobile/src/design-tokens.ts");
      if (relative === "design-font-cache")
        return load("design-font-cache.ts", { "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts") }, "", cache);
      if (relative === "secret-question")
        return load(
          "secret-question.tsx",
          {
            "./display-clock": { useDisplayNow: () => Date.now(), useScreenActive: () => true },
            "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
            ...modules,
          },
          "",
          cache,
        );
      if (relative?.startsWith("primitives/") || relative === "persistence-notice") {
        const target = [relative, `${relative}.tsx`, `${relative}.ts`].find((candidate) =>
          fs.existsSync(path.join(__dirname, "../apps/mobile/src", candidate)),
        );
        assert.ok(target, `Missing primitive: ${relative}`);
        return load(target, modules, "", cache);
      }
      // Pages of the Settings sheet sit one folder deeper (app/(settings)); a test fakes their imports under the names the
      // pages had at app/, so these resolve to the same fake.
      if (file.startsWith("app/(settings)/") && id.startsWith("../../")) id = id.slice(3);
      // A pure helper (the draft clear after a send): tests get the real one.
      // The toast pill (primitives/toast.tsx) draws its icon as a named element, under the screen's own fake when it has one.
      if (file.startsWith("primitives/") && id === "../icons" && !(id in modules)) return modules["./icons"] ?? { Icon: "Icon" };
      if (id === "react-native-safe-area-context" && !(id in modules)) return { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
      // Motion helpers at Normal speed with the system's reduced motion off; a test's own fake wins.
      if (/^\.\.?\/motion$/.test(id) && !(id in modules))
        return { useReducedMotion: () => false, useMotionScale: () => 1, scaledTiming: (config) => config, springTo: (target) => target };
      if (/^\.\/use-skill-names$/.test(id) && !(id in modules)) return { useSkillNames: () => [] };
      // The chips draw as named elements, like the other components these tests do not render.
      if (/^\.\/prompt-chip$/.test(id) && !(id in modules))
        return { SkillChip: "SkillChip", FileMentionChip: "FileMentionChip", ChatMentionChip: "ChatMentionChip" };
      if (/^\.\.?\/(draft-clear|file-mentions|prompt-label)$/.test(id) && !(id in modules)) return load(`${id.replace(/^\.\.?\//, "")}.ts`, modules, "", cache);
      if (
        (id === "@milagre/shared/agent-runs" ||
          id === "@milagre/shared/prompt-parts" ||
          id === "@milagre/shared/appearance" ||
          id === "@milagre/shared/prompt-mentions" ||
          id === "@milagre/shared/themes" ||
          id === "@milagre/shared/file-kinds" ||
          id === "@milagre/shared/streaming-blocks" ||
          id === "@milagre/shared/tool-activity" ||
          id === "@milagre/shared/project-origin" ||
          id === "@milagre/shared/chats-home") &&
        !(id in modules)
      )
        return require(id);
      if (relative && `./${relative}` in modules) id = `./${relative}`;
      if (id === "react-native-gesture-handler") return { ScrollView: "GestureScrollView", ...modules[id] };
      // Image assets are opaque sources; any value stands in.
      if (id.endsWith(".png") && !(id in modules)) return { uri: id };
      // The Chats home helpers (project-surfaces.ts, chats-group.ts) are pure: tests get the real ones.
      if (relative === "project-surfaces" && !(id in modules)) return load("project-surfaces.ts", modules, "", cache);
      if (relative === "chats-group" && !(id in modules))
        return load(
          "chats-group.ts",
          {
            "@milagre/shared/chat-row": require("../packages/shared/src/chat-row.ts"),
            "./chat-list-order.ts": load("chat-list-order.ts", { "@milagre/shared/chats": require("../packages/shared/src/chats.mjs") }),
          },
          "",
          cache,
        );
      if (id === "@milagre/shared/model-copy" && !(id in modules)) return require("../packages/shared/src/model-copy.ts");
      if (id === "@milagre/shared/pull-request-review" && !(id in modules)) return require("../packages/shared/src/pull-request-review.ts");
      const base = id.replace(/^\.\.?\//, "");
      if (base === "theme" || base === "ui") {
        // Themed code reads colors through hooks; a test's own fake wins over these defaults.
        const own = modules[id] ?? {};
        return { ...(base === "theme" ? themeHooks : uiHooks), ...own };
      }
      // Where the phone reaches the Chat's computer: none unless a test says so, so localhost links stay as written.
      if (base === "reachable-host" && !(id in modules)) return { ReachableHostContext: "ReachableHostContext" };
      if (base === "chat-link-context" && !(id in modules)) return { ChatLinkContext: "ChatLinkContext", ChatLinkProvider: "ChatLinkProvider" };
      if (base === "browser-link" && !(id in modules)) return load("browser-link.ts", modules, "", cache);
      if (base === "routes-native") return { useReachableHost: () => null, ...modules[id] };
      if (id === "@milagre/shared/loopback-url" && !(id in modules)) return require(id);
      // A Chat's activity (chat-activity.mjs) is a pure derivation many screens read; tests get the real one.
      if (id === "@milagre/shared/chat-activity" && !(id in modules)) return require("@milagre/shared/chat-activity");
      if (
        [
          "@milagre/shared/archive",
          "@milagre/shared/chat-history",
          "@milagre/shared/chat-window-cache",
          "@milagre/shared/display-clock",
          "@milagre/shared/refresh-loop",
          "@milagre/shared/read-timeout",
          "@milagre/shared/qa-personas",
          "@milagre/shared/voice-dictation",
        ].includes(id) &&
        !(id in modules)
      )
        return require(id);
      if (relative === "display-clock" && !(id in modules)) return load("display-clock.ts", modules, "", cache);
      if (relative === "activity-source" && !(id in modules)) return { ActivitySources: "ActivitySources", ActivityIcon: "ActivityIcon" };
      if (relative === "step-output" && !(id in modules))
        return load("step-output.tsx", { ...modules, "expo-clipboard": { setStringAsync: async () => {} } }, "", cache);
      // Long-press message actions are an iOS-only wrapper: tests see the message as it is without it, with its text selectable.
      if (base === "message-actions" && !(id in modules))
        return { MessageActions: messageActionsStub, messageActionProps: () => ({}), selectableMessageText: true };
      // Fonts load at runtime; none is ready in a test, and loading one never fails.
      if (id === "expo-font" && !(id in modules)) return { isLoaded: () => false, loadAsync: async () => {} };
      if (id.endsWith(".ttf") && !(id in modules)) return { uri: id };
      // Dictation is not available in a test: no microphone, no on-device transcriber.
      if (file === "prompt-field.tsx" && base === "chat-display-setting" && !(id in modules)) return { useDictationAction: () => ["paste"] };
      if (base === "voice-dictation-hook" && !(id in modules))
        return {
          useVoiceDictation: () => ({
            available: false,
            phase: "idle",
            error: null,
            partial: { text: "", settled: 0 },
            download: null,
            level: { value: 0 },
            start() {},
            stop() {},
            cancel() {},
            dismiss() {},
          }),
        };
      if (base === "voice-mic-button" && !(id in modules))
        return {
          VoiceMicButton: "VoiceMicButton",
          DictationCapsule: "DictationCapsule",
          MIC_SIZE: 32,
          CAPSULE_WIDTH: 72,
          CAPSULE_INSET: { right: 6, bottom: 4 },
        };
      // Icon data and the icon component are drawing; a test reads the icon's name.
      if (id === "@hugeicons/core-free-icons" && !(id in modules)) return new Proxy({}, { get: (_target, name) => String(name) });
      if (base === "icons" && !(id in modules)) return { Icon: "Icon", SpinnerRing: "SpinnerRing" };
      if (base === "dictation-notice" && !(id in modules)) return { DictationNotice: "DictationNotice" };
      // Settings › Experimental's Device notes copy is plain text.
      if (id === "@milagre/shared/device-notes" && !(id in modules)) return require("@milagre/shared/device-notes");
      // Where this device's messages say they came from (sent-from.ts): a phone in a test.
      if (base === "sent-from" && !(id in modules)) return { SENT_FROM: "phone" };
      // The archived count in Settings comes from the computers the sidebar has read; none are read in a test.
      // New Chat's Project choices come from the same store: none unless a test says so.
      if (base === "all-computers" && !(id in modules))
        return {
          useArchivedCount: () => null,
          useArchivedChats: () => ({ chats: [], loading: false }),
          useNewChatProjects: () => [],
          useNoProjectChoice: () => undefined,
          chatsHomePath: async (_client, _hostId, home) => home.path,
          allComputers: { clientFor: () => null, hostFor: () => undefined, viewOf: () => undefined },
        };
      // One row per repository in New Chat's Project picker (new-chat-project.ts) is pure.
      if (base === "new-chat-project" && !(id in modules)) return require("../apps/mobile/src/new-chat-project.ts");
      if (base === "project-icon" && !(id in modules)) return { ProjectIcon: "ProjectIcon", ProjectIcons: "ProjectIcons" };
      // A phone-width window: no pinned sidebar and no reading column (split-context.tsx); the width helpers are pure.
      if (base === "split-context" && !(id in modules))
        return { useSplit: () => phoneSplit, useSplitLayout: () => phoneSplit, SplitProvider: ({ children }) => children };
      if ((base === "split-width" || base === "navigation-commands") && !(id in modules)) return load(`${base}.ts`, modules, "", cache);
      // The Chat open beside another (split-chats.ts) is pure plus a small store; with a phone's width it never shows.
      if (base === "split-chats" && !(id in modules))
        return load("split-chats.ts", { react: { useSyncExternalStore: (_subscribe, read) => read() } }, "", cache);
      // A Chat beside of another Project reads its own session (beside-session.tsx); none shows at a phone's width.
      if (base === "beside-session" && !(id in modules)) return { BesideSession: ({ children }) => children, touchPane() {} };
      // The iPad panel's dragged width, kept on the device; a test keeps the default.
      if (base === "panel-width" && !(id in modules)) return { usePanelWidth: () => 420, setPanelWidth() {} };
      // A phone's width: simulators and designs open full screen, never in the panel docked beside the Chat (panel-tabs.tsx).
      if (base === "panel-tabs" && !(id in modules)) return { PanelTabsContext: ({ children }) => children, usePanelTabs: () => null };
      if (base === "side-panels" && !(id in modules)) return { useChatPanelTabs: () => null };
      if (base === "browser-setting" && !(id in modules)) return { useInternalBrowser: () => [globalThis.internalBrowser !== false, async () => {}] };
      // Hardware keyboards belong to an iPad: no Return-to-send or shortcuts in a test.
      if (base === "hardware-keys" && !(id in modules))
        return { useReturnKey: () => ({ attach() {} }), useHardwareShortcuts() {}, chatShortcutIndex: () => null, SHORTCUTS: [] };
      // The PR sheet's bridge to the Chat is pure; opening the sheet is recorded on globalThis.openedPullRequests.
      if (base === "pr-chat" && !(id in modules)) return (globalThis.prChat = load("pr-chat.ts", modules, "", cache));
      // A PR badge's glyph by state (pr-look.ts): each icon by its name.
      if (base === "pr-look" && !(id in modules))
        return {
          PR_ICONS: {
            merged: "GitMergeIcon",
            closed: "GitPullRequestClosedIcon",
            draft: "GitPullRequestDraftIcon",
            ready: "Tick02Icon",
            checking: "CircleDotIcon",
            open: "GitPullRequestIcon",
          },
        };
      if (base === "pr-nav" && !(id in modules))
        return {
          openPullRequest: (route) => (globalThis.openedPullRequests ??= []).push(route),
          openPrPage: (page, route, extra) => (globalThis.openedPrPages ??= []).push([page, route, extra]),
          openPrFile: (route, path) => (globalThis.openedPrPages ??= []).push(["file", route, { path }]),
        };
      // The Chat reads its open PR's detail for the Review pill; a test stubs the store with no threads unless it sets one.
      if (base === "pr-store" && !(id in modules)) return { usePrDetail: () => ({ pr: globalThis.prDetail ?? null, error: "", loading: false, refresh() {} }) };
      assert.ok(id in modules, `Unexpected import: ${id}`);
      return modules[id];
    },
    process: { env: {} },
    // The host's Error, so `failure instanceof Error` holds for errors a test's fake client throws.
    Error,
    Date,
    URL,
    TextDecoder,
    fetch: () => {
      throw new Error("Unexpected network request in mobile UI test");
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  });
  return exports;
}
// The long-press wrapper gives its children no `open`; elements built through `jsx` show them in its place, so a test reads the message.
const messageActionsStub = ({ children }) => children(undefined);
const jsx = (type, props, key) => (type === messageActionsStub ? props.children(undefined) : { type, props, key });

// The compiler's per-component cache uses a hook slot, just like a manual memo.
const compilerRuntime = (host) => ({ c: (size) => host.useRef(Array(size).fill(Symbol.for("react.memo_cache_sentinel"))).current });

test("context settings stay safe and unavailable on both clients without a host response", async () => {
  const shared = await import("../packages/shared/src/context-settings.mjs");
  for (const response of [null, undefined]) {
    const desktop = hookHost({ effects: true });
    const bridge = { readContextSettings: async () => response };
    const { useContextSettings } = load("../../desktop/app/src/lib/context-settings.ts", {
      react: desktop,
      "@milagre/shared/context-settings": shared,
      "./computer-bridge": { useBridge: () => bridge },
    });
    desktop.begin();
    useContextSettings();
    await new Promise(setImmediate);
    desktop.begin();
    const value = useContextSettings();
    assert.equal(value.settings.autoCompact, false, "the desktop composer can read defaults without crashing");
    assert.equal(value.ready, false, "unavailable host settings cannot be edited");

    const mobile = hookHost();
    const phone = load("context-settings.ts", {
      react: mobile,
      "@milagre/shared/context-settings": shared,
      "./session": { useSession: () => ({ client: {} }) },
      "./use-rpc": { useRpc: () => ({ data: response, error: "" }) },
    }).useContextSettings();
    assert.deepEqual(value.settings, phone.settings);
    assert.equal(value.ready, phone.ready);
    desktop.unmount();
  }
});

test("desktop context settings handle missing methods, read failures, events and switching computers", async () => {
  const shared = await import("../packages/shared/src/context-settings.mjs");
  const react = hookHost({ effects: true });
  let bridge = {};
  const { useContextSettings } = load("../../desktop/app/src/lib/context-settings.ts", {
    react,
    "@milagre/shared/context-settings": shared,
    "./computer-bridge": { useBridge: () => bridge },
  });
  const render = () => {
    react.begin();
    return useContextSettings();
  };
  assert.equal(render().ready, false);
  bridge = {
    readContextSettings: async () => {
      throw new Error("offline");
    },
  };
  render();
  await new Promise(setImmediate);
  assert.equal(render().error, "Could not read context settings.");
  assert.equal(render().settings.autoCompact, false);
  assert.equal(render().ready, false);

  const pending = deferred();
  let onChange;
  let removed = false;
  bridge = {
    readContextSettings: () => pending.promise,
    onContextSettings: (fn) => {
      onChange = fn;
      return () => {
        removed = true;
      };
    },
  };
  render();
  const enabled = { ...shared.CONTEXT_DEFAULTS, autoCompact: true };
  onChange(enabled);
  assert.equal(render().settings.autoCompact, true);
  assert.equal(render().ready, true);
  pending.resolve(null);
  await new Promise(setImmediate);
  assert.equal(render().settings.autoCompact, true, "a stale initial read cannot replace the newer event");
  onChange(null);
  assert.equal(render().settings.autoCompact, false);
  assert.equal(render().ready, false);
  bridge = {};
  assert.equal(render().ready, false);
  assert.equal(removed, true);
  onChange(enabled);
  assert.equal(render().settings.autoCompact, false, "late events from the old computer are ignored");
  react.unmount();
});

test("display clocks stop off-screen and in the background, then catch up from wall time", () => {
  const host = hookHost({ effects: true });
  let focused = true,
    now = 1000;
  const listeners = new Set(),
    timers = new Set();
  const AppState = {
    currentState: "active",
    addEventListener(_event, fn) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
  };
  const react = {
    ...host,
    useState: (initial) => host.useState(typeof initial === "function" ? () => now : initial),
    useSyncExternalStore(subscribe, snapshot) {
      host.useEffect(() => subscribe(() => {}), [subscribe]);
      return snapshot();
    },
  };
  const real = require("@milagre/shared/display-clock");
  const clock = load("display-clock.ts", {
    react,
    "react-native": { AppState },
    "expo-router": { useIsFocused: () => focused },
    "@milagre/shared/display-clock": {
      createDisplayClock(options) {
        return real.createDisplayClock({
          ...options,
          now: () => now,
          setInterval: (fn) => {
            timers.add(fn);
            return fn;
          },
          clearInterval: (fn) => timers.delete(fn),
        });
      },
    },
  });
  const read = () => {
    host.begin();
    return clock.useDisplayNow(100);
  };
  try {
    assert.equal(read(), 1000);
    assert.equal(timers.size, 1);
    AppState.currentState = "background";
    for (const fn of Array.from(listeners)) fn();
    read();
    assert.equal(timers.size, 0);
    now = 5000;
    AppState.currentState = "active";
    for (const fn of Array.from(listeners)) fn();
    assert.equal(read(), 5000);
    focused = false;
    read();
    assert.equal(timers.size, 0);
    now = 9000;
    focused = true;
    assert.equal(read(), 9000);
  } finally {
    host.unmount();
  }
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test("an inactive mobile clock reader starts at mount time even if the shared snapshot is old", () => {
  const host = hookHost({ effects: true });
  let subscriptions = 0;
  const clock = load("display-clock.ts", {
    react: {
      ...host,
      useSyncExternalStore(subscribe, snapshot) {
        host.useEffect(() => subscribe(() => {}), [subscribe]);
        return snapshot();
      },
    },
    "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
    "expo-router": { useIsFocused: () => true },
    "@milagre/shared/display-clock": {
      createDisplayClock: () => ({
        snapshot: () => 1000,
        subscribe: () => {
          subscriptions++;
          return () => subscriptions--;
        },
      }),
    },
  });
  const before = Date.now();
  const value = clock.useDisplayNow(1000, false);
  assert.ok(value >= before && value <= Date.now(), "a disabled reader uses a stable current mount time");
  assert.equal(subscriptions, 0);
  host.begin();
  assert.equal(clock.useDisplayNow(1000, false), value, "the mount-time fallback stays stable across renders");
  host.unmount();
});

test("formatted display clocks stop off-screen and in the background, then catch up from wall time", () => {
  const host = hookHost({ effects: true });
  let focused = true,
    now = 1000;
  const listeners = new Set(),
    timers = new Set();
  const AppState = {
    currentState: "active",
    addEventListener(_event, fn) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
  };
  const react = {
    ...host,
    useSyncExternalStore(subscribe, snapshot) {
      host.useEffect(() => subscribe(() => {}), [subscribe]);
      return snapshot();
    },
  };
  const real = require("@milagre/shared/display-clock");
  const clock = load("display-clock.ts", {
    react,
    "react-native": { AppState },
    "expo-router": { useIsFocused: () => focused },
    "@milagre/shared/display-clock": {
      createDisplayClock(options) {
        return real.createDisplayClock({
          ...options,
          now: () => now,
          setInterval: (fn) => {
            timers.add(fn);
            return fn;
          },
          clearInterval: (fn) => timers.delete(fn),
        });
      },
    },
  });
  let enabled = true;
  const read = () => {
    host.begin();
    return clock.useDisplayValue(250, (value) => real.formatElapsed(value - 1000), enabled);
  };
  try {
    assert.equal(read(), "0s");
    assert.equal(timers.size, 1);
    now = 1250;
    for (const fn of timers) fn();
    assert.equal(read(), "0s", "250 ms ticks keep the snapshot unchanged within a second");
    now = 2000;
    for (const fn of timers) fn();
    assert.equal(read(), "1s");
    AppState.currentState = "background";
    for (const fn of Array.from(listeners)) fn();
    read();
    assert.equal(timers.size, 0);
    now = 5000;
    AppState.currentState = "active";
    for (const fn of Array.from(listeners)) fn();
    assert.equal(read(), "4s");
    focused = false;
    read();
    assert.equal(timers.size, 0);
    now = 9000;
    focused = true;
    assert.equal(read(), "8s");
    enabled = false;
    read();
    assert.equal(timers.size, 0);
    now = 12_000;
    enabled = true;
    assert.equal(read(), "11s");
  } finally {
    host.unmount();
  }
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test("background tasks on the phone open command output and subagent details", () => {
  const react = hookHost();
  const session = {
    snapshot: {
      project: {
        path: "/project",
        state: {
          sessions: {
            7: {
              provider: "claude",
              backgroundTasks: [{ id: "watch", kind: "local_bash", title: "Publish watcher", startedAt: 1 }],
              subagents: [{ id: "review", title: "Review changes", background: true, status: "running", startedAt: 2, transcript: [] }],
            },
          },
        },
      },
    },
    client: { call: async () => {} },
  };
  const { default: BackgroundSheet } = load("app/background.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { router: { back() {} }, useLocalSearchParams: () => ({ id: "7" }) },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, name) => String(name) }),
    "../session": { useSession: () => session },
    "../subagent-glance": { WholeSubagentDetail: "WholeSubagentDetail" },
    "../task-output": { TaskOutput: "TaskOutput" },
    "../ui": { CircleButton: "CircleButton", ListRow: "ListRow", PageScroll: "PageScroll" },
    // No ports listening, so no background command moves to Ports.
    "../ports": { useChatPorts: () => noPorts },
  });
  const render = () => {
    react.begin();
    return BackgroundSheet();
  };
  find(render(), (node) => node.type === "ListRow" && node.props.title === "Publish watcher").props.onPress();
  assert.equal(find(render(), (node) => node.type === "TaskOutput").props.taskId, "watch");
  assert.equal(find(render(), (node) => node.type === "TaskOutput").props.running, true);
  session.snapshot.project.state.sessions[7].backgroundTasks = [];
  const completed = find(render(), (node) => node.type === "TaskOutput");
  assert.equal(completed.props.taskId, "watch", "Completion preserves the selected command");
  assert.equal(completed.props.running, false, "Completion requests the final output without continued polling");
  find(render(), (node) => node.type === "CircleButton" && node.props.label === "Back to tasks").props.onPress();
  find(render(), (node) => node.type === "ListRow" && node.props.title === "Review changes").props.onPress();
  const detail = find(render(), (node) => node.type === "WholeSubagentDetail" && node.props.agent?.id === "review");
  assert.ok(detail, "Selecting a background subagent opens its existing detail view");
});

test("the phone's background line opens the numeric Chat in its tasks sheet", () => {
  const host = chatHost();
  host.params.id = "7";
  host.session.snapshot.project.state.sessions[7] = {
    id: 7,
    provider: "claude",
    worktree_id: 1,
    backgroundTasks: [{ id: "watch", kind: "local_bash", title: "Publish watcher", startedAt: 1 }],
  };
  const line = find(host.render(), (node) => node.type === "BackgroundIndicator");
  line.props.onPress();
  const route = host.router.pushed.at(-1);
  assert.equal(route.pathname, "/background");
  assert.equal(route.params.id, "7");
});

test("the phone selects the computer's shell for new Terminals and keeps selection on save failure", async (t) => {
  const react = hookHost();
  t.after(() => react.cleanup());
  const calls = [],
    alerts = [];
  let rejectSave = false;
  let profiles = {
    shells: [
      { file: "/bin/zsh", label: "zsh" },
      { file: "/bin/bash", label: "bash" },
      { file: "/opt/homebrew/bin/bash", label: "bash" },
    ],
    defaultShell: "/bin/zsh",
    selectedShell: null,
  };
  const terminal = { id: "one", chatId: "/p#1", title: "zsh", cwd: "/p", busy: false };
  const client = {
    url: "computer",
    call: async (method, args) => {
      calls.push({ method, args });
      if (method === "terminal:list") return { terminals: [terminal] };
      if (method === "terminal:profiles") return profiles;
      if (method === "terminal:setShell") {
        if (rejectSave) throw new Error("Disk full");
        profiles = { ...profiles, selectedShell: args[0].shell };
        return profiles;
      }
      if (method === "terminal:open") return { ...terminal, id: "two", title: "bash" };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const { TerminalSheet } = load("terminal.tsx", {
    react: { ...react, useEffect: (fn, deps) => react.effect(fn, deps), useImperativeHandle() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Alert: { alert: (...args) => alerts.push(args) },
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
    },
    "expo-router": { router: {}, useFocusEffect: (fn) => react.effect(fn, [fn]) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "react-native-keyboard-controller": {
      KeyboardAvoidingView: "KeyboardAvoidingView",
      KeyboardStickyView: "KeyboardStickyView",
      useKeyboardState: (select) => select({ isVisible: false, height: 0 }),
    },
    "react-native-gesture-handler": { Gesture: {}, GestureDetector: "GestureDetector" },
    "react-native-reanimated": { default: { View: "AnimatedView" }, Easing: { bezier: () => () => 0 }, ReduceMotion: { System: "system" } },
    "react-native-worklets": { scheduleOnRN() {} },
    "./motion": { scaledTiming: (config) => config, useMotionScale: () => 1 },
    "expo-clipboard": { getStringAsync: async () => "" },
    "@expo/dom-webview": { DomWebView: "DomWebView" },
    "expo-file-system": { File() {}, Paths: {} },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/terminal-client": { followTerminal() {} },
    "./session": { useSession: () => ({ client }) },
    "./icons": { Icon: "Icon" },
    "./theme": themeHooks,
    "./status-pill": { StatusPill: "StatusPill" },
    "./design-tokens": {
      type: { caption2: 11, caption1: 12, footnote: 13, subheadline: 15, callout: 16, body: 17, title3: 20, title2: 22, title1: 28, largeTitle: 34 },
      radius: { chip: 6, control: 10, card: 14, sheet: 20, full: 999 },
    },
    "./ui": { CircleButton: "CircleButton", PillButton: "PillButton", PullDown: "PullDown" },
    "./terminal-receiver": {},
  });
  const render = () => {
    react.begin();
    const tree = TerminalSheet({ hostId: "computer", chatId: "/p#1" });
    react.flush();
    return tree;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  render();
  await settle();
  let tree = render();
  let picker = find(tree, (node) => node.type === "PullDown");
  assert.equal(picker.props.label, "Shell for new Terminals");
  assert.deepEqual(
    Array.from(picker.props.sections[0].items, (item) => item.title),
    ["Automatic (/bin/zsh)", "zsh (/bin/zsh)", "bash (/bin/bash)", "bash (/opt/homebrew/bin/bash)"],
  );
  picker.props.onSelect("/bin/bash");
  await settle();
  tree = render();
  picker = find(tree, (node) => node.type === "PullDown");
  assert.equal(picker.props.nativeTrigger.title, "bash");
  assert.equal(calls.at(-1).args[0].shell, "/bin/bash");
  picker.props.onSelect("/opt/homebrew/bin/bash");
  await settle();
  tree = render();
  picker = find(tree, (node) => node.type === "PullDown");
  assert.equal(calls.at(-1).args[0].shell, "/opt/homebrew/bin/bash");
  assert.equal(picker.props.sections[0].items.find((item) => item.id === "/bin/bash").checked, false);
  assert.equal(picker.props.sections[0].items.find((item) => item.id === "/opt/homebrew/bin/bash").checked, true);
  assert.equal(calls.filter((call) => call.method === "terminal:open").length, 0, "changing the preference does not restart an existing Terminal");
  find(tree, (node) => node.type === "CircleButton" && node.props.label === "New Terminal").props.onPress();
  await settle();
  assert.equal(calls.at(-1).method, "terminal:open");
  assert.equal(calls.at(-1).args[0].chatId, "/p#1");
  rejectSave = true;
  picker.props.onSelect("/bin/zsh");
  await settle();
  assert.equal(find(render(), (node) => node.type === "PullDown").props.nativeTrigger.title, "bash");
  assert.equal(find(render(), (node) => node.type === "PullDown").props.sections[0].items.find((item) => item.id === "/opt/homebrew/bin/bash").checked, true);
  assert.deepEqual(alerts[0], ["Couldn't select a shell", "Disk full"]);
  rejectSave = false;
  find(render(), (node) => node.type === "PullDown").props.onSelect("automatic");
  await settle();
  assert.equal(find(render(), (node) => node.type === "PullDown").props.nativeTrigger.title, "Automatic");
});

test("the floating inbox defaults off and its switch updates and persists the phone preference", async () => {
  const hooks = hookHost();
  const saved = [];
  const savedActivity = [];
  const { useFloatingInbox, useFloatingInboxActivity } = load("floating-inbox-setting.ts", {
    react: { useSyncExternalStore: (_subscribe, read) => read() },
    "./hosts-native": {
      readFloatingInbox: async () => false,
      readFloatingInboxActivity: async () => true,
      saveFloatingInboxActivity: async (on) => savedActivity.push(on),
      saveFloatingInbox: async (on) => saved.push(on),
    },
  });
  await Promise.resolve();
  hooks.begin();
  let [on, set] = useFloatingInbox();
  assert.equal(on, false);
  set(true);
  [on] = useFloatingInbox();
  assert.equal(on, true);
  assert.deepEqual(saved, [true]);
  let [activity, setActivity] = useFloatingInboxActivity();
  assert.equal(activity, true);
  setActivity(false);
  [activity] = useFloatingInboxActivity();
  assert.equal(activity, false);
  assert.deepEqual(savedActivity, [false]);
});

test("the mobile inbox button can move, flick to an edge, restore and open without a drag opening the inbox", () => {
  const react = hookHost();
  const values = [];
  let opened = 0;
  const { FloatingInboxButton, floatingInboxStatus, landInboxButton } = load("floating-inbox-button.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View" },
    "react-native-safe-area-context": {
      useSafeAreaFrame: () => ({ width: 402, height: 874 }),
      useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
    },
    "react-native-gesture-handler": {
      GestureDetector: "GestureDetector",
      usePanGesture: (config) => config,
      useTapGesture: (config) => config,
      useCompetingGestures: (pan, tap) => ({ pan, tap }),
    },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      ReduceMotion: { System: "system" },
      cancelAnimation() {},
      useReducedMotion: () => false,
      useAnimatedStyle: (fn) => fn(),
      withSpring: (to) => to,
      useSharedValue(initial) {
        const ref = react.useRef(null);
        if (!ref.current) {
          let value = initial;
          ref.current = {
            get: () => value,
            set: (next) => {
              value = next;
            },
          };
          values.push(ref.current);
        }
        return ref.current;
      },
    },
    "react-native-worklets": { scheduleOnRN: (fn, ...args) => fn(...args) },
    "@hugeicons/core-free-icons": { BubbleChatIcon: "BubbleChatIcon" },
    "./icons": { Icon: "Icon", SpinnerRing: "SpinnerRing" },
  });
  assert.equal(floatingInboxStatus([{ status: "working" }, { status: "question" }, { status: "approval" }]), "approval");
  assert.equal(floatingInboxStatus([{ status: "working" }, { status: "question" }]), "question");
  assert.equal(floatingInboxStatus([{ status: "working" }]), "working");
  assert.equal(floatingInboxStatus([]), undefined);
  for (const [vx, vy, edge] of [
    [-1400, 0, 1],
    [1400, 0, 2],
    [0, -2200, 0],
    [0, 2600, 0],
  ]) {
    assert.equal(landInboxButton(160, 260, vx, vy, 402, 606).edge, edge, "only sideways momentum hides the button");
  }
  assert.deepEqual({ ...landInboxButton(160, 0, 0, -2200, 402, 606) }, { x: 160, y: 12, edge: 0 }, "a top release stays visible inside the bounds");
  assert.deepEqual({ ...landInboxButton(160, 550, 0, 2600, 402, 606) }, { x: 160, y: 538, edge: 0 }, "a bottom release stays visible inside the bounds");
  assert.equal(landInboxButton(0, 260, 0, 0, 402, 606).edge, 1, "a slow drop at the left edge still hides");
  assert.equal(landInboxButton(346, 260, 0, 0, 402, 606).edge, 2, "a slow drop at the right edge still hides");
  assert.equal(landInboxButton(160, 260, 100, 100, 402, 606).edge, 0, "an ordinary move stays floating");
  const render = () => {
    react.begin();
    return FloatingInboxButton({ status: "approval", label: "Waiting for approval", open: () => opened++ });
  };
  let tree = render();
  const badge = find(tree, (n) => n.type?.name === "StatusBadge");
  assert.equal(badge.type({ status: "approval" }).props.style.backgroundColor, "orange");
  assert.equal(badge.type({ status: "question" }).props.style.backgroundColor, "accentInk");
  assert.equal(badge.type({ status: "working" }).type, "SpinnerRing");
  let { pan, tap } = find(tree, (n) => n.type === "GestureDetector").props.gesture;
  // The Pan recognizer loses to Tap without ever activating. It must not reset the placement.
  const initial = [values[0].get(), values[1].get()];
  pan.onFinalize({ canceled: true });
  assert.deepEqual([values[0].get(), values[1].get()], initial);
  tap.onDeactivate({ canceled: false });
  assert.equal(opened, 1);
  pan.onActivate();
  pan.onUpdate({ translationX: -180, translationY: 220 });
  pan.onDeactivate({ velocityX: 0, velocityY: 0, canceled: false });
  pan.onFinalize({ canceled: false });
  const moved = [values[0].get(), values[1].get()];
  assert.equal(opened, 1, "dragging never opens the inbox");
  assert.notDeepEqual(moved, initial);
  pan.onActivate();
  pan.onUpdate({ translationX: -60, translationY: 30 });
  pan.onDeactivate({ canceled: true });
  pan.onFinalize({ canceled: true });
  assert.deepEqual([values[0].get(), values[1].get()], moved, "a canceled drag returns to its previous position");
  pan.onActivate();
  pan.onUpdate({ translationX: 30, translationY: 0 });
  pan.onDeactivate({ velocityX: 1800, velocityY: 0, canceled: false });
  pan.onFinalize({ canceled: false });
  tree = render();
  assert.ok(find(tree, (n) => n.props?.accessibilityLabel?.startsWith("Show inbox button")));
  ({ tap } = find(tree, (n) => n.type === "GestureDetector").props.gesture);
  tap.onDeactivate({ canceled: false });
  assert.equal(opened, 1, "tapping the tucked tab restores it first");
  tree = render();
  assert.ok(find(tree, (n) => n.props?.accessibilityLabel?.startsWith("Open inbox")));
  ({ tap } = find(tree, (n) => n.type === "GestureDetector").props.gesture);
  tap.onDeactivate({ canceled: false });
  assert.equal(opened, 2);
});

function planPanelHost(initial) {
  const react = hookHost({ effects: true });
  const finishes = [];
  const focused = [];
  const backs = [];
  const keyboard = { height: 0, listeners: [] };
  const window = { width: 402, height: 874 };
  const { usePlanPanel, PlanPill, PlanPanel } = load("plan-pill.tsx", {
    react: { ...react, memo: (component) => component },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
      StyleSheet: { absoluteFill: { position: "absolute" } },
      Platform: { OS: "ios" },
      Keyboard: {
        isVisible: () => keyboard.height > 0,
        metrics: () => (keyboard.height ? { height: keyboard.height } : undefined),
        addListener: (name, handler) => {
          const listener = { name, handler };
          keyboard.listeners.push(listener);
          return { remove: () => keyboard.listeners.splice(keyboard.listeners.indexOf(listener), 1) };
        },
      },
      Dimensions: { addEventListener: () => ({ remove() {} }) },
      BackHandler: {
        addEventListener: (_name, handler) => {
          backs.push(handler);
          return { remove: () => backs.splice(backs.indexOf(handler), 1) };
        },
      },
      AccessibilityInfo: { sendAccessibilityEvent: (node, kind) => focused.push([node, kind]) },
      useWindowDimensions: () => window,
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }) },
    "react-native-gesture-handler": { GestureDetector: "GestureDetector", usePanGesture: (config) => config },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      Easing: { bezier: () => "ease" },
      ReduceMotion: { System: "system" },
      cancelAnimation() {},
      useReducedMotion: () => false,
      useAnimatedStyle: (fn) => fn(),
      withDelay: (_delay, animation) => animation,
      // Animations land at once; the closing callback waits for the test to finish it.
      withTiming: (to, _config, done) => {
        if (done) finishes.push(done);
        return to;
      },
      useSharedValue(value) {
        const ref = react.useRef(null);
        ref.current ??= { get: () => value, set: (next) => (value = next) };
        return ref.current;
      },
    },
    "react-native-worklets": { scheduleOnRN: (fn, ...args) => fn(...args) },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "@milagre/shared/chat-plan": require("@milagre/shared/chat-plan"),
    "./icons": { Icon: "Icon" },
    "./plan-label": require("../apps/mobile/src/plan-label.ts"),
    "./plan-panel-frame": require("../apps/mobile/src/plan-panel-frame.ts"),
    "./plan-view": { PlanTree: "PlanTree", PlanPhaseGraph: "PlanPhaseGraph" },
    "./status-pill": { StatusPill: "StatusPill", StatusPillFace: "StatusPillFace", STATUS_PILL: { height: 24, paddingHorizontal: 8, gap: 6 } },
    "./ui": { IconButton: "IconButton", PageScroll: "PageScroll" },
  });
  // The pill sits in the status row above the composer at `pill` (a test moves it as the keyboard would). The overlay
  // covers the window unless `overlay` moves it; `column`, when set, is the composer's column the Chat attaches.
  const host = {
    plan: initial,
    finishes,
    focused,
    backs,
    keyboard,
    window,
    pill: { x: 250, y: 790, width: 54, height: 24 },
    overlay: { x: 0, y: 0, width: 402, height: 874 },
    column: null,
    heading: { heading: true },
  };
  host.render = () => {
    react.begin();
    const panel = usePlanPanel(host.plan, "c1");
    if (host.column) panel.attachRoom({ measureInWindow: (done) => done(host.column.x, 700, host.column.width, 174) });
    const tree = { pill: PlanPill({ panel }), overlay: PlanPanel({ panel }) };
    const chip = find(tree.pill, (node) => node.type === "StatusPill");
    if (chip) chip.props.chipRef({ measureInWindow: (done) => done(host.pill.x, host.pill.y, host.pill.width, host.pill.height) });
    const root = tree.overlay;
    if (root) root.props.ref({ measureInWindow: (done) => done(host.overlay.x, host.overlay.y, host.overlay.width, host.overlay.height) });
    const label = find(root, (node) => node.props?.textRef);
    if (label) label.props.textRef.current = host.heading;
    const surface = find(root, (node) => node.props?.testID === "plan-surface");
    const box = surface && Object.assign({}, ...[surface.props.style].flat(Infinity).filter(Boolean));
    return { ...tree, chip, root, box, face: find(root, (node) => node.props?.testID === "plan-panel") };
  };
  // Keyboard events reach the panel the way React Native sends them.
  host.emit = (name) => {
    for (const listener of keyboard.listeners.filter((entry) => entry.name === name)) listener.handler({});
  };
  return host;
}

test("the Tasks pill grows into its panel over the Chat and folds back into the pill", () => {
  const plan = {
    source: "milagre",
    tasks: [
      { id: "1", title: "Wire it", status: "completed" },
      { id: "2", title: "Test it", status: "in_progress" },
    ],
    phases: [{ phase: "build", at: 1 }],
    updatedAt: 0,
  };
  const host = planPanelHost(plan);
  let screen = host.render();
  assert.equal(screen.chip.props.accessibilityLabel, "Tasks, 1 of 2 done");
  assert.deepEqual([screen.chip.props.count, screen.chip.props.total], [1, 2], "the pill reads done/total, as desktop's does");
  assert.equal(screen.chip.props.hidden, false);
  assert.equal(screen.root.props.pointerEvents, "none", "closed, the overlay lets every touch through");
  assert.equal(screen.face.props.pointerEvents, "none");
  assert.equal(screen.face.props.accessibilityElementsHidden, true, "the closed panel face is hidden from VoiceOver");

  screen.chip.props.onPress();
  host.render();
  screen = host.render();
  assert.equal(screen.chip.props.hidden, true, "the row's pill hands over to the surface, hidden from VoiceOver too");
  assert.equal(screen.chip.props.expanded, true);
  assert.equal(screen.root.props.pointerEvents, "box-none");
  assert.notEqual(screen.face.props.pointerEvents, "none");
  assert.ok(!screen.face.props.accessibilityElementsHidden);
  assert.ok(
    find(screen.face, (node) => node.type === "PlanTree"),
    "the panel shows the task tree",
  );
  assert.ok(
    find(screen.face, (node) => node.type === "PlanPhaseGraph"),
    "and the phase graph below it",
  );
  const heading = find(screen.face, (node) => node.type?.name === "SectionLabel");
  assert.deepEqual([heading.props.title, heading.props.count], ["Tasks", 2], "under desktop's header: Tasks and the leaf total");
  const surface = find(screen.root, (node) => node.props?.testID === "plan-surface");
  const box = Object.assign({}, ...[surface.props.style].flat(Infinity).filter(Boolean));
  assert.equal(box.left + box.width, 402 - 12, "the panel spans the Chat to its right padding");
  assert.equal(box.top + box.height, 790 + 24, "and keeps the pill's bottom edge");
  assert.equal(host.backs.length, 1, "Android back closes the panel while it is open");

  find(screen.root, (node) => node.props?.testID === "plan-backdrop").props.onPress();
  screen = host.render();
  assert.equal(screen.face.props.pointerEvents, "none", "a closing panel is inert at once");
  assert.equal(screen.chip.props.hidden, true, "the pill comes back when the surface lands");
  host.finishes.pop()(true);
  screen = host.render();
  assert.equal(screen.chip.props.hidden, false);
  assert.equal(screen.root.props.pointerEvents, "none");
  assert.deepEqual(host.focused.at(-1)?.[1], "focus", "focus returns to the pill");
  assert.equal(host.backs.length, 0);

  // The collapse control in the header and a downward swipe on it close the panel too.
  screen.chip.props.onPress();
  host.render();
  screen = host.render();
  find(screen.face, (node) => node.type === "IconButton" && node.props.label === "Collapse tasks").props.onPress();
  host.render();
  host.finishes.pop()(true);
  screen = host.render();
  assert.equal(screen.root.props.pointerEvents, "none");
  screen.chip.props.onPress();
  host.render();
  screen = host.render();
  const { gesture } = find(screen.face, (node) => node.type === "GestureDetector").props;
  gesture.onUpdate({ translationY: 30 });
  gesture.onDeactivate({ translationY: 30, velocityY: 100, canceled: false });
  screen = host.render();
  assert.notEqual(screen.face.props.pointerEvents, "none", "a short drag springs back");
  gesture.onDeactivate({ translationY: 120, velocityY: 100, canceled: false });
  screen = host.render();
  assert.equal(screen.face.props.pointerEvents, "none", "a long drag down closes it");

  // The plan going away mid-way leaves nothing behind.
  host.plan = undefined;
  host.render();
  screen = host.render();
  assert.equal(screen.pill, null);
  assert.equal(screen.overlay, null);
});

test("the open Tasks panel follows the pill when the keyboard or the row moves it, and keeps the screen reader inside", () => {
  const plan = { source: "milagre", tasks: [{ id: "1", title: "Wire it", status: "pending" }], phases: [], updatedAt: 0 };
  const host = planPanelHost(plan);
  let screen = host.render();
  assert.ok(!screen.root.props.accessibilityViewIsModal);
  assert.equal(host.keyboard.listeners.length, 0, "closed, nothing listens to the keyboard");
  screen.chip.props.onPress();
  host.render();
  screen = host.render();
  assert.equal(screen.root.props.accessibilityViewIsModal, true, "VoiceOver stays in the overlay, backdrop and card");
  assert.equal(screen.face.props.role, "dialog");
  assert.equal(screen.face.props.accessibilityLabel, "Tasks");
  assert.deepEqual(host.focused.at(-1), [host.heading, "focus"], "opening moves focus onto the panel's heading");
  assert.ok(find(screen.root, (node) => node.props?.testID === "plan-backdrop").props.accessibilityLabel, "Close tasks stays reachable");
  assert.equal(find(screen.face, (node) => node.type === "PageScroll").props.keyboardDismissMode, "none", "scrolling the panel keeps the keyboard");
  assert.equal(screen.box.top + screen.box.height, 814);

  // The keyboard comes up: the composer rides it and the card's bottom goes with the pill.
  host.pill = { ...host.pill, y: 454 };
  host.keyboard.height = 336;
  host.emit("keyboardDidShow");
  screen = host.render();
  assert.equal(screen.box.top + screen.box.height, 454 + 24, "the card sits on the pill above the keyboard");
  // iOS reports a frame change (another keyboard height) once it lands.
  host.pill = { ...host.pill, y: 420 };
  host.emit("keyboardDidChangeFrame");
  screen = host.render();
  assert.equal(screen.box.top + screen.box.height, 420 + 24);
  host.pill = { ...host.pill, y: 790 };
  host.keyboard.height = 0;
  host.emit("keyboardDidHide");
  screen = host.render();
  assert.equal(screen.box.top + screen.box.height, 814, "and comes back down with it");

  // A new label widens the pill; the face it folds back into is drawn at the new frame.
  host.pill = { ...host.pill, x: 240, width: 64 };
  screen.chip.props.onLayout();
  screen = host.render();
  const pillFace = find(screen.root, (node) => node.props?.children?.type === "StatusPillFace");
  const pillBox = Object.assign({}, ...[pillFace.props.style].flat(Infinity).filter(Boolean));
  assert.deepEqual([pillBox.left, pillBox.width], [240, 64]);

  find(screen.face, (node) => node.type === "IconButton" && node.props.label === "Collapse tasks").props.onPress();
  host.render();
  assert.equal(host.keyboard.listeners.length, 0, "closing stops following the keyboard");
});

test("beside an iPad's sidebar the Tasks panel keeps to the composer's column", () => {
  const plan = { source: "milagre", tasks: [{ id: "1", title: "Wire it", status: "pending" }], phases: [], updatedAt: 0 };
  const host = planPanelHost(plan);
  // A 1210 pt landscape window: the pinned sidebar takes 332 pt, the Chat the rest, its column centred at 760 pt.
  Object.assign(host.window, { width: 1210, height: 834 });
  host.overlay = { x: 332, y: 0, width: 878, height: 834 };
  host.column = { x: 391, width: 760 };
  host.pill = { x: 1080, y: 680, width: 54, height: 24 };
  let screen = host.render();
  screen.chip.props.onPress();
  host.render();
  screen = host.render();
  assert.equal(screen.box.left, 391 + 12 - 332, "the panel starts inside the column, not under the sidebar");
  assert.equal(screen.box.width, 760 - 2 * 12, "and is as wide as the composer");
  // The sidebar sliding away moves the pill; the row's relayout measures the column again.
  host.overlay = { x: 0, y: 0, width: 1210, height: 834 };
  host.column = { x: 225, width: 760 };
  host.pill = { x: 914, y: 680, width: 54, height: 24 };
  screen.chip.props.onLayout();
  screen = host.render();
  assert.deepEqual([screen.box.left, screen.box.width], [225 + 12, 736]);
});

test("inbox single-choice questions require Send and typed answers replace the choice", () => {
  const react = hookHost();
  const sent = [];
  const { Questions } = load("questions.tsx", {
    "./inbox-motion": { InboxPage: "InboxPage", InboxPager: "InboxPager", useInboxLayout: () => undefined },
    "./floating-inbox-button": { FloatingInboxButton: "FloatingInboxButton", floatingInboxStatus: () => undefined },
    "./floating-inbox-setting": { useFloatingInboxActivity: () => [true, () => {}] },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Pressable: "Pressable",
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
    },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "@milagre/shared/limits": require("@milagre/shared/limits"),
    "./activity-drafts": { takeActivityDraft() {} },
    "./icons": { Icon: "Icon" },
    "./ui": { IconButton: "IconButton", PillButton: "PillButton" },
  });
  const request = {
    requestId: "q",
    questions: [
      {
        id: "next",
        question: "What next?",
        options: [{ label: "Read" }],
        allowOther: true,
      },
    ],
  };
  const render = () => {
    react.begin();
    return Questions({
      request,
      busy: false,
      confirmSingle: true,
      submit: (...args) => sent.push(args),
    });
  };
  let tree = render();
  assert.equal(
    find(tree, (n) => n.props?.label === "Dismiss questions"),
    undefined,
  );
  find(tree, (n) => n.props?.accessibilityRole === "radio").props.onPress();
  tree = render();
  assert.equal(sent.length, 0);
  assert.equal(find(tree, (n) => n.type === "PillButton").props.disabled, false);
  find(tree, (n) => n.type === "TextInput").props.onChangeText("Write instead");
  tree = render();
  assert.equal(find(tree, (n) => n.props?.accessibilityRole === "radio").props.accessibilityState.checked, false);
  find(tree, (n) => n.type === "PillButton").props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][0])), {
    next: ["Write instead"],
  });
});

test("inbox approval shows the entire action inline, including folders, files and delegation", () => {
  const react = hookHost();
  const { Approval } = load("questions.tsx", {
    "./inbox-motion": { InboxPage: "InboxPage", InboxPager: "InboxPager", useInboxLayout: () => undefined },
    "./floating-inbox-button": { FloatingInboxButton: "FloatingInboxButton", floatingInboxStatus: () => undefined },
    "./floating-inbox-setting": { useFloatingInboxActivity: () => [true, () => {}] },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Pressable: "Pressable",
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
    },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_t, k) => k }),
    "@milagre/shared/limits": require("@milagre/shared/limits"),
    "./activity-drafts": { takeActivityDraft() {} },
    "./icons": { Icon: "Icon" },
    "./ui": { IconButton: "IconButton", PillButton: "PillButton" },
  });
  const command = "full command\n".repeat(60),
    decisions = [];
  react.begin();
  const tree = Approval({
    variant: "inline",
    approval: {
      title: "Approve?",
      tool: "Shell",
      command,
      cwd: "/project",
      files: ["one.ts", "two.ts"],
      delegation: { target: "Other Chat", message: "Exact message" },
      allowForChat: true,
    },
    busy: false,
    respond: (d) => decisions.push(d),
  });
  assert.equal(tree.props.style.borderWidth, undefined, "the inbox approval has no nested card border");
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === command));
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "/project"));
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "one.ts\ntwo.ts"));
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "Exact message"));
  assert.equal(
    find(tree, (n) => n.props?.style?.maxHeight === 220),
    undefined,
    "approval details are never clipped",
  );
  find(tree, (n) => n.props?.title === "Allow once").props.onPress();
  assert.deepEqual(decisions, ["allow"]);
});

test("setup approval shows full setup context and emits each setup decision", () => {
  const react = hookHost();
  const { Approval } = load("questions.tsx", {
    "./inbox-motion": { InboxPage: "InboxPage", InboxPager: "InboxPager", useInboxLayout: () => undefined },
    "./floating-inbox-button": { FloatingInboxButton: "FloatingInboxButton", floatingInboxStatus: () => undefined },
    "./floating-inbox-setting": { useFloatingInboxActivity: () => [true, () => {}] },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View" },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_t, k) => k }),
    "@milagre/shared/limits": require("@milagre/shared/limits"),
    "@milagre/shared/model-copy": require("../packages/shared/src/model-copy.ts"),
    "./activity-drafts": { takeActivityDraft() {} },
    "./icons": { Icon: "Icon" },
    "./ui": { IconButton: "IconButton", PillButton: "PillButton" },
  });
  const command = "prepare-project --flag='full value'\necho finished";
  const decisions = [];
  react.begin();
  const tree = Approval({
    approval: {
      kind: "setup",
      title: "Run setup?",
      tool: "Setup",
      command,
      cwd: "/worktree",
      setup: { projectPath: "/projects/sample", source: "package.json scripts.setup", computer: "MacBook Pro" },
      allowForChat: true,
    },
    busy: false,
    respond: (decision) => decisions.push(decision),
  });
  for (const value of [command, "/projects/sample", "package.json scripts.setup", "MacBook Pro"])
    assert.ok(
      find(tree, (node) => node.type === "Text" && node.props.children === value),
      `missing setup approval value: ${value}`,
    );
  find(tree, (node) => node.type === "PillButton" && node.props.title === "Run once").props.onPress();
  find(tree, (node) => node.type === "Pressable" && node.props.accessibilityRole === "button").props.onPress();
  find(tree, (node) => node.type === "PillButton" && node.props.title === "Skip setup").props.onPress();
  assert.deepEqual(decisions, ["allow", "allow-for-chat", "deny"]);
});

test("phone inbox pages keep one Chat visible and retain a draft when paging back", () => {
  const react = hookHost();
  const gesture = {
    activeOffsetX() {
      return this;
    },
    failOffsetY() {
      return this;
    },
    onEnd(fn) {
      this.end = fn;
      return this;
    },
  };
  const { PhoneInboxPages } = load("inbox.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      AppState: {},
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
      Keyboard: { dismiss() {} },
      useWindowDimensions: () => ({ height: 844 }),
    },
    "react-native-gesture-handler": {
      Gesture: { Pan: () => gesture },
      GestureDetector: "GestureDetector",
    },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      useReducedMotion: () => false,
    },
    "react-native-worklets": { scheduleOnRN: (fn, ...args) => fn(...args) },
    "./inbox-motion": { InboxPage: "InboxPage", InboxPager: "InboxPager", useInboxLayout: () => undefined },
    "./floating-inbox-button": { FloatingInboxButton: "FloatingInboxButton", floatingInboxStatus: () => undefined },
    "./floating-inbox-setting": { useFloatingInboxActivity: () => [true, () => {}] },
    "expo-router": {
      router: {},
      useFocusEffect() {},
      useLocalSearchParams: () => ({}),
    },
    "react-native-safe-area-context": {
      useSafeAreaInsets: () => ({ bottom: 0 }),
      useSafeAreaFrame: () => ({ height: 844 }),
    },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/agent-runs": require("@milagre/shared/agent-runs"),
    "@milagre/shared/attention": require("../packages/shared/src/attention.mjs"),
    "@milagre/shared/providers": require("@milagre/shared/providers"),
    "./session": { useSession: () => ({ client: null }) },
    "./icons": { Icon: "Icon" },
    "./questions": { Questions: "Questions", Approval: "Approval" },
    "./ui": {
      GlassIconButton: "GlassIconButton",
      IconButton: "IconButton",
      PageScroll: "PageScroll",
    },
  });
  const items = [
    { key: "a", title: "First", question: { requestId: "q1" } },
    { key: "b", title: "Second", permission: { requestId: "p1" } },
  ];
  const render = () => {
    react.begin();
    return PhoneInboxPages({ items, refresh() {} });
  };
  let tree = render();
  const card = (t) => find(t, (n) => n.type?.name === "PhoneInboxCard");
  assert.equal(card(tree).props.item.key, "a");
  assert.equal(
    find(tree, (n) => n.props?.label === "Floating inbox settings"),
    undefined,
  );
  const draft = { page: 0, picked: { next: ["Read"] }, typed: { next: "" } };
  card(tree).props.setDraft(draft);
  find(tree, (n) => n.type === "InboxPager").props.select(1);
  tree = render();
  assert.equal(card(tree).props.item.key, "b");
  find(tree, (n) => n.type === "InboxPager").props.select(0);
  tree = render();
  assert.deepEqual(JSON.parse(JSON.stringify(card(tree).props.draft)), draft);
  assert.equal(
    find(tree, (n) => n.props?.accessibilityRole === "tab"),
    undefined,
    "the inbox has no filters",
  );
  gesture.end({ translationX: -90, velocityX: 0 });
  tree = render();
  assert.equal(card(tree).props.item.key, "b", "swiping left moves to the next message");
  gesture.end({ translationX: 0, velocityX: 0 });
  tree = render();
  assert.equal(card(tree).props.item.key, "b");
});

test("phone inbox refresh coalesces requests and drops results from an earlier host", async (t) => {
  const react = hookHost();
  t.after(() => react.cleanup());
  const first = deferred();
  const second = deferred();
  let calls = 0;
  let client = {
    inbox: () => {
      calls++;
      return first.promise;
    },
  };
  const { usePhoneInbox } = load("inbox.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
    },
    "react-native-gesture-handler": {
      Gesture: {},
      GestureDetector: "GestureDetector",
    },
    "react-native-reanimated": { default: { View: "AnimatedView" } },
    "react-native-worklets": { scheduleOnRN: (fn) => fn() },
    "./inbox-motion": { InboxPage: "InboxPage", InboxPager: "InboxPager", useInboxLayout: () => undefined },
    "./floating-inbox-button": { FloatingInboxButton: "FloatingInboxButton", floatingInboxStatus: () => undefined },
    "./floating-inbox-setting": { useFloatingInboxActivity: () => [true, () => {}] },
    "expo-router": {
      router: {},
      useFocusEffect: (fn) => react.effect(fn, [fn]),
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0 }) },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/agent-runs": require("@milagre/shared/agent-runs"),
    "@milagre/shared/attention": require("../packages/shared/src/attention.mjs"),
    "@milagre/shared/providers": require("@milagre/shared/providers"),
    "./session": { useSession: () => ({ client }) },
    "./icons": { Icon: "Icon" },
    "./questions": { Questions: "Questions", Approval: "Approval" },
    "./ui": {},
  });
  const render = () => {
    react.begin();
    const state = usePhoneInbox();
    react.flush();
    return state;
  };
  let state = render();
  state.refresh();
  state.refresh();
  assert.equal(calls, 1);
  client = { inbox: () => second.promise };
  state = render();
  first.resolve({ agents: [{ key: "old" }], items: [{ key: "old" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render().snapshot.items.length, 0);
  second.resolve({ agents: [], items: [{ key: "new" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render().snapshot.items[0].key, "new");
});
const { resolvePalette } = require("../packages/shared/src/themes/index.ts");
const archiveStore = require("../apps/mobile/src/archive.ts");
const archiveProgress = load("archive-progress.tsx", {
  react: { useSyncExternalStore: (_subscribe, read) => read() },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": { Text: "Text", View: "View", StyleSheet: { absoluteFill: {}, create: (styles) => styles } },
  "./archive": archiveStore,
  "./icons": { SpinnerRing: "SpinnerRing" },
  "./ui": { styles: {}, colors: {} },
});
const enterAnimation = {
  duration() {
    return this;
  },
  easing() {
    return this;
  },
  withInitialValues() {
    return this;
  },
  reduceMotion() {
    return this;
  },
};
const reanimatedStub = { default: { View: "AnimatedView" }, FadeInDown: enterAnimation, Easing: { bezier() {} }, ReduceMotion: { System: "system" } };

test("mobile inbox position track jumps across long lists and keeps count and accessible navigation in sync", () => {
  for (const scheme of ["dark", "light"]) {
    const react = hookHost();
    let reduced = false;
    const { InboxPager } = load("inbox-motion.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { Pressable: "Pressable", View: "View", Text: "Text" },
      "@hugeicons/core-free-icons": { ArrowLeft01Icon: "left", ArrowRight01Icon: "right" },
      "react-native-reanimated": {
        ...reanimatedStub,
        __esModule: true,
        cubicBezier: () => "ease-out",
        FadeInLeft: enterAnimation,
        FadeInRight: enterAnimation,
        FadeOut: enterAnimation,
        LinearTransition: enterAnimation,
        useReducedMotion: () => reduced,
      },
      "./ui": { IconButton: "IconButton" },
      "./theme": { useTheme: () => ({ colors: fakePalette, scheme }) },
      // Reduced motion (the system's or Animations Off) is what this test flips.
      "./motion": { useReducedMotion: () => reduced, useMotionScale: () => 1 },
    });
    let index = 0,
      count = 20;
    const render = () => InboxPager({ index, count, select: (next) => (index = next) });
    const track = () => find(render(), (node) => node.props?.testID === "inbox-position-track");
    const counter = () => find(render(), (node) => node.props?.testID === "inbox-position-count").props.children.join("");
    assert.equal(counter(), "1 of 20");
    track().props.onPress({ nativeEvent: { locationX: 100 } });
    assert.equal(index, 19);
    assert.equal(counter(), "20 of 20");
    track().props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    assert.equal(index, 19, "accessible navigation stops at the end");
    track().props.onPress({ nativeEvent: { locationX: 50 } });
    assert.equal(index, 10);
    assert.equal(counter(), "11 of 20");
    track().props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
    assert.equal(counter(), "10 of 20");
    const pill = find(track(), (node) => node.type === "AnimatedView");
    assert.equal(pill.props.style.backgroundColor, scheme === "dark" ? "#fff" : "#000");
    track().props.onPress({ nativeEvent: { locationX: -10 } });
    assert.equal(index, 0, "track jumps clamp at the beginning");
    reduced = true;
    assert.equal(find(track(), (node) => node.type === "AnimatedView").props.style.transitionDuration, 0);
    count = 1;
    assert.equal(counter(), "1 of 1");
    assert.equal(track().props.disabled, true);
    assert.equal(find(track(), (node) => node.type === "AnimatedView").props.style.transform[0].translateX, 0);
    track().props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    assert.equal(index, 0);
    count = 0;
    assert.equal(counter(), "0 of 0");
  }
});

test("mobile slash suggestions filter skills and insert at the caret while preserving surrounding text", () => {
  const react = hookHost();
  let draft = "Please /tl afterwards";
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("../packages/shared/src/prompt-skills.mjs"),
    "./use-rpc": {
      useRpc: () => ({
        data: {
          skills: [
            { name: "other", description: "A description mentioning tldr." },
            { name: "tldr", description: "Rewrite for a skimming reader." },
            { name: "docs", description: "Read documentation." },
            { name: "plugin:review-code", description: "Review code." },
            { name: "docs.v2", description: "Read version two documentation." },
          ],
        },
      }),
    },
    "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
    "./ui": {
      Field: "Field",
      ListRow: "ListRow",
      PageScroll: "PageScroll",
      colors: { ink: "ink", accentInk: "accent" },
    },
  });
  function render() {
    react.begin();
    return PromptField({
      client: {},
      projectPath: "/project",
      draft,
      onChangeText: (value) => {
        draft = value;
      },
    });
  }
  const field = () => find(render(), (node) => node.type === "Field");
  field().props.onFocus();
  field().props.onSelectionChange({
    nativeEvent: { selection: { start: 10, end: 10 } },
  });
  const suggestion = find(render(), (node) => node.type === "ListRow" && node.props.title === "/tldr");
  assert.equal(find(render(), (node) => node.type === "ListRow").props.title, "/tldr", "name prefixes come before description matches");
  assert.ok(suggestion, "a partial slash skill must open a suggestion");
  assert.equal(
    find(render(), (node) => node.type === "ListRow" && node.props.title === "/docs"),
    undefined,
  );
  suggestion.props.onPress();
  assert.equal(draft, "Please /tldr afterwards");
  assert.deepEqual({ ...field().props.selection }, { start: 13, end: 13 });
  assert.equal(
    find(render(), (node) => node.type === "ListRow"),
    undefined,
    "choosing a skill closes suggestions",
  );
  assert.ok(find(field(), (node) => node.type === "Text" && node.props.children === "/tldr" && node.props.style.color === "accentInk"));
  for (const punctuation of [".", ",", ":"]) {
    draft = `Please /tl${punctuation} afterwards`;
    field().props.onSelectionChange({
      nativeEvent: { selection: { start: 10, end: 10 } },
    });
    find(render(), (node) => node.type === "ListRow" && node.props.title === "/tldr").props.onPress();
    assert.equal(draft, `Please /tldr${punctuation} afterwards`, "completion preserves sentence punctuation");
    assert.equal(
      find(render(), (node) => node.type === "ListRow"),
      undefined,
    );
  }
  for (const [partial, name] of [
    ["plugin:", "plugin:review-code"],
    ["docs.", "docs.v2"],
  ]) {
    draft = `/${partial}`;
    field().props.onSelectionChange({
      nativeEvent: { selection: { start: draft.length, end: draft.length } },
    });
    find(render(), (node) => node.type === "ListRow" && node.props.title === `/${name}`).props.onPress();
    assert.equal(draft, `/${name} `, "qualified prefixes do not leave duplicate punctuation");
  }
  draft = "/";
  field().props.onSelectionChange({
    nativeEvent: { selection: { start: 1, end: 1 } },
  });
  assert.ok(
    find(render(), (node) => node.type === "ListRow" && node.props.title === "/docs"),
    "a bare slash opens the full catalog",
  );
  field().props.onBlur();
  assert.equal(
    find(render(), (node) => node.type === "ListRow"),
    undefined,
  );
});

for (const reactCompiler of [false, true])
  test(`returning to a mobile Chat restores the draft end without moving the caret during edits (compiler: ${reactCompiler})`, () => {
    const react = hookHost({ effects: true });
    let focus;
    let draft = Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join("\n");
    const catalog = { skills: [] };
    const { PromptField } = load(
      "prompt-field.tsx",
      {
        react,
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "expo-router": {
          useFocusEffect: (callback) => {
            focus = callback;
          },
        },
        "react/compiler-runtime": compilerRuntime(react),
        "react-native": { Text: "Text", View: "View" },
        "react-native-reanimated": reanimatedStub,
        "@milagre/shared/prompt-skills": require("../packages/shared/src/prompt-skills.mjs"),
        "./use-rpc": { useRpc: () => ({ data: catalog }) },
        "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
        "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
      },
      "",
      new Map(),
      reactCompiler,
    );
    const field = () => {
      react.begin();
      return find(
        PromptField({
          client: {},
          projectPath: "/project",
          draft,
          onChangeText: (value) => {
            draft = value;
          },
        }),
        (node) => node.type === "Field",
      );
    };
    const end = () => ({ start: draft.length, end: draft.length });
    assert.deepEqual({ ...field().props.selection }, end(), "a mounted draft opens at its end");
    field().props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } });
    assert.equal(field().props.selection, undefined, "native clicks can move the caret");
    const firstFocus = focus;
    field().props.onChangeText(draft.slice(0, 2) + " inserted" + draft.slice(2));
    assert.equal(field().props.selection, undefined, "typing in the middle keeps native caret control");
    assert.equal(focus, firstFocus, "typing must not re-run the route focus effect");
    focus();
    assert.deepEqual({ ...field().props.selection }, end(), "returning to the mounted screen restores the latest draft end");
    field().props.onSelectionChange({ nativeEvent: { selection: end() } });
    assert.equal(field().props.selection, undefined, "native selection resumes after restoration");
    draft = "";
    field();
    focus();
    assert.deepEqual({ ...field().props.selection }, { start: 0, end: 0 }, "empty drafts restore safely");
  });

test("mobile skill input preserves edits and clears its description when the caret or catalog changes", () => {
  const react = hookHost();
  let catalog = { skills: [{ name: "tldr", description: "Rewrite for a skimming reader." }] };
  let draft = "run /tldr";
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("../packages/shared/src/prompt-skills.mjs"),
    "./use-rpc": { useRpc: () => ({ data: catalog }) },
    "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
    "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll", colors: { ink: "ink", accentInk: "accent" } },
  });
  function render() {
    react.begin();
    const tree = PromptField({
      client: {},
      projectPath: "/project",
      draft,
      images: 1,
      onChangeText: (value) => {
        draft = value;
      },
    });
    react.flush();
    return tree;
  }
  const field = () => find(render(), (node) => node.type === "Field");
  const description = () =>
    find(
      render(),
      (node) =>
        (node.type === "Text" && node.props.children === "Rewrite for a skimming reader.") ||
        (node.type === "ListRow" && node.props.subtitle === "Rewrite for a skimming reader."),
    );
  assert.equal("value" in field().props, false, "native attributed children must not be combined with value");
  assert.ok(find(field(), (node) => node.type === "Text" && node.props.children === "/tldr" && node.props.style.color === "accentInk"));
  field().props.onFocus();
  field().props.onSelectionChange({ nativeEvent: { selection: { start: 7, end: 7 } } });
  assert.ok(description());
  field().props.onChangeText("run /tldr please");
  assert.equal(draft, "run /tldr please");
  field().props.onSelectionChange({ nativeEvent: { selection: { start: 16, end: 16 } } });
  assert.equal(description(), undefined);
  field().props.onSelectionChange({ nativeEvent: { selection: { start: 7, end: 7 } } });
  assert.ok(description());
  catalog = { skills: [] };
  assert.equal(description(), undefined);
  assert.equal(
    find(field(), (node) => node.type === "Text" && node.props.style.color === "accent"),
    undefined,
  );
  catalog = { skills: [{ name: "tldr", description: "Rewrite for a skimming reader." }] };
  field().props.onBlur();
  assert.equal(description(), undefined);
  draft = "";
  assert.equal(field().props.children.props.children.length, 0, "clearing a sent draft clears native attributed text");
  draft = "run /tldr";
  field().props.onSelectionChange({ nativeEvent: { selection: { start: 4, end: 9 } } });
  catalog = { skills: [] };
  assert.deepEqual({ ...field().props.selection }, { start: 4, end: 9 }, "catalog recoloring preserves the native text selection");
  field().props.onChangeText("run /tldr please");
  assert.equal(field().props.selection, undefined, "ordinary typing keeps native caret control");
  draft = "see [Image #1] next";
  field().props.onChangeText("see [Image #1 next");
  assert.equal(draft, "see  next", "Backspace removes the whole image reference");
});

for (const reactCompiler of [false, true])
  test(`file lookup recoloring preserves selection with an unchanged draft (compiler: ${reactCompiler})`, async () => {
    const react = hookHost();
    react.useEffect = react.effect;
    const answer = deferred(),
      started = deferred();
    const client = {
      call: () => {
        started.resolve();
        return answer.promise;
      },
    };
    const known = require("../apps/mobile/src/file-mentions.ts").createKnownFiles();
    const { PromptField } = load(
      "prompt-field.tsx",
      {
        react,
        "react/compiler-runtime": compilerRuntime(react),
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "react-native": { Text: "Text", View: "View" },
        "react-native-reanimated": reanimatedStub,
        "@milagre/shared/prompt-skills": require("../packages/shared/src/prompt-skills.mjs"),
        "./use-rpc": { useRpc: () => ({ data: null }) },
        "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
        "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
      },
      "",
      new Map(),
      reactCompiler,
    );
    const mention = "@notes.txt";
    const props = { client, known, projectPath: "/p", draft: `see ${mention} next`, onChangeText() {} };
    const render = () => {
      react.begin();
      const tree = PromptField(props);
      react.flush();
      return find(tree, (node) => node.type === "Field");
    };
    // The chip glyph font loads once the field mounts, so a known file draws as the chip: the hover gray behind its icon and name.
    const fileMark = (field) => find(field, (node) => node.type === "Text" && node.props.style?.backgroundColor === "hover");
    try {
      const field = render();
      assert.equal(fileMark(field), undefined);
      field.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 3 } } });
      render();
      await started.promise;
      answer.resolve(["notes.txt"]);
      await settle();
      const colored = render();
      assert.equal(fileMark(colored)?.props.style.color, "ink");
      assert.deepEqual({ ...colored.props.selection }, { start: 0, end: 3 });
      const children = colored.props.children;
      assert.deepEqual(render().props.children, children, "recoloring settles with stable marks");
      assert.deepEqual(render().props.children, children);
    } finally {
      react.cleanup();
    }
  });

function markdownHost({
  media,
  basePath,
  reachable = null,
  openChatLink,
  reactCompiler = false,
  copy = async () => {},
  haptic = () => {},
  textPx = 15,
  codeSize = 12,
} = {}) {
  const react = {
    ...hookHost({ effects: true }),
    memo: (fn) => fn,
    useContext: (context) => (context === "ReachableHostContext" ? reachable : context === "ChatLinkContext" ? openChatLink : undefined),
  };
  const viewer = require("../apps/mobile/src/viewer-store.ts");
  const routes = [],
    links = [];
  const { Markdown } = load(
    "markdown.tsx",
    {
      "react/compiler-runtime": compilerRuntime(react),
      "@milagre/shared/genui": require("../packages/shared/src/genui.ts"),
      "@milagre/shared/diagram": require("../packages/shared/src/diagram.ts"),
      "./diagram": { MermaidBlock: "MermaidBlock" },
      "./genui/GenerativeUI": { GenerativeUI: "GenerativeUI", MarkdownStreamingContext: "MarkdownStreamingContext" },
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Text: "Text",
        View: "View",
        Image: "Image",
        Pressable: "Pressable",
        StyleSheet: { hairlineWidth: 0.5 },
        Platform: { OS: "ios" },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        Alert: {},
        Linking: {
          openURL: async (url) => {
            links.push(url);
          },
        },
      },
      "expo-router": { router: { push: (route) => routes.push(route) } },
      "expo-clipboard": { setStringAsync: copy },
      "@hugeicons/core-free-icons": { Copy01Icon: "copy", Tick02Icon: "tick" },
      "./icons": { Icon: "Icon" },
      "expo-haptics": { selectionAsync: async () => haptic() },
      "./markdown-table": require("../apps/mobile/src/markdown-table.ts"),
      "./theme": { useTheme: () => ({ ...themeHooks.useTheme(), textPx, codeSize }) },
      "./viewer-store": viewer,
      "./chat-presentation": require("../apps/mobile/src/chat-presentation.ts"),
      "./markdown-image": require("../apps/mobile/src/markdown-image.ts"),
      "@milagre/shared/file-link": require("../packages/shared/src/file-link.mjs"),
      "./ui": { PageScroll: "PageScroll", colors: {}, styles: { muted: {}, code: {} } },
    },
    "",
    new Map(),
    reactCompiler,
  );
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    if (node.type === "MermaidBlock" || node.type === "GenerativeUI") {
      const prop = node.type === "MermaidBlock" ? "plain" : "fallback";
      return { ...node, props: { ...node.props, [prop]: expand(node.props[prop]) } };
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  return {
    render(text, streaming = false) {
      react.begin();
      return expand(Markdown({ text, streaming, media, basePath }));
    },
    routes,
    links,
    viewer,
    unmount: () => react.unmount(),
  };
}

test("Markdown code copies exact current content, replaces its feedback timer, and scales code", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reactCompiler of [false, true]) {
    const copies = [];
    let taps = 0;
    const screen = markdownHost({ reactCompiler, copy: async (code) => copies.push(code), haptic: () => taps++ });
    const source = "```BASH\n  printf 'a  b'\n\n```";
    const button = (tree) => find(tree, (node) => node.props?.accessibilityRole === "button");
    let rendered = screen.render(source);
    assert.ok(textOf(rendered).includes("bash"));
    const codeText = find(rendered, (node) => node.type === "Text" && Array.isArray(node.props.style) && node.props.style[1]?.fontSize);
    assert.equal(codeText.props.style[1].fontSize, 13);
    assert.equal(codeText.props.style[1].lineHeight, 20);
    assert.equal(button(rendered).props.accessibilityLabel, "Copy code");
    const hit = button(rendered).props.style({ pressed: false });
    assert.ok(hit.minWidth >= 44 && hit.minHeight >= 44);
    button(rendered).props.onPress();
    await Promise.resolve();
    rendered = screen.render(source);
    assert.equal(button(rendered).props.accessibilityLabel, "Copied");
    assert.equal(find(rendered, (node) => node.type === "Icon").props.icon, "tick");
    t.mock.timers.tick(1000);
    button(rendered).props.onPress();
    await Promise.resolve();
    t.mock.timers.tick(500);
    assert.equal(button(screen.render(source)).props.accessibilityLabel, "Copied");
    t.mock.timers.tick(1000);
    assert.equal(button(screen.render(source)).props.accessibilityLabel, "Copy code");
    assert.deepEqual(copies, ["  printf 'a  b'\n", "  printf 'a  b'\n"]);
    assert.equal(taps, 2);
    rendered = screen.render("```\nfirst", true);
    assert.ok(textOf(rendered).includes("text"));
    button(rendered).props.onPress();
    await Promise.resolve();
    rendered = screen.render("```\nfirst\nsecond", true);
    button(rendered).props.onPress();
    await Promise.resolve();
    assert.deepEqual(copies.slice(-2), ["first", "first\nsecond"]);
    screen.unmount();
    t.mock.timers.tick(1500);
  }
});

test("a streaming Markdown reply renders at most every 50 ms, and its newest text always follows", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const screen = markdownHost();
  assert.equal(textOf(screen.render("First", true)), "First");
  // Each render reads the hook's state as the last timer left it: this harness doesn't re-render on its own.
  assert.equal(textOf(screen.render("First words", true)), "First", "a batch waits for the next frame");
  t.mock.timers.tick(0);
  assert.equal(textOf(screen.render("First words", true)), "First words", "the first batch after a pause shows at once");
  assert.equal(textOf(screen.render("First words\n\nSecond", true)), "First words");
  t.mock.timers.tick(49);
  assert.equal(textOf(screen.render("First words\n\nSecond", true)), "First words", "inside 50 ms the reply holds");
  t.mock.timers.tick(1);
  assert.equal(
    find(screen.render("First words\n\nSecond", true), (node) => node.type === "View" && node.props.style?.gap === 12).props.children.length,
    2,
    "the trailing batch shows, in its blocks",
  );
  assert.equal(textOf(screen.render("Another reply", true)), "Another reply", "a text that doesn't continue the shown one shows at once");
  assert.equal(textOf(screen.render("First words\n\nSecond and the end", false)), "First wordsSecond and the end", "a finished reply shows whole");
  screen.unmount();
});

test("Markdown code ignores stale clipboard completion, failure and resolution after unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  let taps = 0;
  const screen = markdownHost({
    copy: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    haptic: () => taps++,
  });
  const source = "    indented code\n";
  const button = () => find(screen.render(source), (node) => node.props?.accessibilityRole === "button");
  assert.ok(textOf(screen.render(source)).includes("text"));
  button().props.onPress();
  button().props.onPress();
  requests[1].resolve();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  requests[0].resolve();
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.equal(button().props.accessibilityLabel, "Copy code");
  assert.equal(taps, 1);
  button().props.onPress();
  requests[2].reject(new Error("clipboard unavailable"));
  await Promise.resolve();
  assert.equal(button().props.accessibilityLabel, "Copy code");
  button().props.onPress();
  screen.unmount();
  requests[3].resolve();
  await Promise.resolve();
  assert.equal(taps, 1);
});

test("Markdown tables align header/body columns, fill short tables and preserve rich nested cells", async () => {
  for (const prefix of ["", "> ", "  "]) {
    const source =
      (prefix === "  " ? "- Table\n\n" : "") +
      ["| Name | Value |", "| --- | --- |", "| **bold** | [short](https://example.org) |", "| `code` | final |"].map((line) => prefix + line).join("\n");
    const screen = markdownHost({ textPx: 20 });
    let rendered = screen.render(source);
    const outer = find(rendered, (node) => typeof node.props?.onLayout === "function");
    outer.props.onLayout({ nativeEvent: { layout: { width: 341 } } });
    rendered = screen.render(source);
    const scroll = find(rendered, (node) => node.type === "PageScroll" && node.props.horizontal);
    assert.deepEqual({ ...scroll.props.contentContainerStyle }, { padding: 0, paddingBottom: 0, gap: 0 });
    const cells = [];
    const collect = (node) => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (!node || typeof node !== "object") return;
      if (node.props?.style?.width) cells.push(node);
      collect(node.props?.children);
    };
    collect(scroll);
    assert.equal(cells.length, 6);
    assert.ok(cells.every((cell) => cell.props.style.width === 170));
    const headerText = find(cells[0], (node) => node.type === "Text");
    assert.equal(headerText.props.style.fontWeight, "600");
    assert.equal(headerText.props.style.fontSize, 20);
    assert.ok(textOf(rendered).includes("bold") && textOf(rendered).includes("code"));
    const link = find(rendered, (node) => node.props?.accessibilityRole === "link");
    link.props.onPress();
    await Promise.resolve();
    assert.deepEqual(screen.links, ["https://example.org"]);
    screen.unmount();
  }
});

test("Markdown fences render native headings and links with nested code kept literal", async () => {
  for (const streaming of [false, true]) {
    const screen = markdownHost();
    const rendered = screen.render("~~~~markdown\n## Description\n\n[Read more](https://example.org)\n\n```ts\nconst value = 1;\n```\n~~~~", streaming);
    assert.ok(find(rendered, (node) => node.props?.accessibilityRole === "header"));
    const link = find(rendered, (node) => node.props?.accessibilityRole === "link");
    assert.ok(link);
    await link.props.onPress();
    assert.deepEqual(screen.links, ["https://example.org"]);
    assert.ok(
      find(rendered, (node) => node.type === "PageScroll"),
      "Nested TypeScript stays a code block",
    );
  }
});

test("plain URLs in mobile replies render as links and open the exact address", async () => {
  for (const streaming of [false, true]) {
    for (const [text, url] of [
      ["The fix is in PR #289: https://github.com/the-ptf/milagre-ade/pull/289. It fixes both banners.", "https://github.com/the-ptf/milagre-ade/pull/289"],
      ["See (https://example.org/a_(b)).", "https://example.org/a_(b)"],
      ["Visit www.example.org or ask me later.", "http://www.example.org"],
      ["Email hello@example.org.", "mailto:hello@example.org"],
      ["[Pull request](https://github.com/the-ptf/milagre-ade/pull/289)", "https://github.com/the-ptf/milagre-ade/pull/289"],
    ]) {
      const screen = markdownHost();
      const link = find(screen.render(text, streaming), (node) => node.props?.accessibilityRole === "link");
      assert.ok(link, `Missing link in ${text} (streaming: ${streaming})`);
      assert.ok(link.props.style.some((style) => style.textDecorationLine === "underline"));
      await link.props.onPress();
      assert.deepEqual(screen.links, [url]);
    }
  }
});

test("mobile reply links honor the Chat destination and retain an external fallback without one", async () => {
  const { associatedPullRequest } = require("../packages/shared/src/chats.mjs");
  const prs = [
    { url: "https://github.com/team/first/pull/12", cwd: "/first" },
    { url: "https://github.com/team/second/pull/12", cwd: "/second" },
  ];
  for (const streaming of [false, true]) {
    const opened = [];
    const screen = markdownHost({
      openChatLink: (url) => {
        const pr = associatedPullRequest(url, prs);
        if (pr) opened.push(pr);
        return !!pr;
      },
    });
    await find(
      screen.render("[PR](https://github.com/team/second/pull/12/files#diff-123)", streaming),
      (node) => node.props?.accessibilityRole === "link",
    ).props.onPress();
    assert.deepEqual(opened, [prs[1]]);
    assert.deepEqual(screen.links, []);
    await find(screen.render("https://github.com/other/project/pull/12", streaming), (node) => node.props?.accessibilityRole === "link").props.onPress();
    assert.deepEqual(screen.links, ["https://github.com/other/project/pull/12"]);
  }
});

test("mobile reply links preserve localhost for the internal Browser instead of rewriting it to the phone's LAN route", async () => {
  for (const streaming of [false, true]) {
    const opened = [];
    const screen = markdownHost({
      reachable: { host: "100.69.206.111", loopbackOnly: new Set() },
      openChatLink: (url) => {
        opened.push(url);
        return true;
      },
    });
    find(screen.render("[App](http://localhost:5173/path?q=1)", streaming), (node) => node.props?.accessibilityRole === "link").props.onPress();
    assert.deepEqual(opened, ["http://localhost:5173/path?q=1"]);
    assert.deepEqual(screen.links, []);
  }
});

test("a localhost link opens at the computer's IP when the phone reaches it on the LAN, and stays as written otherwise or for a loopback-only server", async () => {
  for (const [text, label, url] of [
    ["Open http://localhost:5173 to see it.", "http://100.69.206.111:5173", "http://100.69.206.111:5173"],
    ["[The app](http://127.0.0.1:3000/app?x=1)", "The app", "http://100.69.206.111:3000/app?x=1"],
  ]) {
    const screen = markdownHost({ reachable: { host: "100.69.206.111", loopbackOnly: new Set([5175]) } });
    const tree = screen.render(text);
    const link = find(tree, (node) => node.props?.accessibilityRole === "link");
    assert.ok(link, `Missing link in ${text}`);
    assert.ok(JSON.stringify(link.props.children).includes(label), `the link reads ${label}`);
    await link.props.onPress();
    assert.deepEqual(screen.links, [url]);
  }
  // A server the Chat's ports show on the computer's loopback only would not answer at its IP.
  const loopback = markdownHost({ reachable: { host: "100.69.206.111", loopbackOnly: new Set([5175]) } });
  await find(loopback.render("Running at http://127.0.0.1:5175."), (node) => node.props?.accessibilityRole === "link").props.onPress();
  assert.deepEqual(loopback.links, ["http://127.0.0.1:5175"]);
  const relay = markdownHost();
  const link = find(relay.render("Open http://localhost:5173 to see it."), (node) => node.props?.accessibilityRole === "link");
  await link.props.onPress();
  assert.deepEqual(relay.links, ["http://localhost:5173"]);
});

test("links to files on the computer open the file preview", () => {
  for (const [text, path] of [
    ["The [written design](/Users/me/repo/docs/spec.md) is committed.", "/Users/me/repo/docs/spec.md"],
    ["See [the spec](docs/spec.md#L4).", "/worktrees/feature/docs/spec.md"],
    ["See [main](src/main.ts:12).", "/worktrees/feature/src/main.ts"],
  ]) {
    const screen = markdownHost({ basePath: "/worktrees/feature" });
    const link = find(screen.render(text), (node) => node.props?.accessibilityRole === "link");
    assert.ok(link, `Missing link in ${text}`);
    link.props.onPress();
    assert.equal(JSON.stringify(screen.routes), JSON.stringify([{ pathname: "/file-preview", params: { path } }]));
    assert.deepEqual(screen.links, [], "a file link never goes to the phone's browser");
  }
});

test("mobile replies keep code URLs and unsafe links inert", () => {
  for (const text of [
    "`https://example.org`",
    "```text\nhttps://example.org\n```",
    "[local](file:///etc/passwd)",
    "[command](javascript:alert(1))",
    "[pair](milagre-local://connect)",
  ]) {
    assert.equal(
      find(markdownHost().render(text), (node) => node.props?.accessibilityRole === "link"),
      undefined,
      text,
    );
  }
});

test("Markdown screenshot links render image previews outside Text and open the image viewer", () => {
  const screen = markdownHost();
  const url = "https://raw.githubusercontent.com/marcosgenesis/milagre-ade/22cc3932b99921b51318d869f617db4bfef45523/mobile-push/computers.jpg";
  const rendered = screen.render(`Here is the **Computers screen**:\n\n![Computers with Settings and bottom +](${url})`);
  const image = find(rendered, (node) => node.type === "Image");
  assert.ok(image, "The screenshot must render as an image, not an alt-text placeholder");
  assert.equal(image.props.source.uri, url);
  assert.equal(
    find(rendered, (node) => node.type === "Text" && [node.props.children].flat(Infinity).some((child) => find(child, (nested) => nested.type === "Image"))),
    undefined,
  );
  const preview = find(rendered, (node) => node.props?.accessibilityRole === "imagebutton");
  preview.props.onPress();
  assert.equal(screen.routes.at(-1), "/viewer");
  assert.equal(screen.viewer.viewerImages().images[0].source.uri, url);
});

test("local Markdown images use the computer connection and keep authentication in the viewer", () => {
  const paths = [];
  const source = { uri: "https://mac/media?path=shot", headers: { Authorization: "Bearer paired-token" } };
  const screen = markdownHost({
    basePath: "/worktrees/feature",
    media: (path) => {
      paths.push(path);
      return source;
    },
  });
  const rendered = screen.render("![Screenshot](./screens/left%20bar.png)");
  const image = find(rendered, (node) => node.type === "Image");
  assert.ok(image, "a local path must use the daemon, not disappear into alt text");
  assert.deepEqual(paths, ["/worktrees/feature/screens/left bar.png"]);
  assert.equal(image.props.source, source);
  find(rendered, (node) => node.props?.accessibilityRole === "imagebutton").props.onPress();
  assert.equal(screen.viewer.viewerImages().images[0].source, source);
});

test("relay Markdown images wait for the cached file and render it when ready", async () => {
  const file = deferred();
  const screen = markdownHost({ media: () => file.promise });
  const text = "![Screenshot](/tmp/shot.png)";
  assert.equal(
    find(screen.render(text), (node) => node.type === "Image"),
    undefined,
  );
  file.resolve({ uri: "file:///phone/cache/shot.png" });
  await settle();
  assert.equal(find(screen.render(text), (node) => node.type === "Image")?.props.source.uri, "file:///phone/cache/shot.png");
});

for (const reactCompiler of [false, true])
  test(`image retry refetches once and ignores a late previous source (compiler: ${reactCompiler})`, async () => {
    const requests = [];
    const media = (path) => {
      const request = deferred();
      requests.push({ path, ...request });
      return request.promise;
    };
    const screen = markdownHost({ media, reactCompiler });
    const first = "![Preview](/tmp/first.png)",
      second = "![Preview](/tmp/second.png)";
    screen.render(first);
    screen.render(first);
    assert.equal(requests.length, 1, "unrelated renders reuse the image request");
    requests[0].reject(new Error("Computer unavailable"));
    await settle();
    const retry = find(screen.render(first), (node) => node.props?.accessibilityLabel === "Retry Preview");
    assert.ok(retry);
    retry.props.onPress();
    screen.render(first);
    assert.equal(requests.length, 2, "retry reads again with unchanged target and media callback");
    screen.render(second);
    assert.equal(requests.length, 3);
    requests[2].resolve({ uri: "file:///cache/second.png" });
    await settle();
    assert.equal(find(screen.render(second), (node) => node.type === "Image")?.props.source.uri, "file:///cache/second.png");
    requests[1].resolve({ uri: "file:///cache/first.png" });
    await settle();
    assert.equal(find(screen.render(second), (node) => node.type === "Image")?.props.source.uri, "file:///cache/second.png");
    assert.equal(requests.length, 3);
  });

for (const reactCompiler of [false, true])
  test(`usage revision isolates pending account reads and closes the old connection (compiler: ${reactCompiler})`, async () => {
    const host = hookHost({ effects: true });
    const listeners = new Set(),
      connections = [],
      reads = [];
    const AppState = {
      currentState: "active",
      addEventListener: (_event, fn) => {
        listeners.add(fn);
        return { remove: () => listeners.delete(fn) };
      },
    };
    const react = {
      ...host,
      useSyncExternalStore(subscribe, snapshot) {
        host.useEffect(() => subscribe(() => {}), [subscribe]);
        return snapshot();
      },
    };
    const client = {
      call(method) {
        const pending = deferred();
        reads.push({ method, ...pending });
        return pending.promise;
      },
      live() {
        const connection = {
          closed: 0,
          close() {
            this.closed++;
          },
        };
        connections.push(connection);
        return connection;
      },
    };
    const { useUsage } = load(
      "use-usage.ts",
      {
        react,
        "react/compiler-runtime": compilerRuntime(host),
        "react-native": { AppState },
        "./usage-state": require("../apps/mobile/src/usage-state.ts"),
      },
      "",
      new Map(),
      reactCompiler,
    );
    const render = (revision) => {
      host.begin();
      return useUsage(client, "/p", revision);
    };
    try {
      const old = render(0);
      assert.equal(reads.length, 2);
      assert.equal(render(0).refresh, old.refresh);
      assert.equal(reads.length, 2, "same revision keeps the store and its pending reads");
      assert.equal(render(1).snapshot, null);
      assert.equal(reads.length, 4, "new account gets fresh cached and live reads");
      assert.equal(connections[0].closed, 1);
      assert.equal(listeners.size, 1);
      for (const read of reads.slice(2)) read.resolve({ accountKey: "new-account", providers: [] });
      await settle();
      assert.equal(render(1).snapshot.accountKey, "new-account");
      for (const read of reads.slice(0, 2)) read.resolve({ accountKey: "old-account", providers: [] });
      await settle();
      assert.equal(render(1).snapshot.accountKey, "new-account");
      assert.equal(connections.length, 2);
    } finally {
      host.unmount();
    }
    assert.equal(listeners.size, 0);
    assert.equal(connections[1].closed, 1);
  });

test("images embedded in emphasis, links and tables keep their surrounding text", () => {
  const screen = markdownHost();
  const rendered = screen.render(
    "Before **bold ![Preview](https://example.org/screen.png) after** end.\n\n| Screenshot |\n| --- |\n| [![Table preview](https://example.org/table.png)](https://example.org) |",
  );
  assert.ok(find(rendered, (node) => node.type === "Image" && node.props.source.uri === "https://example.org/screen.png"));
  assert.ok(find(rendered, (node) => node.type === "Image" && node.props.source.uri === "https://example.org/table.png"));
  assert.ok(
    find(
      rendered,
      (node) =>
        node.type === "Text" &&
        Array.isArray(node.props.style) &&
        node.props.style.some((style) => style.fontWeight === "600") &&
        [node.props.children].flat(Infinity).some((child) => find(child, (nested) => nested.type === "Text" && nested.props.children === " after")),
    ),
  );
});

test("a broken Markdown image leaves a browser link, and unsafe sources never load", async () => {
  const screen = markdownHost();
  const text = "![Missing screenshot](https://example.org/missing.png)";
  find(screen.render(text), (node) => node.type === "Image").props.onError();
  const fallback = find(screen.render(text), (node) => node.props?.accessibilityRole === "link");
  assert.ok(fallback);
  await fallback.props.onPress();
  assert.equal(screen.links.at(-1), "https://example.org/missing.png");
  for (const source of ["file:///etc/passwd", "mailto:hello@example.org", "milagre://pair", "https://secret@example.org/image.png"]) {
    assert.equal(
      find(markdownHost().render(`![blocked](${source})`), (node) => node.type === "Image"),
      undefined,
    );
  }
});
const snapshot = (projectPath) => ({ project: { path: projectPath, state: { sessions: {} } }, runs: { runs: {} } });

const relayRuntime = { name: "relay runtime" };
/** The LAN route wiring, stubbed: no native modules, every computer stays on its paired route. Calls are recorded when asked. */
const routesNative = ({ learned = [], forgotten = [] } = {}) => ({
  lanRoutes: {
    set() {},
    forget: (id) => forgotten.push(id),
    checkAll() {},
    subscribe: () => () => {},
    kind: () => "remote",
    view: () => ({ current: () => null, subscribe: () => () => {} }),
  },
  learnRoutes: async (client, host) => {
    learned.push([client.url, host]);
  },
});
function sessionHost(
  client,
  {
    effects = false,
    AppState = {},
    created = [],
    saved = [],
    learned = [],
    savedProjectOrder,
    savedHiddenProjects,
    chatDefaults,
    clientFactory,
    navigationStore,
    permission = "ask",
  } = {},
) {
  client.recentScopes ??= () => client.call("project:recent");
  client.open ??= async (owner) => {
    await client.call("project:open", [owner]);
    return client.snapshot(owner);
  };
  const react = hookHost({ effects });
  const { useSessionState, PendingChatsProvider, ComposerProvider } = load(
    "session.tsx",
    {
      react,
      "@milagre/shared/reconcile": require("@milagre/shared/reconcile"),
      "@milagre/shared/stable-order": require("@milagre/shared/stable-order"),
      "react/jsx-runtime": { jsx },
      "react-native": { AppState },
      "./client": {
        createClient: (...args) => {
          created.push(args);
          return clientFactory ? clientFactory(...args) : client;
        },
      },
      "./relay-native": { relayRuntime },
      "./routes-native": routesNative({ learned }),
      "./live": require("../apps/mobile/src/live.ts"),
      "./hosts-native": {
        savedHosts: {
          save: async (host) => {
            saved.push(host);
          },
          list: async () => [],
        },
        savedNavigation: navigationStore ?? { read: async () => null, save: async () => {}, forgetProject: async () => {} },
        savedProjectOrder: savedProjectOrder ?? { apply: async (_host, projects) => projects, save: async () => {} },
        savedHiddenProjects: savedHiddenProjects ?? { hidden: () => new Set(), apply: async (_host, projects) => projects, setHidden: async () => {} },
        readPermission: async () => permission,
        savedChatDefaults:
          chatDefaults ?? require("../apps/mobile/src/chat-defaults-store.ts").createChatDefaultsStore({ getItem: () => null, setItemAsync: async () => {} }),
        savePermission: async () => {},
      },
      "./turn-options": require("../apps/mobile/src/turn-options.ts"),
      "@milagre/shared/chats": require("@milagre/shared/chats"),
      "@milagre/shared/send-retry": require("@milagre/shared/send-retry"),
      "@milagre/shared/chat-summary": require("@milagre/shared/chat-summary"),
      "@milagre/shared/model": {},
      "./link-operations": require("../apps/mobile/src/link-operations.ts"),
      "./chat-pages": { prefetchChatPage: () => {}, noteChatProjectOpening: () => {} },
      "./pr-status": { pullRequestsChanged: () => {} },
      "./use-links": { refreshLinks: async () => {} },
      "./use-designs": { useDesigns: () => designsOn },
    },
    "\nexport { useSessionState, PendingChatsProvider, ComposerProvider };",
  );
  return Object.assign(
    () => {
      react.begin();
      return useSessionState();
    },
    {
      composer: () => {
        react.begin();
        return ComposerProvider({ children: null }).props.value;
      },
      unmount: react.unmount,
      pending: (props) => {
        react.begin();
        return PendingChatsProvider(props).props.value;
      },
    },
  );
}

test("pairing through the relay builds the client from the pairing and saves the relay link", async () => {
  const created = [],
    saved = [],
    learned = [];
  const relay = {
    url: "wss://relay.milagre.cloud",
    hostId: "H".repeat(22),
    key: "K".repeat(43),
  };
  const render = sessionHost(
    {
      url: `relay://${relay.hostId}`,
      call: async (method) => (method === "project:recent" ? [] : {}),
    },
    { created, saved, learned },
  );
  const pairing = {
    address: `relay://${relay.hostId}`,
    token: "a".repeat(64),
    name: "",
    relay,
  };
  assert.equal(await render().connect(pairing), true);
  assert.equal(created[0][0], pairing);
  assert.equal(created[0][3], relayRuntime);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [
    {
      name: "Mac",
      address: `relay://${relay.hostId}`,
      token: "a".repeat(64),
      relay,
    },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(learned)),
    [[`relay://${relay.hostId}`, { token: "a".repeat(64), relay }]],
    "asks the Mac for its LAN route after connecting",
  );
  assert.equal(render().hostName, "Mac");
});

test("reloading Projects keeps their order when opening a Chat moves its Project to the top of the host's list", async () => {
  let recent = [{ path: "A" }, { path: "B" }, { path: "C" }];
  const render = sessionHost({ call: async (method) => (method === "project:recent" ? recent : {}) });
  await render().connect({ address: "address", token: "token" });
  recent = [{ path: "C" }, { path: "A" }, { path: "B" }];
  await render().reloadProjects();
  assert.deepEqual(
    render().recent.map((item) => item.path),
    ["A", "B", "C"],
  );
  recent = [{ path: "D" }, { path: "C" }, { path: "B" }];
  await render().reloadProjects();
  assert.deepEqual(
    render().recent.map((item) => item.path),
    ["D", "B", "C"],
    "a new Project goes on top and a removed one leaves",
  );
});

test("removing the open Project clears its snapshot and list entry; a failed removal preserves both", async () => {
  let recent = [{ path: "/p" }];
  let fail = true;
  const render = sessionHost({
    url: "mac",
    call: async (method) => {
      if (method === "project:recent") return recent;
      if (method === "project:forget") {
        if (fail) throw new Error("disk full");
        recent = [];
      }
      return {};
    },
    snapshot: async () => snapshot("/p"),
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/p");
  await assert.rejects(render().forgetProject("/p"), /disk full/);
  assert.equal(render().snapshot.project.path, "/p");
  assert.equal(render().recent.length, 1);
  fail = false;
  await render().forgetProject("/p");
  assert.equal(render().snapshot, null);
  assert.equal(render().recent.length, 0);
});

for (const delay of ["acknowledgement", "saved location"]) {
  test(`a removal waiting for its ${delay} cannot overwrite a newly connected computer`, async () => {
    const pending = deferred();
    const a = {
      url: "a",
      call: async (method) => (method === "project:forget" && delay === "acknowledgement" ? pending.promise : {}),
      recentScopes: async () => [{ path: "/a" }],
    };
    const b = { url: "b", call: async () => ({}), recentScopes: async () => [{ path: "/b" }] };
    const render = sessionHost(a, {
      clientFactory: (host) => (host.address === "b" ? b : a),
      navigationStore: { read: async () => null, save: async () => {}, forgetProject: async () => (delay === "saved location" ? pending.promise : undefined) },
    });
    await render().connect({ address: "a", token: "token" });
    const removing = render().forgetProject("/a");
    await settleAll();
    await render().connect({ address: "b", token: "token" });
    pending.resolve();
    assert.equal(await removing, false, "The completion must not navigate away from the new computer");
    await settleAll();
    assert.equal(render().client, b);
    assert.deepEqual(
      render().recent.map((item) => item.path),
      ["/b"],
    );
  });
}

test("a removal cannot close a newer Chat selection on the same computer", async () => {
  const pending = deferred();
  const render = sessionHost({
    url: "a",
    call: async (method) => (method === "project:forget" ? pending.promise : {}),
    recentScopes: async () => [{ path: "/a" }, { path: "/b" }],
    snapshot: async (path) => snapshot(path),
  });
  await render().connect({ address: "a", token: "token" });
  await render().open("/a");
  const removing = render().forgetProject("/a");
  await render().open("/b");
  pending.resolve();
  assert.equal(await removing, false);
  assert.equal(render().snapshot.project.path, "/b");
});

test("the Projects order survives a relaunch, per computer", async () => {
  const { createProjectOrderStore } = require("../apps/mobile/src/project-order-store.ts");
  const disk = new Map();
  const store = createProjectOrderStore({ getItemAsync: async (key) => disk.get(key) ?? null, setItemAsync: async (key, value) => void disk.set(key, value) });
  const launch = async (url, recent) => {
    const render = sessionHost(
      { url, call: async (method) => (method === "project:recent" ? recent : {}) },
      {
        effects: true,
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
        savedProjectOrder: store,
      },
    );
    await render().connect({ address: url, token: "token" });
    await settle();
    render();
    await settle();
    return render;
  };
  const paths = (render) => render().recent.map((item) => item.path);
  // First launch: the Mac lists A, B, C and the phone shows them so.
  assert.deepEqual(paths(await launch("https://mac", [{ path: "A" }, { path: "B" }, { path: "C" }])), ["A", "B", "C"]);
  // Next launch the Mac's recent list has C first; the phone keeps its order, drops a gone Project and puts a new one on top.
  assert.deepEqual(paths(await launch("https://mac", [{ path: "C" }, { path: "A" }, { path: "B" }])), ["A", "B", "C"]);
  assert.deepEqual(paths(await launch("https://mac", [{ path: "D" }, { path: "C" }, { path: "B" }])), ["D", "B", "C"]);
  // Another computer has its own order.
  assert.deepEqual(paths(await launch("https://studio", [{ path: "C" }, { path: "B" }])), ["C", "B"]);
  assert.deepEqual(paths(await launch("https://mac", [{ path: "C" }, { path: "B" }, { path: "D" }])), ["D", "B", "C"]);
  // Every Project removed: the empty list is saved too, so Projects added back later start from the Mac's order.
  assert.deepEqual(paths(await launch("https://mac", [])), []);
  assert.deepEqual(paths(await launch("https://mac", [{ path: "B" }, { path: "C" }, { path: "D" }])), ["B", "C", "D"]);
});

test("a poll from the previous Project cannot restore it after another Project opens", async () => {
  const openingB = deferred(),
    pollingA = deferred();
  let delayA = false;
  const render = sessionHost({
    call: async (method, args) => (method === "project:recent" ? [] : method === "project:open" ? (args[0] === "B" ? openingB.promise : { path: "A" }) : {}),
    snapshot: async (projectPath) => (projectPath === "A" && delayA ? pollingA.promise : snapshot(projectPath)),
  });
  await render().connect({ address: "address", token: "token" });
  await render().open("A");
  const oldSession = render();
  delayA = true;
  const alreadyPolling = oldSession.refresh();
  const opening = oldSession.open("B");
  const pollingDuringOpen = oldSession.refresh();
  openingB.resolve({ path: "B" });
  await opening;
  assert.equal(render().snapshot.project.path, "B");
  pollingA.resolve(snapshot("A"));
  await Promise.all([alreadyPolling, pollingDuringOpen]);
  assert.equal(render().snapshot.project.path, "B");
  await oldSession.refresh();
  assert.equal(render().snapshot.project.path, "B");
});

test("the session fetches on live signals and polls only while the live socket is down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = [];
  const fetched = { snapshot: 0, runs: 0 };
  const listeners = [];
  const AppState = {
    currentState: "active",
    addEventListener: (_event, listener) => {
      listeners.push(listener);
      return { remove() {} };
    },
  };
  const setApp = (state) => {
    AppState.currentState = state;
    listeners.forEach((listener) => listener(state));
  };
  const render = sessionHost(
    {
      call: async (method, args) => (method === "project:recent" ? [] : method === "project:open" ? { path: args[0] } : {}),
      snapshot: async (projectPath) => {
        fetched.snapshot++;
        return { ...snapshot(projectPath), runs: { runs: {}, seq: 1 } };
      },
      runs: async () => {
        fetched.runs++;
        return { runs: { "A#1": { text: "streaming" } }, seq: 2 };
      },
      live: (projectPath, options) => {
        const socket = {
          projectPath,
          options,
          closed: false,
          close() {
            socket.closed = true;
          },
        };
        sockets.push(socket);
        return socket;
      },
    },
    { effects: true, AppState },
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const snapshots = async (count, message) => {
    await settle();
    assert.equal(fetched.snapshot, count, message);
  };
  await render().connect({ address: "address", token: "token" });
  await render().open("A");
  render();
  assert.deepEqual(
    sockets.map((socket) => socket.projectPath),
    ["A"],
  );
  await snapshots(2, "opening fetches, then the sync fetches once");
  t.mock.timers.tick(4000);
  await snapshots(3, "it polls while the socket is not open (an older bridge)");
  sockets[0].options.onStatus(true);
  await snapshots(4, "it catches up once the socket opens");
  t.mock.timers.tick(30000);
  await snapshots(4, "no polling while live");
  const before = render().snapshot;
  sockets[0].options.onSignal("runs");
  await settle();
  assert.equal(fetched.runs, 1);
  const live = render();
  assert.equal(live.snapshot, before, "a runs read leaves the snapshot every screen reads as it is");
  const runsNow = () => render().runsStore.runsFor(`${render().client.url}|A`, render().snapshot);
  assert.equal(runsNow().runs["A#1"].text, "streaming", "its runs show from the runs store");
  assert.equal(live.snapshot.project.path, "A");
  sockets[0].options.onSignal("project");
  await snapshots(5);
  assert.deepEqual(runsNow().runs, {}, "a whole read after it is newer: its runs show");
  sockets[0].options.onStatus(false);
  await snapshots(6, "losing the socket fetches at once");
  t.mock.timers.tick(4000);
  await snapshots(7, "and polls again");
  setApp("background");
  assert.equal(sockets[0].closed, true, "the socket closes in the background");
  t.mock.timers.tick(30000);
  await snapshots(7, "and nothing polls");
  setApp("active");
  assert.equal(sockets.length, 2, "it opens again in the foreground");
  await snapshots(8);
  render.unmount();
  assert.equal(sockets[1].closed, true);
});

test("disconnect cancels a connection that is still loading recent Projects", async () => {
  const recent = deferred();
  const render = sessionHost({ call: async (method) => (method === "project:recent" ? recent.promise : {}) });
  const connecting = render().connect({ address: "address", token: "token" });
  await Promise.resolve();
  render().disconnect();
  recent.resolve([]);
  await connecting;
  assert.equal(render().client, null);
});

function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
function chatHost({
  pickAttachments = async () => [],
  preparePastedImage = async () => {},
  call,
  effects = false,
  alert = () => {},
  linear = { active: false },
  browserShortcut = null,
  routines = [],
  routinesOn = true,
  localOutbox,
  computers,
  screenWidth = 402,
  contextPreferences = { showContextSize: true, compactButtonDisplay: "threshold" },
  contextSettings = { buttonThreshold: 70, autoThreshold: 85, autoCompact: false },
  now = new Date(2026, 9, 17, 10, 30).getTime(),
  chatDefaults = require("../apps/mobile/src/chat-defaults-store.ts").createChatDefaultsStore({ getItem: () => null, setItemAsync: async () => {} }),
  // "secondary" renders the pane as the Chat beside the routed one, with these params as its own.
  pane: asPane,
} = {}) {
  const sending = deferred();
  const calls = [];
  const choices = [];
  // The Chat's Undo changes state: a stand-in for the shared hook, which has its own test.
  const undo = {
    view: "closed",
    tasks: [],
    preview: null,
    opened: 0,
    inspected: [],
    async open() {
      undo.opened++;
      undo.view = "list";
    },
    async inspect(id) {
      undo.inspected.push(id);
      undo.view = "preview";
    },
  };
  const panels = {
    gesture: {},
    open: null,
    shown: [],
    show(side) {
      this.open = side;
      this.shown.push(side);
    },
    showChanges() {
      this.show("right");
    },
    showPullRequest(key) {
      this.show(key ? `right:pr:${key}` : "right:pr");
    },
  };
  const params = { worktreeId: "1" };
  const session = {
    designs: designsOn,
    client: {
      upload: async (_project, name) => ({ path: `/p/uploads/${name}` }),
      url: "mac",
      call: (method, args) => {
        calls.push({ method, args });
        return call ? call(method, args) : method === "project:branches" ? Promise.resolve(["main"]) : sending.promise;
      },
    },
    snapshot: {
      project: {
        path: "/p",
        name: "P",
        state: { next_id: 4, projects: {}, sessions: {}, messages: [], tasks: {}, worktrees: { 1: { id: 1, name: "main", path: "/p", project_id: 1 } } },
      },
      runs: { runs: {} },
    },
    pendingChats: {},
    setPendingChats(fn) {
      session.pendingChats = fn(session.pendingChats);
    },
    drafts: { "/p#new:1": "first message" },
    attachments: {},
    setAttachments(fn) {
      this.attachments = fn(this.attachments);
    },
    preferences: {},
    compactRequests: {},
    requestCompact(chatId) {
      this.compactRequests = { ...this.compactRequests, [chatId]: (this.compactRequests[chatId] ?? 0) + 1 };
    },
    defaults: require("../apps/mobile/src/turn-options.ts").defaultPreferences,
    setDefaultPermission() {},
    setDefaultModel() {},
    models: null,
    cliStatus: null,
    linkOperations: require("../apps/mobile/src/link-operations.ts").createLinkOperations(),
    setPreferences(fn) {
      this.preferences = fn(this.preferences);
    },
    setDrafts(fn) {
      this.drafts = fn(this.drafts);
    },
    refresh: async () => {
      session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex" };
    },
    previewProject: async () => session.snapshot,
    expectActivity() {},
    rememberChat() {},
    isSelected: () => true,
  };
  const react = hookHost({ effects });
  const ui = {
    ...Object.fromEntries(
      ["Button", "GlassIconButton", "IconButton", "ErrorNotice", "Field", "PageScroll", "PillButton", "PullDown", "HeaderButton"].map((name) => [name, name]),
    ),
    styles: { code: {} },
    colors: {},
  };
  const native = {
    ...Object.fromEntries(["KeyboardAvoidingView", "Text", "View", "Image", "Pressable"].map((name) => [name, name])),
    Platform: { OS: "ios" },
    Keyboard: { dismiss() {} },
    Alert: { alert },
    Linking: {},
    StyleSheet: { absoluteFill: {} },
    useColorScheme: () => "light",
    useWindowDimensions: () => ({ width: screenWidth, height: 874 }),
  };
  const icons = new Proxy({}, { get: (_, name) => String(name) });
  const router = {
    setParams: (values) => {
      if (router.deferParams) router.pendingParams = { ...router.pendingParams, ...values };
      else Object.assign(params, values);
    },
    push(href) {
      (router.pushed ??= []).push(href);
    },
    replace(route) {
      router.replaced = route;
    },
    back() {
      router.backs = (router.backs ?? 0) + 1;
    },
  };
  const { default: ChatScreen } = load("app/chat.tsx", {
    "../chat-display-setting": {
      useShowContextSize: () => [contextPreferences.showContextSize],
      useCompactButtonDisplay: () => [contextPreferences.compactButtonDisplay],
    },
    "@milagre/shared/chat-display": require("@milagre/shared/chat-display"),
    ...(localOutbox
      ? {
          "../outbox": {
            outbox: localOutbox,
            hasQueuedChat: (computerId, owner, sessionId) =>
              localOutbox
                .getSnapshot()
                .items?.some(
                  (item) => item.computerId === computerId && item.owner === owner && item.request.sessionId === sessionId && item.status !== "sent",
                ) ?? false,
            outboxAttachments: require("../apps/mobile/src/attachments.ts").outboxAttachments,
          },
        }
      : {}),
    ...(computers ? { "../all-computers": computers } : {}),
    "react-native-reanimated": { default: { View: "AnimatedView" }, useAnimatedStyle: (style) => style() },
    "../hosts-native": { savedChatDefaults: chatDefaults },
    "../genui/GenerativeUI": { GenerativeUIProvider: "GenerativeUIProvider" },
    // A test can stand in for a host that keeps messages by Chat with globalThis.chatPage.
    "../chat-pages": {
      useChatPage: (...args) => ({
        trim() {},
        ...(globalThis.chatPage?.(...args) ?? { messages: [], hasMore: false, total: 0, loading: false, loadEarlier: async () => {} }),
      }),
    },
    "@sbaiahmed1/react-native-blur": { LiquidGlassView: "LiquidGlassView" },
    "expo-crypto": { randomUUID: require("node:crypto").randomUUID },
    "../archive-progress": archiveProgress,
    "../attention": { AttentionPill: () => null },
    "../plan-pill": { PlanPill: () => null, PlanPanel: () => null, usePlanPanel: () => globalThis.planPanel ?? { phase: "closed" } },
    "../chat-actions": load("chat-actions.ts", {
      "react-native": { Alert: { alert } },
      "expo-clipboard": { setStringAsync: async () => {} },
      "./archive": require("../apps/mobile/src/archive.ts"),
      "./pins": require("../apps/mobile/src/pins.ts"),
      "./confirm-store": { confirmSheet: (...args) => alert(...args), confirm: async () => true },
    }),
    "@milagre/shared/message-navigation": require("@milagre/shared/message-navigation"),
    "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
    "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
    "@milagre/shared/provider-capabilities": require("@milagre/shared/provider-capabilities"),
    "../message-navigation": { MessageNavigation: "MessageNavigation" },
    "../queued-messages": { QueuedMessages: "QueuedMessages" },
    "../prompt-field": { PromptField: "PromptField" },
    "../context-ring": { ContextRing: "ContextRing" },
    "../context-settings": { useContextSettings: () => ({ settings: contextSettings }) },
    "@milagre/shared/use-compaction-feedback": { useCompactionFeedback: () => null },
    "../theme": { hex: () => ({ surface: "#ffffff" }) },
    "../simulator": { SimulatorChip: "SimulatorChip" },
    "../browser": { useBrowserShortcut: (options) => (typeof browserShortcut === "function" ? browserShortcut(options) : browserShortcut) },
    "../ports": { PortsChip: "PortsChip", useChatPorts: () => noPorts },
    "../terminal": { TerminalChip: "TerminalChip", terminalPlaces: () => undefined },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "expo-router": {
      Redirect: "Redirect",
      Stack: {
        Screen: "Screen",
        Toolbar: Object.assign(() => null, { Menu: "ToolbarMenu", MenuAction: "ToolbarMenuAction", Button: "ToolbarButton", View: "ToolbarView" }),
      },
      router,
      useNavigation: () => ({ setParams: (values) => Object.assign(params, values) }),
      useLocalSearchParams: () => params,
      useFocusEffect: (fn) => react.effect(fn, [fn]),
    },
    "@hugeicons/core-free-icons": icons,
    "@milagre/shared/pr-blockers": require("@milagre/shared/pr-blockers"),
    "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
    "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
    "../indicators": require("../apps/mobile/src/indicators.ts"),
    "../icons": { Icon: "Icon" },
    "../bottom-fade": { BottomFade: "BottomFade", EdgeFade: "EdgeFade" },
    "../side-panels": { useSidePanels: () => panels, PanelSwipe: "PanelSwipe" },
    "../read-open-chat": { useReadOpenChat() {} },
    "../loading-logo": { LoadingLogo: "LoadingLogo" },
    "../use-open-project": load("use-open-project.ts", {
      react,
      "expo-router": { router, useFocusEffect: (fn) => react.effect(fn, [fn]) },
      "./session": { useSession: () => session },
    }),
    "../dot-background": { useDotBackground: () => ({}) },
    "react-native-keyboard-controller": {
      KeyboardChatScrollView: "KeyboardChatScrollView",
      KeyboardStickyView: "KeyboardStickyView",
      useReanimatedKeyboardAnimation: () => ({ height: { get: () => 0 }, progress: { get: () => 0 } }),
      useKeyboardState: (select) => select({ isVisible: false, height: 0 }),
    },
    "../running-logo": { ThinkingIndicator: "ThinkingIndicator", BackgroundIndicator: "BackgroundIndicator" },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "@milagre/shared/model": require("@milagre/shared/model"),
    "@milagre/shared/agent-runs": { ...require("@milagre/shared/agent-runs"), lastUserModel: () => "" },
    "@milagre/shared/chats": require("@milagre/shared/chats"),
    "@milagre/shared/chat-summary": require("@milagre/shared/chat-summary"),
    "@milagre/shared/linear": require("@milagre/shared/linear"),
    "@milagre/shared/archive": require("@milagre/shared/archive"),
    "../use-linear": { useLinear: () => linear },
    "../use-routines": {
      useRoutines: () => ({ routines, enabled: routinesOn, unavailable: null, error: "", loading: false, refresh: async () => {}, update: async () => {} }),
    },
    "../chat-row-store": { useActivityClock: (on) => (on ? now : 0) },
    "../use-worktree-linear-issues": { useWorktreeLinearIssues: () => ({}) },
    "../choice-store": { showChoiceSheet: (request) => choices.push(request) },
    "../session": {
      useSession: () => session,
      useMainSession: () => session,
      useComposer: () => session,
      usePendingChats: () => session,
      // The Chat's streaming turn, read live from the test's snapshot as the session's runs store would hand it out.
      useRun: (key) => (key ? session.snapshot?.runs?.runs[key] : undefined),
      sameSession: (a, b) => a === b,
    },
    "../pending-chats": require("../apps/mobile/src/pending-chats.ts"),
    "@milagre/shared/send-retry": require("@milagre/shared/send-retry"),
    "../attachment-picker": { pickAttachments, preparePastedImage, discardPastedImage() {} },
    "../attachments": require("../apps/mobile/src/attachments.ts"),
    // A test can show the Worktree branch's PR with globalThis.chatPullRequest, and PRs the Chat named with globalThis.chatNamedPullRequests.
    "../status-indicators": {
      PullRequestAction: "PullRequestAction",
      PullRequestMerge: "PullRequestMerge",
      PullRequestReview: "PullRequestReview",
      HeaderPullRequestChip: "HeaderPullRequestChip",
      SubagentChip: "SubagentChip",
      BackgroundRing: "BackgroundRing",
    },
    "../use-chat-pull-requests": {
      useChatPullRequests: (_client, targets) =>
        Object.fromEntries(
          targets.map(({ path }) => [
            path,
            {
              branch: globalThis.branchPullRequests ? globalThis.branchPullRequests[path] : globalThis.chatPullRequest,
              found: globalThis.chatNamedPullRequests ?? {},
            },
          ]),
        ),
    },
    "../questions": { Approval: "Approval", Questions: "Questions" },
    "../chat-reply": { ChatReply: "ChatReply" },
    "../design-outbox": require("../apps/mobile/src/design-outbox.ts"),
    "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
    "../ui": ui,
    "../agent-controls": { AgentControls: "AgentControls", PermissionChip: "PermissionChip" },
    "../ultracode-glow": { UltracodeGlow: () => null },
    "../turn-options": require("../apps/mobile/src/turn-options.ts"),
    "../handoff-sides": require("../apps/mobile/src/handoff-sides.ts"),
    "../handoff-divider": { HandoffDivider: "HandoffDivider" },
    "../worktree-link-divider": { WorktreeLinkDivider: "WorktreeLinkDivider" },
    "../compaction-divider": { CompactionDivider: "CompactionDivider" },
    "../account-switch-divider": { AccountSwitchDivider: "AccountSwitchDivider" },
    "../chat-reload-divider": { ChatReloadDivider: "ChatReloadDivider" },
    "../babysit-stopped-divider": { BabysitStoppedDivider: "BabysitStoppedDivider" },
    "@milagre/shared/babysit": require("@milagre/shared/babysit"),
    "../routine-run-divider": { RoutineRunDivider: "RoutineRunDivider" },
    "@milagre/shared/routines": require("@milagre/shared/routines"),
    "@milagre/shared/chat-reload": require("@milagre/shared/chat-reload"),
    "../checkpoint-restore-divider": { CheckpointRestoreDivider: "CheckpointRestoreDivider" },
    "@milagre/shared/checkpoint-restore": require("@milagre/shared/checkpoint-restore"),
    "@milagre/shared/use-checkpoints": { useCheckpoints: (api, chatId) => Object.assign(undo, { api, chatId }) },
    "../undo-panel": { UndoPanel: "UndoPanel" },
    "../handoff-brief-store": { showBrief() {} },
    "@milagre/shared/handoff": require("@milagre/shared/handoff"),
    "@milagre/shared/worktree-link": require("@milagre/shared/worktree-link"),
    "@milagre/shared/compaction": require("@milagre/shared/compaction"),
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "../archive": require("../apps/mobile/src/archive.ts"),
    "../confirm-store": { confirmSheet: (...args) => alert(...args) },
  });
  const render = () => {
    react.begin();
    // The screen holds the routed Chat's pane, and on a wide iPad a second one beside it, which a phone never shows.
    const screen = ChatScreen();
    const pane = find(screen, (node) => typeof node.type === "function" && node.props.pane);
    const tree = pane.type(asPane ? { ...pane.props, pane: asPane, onClose: () => (router.closed = (router.closed ?? 0) + 1) } : pane.props);
    react.flush();
    return tree;
  };
  const field = () => {
    const props = find(render(), (node) => node.type === "PromptField").props;
    return { ...props, value: props.draft };
  };
  const send = () =>
    find(render(), (node) => node.type === "IconButton" && ["Send message", "Send follow-up", "Queue message"].includes(node.props.label)).props.onPress();
  return { session, sending, params, field, send, render, router, calls, choices, panels, undo };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function subagentsHost({ call = async () => {} } = {}) {
  const react = hookHost();
  const calls = [];
  const state = {
    sessions: {
      7: {
        id: 7,
        subagents: ["running", "completed", "failed", "cancelled", "unknown"].map((status) => ({ id: status, title: status, status, transcript: [] })),
      },
    },
  };
  const session = {
    snapshot: { project: { path: "/project", state } },
    client: {
      async call(method, args) {
        calls.push({ method, args: Array.from(args) });
        await call(method, args);
        const edits = require("@milagre/shared/project-edits");
        const next =
          method === "chat:archive-finished-subagents"
            ? edits.archiveFinishedSubagents(state, args[1])
            : edits.archiveSubagent(state, args[1], args[2], args[3]);
        state.sessions = next.sessions;
      },
    },
    refresh: async () => {},
    expectActivity() {},
  };
  const { default: AgentsSheet } = load("app/agents.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { router: { back() {} }, useLocalSearchParams: () => ({ id: "7" }) },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, name) => String(name) }),
    "@milagre/shared/project-edits": require("@milagre/shared/project-edits"),
    "@milagre/shared/agent-activity": require("@milagre/shared/agent-activity"),
    "../session": { useSession: () => session },
    "../subagent-glance": {
      SubagentRow: "SubagentRow",
      WholeSubagentDetail: "WholeSubagentDetail",
      elapsed: () => "1s",
      subagentRunning: (agent) => ["initializing", "running", "waiting"].includes(agent.status),
      useClock: () => 0,
    },
    "../icons": { Icon: "Icon" },
    "../ui": {
      CircleButton: "CircleButton",
      IconButton: "IconButton",
      ListRow: "ListRow",
      ErrorNotice: "ErrorNotice",
      PageScroll: "PageScroll",
      colors: {},
      styles: {},
    },
  });
  const render = () => {
    react.begin();
    return AgentsSheet();
  };
  const button = (title) => find(render(), (node) => node.props?.title === title || node.props?.label === title);
  const open = (id) => find(render(), (node) => node.type === "SubagentRow" && node.props.agent.id === id).props.onPress();
  return { render, button, open, calls, state, session };
}

test("mobile archives finished subagents without offering archived browsing", async () => {
  const host = subagentsHost();
  const archive = host.button("Archive finished");
  assert.ok(archive, "the sheet must offer bulk archive");
  await archive.props.onPress();
  assert.deepEqual(host.calls[0], { method: "chat:archive-finished-subagents", args: ["/project", 7] });
  assert.deepEqual(
    host.state.sessions[7].subagents.filter((agent) => agent.archived).map((agent) => agent.id),
    ["completed", "failed", "cancelled"],
  );
  assert.equal(host.button("Archive finished").props.disabled, true);
  assert.equal(host.button("Archived (3)"), undefined);
  assert.equal(host.button("Restore completed"), undefined);
  assert.equal(
    find(host.render(), (node) => node.type === "SubagentRow" && node.props.agent.archived),
    undefined,
  );
  // One subagent is archived from its detail, which closes back to the list.
  host.open("running");
  assert.ok(find(host.render(), (node) => node.type === "WholeSubagentDetail" && node.props.agent?.id === "running" && node.props.read));
  host.button("Archive subagent").props.onPress();
  await settle();
  assert.deepEqual(host.calls[1], { method: "chat:archive-subagent", args: ["/project", 7, "running", true] });
  assert.equal(
    find(host.render(), (node) => node.type === "SubagentRow" && node.props.agent.id === "running"),
    undefined,
  );
});

test("mobile blocks duplicate archive taps and reports a failed request without hiding entries", async () => {
  const pending = deferred();
  const host = subagentsHost({ call: () => pending.promise });
  const archive = host.button("Archive finished");
  assert.ok(archive, "the sheet must offer bulk archive");
  const first = archive.props.onPress();
  await archive.props.onPress();
  assert.equal(host.calls.length, 1);
  assert.equal(host.button("Archive finished").props.disabled, true);
  pending.reject(new Error("Computer disconnected"));
  await first;
  assert.match(find(host.render(), (node) => node.type === "ErrorNotice").props.message, /Computer disconnected/);
  assert.equal(
    host.state.sessions[7].subagents.some((agent) => agent.archived),
    false,
  );
  assert.equal(host.button("Archive finished").props.disabled, false);
});

test("archived-only subagents hide the mobile Chat menu action and pill", () => {
  const chat = chatHost();
  chat.params.id = "7";
  chat.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1, subagents: [{ id: "done", status: "completed", archived: true }] };
  assert.equal(chatMenuEntry(chat.render(), "Subagents"), undefined);
  assert.equal(
    find(chat.render(), (node) => node.type === "SubagentChip"),
    undefined,
  );
});

test("a saved phone Chat offers Undo changes in ⋯ and /undo, both open the list in the composer's place, and an undo line's Redo previews", async () => {
  const chat = chatHost();
  chat.params.id = "7";
  const state = chat.session.snapshot.project.state;
  state.sessions[7] = { id: 7, worktree_id: 1 };
  state.messages.push(
    { id: 1, session_id: 7, role: "user", body: "Edit login", context: null },
    {
      id: 2,
      session_id: 7,
      role: "assistant",
      body: "Undid 2 files",
      context: { kind: "checkpoint-restore", checkpointId: "t", recoveryId: "r", restored: 2, kept: 0, redo: false },
    },
  );
  chat.render();
  assert.equal(chat.undo.chatId, "/p#7");
  assert.deepEqual(JSON.parse(JSON.stringify(chat.field().commands)), [{ name: "undo", description: "Undo a task's file changes" }]);
  chatMenuEntry(chat.render(), "Undo changes").props.onPress();
  assert.equal(chat.undo.opened, 1);
  let tree = chat.render();
  assert.ok(find(tree, (node) => node.type === "UndoPanel"));
  assert.equal(
    find(tree, (node) => node.type === "PromptField"),
    undefined,
    "the panel takes the composer's place",
  );
  chat.undo.view = "closed";
  chat.field().onChangeText("/undo");
  assert.equal(await chat.send(), undefined);
  assert.equal(chat.undo.opened, 2);
  assert.equal(
    chat.calls.some((call) => call.method === "chat:send"),
    false,
    "/undo never reaches the agent",
  );
  chat.undo.view = "closed";
  tree = chat.render();
  find(tree, (node) => node.type === "CheckpointRestoreDivider").props.onPreview("r", "Redo");
  assert.deepEqual(chat.undo.inspected, ["r"]);
  assert.equal(find(chat.render(), (node) => node.type === "UndoPanel").props.intent, "Redo");
});

test("the mobile composer loads skills from the selected Chat Worktree", () => {
  const chat = chatHost();
  chat.session.snapshot.project.state.worktrees[2] = { id: 2, name: "feature", path: "/worktrees/feature", project_id: 1 };
  chat.params.worktreeId = "2";
  assert.equal(chat.field().projectPath, "/worktrees/feature");
});

test("a mobile Link draft sends through its canonical owner and retries the same operation", async () => {
  let attempts = 0;
  const chat = chatHost({
    effects: true,
    call: async (method) => {
      if (method === "link:send" && ++attempts === 1) throw new Error("Connection lost");
      return { sessionId: 42 };
    },
  });
  const id = "40996067-6cc2-4427-bc1e-9007c5f51875",
    owner = `milagre-link:${id}`;
  const link = {
    link: { id, name: "Food", projectIds: ["api", "web"] },
    projects: [
      { id: "api", path: "/api", name: "API" },
      { id: "web", path: "/web", name: "Web" },
    ],
    state: { next_id: 1, sessions: {}, messages: [], preparations: {} },
  };
  chat.session.snapshot = require("../apps/mobile/src/chat-scope.ts").phoneSnapshot({
    link,
    runs: { runs: {} },
  });
  chat.params.worktreeId = "0";
  chat.session.drafts = { [`${owner}#new:0`]: "Update both Projects" };
  assert.equal(chat.field().projectPath, "", "A new shared draft never selects a primary Project for skills");
  await chat.send();
  await settle();
  assert.equal(chat.field().value, "Update both Projects", "Failure restores the draft");
  await chat.send();
  await settle();
  const sends = chat.calls.filter((call) => call.method === "link:send");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].args[0].linkId, id);
  assert.equal(sends[0].args[0].sessionId, null);
  assert.equal(sends[0].args[0].operationId, sends[1].args[0].operationId);
  assert.equal("worktreeId" in sends[0].args[0], false);
  assert.equal(
    chat.calls.some((call) => ["worktree:create", "chat:send"].includes(call.method)),
    false,
  );
  assert.equal(chat.params.id, "42");
});

test("a Link Chat's PRs are its Projects' branch PRs, each opened in its own Worktree", () => {
  const id = "40996067-6cc2-4427-bc1e-9007c5f51875";
  const member = (projectId) => ({ projectId, projectPath: `/${projectId}`, worktreePath: `/wt/${projectId}`, branch: `milagre/${projectId}`, base: "main" });
  const pr = (number, state) => ({ number, title: `Change ${number}`, url: `https://github.com/o/${number}/pull/${number}`, state, readyToMerge: false });
  globalThis.branchPullRequests = {
    "/wt/api": { ...pr(12, "MERGED"), url: "https://github.com/o/api/pull/12" },
    "/wt/web": { ...pr(12, "OPEN"), url: "https://github.com/o/web/pull/12" },
  };
  globalThis.openedPullRequests = [];
  try {
    const chat = chatHost({ effects: true });
    const link = {
      link: { id, name: "Food", projectIds: ["api", "web"] },
      projects: [
        { id: "api", path: "/api", name: "API" },
        { id: "web", path: "/web", name: "Web" },
      ],
      state: {
        next_id: 43,
        sessions: { 42: { id: 42, provider: "codex", workspacePath: "/links/food/42", worktrees: [member("api"), member("web")] } },
        messages: [],
        preparations: {},
      },
    };
    chat.session.snapshot = require("../apps/mobile/src/chat-scope.ts").phoneSnapshot({ link, runs: { runs: {} } });
    chat.params.id = "42";
    const tree = chat.render();
    const key = `${chat.session.snapshot.project.path}#42`;
    // Both Projects opened a #12: the open one comes first, and each is read in its own Worktree.
    const choices = globalThis.prChat.chatPullRequestChoices(key);
    assert.equal(
      JSON.stringify(choices.map(({ number, state, cwd, project, projectPath }) => [number, state, cwd, project, projectPath])),
      JSON.stringify([
        [12, "OPEN", "/wt/web", "Web", "/web"],
        [12, "MERGED", "/wt/api", "API", "/api"],
      ]),
    );
    // The header's PR chip opens the open one, in the web Project's Worktree.
    const title = find(tree, (node) => node.type === "Screen" && typeof node.props.options?.headerTitle === "function").props.options.headerTitle();
    find(title, (node) => node.type === "HeaderPullRequestChip").props.onPress();
    assert.equal(JSON.stringify(globalThis.openedPullRequests), JSON.stringify([{ worktreeId: "42", number: "12", chat: key, cwd: "/wt/web" }]));
    const links = find(tree, (node) => node.type === "ChatLinkProvider").props;
    assert.equal(links.openLink("https://github.com/o/api/pull/12/files#diff-123"), true);
    assert.equal(JSON.stringify(globalThis.openedPullRequests.at(-1)), JSON.stringify({ worktreeId: "42", number: "12", chat: key, cwd: "/wt/api" }));
    assert.equal(links.openLink("https://github.com/o/unrelated/pull/12"), true);
    assert.equal(chat.router.pushed.at(-1).pathname, "/browser-sheet");
    assert.equal(chat.router.pushed.at(-1).params.url, "https://github.com/o/unrelated/pull/12");
    assert.equal(globalThis.openedPullRequests.length, 2);
  } finally {
    delete globalThis.branchPullRequests;
    delete globalThis.openedPullRequests;
  }
});

test("browsing another Project in the drawer leaves the current Chat selected", async () => {
  const render = sessionHost({
    url: "mac",
    call: async (method, args) => (method === "project:recent" ? [] : { path: args?.[0] }),
    snapshot: async (path) => snapshot(path),
    preview: async (path) => ({ ...snapshot(path), previewOnly: true }),
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/current");
  const before = render();
  const preview = await before.previewProject("/other");
  assert.equal(preview.project.path, "/other");
  assert.equal(preview.previewOnly, true);
  assert.equal(render().snapshot.project.path, "/current");
  assert.equal(before.isSelected(), true);
});

test("closing the drawer during an open keeps the previous Chat usable", async () => {
  const loading = deferred();
  const render = sessionHost({
    url: "mac",
    call: async (method, args) => (method === "project:recent" ? [] : { path: args?.[0] }),
    snapshot: async (path) => (path === "/other" ? loading.promise : snapshot(path)),
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/current");
  const before = render();
  const opening = before.open("/other", { background: true });
  render().cancelNavigation();
  loading.resolve(snapshot("/other"));
  assert.equal(await opening, undefined);
  assert.equal(render().snapshot.project.path, "/current");
  assert.equal(before.isSelected(), true);
});

test("a deleted drawer Chat does not switch the Project behind the drawer", async () => {
  const render = sessionHost({
    url: "mac",
    call: async (method, args) => (method === "project:recent" ? [] : { path: args?.[0] }),
    snapshot: async (path) => snapshot(path),
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/current");
  await assert.rejects(render().open("/other", { background: true, chatId: 77 }), /no longer available/);
  assert.equal(render().snapshot.project.path, "/current");
});

test("cancelling a computer switch preserves the active Chat selection", async () => {
  const status = deferred();
  let delay = false;
  const render = sessionHost({
    url: "mac",
    call: async (method, args) => (method === "daemon:status" && delay ? status.promise : method === "project:recent" ? [] : { path: args?.[0] }),
    snapshot: async (path) => snapshot(path),
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/current");
  const before = render();
  delay = true;
  const connecting = before.connect({ address: "studio", token: "token" });
  render().cancelNavigation();
  status.resolve({});
  assert.equal(await connecting, false);
  assert.equal(before.isSelected(), true);
});

test("a draft's computer switch keeps its old client and Project until the destination is ready", async () => {
  const loading = deferred();
  const old = { url: "mac", call: async () => [], snapshot: async (path) => snapshot(path) };
  const next = { url: "studio", call: async () => [], recentScopes: async () => [], open: () => loading.promise };
  const render = sessionHost(old, { clientFactory: (host) => (host.address === "studio" ? next : old) });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/current");
  const commits = [];
  const switching = render().connect({ address: "studio", token: "token" }, false, {
    projectPath: "/other",
    onOpen: (state) => commits.push(state.project.path),
  });
  await settle();
  assert.equal(render().client, old);
  assert.equal(render().snapshot.project.path, "/current");
  assert.equal(render().isSelected(), true);
  assert.deepEqual(commits, []);
  loading.resolve(snapshot("/other"));
  assert.equal(await switching, true);
  assert.equal(render().client, next);
  assert.equal(render().snapshot.project.path, "/other");
  assert.equal(render().isSelected(), true);
  assert.deepEqual(commits, ["/other"]);
});

test("failed or cancelled draft computer switches never commit a destination", async (t) => {
  for (const cancel of [false, true])
    await t.test(cancel ? "cancelled" : "failed", async () => {
      const loading = deferred();
      const old = { url: "mac", call: async () => [], snapshot: async (path) => snapshot(path) };
      const next = { url: "studio", call: async () => [], recentScopes: async () => [], open: () => loading.promise };
      const render = sessionHost(old, { clientFactory: (host) => (host.address === "studio" ? next : old) });
      await render().connect({ address: "mac", token: "token" });
      await render().open("/current");
      let committed = false;
      const switching = render().connect({ address: "studio", token: "token" }, false, {
        projectPath: "/other",
        onOpen: () => {
          committed = true;
        },
      });
      await settle();
      if (cancel) {
        render().cancelNavigation();
        loading.resolve(snapshot("/other"));
        assert.equal(await switching, false);
      } else {
        loading.reject(new Error("Computer unavailable"));
        await assert.rejects(switching, /Computer unavailable/);
      }
      assert.equal(committed, false);
      assert.equal(render().client, old);
      assert.equal(render().snapshot.project.path, "/current");
      assert.equal(render().isSelected(), true);
    });
});

function resumeHost({ target = { hostId: "mac", projectPath: "/last", chatId: 3 }, state = snapshot("/last"), failure } = {}) {
  const react = hookHost();
  react.useEffect = react.effect;
  const routes = [],
    opened = [];
  const session = {
    client: { url: "mac" },
    lastLocation: target,
    open: async (path) => {
      opened.push(path);
      if (failure) throw new Error(failure);
      return state;
    },
  };
  const { default: Screen } = load("app/projects.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": {
      Redirect: "Redirect",
      Stack: { Screen: "Screen" },
      router: { replace: (route) => routes.push(route) },
      useLocalSearchParams: () => ({ resume: "1" }),
    },
    "../session": { useSession: () => session },
    "../project-navigation": { ProjectNavigation: "ProjectNavigation" },
    "../ui": { ErrorNotice: "ErrorNotice", styles: {} },
    "../icons": { SpinnerRing: "SpinnerRing" },
    "../loading-logo": { LoadingLogo: "LoadingLogo" },
  });
  return {
    routes,
    opened,
    render() {
      react.begin();
      const tree = Screen();
      react.flush();
      return tree;
    },
    unmount: react.cleanup,
  };
}

test("launch restoration shows the splash animation while the saved Chat opens", () => {
  const app = resumeHost();
  const tree = app.render();
  assert.ok(find(tree, (node) => node.type === "LoadingLogo"));
  assert.equal(
    find(tree, (node) => node.type === "SpinnerRing"),
    undefined,
  );
  assert.ok(find(tree, (node) => node.props.accessibilityRole === "progressbar" && node.props.accessibilityLabel === "Reopening your Chat..."));
});

// The computer's Links as useLinks hands them out; none (an older Mac) unless a test gives some.
const linksState = ({ links = [], projects = [], available = projects.length > 0 } = {}) => ({
  available,
  links,
  projects,
  projectIdOf: (path) => projects.find((project) => project.path === path)?.id,
  projectNameOf: (id) => projects.find((project) => project.id === id)?.name,
  refresh: async () => {},
});
const chatLinks = () => load("chat-links.ts", { "@milagre/shared/chat-links": require("@milagre/shared/chat-links") });

/**
 * The sidebar's store as the tests see it: one computer built from the session (its Projects, its cached copies), or the
 * `computers` a test lists, each `{ hostId, name, state, projects, copies }`.
 */
function allComputersFake(session, computers, storeCalls) {
  const views = () =>
    computers
      ? computers.map((computer) => ({ loaded: true, errors: new Map(), lastSuccess: 1, ...computer, copies: new Map(Object.entries(computer.copies ?? {})) }))
      : [
          {
            hostId: session.client.url,
            name: "Mac",
            state: "online",
            loaded: true,
            lastSuccess: 1,
            projects: session.recent,
            copies: new Map(session.recent.flatMap((item) => (session.cachedProject(item.path) ? [[item.path, session.cachedProject(item.path)]] : []))),
            errors: new Map(),
          },
        ];
  return {
    useAllComputers: (options) => {
      storeCalls.push(["use", options]);
      return views();
    },
    useFoldedProjects: (ids) => new Map(ids.map((id) => [id, new Set()])),
    allComputers: {
      viewOf: (hostId) => views().find((view) => view.hostId === hostId),
      // A computer of the test's may bring its own client (`computer.client`), to see what reached it.
      clientFor: (hostId) =>
        hostId === session.client.url
          ? session.client
          : (computers?.find((computer) => computer.hostId === hostId)?.client ?? { url: hostId, call: async () => {} }),
      hostFor: (hostId) => ({ id: hostId, name: views().find((view) => view.hostId === hostId)?.name ?? "Mac", address: hostId, token: "token", lastUsed: 0 }),
      refreshProject: async (hostId, path) => {
        storeCalls.push(["refreshProject", hostId, path]);
        return session.previewProject(path);
      },
      refreshAll: async () => {
        storeCalls.push(["refreshAll"]);
      },
    },
  };
}

function navigationHost(
  opening,
  {
    session: extra = {},
    alert = () => {},
    calls = [],
    activeChatId,
    effects = false,
    links = linksState(),
    AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) },
    routinesAvailable = true,
    chatList = "grouped",
    computers,
  } = {},
) {
  const react = hookHost({ effects });
  const linkRequests = [];
  const prRequests = [];
  const choiceRequests = [];
  const storeCalls = [];
  const routes = [];
  const secondaryRoutes = [];
  const opened = [];
  const state = snapshot("/last");
  state.project.state.sessions[3] = { id: 3 };
  state.project.state.worktrees = { 1: { id: 1, path: "/last" } };
  const session = {
    pendingChats: {},
    client: {
      url: "mac",
      call: async (...args) => {
        calls.push(args);
      },
    },
    recent: [{ path: "/last" }],
    hosts: [],
    snapshot: state,
    open: (...args) => {
      opened.push(args);
      return opening;
    },
    reloadProjects: async () => {
      calls.push(["reload"]);
    },
    forgetProject: async (path) => {
      await session.client.call("project:forget", [path]);
      await session.reloadProjects();
      return true;
    },
    cachedProject: () => undefined,
    openCachedChat: () => null,
    previewProject: async () => state,
    openNotificationTargetCalls: [],
    openNotificationTarget: async (...args) => {
      session.openNotificationTargetCalls.push(args);
      return true;
    },
    connect: async () => true,
    ...extra,
  };
  const native = { Alert: { alert, prompt() {} } };
  const external = [];
  const { ChatPullRequestChips } = load("chat-pull-request-chips.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "expo-linking": { openURL: async (url) => external.push(url) },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/chats": require("@milagre/shared/chats"),
    "@milagre/shared/chat-summary": require("@milagre/shared/chat-summary"),
    "@milagre/shared/pr-blockers": require("@milagre/shared/pr-blockers"),
    "@milagre/shared/linear": require("@milagre/shared/linear"),
    "./icons": { Icon: "Icon" },
    "./ui": { PullDown: "PullDown", colors: { ink2: "ink2", green: "green", purple: "purple", red: "red", orange: "orange" } },
  });
  // Confirmations use the real sheet store, shown through the host's alert in the order the sheet would list them.
  const confirmStore = load("confirm-store.ts", {});
  confirmStore.setConfirmPresenter(() => {
    const entry = confirmStore.currentConfirmation();
    alert(
      entry.title,
      entry.message,
      entry.buttons.map((button, index) => ({ ...button, onPress: () => entry.choose(index) })),
    );
  });
  // Groups folded by hand, as the phone's store keeps them; the tests start with none, so every group is open.
  const folded = new Set();
  // Every Chat counts as listed here; the hidden Run Chat rule still applies (chat-list-filter.ts).
  const chats = {
    ...require("@milagre/shared/chats"),
    isListedChat: (chat, count, waiting) => !require("@milagre/shared/chats").isHiddenRunChat(chat, waiting),
  };
  // A row renders apart (NavigationRow, memoized); renderItem hands the tests the row as drawn, as before.
  const drawRows = (type, props, key) => (type?.name === "NavigationRow" ? type(props) : jsx(type, props, key));
  const { ProjectNavigation } = load("project-navigation.tsx", {
    "./update-sheet": { UpdateSettingsBadge: "UpdateSettingsBadge" },
    react: { ...react, useSyncExternalStore: (_subscribe, read) => read(), memo: (component) => component, useLayoutEffect: (fn) => fn() },
    "react/jsx-runtime": { jsx: drawRows, jsxs: drawRows },
    "./hosts-native": {
      // No new Chat has started on this phone yet, so New Chat opens in the open Project.
      savedChatDefaults: { readLastProject: () => null },
      savedFoldedProjects: {
        subscribe: () => () => {},
        folded: () => folded,
        loaded: () => true,
        load: async () => {},
        toggle: async (_host, path) => (folded.has(path) ? folded.delete(path) : folded.add(path)),
      },
    },
    "react-native": {
      ...Object.fromEntries(["FlatList", "Pressable", "RefreshControl", "Text", "View"].map((name) => [name, name])),
      ...native,
      AppState,
      Platform: { OS: "ios" },
      StyleSheet: { create: (styles) => styles },
    },
    "expo-clipboard": { setStringAsync: async () => {} },
    "@hugeicons/core-free-icons": {},
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "@milagre/shared/chats": chats,
    "./chat-swipe-row": { ChatSwipeRow: "ChatSwipeRow" },
    // Every Mac keeps Done unless a test plays an older one (globalThis.olderMac): it answers no retention.
    "./done-retention": { useDoneRetention: () => (globalThis.olderMac ? {} : new Proxy({}, { get: () => 24 })), retentionOf: () => 24 },
    "@milagre/shared/done": require("@milagre/shared/done"),
    "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
    "./chat-list-filter": load("chat-list-filter.ts", { "@milagre/shared/chats": chats }),
    "@milagre/shared/routines": require("@milagre/shared/routines"),
    "@milagre/shared/chat-summary": require("@milagre/shared/chat-summary"),
    "@milagre/shared/message-search": require("@milagre/shared/message-search"),
    "./session": { useSession: () => session, useListSnapshot: () => session.snapshot ?? null, useComposer: () => session, usePendingChats: () => session },
    "./live": require("../apps/mobile/src/live.ts"),
    "./use-links": { useLinks: () => links },
    "./chat-links": chatLinks(),
    "./link-actions": {
      linkWithChat: (request) => linkRequests.push(["link-with", request]),
      removeLinkFromChat: async (request) => linkRequests.push(["link-remove", request]),
    },
    "./turn-options": require("../apps/mobile/src/turn-options.ts"),
    "./indicators": require("../apps/mobile/src/indicators.ts"),
    "./status-indicators": { ChatMarkIcon: "ChatMarkIcon" },
    "./use-chat-pull-requests": { useComputerChatPullRequests: (targets) => (prRequests.push(targets), extra.prStatus ?? {}) },
    "./use-linear": { useLinear: () => ({ active: false }) },
    "./use-routines": { useRoutinesAvailable: () => routinesAvailable },
    "./use-worktree-linear-issues": { useWorktreeLinearIssues: () => ({}) },
    "@milagre/shared/chat-row": require("../packages/shared/src/chat-row.ts"),
    "./chat-row-store": {
      useChatRowShow: () => require("../packages/shared/src/chat-row.ts").PHONE_CHAT_ROW_SHOW,
      saveChatRowShow: () => {},
      useActivityClock: () => Date.now(),
    },
    "./chat-pull-request-chips": { ChatPullRequestChips },
    "./icons": { Icon: "Icon", SpinnerRing: "SpinnerRing" },
    "./loading-logo": { LoadingLogo: "LoadingLogo" },
    "./ui": {
      ...Object.fromEntries(["ErrorNotice", "Field", "IconButton", "PillButton", "PullDown"].map((name) => [name, name])),
      colors: { ink: "ink", ink2: "ink2", accent: "accent", accentInk: "accentInk", orange: "orange", red: "red" },
      styles: {},
    },
    "./archive-progress": archiveProgress,
    "./archive": archiveStore,
    "./attention": { AttentionDot: "AttentionDot", useAttention: () => [] },
    "@milagre/shared/agent-runs": { projectOfKey: (key) => key.slice(0, key.lastIndexOf("#")), lastUserModel: () => "" },
    "./chat-actions": load("chat-actions.ts", {
      "react-native": native,
      "expo-clipboard": { setStringAsync: async () => {} },
      "./archive": require("../apps/mobile/src/archive.ts"),
      "./pins": require("../apps/mobile/src/pins.ts"),
      "./confirm-store": confirmStore,
    }),
    "@milagre/shared/chat-scopes": require("@milagre/shared/chat-scopes"),
    "./accounts-section": { AccountsSection: "AccountsSection" },
    "./confirm-store": confirmStore,
    "./app/settings": { SettingsView: "SettingsView" },
    "./app/notifications": { NotificationsView: "NotificationsView" },
    "./usage-section": { UsageSection: "UsageSection" },
    "./project-icon": { ProjectIcon: "ProjectIcon", ProjectIcons: "ProjectIcons" },
    "./project-search": { ProjectSearch: "ProjectSearch" },
    "./chat-display-setting": { useChatList: () => [chatList, () => {}] },
    "./chat-list-controls": {
      ChatListControls: "ChatListControls",
      CONTROLS_HEIGHT: 48,
      useControlsVisibility: () => ({ hidden: {}, onScroll() {}, reveal() {} }),
      useControlsBottomInset: () => 96,
    },
    "./choice-store": { showChoiceSheet: (request) => choiceRequests.push(request) },
    "./chat-list-order": load("chat-list-order.ts", { "@milagre/shared/chats": chats }),
    "./computer-actions": { isDesktopComputer: () => false },
    "./new-chat-project": load("new-chat-project.ts", {}),
    "./app-version": { appVersionLine: () => "1.2.3" },
    "expo-haptics": { selectionAsync: async () => {} },
    "@sbaiahmed1/react-native-blur": { LiquidGlassView: "LiquidGlassView" },
    // The store's polling is the store's own test; here each computer's views come from the test's session or `computers`.
    "./all-computers": allComputersFake(session, computers, storeCalls),
  });
  const render = () => {
    react.begin();
    const tree = ProjectNavigation({
      activeChatId,
      onNavigate: (route, secondary) => {
        routes.push(route);
        secondaryRoutes.push(secondary);
      },
    });
    return typeof tree.type === "function" ? tree.type(tree.props) : tree;
  };
  const rows = () => find(render(), (node) => node.type === "FlatList");
  const row = (kind, index = 0) => {
    const list = rows();
    return list.props.renderItem({ item: list.props.data.filter((item) => item.kind === kind)[index] });
  };
  // A row's tap target is the menu that also has onPress; its ⋯ is the menu without one.
  const open = (node) => find(node, (child) => child.type === "PullDown" && child.props.onPress);
  const more = (node) => find(node, (child) => child.type === "PullDown" && !child.props.onPress);
  return {
    state,
    session,
    routes,
    secondaryRoutes,
    opened,
    calls,
    external,
    render,
    rows,
    row,
    open,
    more,
    linkRequests,
    prRequests,
    choiceRequests,
    storeCalls,
    unmount: react.unmount,
  };
}

test("the sidebar reads its computers only while shown, all Projects in One list and the unfolded ones when grouped", () => {
  const list = navigationHost(Promise.resolve(), { chatList: "list" });
  list.render();
  same(list.storeCalls.at(-1), ["use", { visible: true, expandAll: true }]);
  const grouped = navigationHost(Promise.resolve());
  grouped.render();
  same(grouped.storeCalls.at(-1), ["use", { visible: true, expandAll: false }]);
  const search = find(grouped.render(), (node) => node.type === "ChatListControls");
  search.props.onQuery("fix");
  grouped.render();
  same(grouped.storeCalls.at(-1), ["use", { visible: true, expandAll: true }]);
  // Pull to refresh reads every computer, not just the open one.
  const refresh = find(grouped.render(), (node) => node.type === "FlatList").props.refreshControl;
  refresh.props.onRefresh();
  assert.ok(grouped.storeCalls.some(([name]) => name === "refreshAll"));
});

test("One list shows Chats from every computer in one list, each row naming its Project and its computer", async () => {
  const chat = (id, title, summary = {}) => ({ id, worktree_id: 1, title, summary: { count: 1, ...summary } });
  const copy = (path, sessions) => ({
    previewOnly: true,
    project: { path, name: path.slice(1), state: { sessions, worktrees: { 1: { id: 1, path, name: "main" } }, messages: [] } },
    runs: { runs: {} },
  });
  const nav = navigationHost(Promise.resolve(), {
    chatList: "list",
    computers: [
      {
        hostId: "mac",
        name: "MacBook",
        state: "online",
        projects: [{ path: "/web" }],
        copies: { "/web": copy("/web", { 1: chat(1, "Fix login", { firstAt: 100 }), 2: chat(2, "Docs", { firstAt: 300 }) }) },
      },
      {
        hostId: "studio",
        name: "Studio",
        state: "offline",
        projects: [{ path: "/web" }, { path: "/api" }],
        // The same path and Chat id as the first computer: the rows are told apart by their computer.
        copies: { "/web": copy("/web", { 1: chat(1, "Deploy", { firstAt: 200 }) }), "/api": copy("/api", { 7: chat(7, "Schema", { firstAt: 50 }) }) },
      },
    ],
  });
  const data = nav.rows().props.data.filter((item) => item.kind === "chat");
  same(
    data.map((item) => [item.hostId, item.path, item.chat.id, item.title]),
    [
      ["mac", "/web", 2, "Docs"],
      ["studio", "/web", 1, "Deploy"],
      ["mac", "/web", 1, "Fix login"],
      ["studio", "/api", 7, "Schema"],
    ],
  );
  assert.equal(new Set(data.map((item) => item.key)).size, 4, "the same path and Chat id on two computers make two rows");
  const text = (node) => allNodes(node, (child) => child.type === "Text").map((child) => child.props.children);
  const first = nav.rows().props.renderItem({ item: data[0] });
  assert.ok(text(first).includes("Docs"), "line 1 is the title");
  assert.ok(text(first).includes("web"), "line 2 names the Project");
  assert.ok(
    find(first, (node) => node.type === "ProjectIcon" && node.props.size === 32),
    "the Project's icon leads the row",
  );
  assert.equal(find(first, (node) => node.type?.name === "ComputerTag").props.name, "MacBook", "each computer is named when the list spans multiple computers");
  const offline = nav.rows().props.renderItem({ item: data[1] });
  assert.equal(offline.props.children.props.style.opacity, 0.55, "an offline computer's rows are dimmed");
  // Another computer is named on line 2, offline here.
  same(find(offline, (node) => node.type?.name === "ComputerTag").props, { name: "Studio", offline: true, large: true });
  // No ⋯ button: the long-press menu covers the whole row.
  const menus = allNodes(offline, (node) => node.type === "PullDown");
  assert.equal(menus.length, 1);
  assert.ok(menus[0].props.onPress && menus[0].props.sections.length, "a tap opens the Chat, a long press its menu");
  // A row on another computer opens through that computer's own client, never the session's.
  const tap = find(nav.rows().props.renderItem({ item: data[1] }), (node) => node.type === "PullDown" && node.props.onPress);
  tap.props.onPress();
  await settleAll();
  assert.equal(nav.session.openNotificationTargetCalls?.[0]?.[0].id, "studio");
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/web", hostId: "studio", id: "1" } }]));
  assert.deepEqual(nav.calls, [], "nothing went through the open computer's client");
});

test("the sidebar keeps every computer's PR chips and routes each row's lookups after a computer switch", () => {
  const pr = (number) => ({ number, url: `https://github.com/x/y/pull/${number}`, state: "OPEN" });
  const copy = (title) => ({
    project: {
      path: "/same",
      state: {
        sessions: { 1: { id: 1, worktree_id: 1, title, summary: { count: 1, firstAt: 100 } } },
        worktrees: { 1: { id: 1, path: "/same/w" } },
        messages: [],
      },
    },
    runs: { runs: {} },
  });
  const mac = { url: "mac" },
    studio = { url: "studio" };
  const computers = [
    { hostId: "mac", client: mac, name: "Mac", state: "online", projects: [{ path: "/same" }], copies: { "/same": copy("Mac Chat") } },
    { hostId: "studio", client: studio, name: "Studio", state: "offline", projects: [{ path: "/same" }], copies: { "/same": copy("Studio Chat") } },
  ];
  const nav = navigationHost(Promise.resolve(), {
    chatList: "list",
    computers,
    session: {
      client: mac,
      snapshot: copy("Mac Chat"),
      prStatus: {
        mac: { "/same/w": { branch: pr(101), found: {} } },
        studio: { "/same/w": { branch: pr(202), found: {} } },
      },
    },
  });
  const chips = () =>
    nav
      .rows()
      .props.data.filter((row) => row.kind === "chat")
      .map((row) => [row.hostId, row.pullRequests.map((pr) => pr.number)]);
  same(chips(), [
    ["mac", [101]],
    ["studio", [202]],
  ]);
  assert.equal(nav.prRequests.at(-1).find((target) => target.hostId === "studio").client, studio);
  nav.session.client = studio;
  nav.session.snapshot = copy("Studio Chat");
  same(chips(), [
    ["mac", [101]],
    ["studio", [202]],
  ]);
  assert.equal(nav.prRequests.at(-1).find((target) => target.hostId === "mac").client, mac);
});

test("a cached Chat on another computer routes synchronously without the sidebar's loading state", () => {
  const copy = snapshot("/web");
  copy.project.state.worktrees = {};
  copy.project.state.sessions[7] = { id: 7, title: "Cached remote Chat", agent_name: "main" };
  const opened = [];
  const nav = navigationHost(new Promise(() => {}), {
    chatList: "list",
    session: {
      openCachedChat: (...args) => {
        opened.push(args);
        return { url: "studio" };
      },
    },
    computers: [{ hostId: "studio", name: "Studio", state: "offline", projects: [{ path: "/web" }], copies: { "/web": copy } }],
  });
  nav.open(nav.row("chat")).props.onPress();
  assert.equal(opened[0][2].id, "studio");
  assert.equal(nav.routes.length, 1, "the route is issued before any promise settles");
  assert.equal(nav.routes[0].params.id, "7");
  assert.equal(nav.session.openNotificationTargetCalls.length, 0);
  assert.equal(
    find(nav.render(), (node) => node.type === "LoadingLogo"),
    undefined,
  );
});

test("mobile chat titles use summaries before transcripts load and switch to generated or renamed titles", () => {
  const nav = navigationHost(Promise.resolve());
  const chat = { id: 3, agent_name: "main", summary: { count: 2, titleLine: "Fix the login redirect" } };
  nav.state.project.state.sessions[3] = chat;
  nav.state.project.state.messages = [];
  const title = () => find(nav.row("chat"), (node) => node.type === "Text" && node.props.numberOfLines === 2).props.children;
  assert.equal(title(), "Fix the login redirect");
  const search = () => find(nav.render(), (node) => node.type === "ChatListControls");
  search().props.onQuery("login redirect");
  assert.equal(nav.rows().props.data.filter((item) => item.kind === "chat").length, 1, "the summary title is searchable without message bodies");
  search().props.onQuery("");
  nav.state.project.state.sessions = { 3: { ...chat, generatedTitle: "Repair login navigation" } };
  nav.session.snapshot = { ...nav.state };
  assert.equal(title(), "Repair login navigation");
  nav.state.project.state.sessions = { 3: { ...chat, generatedTitle: "Repair login navigation", title: "  My login fix  " } };
  nav.session.snapshot = { ...nav.state };
  assert.equal(title(), "My login fix");

  const host = chatHost();
  host.params.id = "3";
  host.session.snapshot.project.state.sessions[3] = chat;
  const screen = find(host.render(), (node) => node.type === "Screen");
  assert.equal(screen.props.options.title, "Fix the login redirect", "the Chat header uses the summary while the transcript is loading");
});

test("mobile chat titles fall back to messages from an older host, including message search results", () => {
  const nav = navigationHost(Promise.resolve());
  nav.state.project.state.sessions[3] = { id: 3, agent_name: "main" };
  nav.state.project.state.messages = [
    { id: 6, session_id: 99, role: "user", body: "Another Chat's title" },
    { id: 7, session_id: 3, role: "user", body: "Fix login\nCheck the callback URL" },
    { id: 8, session_id: 3, role: "assistant", body: "Check the wrangler configuration" },
  ];
  assert.equal(find(nav.row("chat"), (node) => node.type === "Text" && node.props.numberOfLines === 2).props.children, "Fix login");
  find(nav.render(), (node) => node.type === "ChatListControls").props.onQuery("wrangler");
  assert.equal(nav.row("message").props.accessibilityLabel, "Check the wrangler configuration, in Fix login, last");
});

test("mobile chat rows keep unread emphasis during a running turn and match desktop read title contrast", () => {
  const nav = navigationHost(Promise.resolve());
  const titleStyle = () => Object.assign({}, ...find(nav.row("chat"), (node) => node.type === "Text" && node.props.numberOfLines === 2).props.style);
  assert.equal(titleStyle().color, "ink2", "read, inactive Chats use the secondary ink");
  nav.state.project.state.sessions[3].unread = true;
  nav.state.runs.runs["/last#3"] = { questions: [], approvals: [] };
  assert.equal(titleStyle().color, "ink");
  assert.equal(titleStyle().fontWeight, "600", "running does not hide unread title emphasis");
  const active = navigationHost(Promise.resolve(), { activeChatId: 3 });
  assert.equal(Object.assign({}, ...find(active.row("chat"), (node) => node.type === "Text" && node.props.numberOfLines === 2).props.style).color, "ink");
});

test("mobile chat status labels use the same tone as their status icons", () => {
  const nav = navigationHost(Promise.resolve());
  const list = nav.rows();
  const item = list.props.data.find((row) => row.kind === "chat");
  for (const mark of ["running", "background"]) {
    const row = list.props.renderItem({ item: { ...item, mark } });
    assert.equal(
      find(row, (node) => node.type === "Text" && /^(Running|In the background)$/.test(node.props.children)),
      undefined,
      `a ${mark} row shows no status word`,
    );
  }
  for (const [mark, label, color] of [
    ["question", "Needs reply", "accentInk"],
    ["waiting", "Needs approval", "orange"],
    ["interrupted", "Interrupted", "orange"],
    ["failed", "Failed", "red"],
    ["unread", "Unread", "accentInk"],
  ]) {
    const row = list.props.renderItem({ item: { ...item, mark } });
    const status = find(row, (node) => node.type === "Text" && node.props.children === label);
    assert.equal(Object.assign({}, ...status.props.style).color, color, label);
  }
});

test("mobile chat rows show clickable PR numbers with desktop status colors", async () => {
  const nav = navigationHost(Promise.resolve());
  const list = nav.rows();
  const item = list.props.data.find((row) => row.kind === "chat");
  for (const [extra, tone, label] of [
    [{}, "green", ""],
    [{ state: "MERGED" }, "purple", ""],
    [{ hasConflicts: true }, "red", "Conflicts"],
    [{ isBehind: true }, "orange", "Out of date"],
    [{ checks: "running" }, "orange", "CI running"],
    [{ readyToMerge: true }, "green", "Ready"],
  ]) {
    const pr = {
      number: 246,
      title: "Fix Chat colors",
      url: "https://github.com/example/project/pull/246",
      state: "OPEN",
      ...extra,
    };
    const row = list.props.renderItem({
      item: { ...item, pullRequests: [pr] },
    });
    assert.equal(
      find(row, (node) => node.type === "Text" && node.props.children === item.worktree),
      undefined,
      "PR replaces the branch line",
    );
    const chipsNode = find(row, (node) => typeof node.type === "function" && node.props.pullRequests);
    const chips = chipsNode?.type(chipsNode.props);
    const chip = find(chips, (node) => node.type === "Pressable" && node.props.accessibilityLabel?.includes("pull request #246"));
    assert.ok(chip, "a PR has its own tap target outside the Chat tap target");
    assert.equal(chip.props.accessibilityRole, "button", "a PR of this computer's Chat opens in the app, not on GitHub");
    assert.ok(find(chip, (node) => node.type === "Text" && node.props.children.includes(246)));
    assert.equal(find(chip, (node) => node.type === "Icon").props.tone, tone);
    if (label) assert.ok(find(chip, (node) => node.type === "Text" && node.props.children === label));
    const before = nav.routes.length;
    await chip.props.onPress({ stopPropagation() {} });
    assert.equal(nav.routes.length, before + 1, "the PR opens its Chat, which then opens the PR sheet");
    assert.equal(nav.routes.at(-1).pathname, "/chat");
    assert.equal(nav.routes.at(-1).params.id, String(item.chat.id));
    assert.equal(nav.external.length, 0, "the PR does not leave for GitHub");
  }
  const plain = list.props.renderItem({ item: { ...item, pullRequests: [] } });
  assert.ok(
    find(plain, (node) => node.type === "Text" && node.props.children === item.worktree),
    "Chats without PRs keep their branch name",
  );
  const prs = [246, 247, 248].map((number) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    state: "OPEN",
  }));
  const multi = list.props.renderItem({
    item: { ...item, pullRequests: prs, mark: "waiting" },
  });
  const component = find(multi, (node) => typeof node.type === "function" && node.props.pullRequests);
  const chips = component.type(component.props);
  assert.equal(
    find(chips, (node) => node.type === "Text" && Array.isArray(node.props.children) && node.props.children.includes(248)),
    undefined,
    "extra PRs do not create another line",
  );
  const more = find(chips, (node) => node.type === "PullDown");
  assert.ok(more, "extra PRs remain available in a menu");
  const routesBefore = nav.routes.length;
  more.props.onSelect(prs[2].url);
  await Promise.resolve();
  assert.equal(nav.routes.length, routesBefore + 1, "a PR from the menu opens in its Chat too");
  assert.ok(
    find(chips, (node) => node.type === "Text" && node.props.children === "Needs approval"),
    "PR rows keep what the Chat waits on, on their second line",
  );
  const working = list.props.renderItem({ item: { ...item, pullRequests: prs, mark: "running" } });
  const workingChips = find(working, (node) => typeof node.type === "function" && node.props.pullRequests);
  assert.equal(
    find(workingChips.type(workingChips.props), (node) => node.type === "Text" && node.props.children === "Running"),
    undefined,
    "a working Chat says so with its spinner alone, as on desktop",
  );
});

test("mobile list PR lookups combine branch and historical statuses and stop while backgrounded", async () => {
  const react = hookHost();
  const app = {
    currentState: "active",
    addEventListener: (_event, fn) => (
      (listener = fn),
      {
        remove() {
          listener = null;
        },
      }
    ),
  };
  let listener;
  const called = [];
  const client = {
    url: "mac",
    call: async (method, args) => {
      called.push([method, args]);
      const pr = { number: method === "worktree:pull-request" ? 248 : 246, state: method === "worktree:pull-request" ? "OPEN" : "MERGED" };
      return method === "worktree:pull-request" ? pr : [pr];
    },
  };
  const { useChatPullRequests } = load("use-chat-pull-requests.ts", {
    react: { ...react, useSyncExternalStore: (_subscribe, read) => read() },
    "expo-router": { useFocusEffect: (fn) => react.effect(fn, [fn]) },
    "react-native": { AppState: app },
    "./pr-status": require("../apps/mobile/src/pr-status.ts"),
  });
  let targets = [{ path: "/w", refs: ["246"] }];
  const render = () => {
    react.begin();
    return useChatPullRequests(client, targets);
  };
  render();
  react.flush();
  await new Promise((resolve) => setImmediate(resolve));
  const status = render()["/w"];
  assert.equal(status.branch.number, 248);
  assert.equal(status.found["246"].number, 246);
  assert.deepEqual(called, [
    ["worktree:pull-request", ["/w"]],
    ["worktree:pull-requests", ["/w", ["246"]]],
  ]);
  app.currentState = "background";
  targets = [{ path: "/next", refs: [] }];
  render();
  react.flush();
  assert.equal(called.length, 2, "backgrounded lists do not start GitHub requests");
  app.currentState = "active";
  listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render()["/next"].branch.number, 248, "foreground resumes PR lookup");
  react.cleanup();
});

test("PRs stay scoped to each computer through switches, delayed reads, offline failures and remounts", async () => {
  let react = hookHost();
  let offline = false;
  const pending = deferred();
  const calls = [];
  const client = (url, number) => ({
    url,
    call: async (method, args) => {
      calls.push([url, method, args]);
      if (url === "two" && offline) throw new Error("Offline");
      if (url === "two") return pending.promise;
      return { number, state: "OPEN" };
    },
  });
  const one = client("one", 101),
    two = client("two", 202);
  const modules = {
    react: {
      useCallback: (...args) => react.useCallback(...args),
      useMemo: (...args) => react.useMemo(...args),
      useSyncExternalStore: (_subscribe, read) => read(),
    },
    "expo-router": { useFocusEffect: (fn) => react.effect(fn, [fn]) },
    "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
    "./pr-status": require("../apps/mobile/src/pr-status.ts"),
  };
  const hooks = load("use-chat-pull-requests.ts", modules);
  const targets = [{ path: "/same", refs: [] }];
  let computers = [
    { hostId: "one", client: one, targets },
    { hostId: "two", client: two, targets },
  ];
  const render = () => {
    react.begin();
    return hooks.useComputerChatPullRequests(computers);
  };
  render();
  react.flush();
  await settle();
  assert.equal(render().one["/same"].branch.number, 101);
  assert.equal(render().two, undefined, "another Mac never borrows the PR from an identical path");
  pending.resolve({ number: 202, state: "OPEN" });
  await settle();
  assert.equal(render().two["/same"].branch.number, 202);
  computers = [
    { hostId: "two", client: two, targets },
    { hostId: "one", client: null, targets },
  ];
  assert.equal(render().one["/same"].branch.number, 101, "an offline computer keeps its chip immediately on a switch");
  react.flush();
  await settle();
  offline = true;
  require("../apps/mobile/src/pr-status.ts").pullRequestsChanged(two);
  await settle();
  assert.equal(render().two["/same"].branch.number, 202, "a failed refresh keeps the last answer");
  react.cleanup();
  react = hookHost();
  // A new screen reads the same hook module, like the actual drawer and Chat.
  const original = hooks.useChatPullRequests;
  react.begin();
  assert.equal(original(one, targets)["/same"].branch.number, 101);
  react.cleanup();
  assert.equal(calls.length, 3, "each request is routed through its own client's bounded pool");
});

test("the phone reads the Chat on screen: on opening, on coming back to it, and when a reply lands there", () => {
  const react = hookHost({ effects: true });
  let changed;
  let focus;
  const app = { currentState: "active", addEventListener: (_event, fn) => ((changed = fn), { remove() {} }) };
  const patches = [];
  // Arguments come from the module's own realm: compared as JSON.
  const client = { call: async (method, args) => patches.push(JSON.parse(JSON.stringify([method, args]))) };
  const { useReadOpenChat } = load("read-open-chat.ts", {
    react,
    "expo-router": { useFocusEffect: (fn) => (focus = fn) },
    "react-native": { AppState: app },
  });
  const read = [["chat:patch", ["/p", 4, { unread: false }]]];
  let chat = { id: 4, unread: true };
  let covered = false;
  const render = () => {
    react.begin();
    useReadOpenChat(client, "/p", chat, covered);
  };
  render();
  assert.deepEqual(patches, [], "nothing is read before the screen has focus");
  const blur = focus();
  render();
  assert.deepEqual(patches, read, "opening the Chat reads it");
  chat = { id: 4, unread: false };
  render();
  // Mark as unread from the sidebar, which covers the Chat: it sticks until the Chat shows again.
  covered = true;
  render();
  chat = { id: 4, unread: true };
  render();
  assert.equal(patches.length, 1);
  covered = false;
  render();
  assert.deepEqual(patches, [...read, ...read], "closing the sidebar over it reads it again");
  chat = { id: 4, unread: false };
  render();
  // A turn that ends while the Chat shows sets the mark on the host; the phone clears it.
  chat = { id: 4, unread: true };
  render();
  assert.equal(patches.length, 3);
  chat = { id: 4, unread: false };
  render();
  // In the background, or with another screen on top, nothing is read until the Chat shows again.
  app.currentState = "background";
  changed("background");
  render();
  chat = { id: 4, unread: true };
  render();
  assert.equal(patches.length, 3);
  changed("active");
  render();
  assert.equal(patches.length, 4, "coming back to the foreground over the Chat reads it");
  chat = { id: 4, unread: false };
  render();
  blur();
  render();
  chat = { id: 4, unread: true };
  render();
  assert.equal(patches.length, 4);
  focus();
  render();
  assert.equal(patches.length, 5);
  react.cleanup();
});

test("a sidebar Chat opens at once, leaving its Project to load in the Chat", () => {
  const nav = navigationHost(deferred().promise);
  nav.open(nav.row("chat")).props.onPress();
  assert.deepEqual(nav.opened, [], "the navigation does not open the Project itself");
  assert.deepEqual(JSON.parse(JSON.stringify(nav.routes)), [{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac", id: "3" } }]);
  assert.equal(
    find(nav.render(), (node) => node.type === "LoadingLogo"),
    undefined,
  );
});

test("a new Chat from the sidebar opens at once too", () => {
  const nav = navigationHost(deferred().promise);
  find(nav.row("project"), (node) => node.type === "IconButton").props.onPress();
  assert.deepEqual(nav.opened, []);
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac" } }]));
  assert.equal(
    nav.rows().props.data.some((item) => item.kind === "all"),
    false,
    "no separate Chats screen to go to",
  );
});

test("Add project from the + menu opens the computer search, and a pick opens its Chat at once", async () => {
  const nav = navigationHost(deferred().promise);
  find(nav.render(), (node) => node.type === "PullDown" && node.props.label === "More").props.onSelect("add");
  await settleAll();
  const search = find(nav.render(), (node) => node.type === "ProjectSearch");
  assert.ok(search, "the search replaces the project list");
  search.props.onOpen("/Users/me/Code/app");
  assert.deepEqual(nav.opened, [], "the Chat opens the Project, not the navigation");
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/Users/me/Code/app", hostId: "mac" } }]));
  assert.equal(
    find(nav.render(), (node) => node.type === "ProjectSearch"),
    undefined,
    "the search is put away",
  );
});

test("Settings opens as a sheet over project navigation, which stays open under it", () => {
  const nav = navigationHost(deferred().promise);
  find(nav.render(), (node) => node.props?.label === "Settings").props.onPress();
  assert.deepEqual(nav.routes, ["/settings"]);
  assert.deepEqual(nav.secondaryRoutes, ["sheet"], "the sidebar is not closed to open Settings");
  assert.equal(
    find(nav.render(), (node) => node.type === "SettingsView"),
    undefined,
    "Settings is not a custom drawer page",
  );
  assert.ok(find(nav.render(), (node) => node.type === "FlatList"));
});

test("the sidebar lists no archived Chats, a hidden Run Chat a sweep archived included", () => {
  const nav = navigationHost(deferred().promise);
  nav.state.project.state.sessions[4] = { id: 4, archived: true, title: "Old work" };
  nav.state.project.state.sessions[5] = {
    ...nav.state.project.state.sessions[4],
    id: 5,
    title: "Nightly triage",
    routine: { routineId: "tr", runId: "u5", hidden: true },
  };
  const ids = () =>
    nav
      .rows()
      .props.data.filter((item) => item.kind === "chat")
      .map((item) => item.chat.id);
  same(ids(), [3]);
  assert.equal(
    find(nav.render(), (node) => node.type === "PullDown" && node.props.label === "Filter Chats"),
    undefined,
    "there is no Filter menu any more",
  );
});

/** Two Chats of web in their own Worktrees: Login (3) and Docs (4). */
function withTwoWorktrees(nav) {
  nav.state.project.name = "web";
  nav.state.project.state.messages = [];
  nav.state.project.state.sessions = { 3: { id: 3, title: "Login", worktree_id: 1 }, 4: { id: 4, title: "Docs", worktree_id: 2 } };
  nav.state.project.state.worktrees = { 1: { id: 1, path: "/wt/login", name: "login-form" }, 2: { id: 2, path: "/wt/docs", name: "docs" } };
  return nav;
}
// Values made in a loaded module's own realm compare as JSON.
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test("a linked Chat shows the Link icon, and its ⋯ menu links with another Chat or removes a Link", () => {
  const links = linksState({
    projects: [
      { id: "w", path: "/last", name: "web" },
      { id: "a", path: "/api", name: "api" },
    ],
    links: [{ id: "9", a: { project_id: "w", worktree_path: "/wt/login" }, b: { project_id: "a" }, created_at: "2026-10-10" }],
  });
  const setUp = withTwoWorktrees;
  const nav = setUp(navigationHost(deferred().promise, { links }));
  const ids = (row) => nav.more(row).props.sections.map((section) => section.items.map((item) => item.id));
  // Rows list the newest Chat first: Docs (no Link), then Login (linked to all of api).
  const login = nav.row("chat", 1);
  assert.ok(find(login, (node) => node.type === "View" && node.props.accessibilityLabel === "Linked to All of api"));
  assert.match(nav.open(login).props.label, /, Linked to All of api$/);
  assert.equal(
    find(nav.row("chat", 0), (node) => node.props?.accessibilityLabel?.startsWith?.("Linked to")),
    undefined,
  );
  same(ids(login), [["copy-path", "copy-branch"], ["rename", "unread"], ["pin"], ["link-with", "link-remove"], ["done", "archive"]]);
  same(ids(nav.row("chat", 0))[3], ["link-with"]);
  nav.more(login).props.onSelect("link-with");
  const [action, request] = nav.linkRequests[0];
  assert.equal(action, "link-with");
  same(
    { ...request.source },
    { projectPath: "/last", projectName: "web", projectId: "w", chatId: 3, title: "Login", branch: "login-form", worktreePath: "/wt/login" },
  );
  same(
    request.chats.map((chat) => chat.chatId),
    [4, 3],
  );
  nav.more(login).props.onSelect("link-remove");
  assert.equal(nav.linkRequests[1][0], "link-remove");
  same(
    nav.linkRequests[1][1].ends.map((end) => [end.link.id, end.label]),
    [["9", "All of api"]],
  );
  // A Mac without Links on the phone shows no Link items or icons.
  const old = setUp(navigationHost(deferred().promise));
  same(
    old
      .more(old.row("chat", 1))
      .props.sections.flatMap((section) => section.items.map((item) => item.id))
      .filter((id) => id.startsWith("link")),
    [],
  );
});

test("the phone list and its Link picker leave out a running hidden Run Chat, and show it while it waits on an approval", () => {
  const links = linksState({ projects: [{ id: "w", path: "/last", name: "web" }], links: [] });
  const setUp = (approvals) => {
    const nav = withTwoWorktrees(navigationHost(deferred().promise, { links }));
    nav.state.project.state.sessions[5] = { id: 5, title: "Nightly triage", worktree_id: 2, routine: { routineId: "tr", runId: "u5", hidden: true } };
    nav.state.runs.runs["/last#5"] = { text: "", steps: [], approvals, questions: [], answered: {} };
    return nav;
  };
  const chats = (nav) =>
    nav
      .rows()
      .props.data.filter((row) => row.kind === "chat")
      .map((row) => row.chat.id);
  const picker = (nav) => {
    nav.more(nav.row("chat", 0)).props.onSelect("link-with");
    return nav.linkRequests.at(-1)[1].chats.map((chat) => chat.chatId);
  };
  const running = setUp([]);
  same(chats(running), [4, 3]);
  same(picker(running), [4, 3]);
  const waiting = setUp([{ requestId: "a1" }]);
  same(chats(waiting), [5, 4, 3]);
  same(picker(waiting), [5, 4, 3]);
});

test("the header's Routines button says so while a hidden Run Chat is unread", () => {
  const label = (unread) => {
    const nav = navigationHost(deferred().promise);
    nav.state.project.state.sessions[5] = { id: 5, worktree_id: 1, unread, routine: { routineId: "tr", runId: "u5", hidden: true } };
    return find(nav.render(), (node) => typeof node.props?.label === "string" && node.props.label.startsWith("Routines")).props.label;
  };
  assert.equal(label(true), "Routines, unread Runs");
  assert.equal(label(false), "Routines");
});

test("Choose projects opens as a sheet over the sidebar instead of closing it", () => {
  const nav = navigationHost(deferred().promise);
  find(nav.render(), (node) => node.type === "ChatListControls").props.filters.onSelect("choose-projects");
  assert.deepEqual(nav.routes, ["/choose-projects"]);
  assert.deepEqual(nav.secondaryRoutes, ["sheet"]);
});

function chooseProjectsHost(setProjectHidden, call = async () => {}, { url, views = [], otherHidden = async () => {} } = {}) {
  const react = hookHost();
  const link = { id: "checkout", name: "Checkout", projectIds: ["shop", "api"] };
  const session = {
    client: { call, url },
    recent: [
      { path: "/shop", name: "shop" },
      { path: "milagre-link:checkout", name: "Checkout", link, projects: [] },
    ],
    setProjectHidden,
  };
  const { default: ChooseProjects } = load("app/choose-projects.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "expo-router": { router: { back() {} } },
    "../session": { useSession: () => session },
    "../all-computers": {
      allComputers: { clientFor: () => null },
      setOtherComputerProjectHidden: otherHidden,
      useComputerViews: () => views,
    },
    "../project-icon": { ProjectIcon: "ProjectIcon", ProjectIcons: "ProjectIcons" },
    "../ui": { ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
  });
  const render = () => {
    react.begin();
    return ChooseProjects();
  };
  const row = () => find(render(), (node) => node.props?.accessibilityRole === "checkbox" && node.props.accessibilityLabel === "Checkout");
  return { render, row, session, link };
}

test("the phone chooser hides and restores a Link on this phone without mutating the Mac's registry", async () => {
  const request = deferred();
  const saved = [];
  const rpcCalls = [];
  const host = chooseProjectsHost(
    async (path, hidden) => {
      saved.push([path, hidden]);
      await request.promise;
      host.session.recent[1].hidden = hidden;
    },
    async (method, args) => {
      rpcCalls.push([method, args]);
    },
  );
  assert.ok(host.row(), "Links are included in the chooser");
  const hiding = host.row().props.onPress();
  assert.equal(host.row().props.accessibilityState.checked, false, "the pending choice appears immediately");
  assert.equal(host.row().props.disabled, true, "pending changes cannot race a second tap");
  request.resolve();
  await hiding;
  assert.equal(host.row().props.accessibilityState.checked, false);
  await host.row().props.onPress();
  assert.equal(host.row().props.accessibilityState.checked, true);
  same(saved, [
    ["milagre-link:checkout", true],
    ["milagre-link:checkout", false],
  ]);
  same(rpcCalls, []);
  assert.equal(host.session.recent[1].link.id, "checkout");
});

test("a failed phone visibility change restores the checkbox and shows the error", async () => {
  const host = chooseProjectsHost(async () => {
    throw new Error("Could not save on device");
  });
  assert.ok(host.row());
  await host.row().props.onPress();
  assert.equal(host.row().props.accessibilityState.checked, true);
  assert.equal(find(host.render(), (node) => node.type === "ErrorNotice").props.message, "Could not save on device");
});

const computerView = (hostId, name, projects, extra = {}) => ({ hostId, name, projects, loaded: true, state: "online", ...extra });

test("Choose projects lists every computer under its name and saves a hide for the computer it belongs to", async () => {
  const own = [];
  const other = [];
  const host = chooseProjectsHost(async (path, hidden) => own.push([path, hidden]), undefined, {
    url: "https://studio",
    views: [
      computerView("https://studio", "Studio Mac", []),
      computerView("https://air", "MacBook Air", [{ path: "/blog", name: "blog" }]),
      computerView("https://old", "Old Mac", [], { loaded: false, state: "offline" }),
    ],
    otherHidden: async (hostId, path, hidden) => other.push([hostId, path, hidden]),
  });
  const tree = host.render();
  const headers = [];
  find(tree, (node) => {
    if (node.props?.accessibilityRole === "header" && node.props.children !== "Choose projects") headers.push(node.props.children);
    return false;
  });
  same(headers, ["Studio Mac", "MacBook Air", "Old Mac"]);
  assert.ok(
    find(tree, (node) => node.props?.children === "Offline. Its Projects show here once it answers."),
    "a computer that never answered says so",
  );
  const blog = () => find(host.render(), (node) => node.props?.accessibilityRole === "checkbox" && node.props.accessibilityLabel === "blog");
  await blog().props.onPress();
  await host.row().props.onPress();
  same(other, [["https://air", "/blog", true]]);
  same(own, [["milagre-link:checkout", true]]);
});

test("a chat search with no matching title lists matching messages, and a tap opens their Chat", () => {
  const nav = navigationHost(deferred().promise);
  nav.state.project.state.sessions[3] = { id: 3, title: "Relay work" };
  nav.state.project.state.messages = [{ id: 7, session_id: 3, body: "Deploy the relay with wrangler, then check /health" }];
  const search = () => find(nav.render(), (node) => node.type === "ChatListControls");
  search().props.onQuery("wranglr");
  const data = nav.rows().props.data;
  assert.equal(
    JSON.stringify(data.filter((item) => item.kind === "section" || item.kind === "message").map((item) => item.name ?? item.snippet)),
    JSON.stringify(["Messages", "Deploy the relay with wrangler, then check /health"]),
  );
  const message = nav.row("message");
  assert.equal(message.props.accessibilityLabel, "Deploy the relay with wrangler, then check /health, in Relay work, last");
  message.props.onPress();
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac", id: "3" } }]));
  search().props.onQuery("relay");
  assert.equal(
    JSON.stringify(
      nav
        .rows()
        .props.data.filter((item) => item.kind === "section")
        .map((item) => item.name),
    ),
    JSON.stringify(["Chats", "Messages"]),
    "like ⌘K, a Chat title match lists the messages that match too",
  );
});

test("a drawer search over Projects held without messages asks the host, which finds what was said", async () => {
  const asked = [];
  const preview = {
    previewOnly: true,
    project: { path: "/last", name: "last", state: { sessions: { 3: { id: 3, title: "Relay work" } }, messages: [], worktrees: {}, messagesInChats: true } },
    runs: { runs: {} },
  };
  const nav = navigationHost(deferred().promise, {
    effects: true,
    session: {
      snapshot: null,
      cachedProject: () => preview,
      client: {
        url: "mac",
        call: async () => {},
        searchChats: async (path, query) => {
          asked.push([path, query]);
          return [{ message: { id: 7, session_id: 3 }, score: 9, snippet: "Deploy the relay with wrangler", highlight: [21, 29], term: "wrangler" }];
        },
      },
    },
  });
  const search = () => find(nav.render(), (node) => node.type === "ChatListControls");
  search().props.onQuery("wranglr");
  nav.render();
  // The host is asked after a short pause while typing.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settleAll();
  assert.deepEqual(asked, [["/last", "wranglr"]]);
  assert.match(nav.row("message").props.accessibilityLabel, /^Deploy the relay with wrangler, in /);
});

test("the chooser keeps empty Projects available with the flat Chat list preference", () => {
  const nav = navigationHost(deferred().promise, { chatList: "list", session: { snapshot: null } });
  assert.ok(nav.row("project"));
});

test("a sidebar Project can be removed from the list after confirming", async () => {
  const alerts = [];
  const nav = navigationHost(deferred().promise, { alert: pressDanger(alerts) });
  nav.open(nav.row("project")).props.onSelect("remove");
  await settleAll();
  assert.equal(alerts[0].title, "Remove last?");
  assert.equal(
    JSON.stringify(alerts[0].buttons),
    JSON.stringify([
      ["Remove", "destructive"],
      ["Cancel", "cancel"],
    ]),
  );
  assert.equal(JSON.stringify(nav.calls), JSON.stringify([["project:forget", ["/last"]], ["reload"]]));
  assert.deepEqual(nav.routes, ["/projects"]);
  assert.ok(nav.storeCalls.some(([name]) => name === "refreshAll"));
});

test("a removal completed after newer navigation does not replace the visible screen", async () => {
  const pending = deferred();
  const nav = navigationHost(deferred().promise, { alert: pressDanger([]), session: { forgetProject: () => pending.promise } });
  nav.open(nav.row("project")).props.onSelect("remove");
  await settleAll();
  pending.resolve(false);
  await settleAll();
  assert.deepEqual(nav.routes, []);
});

test("a new Chat reached without a Worktree starts in the Project checkout once it loads", () => {
  const host = chatHost({ effects: true });
  delete host.params.worktreeId;
  host.session.snapshot.project.state.worktrees = { 4: { id: 4, path: "/wt/feature" }, 5: { id: 5, path: "/p" } };
  assert.ok(find(host.render(), (node) => node.type === "LoadingLogo"));
  assert.equal(host.params.worktreeId, "5");
  assert.equal(
    find(host.render(), (node) => node.type === "LoadingLogo"),
    undefined,
  );
});

test("the new Chat computer picker keeps its composer and draft through slow and failed switches", async () => {
  const projects = [
    { hostId: "mac", hostName: "Mac", path: "/p", name: "P", origin: "github.com/test/p", offline: false },
    { hostId: "studio", hostName: "Studio", path: "/other", name: "P", origin: "github.com/test/p", offline: false },
  ];
  const host = chatHost({
    effects: true,
    computers: {
      useNewChatProjects: () => projects,
      useNoProjectChoice: () => undefined,
      allComputers: { hostFor: () => ({ address: "studio", token: "token" }) },
    },
  });
  const loading = deferred();
  host.session.connect = async (_host, remember, target) => {
    assert.equal(remember, false);
    assert.equal(target.projectPath, "/other");
    const state = await loading.promise;
    target.onOpen(state);
    host.session.client = { ...host.session.client, url: "studio" };
    host.session.snapshot = state;
    return true;
  };
  const choose = () => find(host.render(), (node) => node.props?.label === "Choose computer");
  const fieldKey = () => find(host.render(), (node) => node.type === "PromptField").key;
  const beforeKey = fieldKey();
  host.router.deferParams = true;
  choose().props.onSelect("studio\n/other");
  await settle();
  assert.equal(host.field().value, "first message");
  assert.equal(
    find(host.render(), (node) => node.type === "LoadingLogo"),
    undefined,
  );
  assert.equal(choose().props.nativeTrigger.disabled, true);
  host.field().onChangeText("typed while connecting");
  const state = structuredClone(host.session.snapshot);
  state.project.path = "/other";
  state.project.state.worktrees = { 9: { id: 9, name: "main", path: "/other" } };
  loading.resolve(state);
  await settle();
  assert.equal(host.params.worktreeId, "1", "native navigation can publish the new params after the session commits");
  assert.equal(host.field().value, "typed while connecting");
  assert.equal(
    find(host.render(), (node) => node.type === "LoadingLogo"),
    undefined,
    "a delayed route never replaces the composer with the splash",
  );
  Object.assign(host.params, host.router.pendingParams);
  host.router.deferParams = false;
  assert.equal(host.params.worktreeId, "9");
  assert.equal(host.params.hostId, "studio");
  assert.equal(host.field().value, "typed while connecting");
  assert.equal(fieldKey(), beforeKey, "the native text input keeps its identity and keyboard focus");
  assert.equal(host.session.drafts["/p#new:1"], undefined);
  assert.equal(
    find(host.render(), (node) => node.type === "LoadingLogo"),
    undefined,
  );
  host.session.connect = async () => {
    throw new Error("Computer unavailable");
  };
  choose().props.onSelect("mac\n/p");
  await settle();
  assert.equal(host.params.hostId, "studio");
  assert.equal(host.field().value, "typed while connecting");
  assert.ok(find(host.render(), (node) => node.type === "ErrorNotice" && node.props.message === "Computer unavailable"));
});

test("a Chat in another Project loads it behind the splash mark, and shows a failure with Retry", async () => {
  const host = chatHost({ effects: true });
  const opening = [];
  host.session.open = (path, options) => {
    const next = deferred();
    opening.push({ path, options, next });
    return next.promise;
  };
  Object.assign(host.params, { id: "3", projectPath: "/other" });
  assert.ok(find(host.render(), (node) => node.type === "LoadingLogo"));
  assert.equal(JSON.stringify(opening.map((item) => [item.path, item.options])), JSON.stringify([["/other", { chatId: 3 }]]));
  opening[0].next.reject(new Error("This Chat is no longer available. Choose another Chat."));
  await settle();
  const failed = host.render();
  assert.equal(
    find(failed, (node) => node.type === "LoadingLogo"),
    undefined,
  );
  const notice = find(failed, (node) => node.type === "ErrorNotice");
  assert.match(notice.props.message, /no longer available/);
  notice.props.retry();
  host.render();
  assert.equal(opening.length, 2, "Retry opens the Project again");
});

test("a Chat beside of another Project waits for it in its own pane, and never opens a Project or leaves the screen", () => {
  const host = chatHost({ effects: true, pane: "secondary" });
  const opened = [];
  host.session.open = (path) => opened.push(path);
  host.session.snapshot = null;
  Object.assign(host.params, { id: "3", projectPath: "/other", hostId: "studio" });
  delete host.params.worktreeId;
  const waiting = host.render();
  assert.ok(find(waiting, (node) => node.type === "LoadingLogo"));
  assert.equal(
    find(waiting, (node) => node.type === "Redirect"),
    undefined,
    "the routed Chat stays",
  );
  assert.deepEqual(opened, [], "the open Project stays the routed Chat's");
  host.session.error = "Connection lost.";
  const failed = host.render();
  assert.match(find(failed, (node) => node.type === "ErrorNotice").props.message, /Connection lost/);
  find(failed, (node) => node.type === "GlassIconButton" && node.props.label === "Close Chat").props.onPress();
  assert.equal(host.router.closed, 1, "Close ends the pair while it waits");
});

test("launch restoration opens the saved computer/Project/Chat target directly", async () => {
  const state = snapshot("/last");
  state.project.state.sessions[3] = { id: 3 };
  const app = resumeHost({ state });
  app.render();
  await settle();
  assert.deepEqual(app.opened, ["/last"]);
  assert.equal(app.routes.length, 1);
  assert.equal(app.routes[0].pathname, "/chat");
  assert.equal(app.routes[0].params.id, "3");
  assert.equal(app.routes[0].params.hostId, "mac");
  assert.equal(app.routes[0].params.projectPath, "/last");
});

test("missing, archived and unreachable last Chats leave the project list usable", async () => {
  const archived = snapshot("/last");
  archived.project.state.sessions[3] = { id: 3, archived: true };
  for (const input of [{}, { state: archived }, { failure: "offline" }, { target: { hostId: "other", projectPath: "/last", chatId: 3 } }]) {
    const app = resumeHost(input);
    app.render();
    await settle();
    assert.equal(app.routes.length, 0);
    assert.ok(find(app.render(), (node) => node.type === "ProjectNavigation"));
  }
});

function pullDownHost(react = { forwardRef: (fn) => fn }) {
  const sheets = [];
  const modifiers = new Proxy(
    {},
    {
      get: (_, name) => (name === "shapes" ? { rectangle: () => "rectangle" } : (value) => ({ name, value })),
    },
  );
  const { PullDown, PageScroll } = load("ui.tsx", {
    react,
    "react/jsx-runtime": {
      jsx: (type, props, key) => (typeof type === "function" && type.name === "NativeMenuSection" ? type(props) : jsx(type, props, key)),
      jsxs: (type, props, key) => (typeof type === "function" && type.name === "NativeMenuSection" ? type(props) : jsx(type, props, key)),
    },
    "react-native": {
      Platform: { OS: "ios" },
      Keyboard: { dismiss() {} },
      ActionSheetIOS: {
        showActionSheetWithOptions: (options, select) => sheets.push({ options, select }),
      },
      StyleSheet: { create: (value) => value },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      View: "View",
    },
    "@react-native-masked-view/masked-view": { default: "MaskedView" },
    "expo-linear-gradient": { LinearGradient: "LinearGradient" },
    "@expo/ui": {},
    "@expo/ui/swift-ui": Object.fromEntries(
      ["Button", "Host", "Menu", "Picker", "Section", "Text", "Toggle", "HStack", "Image", "Label", "Rectangle"].map((name) => [name, `IOS${name}`]),
    ),
    "@expo/ui/swift-ui/modifiers": modifiers,
    "@expo/ui/community/menu": { MenuView: "MenuView" },
    "@expo/ui/jetpack-compose/modifiers": { semantics: (value) => ({ name: "semantics", value }) },
    "expo-haptics": { selectionAsync: async () => {} },
    "@hugeicons/core-free-icons": {},
    "./theme": {
      colors: { ink2: "#aaa", ink3: "#666" },
      fonts: { mono: "monospace" },
    },
    "./icons": { Icon: "Icon" },
    "./confirm-store": { confirmSheet: (...args) => sheets.push(args) },
    "./choice-store": require("../apps/mobile/src/choice-store.ts"),
    "./native-picker-icon": { NativePickerIcon: "NativePickerIcon" },
  });
  return { PullDown, PageScroll, sheets };
}

test("shared mobile scrolling fades only the edges with more content and keeps native callbacks and its ref", () => {
  const react = hookHost();
  react.forwardRef = (fn) => fn;
  const { PageScroll } = pullDownHost(react);
  const calls = [];
  const ref = { current: null };
  const props = {
    fadeEdges: true,
    style: { height: 120 },
    children: "Result",
    onScroll: (event) => calls.push(["scroll", event.nativeEvent.contentOffset.y]),
    onLayout: (event) => calls.push(["layout", event.nativeEvent.layout.height]),
    onContentSizeChange: (width, height) => calls.push(["content", width, height]),
  };
  const render = () => {
    react.begin();
    return PageScroll(props, ref);
  };
  const scroll = () => find(render(), (node) => node.type === "ScrollView");
  const colors = () => render().props.maskElement.props.colors;
  assert.equal(typeof scroll().props.onScroll, "function");
  scroll().props.onLayout({ nativeEvent: { layout: { height: 120 } } });
  scroll().props.onContentSizeChange(240, 360);
  assert.ok(render().props.maskElement, "scrolling content needs an edge fade mask");
  assert.equal(colors()[0], colors()[1], "the first line stays clear at the start");
  assert.notEqual(colors().at(-1), colors()[1], "overflow fades at the bottom");
  scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 60 } } });
  assert.notEqual(colors()[0], colors()[1], "scrolled text fades under the header");
  scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 240 } } });
  assert.equal(colors().at(-1), colors()[1], "the last line stays clear at the end");
  scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
  scroll().props.onContentSizeChange(240, 80);
  assert.equal(colors()[0], colors()[1]);
  assert.equal(colors().at(-1), colors()[1], "short results have no fades");
  assert.equal(scroll().props.ref, ref, "the ref still controls the native scroll view");
  assert.deepEqual(calls, [
    ["layout", 120],
    ["content", 240, 360],
    ["scroll", 60],
    ["scroll", 240],
    ["scroll", 0],
    ["content", 240, 80],
  ]);
  react.begin();
  assert.equal(PageScroll({ children: "Plain" }, ref).type, "ScrollView", "other screens keep their existing native scroll");
  react.begin();
  const horizontal = PageScroll({ horizontal: true, children: "Wide", contentContainerStyle: { padding: 0 } }, ref);
  assert.equal(horizontal.type, "GestureScrollView", "horizontal content owns its drag instead of opening a side panel");
  assert.equal(horizontal.props.ref, ref);
  assert.equal(horizontal.props.horizontal, true);
});

test("composer attachment choices stay in a native menu after the header action-sheet fix", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kinds = [];
  const screen = chatHost({
    pickAttachments: async (kind) => {
      kinds.push(kind);
      return [];
    },
  });
  const { PullDown, sheets } = pullDownHost();
  const trigger = find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Add photos or files");
  const rendered = PullDown(trigger.props);
  const menu = find(rendered, (node) => node.type === "IOSMenu");
  assert.ok(menu, "the attachment + must open a menu, not the header action sheet");
  assert.equal(
    find(menu.props.label, (node) => node.type === "View"),
    undefined,
    "the SwiftUI trigger cannot host React Native views",
  );
  const files = find(menu, (node) => node.type === "IOSButton" && node.props.label === "Choose Files");
  files.props.onPress();
  t.mock.timers.tick(250);
  await settle();
  assert.deepEqual(kinds, ["files"]);
  assert.equal(sheets.length, 0);
});

test("header switchers keep the shared native overlay without hosting React views", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PullDown, sheets } = pullDownHost();
  const selected = [];
  const header = PullDown({
    label: "Switch Chat",
    sections: [
      {
        items: [
          { id: "current", title: "Current Chat", checked: true },
          { id: "other", title: "Other Chat" },
        ],
      },
    ],
    children: jsx("View", {}),
    onSelect: (id) => selected.push(id),
  });
  const menu = find(header, (node) => node.type === "IOSMenu");
  assert.equal(menu.props.label.type, "IOSRectangle");
  assert.equal(
    find(menu, (node) => node.type === "View"),
    undefined,
    "React trigger stays outside SwiftUI",
  );
  find(menu, (node) => node.type === "IOSButton" && node.props.label === "Other Chat").props.onPress();
  t.mock.timers.tick(250);
  assert.deepEqual(selected, ["other"]);
  assert.equal(sheets.length, 0);
});

test("isolation uses desktop artwork inside SwiftUI labels and preserves delayed selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PullDown } = pullDownHost();
  const screen = chatHost();
  const trigger = find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation");
  const rendered = PullDown(trigger.props);
  const menu = find(rendered, (node) => node.type === "IOSMenu");
  const labels = [];
  find(menu, (node) => {
    if (node.type === "IOSLabel") labels.push(node);
    return false;
  });
  assert.deepEqual(
    Array.from(labels, (node) => node.props.title),
    ["Local", "New worktree"],
  );
  assert.deepEqual(
    Array.from(labels, (node) => node.props.icon.props.name),
    ["laptop", "fork"],
  );
  assert.equal(
    find(menu.props.label, (node) => node.type === "View"),
    undefined,
    "React views stay outside SwiftUI",
  );
  assert.equal(menu.props.label.type, "IOSRectangle", "the desktop SVG trigger stays outside SwiftUI");
  const choices = find(menu, (node) => node.type === "IOSPicker");
  assert.equal(choices.props.selection, "local");
  choices.props.onSelectionChange("worktree");
  assert.equal(find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.nativeTrigger.title, "Local");
  t.mock.timers.tick(250);
  assert.equal(find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.nativeTrigger.title, "New worktree");
});

test("the branch picker opens searchable choices while short action menus remain native", () => {
  const { PullDown } = pullDownHost();
  const choices = require("../apps/mobile/src/choice-store.ts");
  const screen = chatHost();
  const trigger = find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose branch");
  assert.equal(trigger.props.searchable.placeholder, "Search worktrees");
  const rendered = PullDown(trigger.props);
  assert.equal(
    find(rendered, (node) => node.type === "IOSMenu"),
    undefined,
  );
  rendered.props.onPress();
  const entry = choices.currentChoice();
  assert.equal(entry.title, "Choose a worktree");
  assert.equal(entry.items[0].title, "main");
  entry.choose(null);
});

test("choosing a worktree updates the Chat route while the picker route is still leaving", () => {
  const screen = chatHost();
  const picker = find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose branch");
  screen.router.setParams = () => {
    throw new Error("global params target the sheet");
  };
  picker.props.onSelect("2");
  assert.equal(screen.params.worktreeId, "2");
});

test("searching the choice sheet filters full names and selection applies only after dismissal", () => {
  const choices = require("../apps/mobile/src/choice-store.ts");
  const picks = [];
  const longName = "milagre/resolve-pr-246-conflicts-and-mj8k";
  choices.showChoiceSheet({
    title: "Branch from",
    placeholder: "Search branches",
    emptyLabel: "No branches found.",
    items: [
      { id: "main", title: "main", checked: true },
      { id: longName, title: longName },
    ],
    onSelect: (id) => picks.push(id),
  });
  const react = hookHost();
  react.useEffect = react.effect;
  let closed = 0;
  const { default: Screen } = load("app/choice-sheet.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { FlatList: "FlatList", Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { hairlineWidth: 1 } },
    "expo-router": {
      router: {
        back() {
          closed++;
        },
      },
      Stack: {
        Title: "StackTitle",
        SearchBar: "SearchBar",
        Toolbar: Object.assign(function Toolbar() {}, { Button: "ToolbarButton", SearchBarSlot: "SearchBarSlot" }),
      },
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 20 }) },
    "@hugeicons/core-free-icons": {},
    "../bottom-fade": { EdgeFade: "EdgeFade" },
    "../choice-store": choices,
    "../icons": { Icon: "Icon" },
    "../ui": { CircleButton: "CircleButton", Field: "Field", colors: {}, styles: {} },
    "../theme": { fonts: { mono: "mono" } },
  });
  const render = () => {
    react.begin();
    const tree = Screen();
    react.flush();
    return tree;
  };
  const list = () => find(render(), (node) => node.type === "FlatList");
  const field = () => find(render(), (node) => node.type === "SearchBar");
  assert.equal(find(render(), (node) => node.type === "StackTitle").props.children, "Branch from");
  assert.equal(field().props.placement, "integrated");
  assert.equal(field().props.obscureBackground, false, "filtered rows remain tappable during search");
  assert.equal(find(render(), (node) => node.type?.name === "Toolbar" && node.props.placement === "bottom").props.children.type, "SearchBarSlot");
  assert.equal(list().props.data.length, 2);
  field().props.onChangeText({ nativeEvent: { text: "  RESOLVE-PR-246  " } });
  assert.equal(list().props.data.length, 1);
  const row = list().props.renderItem({ item: list().props.data[0] });
  assert.equal(row.props.accessibilityLabel, longName);
  assert.equal(find(row, (node) => node.type === "Text").props.numberOfLines, undefined, "the full name can wrap");
  assert.equal(find(row, (node) => node.type === "Text").props.style.fontFamily, undefined, "names use the body font");
  assert.equal(find(render(), (node) => node.type === "EdgeFade").props.edge, "top", "rows blur under the title bar");
  field().props.onChangeText({ nativeEvent: { text: "missing" } });
  assert.equal(list().props.data.length, 0);
  assert.equal(list().props.ListEmptyComponent.props.children, "No branches found.");
  field().props.onCancelButtonPress();
  assert.equal(list().props.data.length, 2, "native cancel restores the complete list");
  field().props.onChangeText({ nativeEvent: { text: "resolve" } });
  row.props.onPress();
  row.props.onPress();
  assert.equal(closed, 1);
  assert.deepEqual(picks, [], "route updates wait for the native sheet to leave");
  react.cleanup();
  assert.deepEqual(picks, [longName]);
});

// A Project with one Chat (5) in a Milagre worktree that holds an uncommitted file, its turn running.
function archiveProject() {
  const calls = [];
  const dirty = { uncommitted: 1, unpushed: 0, branch: "milagre/fix", head: "h1", removable: false };
  const worktrees = { 1: { id: 1, name: "main", path: "/p" }, 2: { id: 2, name: "milagre/fix", path: "/wt/p/fix", base: "main" } };
  const snapshot = {
    project: {
      path: "/p",
      name: "P",
      state: { sessions: { 5: { id: 5, worktree_id: 2, title: "Fix" } }, messages: [{ id: 1, session_id: 5, role: "user", body: "Fix it" }], worktrees },
    },
    runs: { runs: { "/p#5": { questions: [], approvals: [], steps: [] } } },
  };
  const call = async (method, args = []) => {
    calls.push([method, ...args]);
    if (method === "worktree:roots") return ["/wt"];
    if (method === "worktree:status") return dirty;
    return null;
  };
  return { calls, snapshot, call, client: { call, snapshot: async () => snapshot } };
}
// Presses the first destructive button, after recording what the alert showed.
const pressDanger = (alerts) => (title, message, buttons) => {
  alerts.push({ title, message, buttons: buttons.map((button) => [button.text, button.style]) });
  buttons.find((button) => button.style === "destructive").onPress();
};
async function settleAll() {
  for (let i = 0; i < 10; i++) await settle();
}

/** Lets a deletion's Undo time pass (the test's setTimeout is mocked), then the steps after it. */
async function passUndo(t) {
  await settleAll();
  t.mock.timers.tick(require("@milagre/shared/archive").DELETE_UNDO_MS);
  await settleAll();
}

test("Chat swipe directions mark Done or read status once and block unavailable rows", async () => {
  const react = hookHost();
  const calls = [];
  let closes = 0;
  const pending = deferred();
  const { ChatSwipeRow } = load("chat-swipe-row.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
    "react-native-gesture-handler/ReanimatedSwipeable": { default: "Swipeable" },
    "react-native-reanimated": { ReduceMotion: { Always: "always", System: "system" }, useDerivedValue: (read) => ({ get: read }) },
    "@hugeicons/core-free-icons": {},
    "./icons": { Icon: "Icon" },
    "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
  });
  const render = (unread, disabled = false, done = false, doneable = true) => {
    react.begin();
    return ChatSwipeRow({
      unread,
      done,
      doneable,
      background: "page",
      disabled,
      children: "Chat",
      onAction: (action) => {
        calls.push(action);
        return pending.promise;
      },
    });
  };
  let row = render(true);
  row.props.ref.current = {
    close: () => {
      closes++;
    },
  };
  row.props.onSwipeableOpen("right");
  row.props.onSwipeableOpen("left");
  assert.deepEqual(calls, ["read"], "another swipe cannot mark Done while a read is pending");
  assert.equal(render(true).props.enabled.get(), false);
  pending.resolve();
  await settle();
  row = render(false);
  row.props.onSwipeableOpen("right");
  await settle();
  row = render(true);
  row.props.onSwipeableOpen("left");
  await settle();
  assert.deepEqual(calls, ["read", "unread", "done"]);
  row = render(false, true);
  assert.equal(row.props.enabled.get(), false);
  row.props.onSwipeableOpen("left");
  assert.deepEqual(calls, ["read", "unread", "done"]);
  // A Done row reopens with a swipe right and has nothing to swipe left to.
  row = render(false, false, true);
  assert.equal(row.props.renderRightActions, undefined);
  row.props.onSwipeableOpen("right");
  await settle();
  assert.deepEqual(calls, ["read", "unread", "done", "reopen"]);
  // A Mac too old to keep Done archives on the left swipe, as before Done.
  row = render(false, false, false, false);
  row.props.onSwipeableOpen("left");
  await settle();
  assert.deepEqual(calls, ["read", "unread", "done", "reopen", "archive"]);
  // The row draws on the list's own color, with no corners of its own, and keeps its gesture callbacks across renders.
  assert.equal(row.props.childrenContainerStyle.backgroundColor, "page");
  assert.equal(row.props.containerStyle, undefined);
  assert.equal(render(false, false, false, false).props.onSwipeableOpen, row.props.onSwipeableOpen);
  assert.ok(closes >= 3, "rows close after the action");
  assert.equal(row.props.hitSlop, undefined, "outside the sidebar a row swipes across its whole width");

  // In the slide-over sidebar a left swipe only reveals Done, which a tap commits; the row leaves its right edge to the
  // sidebar's close, and takes no swipe while the sidebar slides.
  let open = true;
  react.useContext = () => ({ get: () => open });
  row = render(true);
  assert.equal(row.props.hitSlop.right, -32);
  assert.equal(row.props.enabled.get(), true);
  assert.equal(render(true).props.hitSlop, row.props.hitSlop, "the edge keeps its identity across renders");
  open = false;
  assert.equal(row.props.enabled.get(), false, "a sliding sidebar's rows take no swipe");
  open = true;
  row.props.onSwipeableOpen("left");
  await settle();
  assert.deepEqual(calls, ["read", "unread", "done", "reopen", "archive"], "a revealed Done waits for its tap");
  const done = row.props.renderRightActions();
  assert.equal(done.type, "Pressable");
  done.props.onPress();
  await settle();
  assert.deepEqual(calls, ["read", "unread", "done", "reopen", "archive", "done"]);
  row.props.onSwipeableOpen("right");
  await settle();
  assert.deepEqual(calls.at(-1), "read", "a right swipe still commits on release");
});

test("an older Mac's rows offer no Done, and their left swipe archives as before", () => {
  globalThis.olderMac = true;
  try {
    const nav = navigationHost(deferred().promise);
    const row = nav.row("chat");
    const swipe = find(row, (node) => node.type === "ChatSwipeRow");
    assert.equal(swipe.props.doneable, false, "the left swipe archives");
    const items = new Set(nav.more(row).props.sections.flatMap((section) => section.items.map((item) => item.id)));
    assert.equal(items.has("done"), false);
    assert.equal(items.has("archive"), true);
  } finally {
    delete globalThis.olderMac;
  }
});

test("a sidebar Chat deletes immediately and stops the turn while preserving unsaved work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const alerts = [];
  const project = archiveProject();
  const nav = navigationHost(deferred().promise, {
    alert: pressDanger(alerts),
    session: {
      client: { ...project.client, url: "mac" },
      recent: [{ path: "/p" }],
      snapshot: project.snapshot,
      expectActivity() {},
      refresh: async () => {
        project.calls.push(["refresh"]);
      },
    },
  });
  const more = nav.more(nav.row("chat"));
  const archiveItem = more.props.sections.at(-1).items.find((item) => item.id === "archive");
  assert.equal(more.props.sections.at(-1).items[0].id, "done", "Mark Done comes before Delete");
  assert.equal(archiveItem.disabled, undefined, "a running Chat can be archived: it is stopped first");
  more.props.onSelect("archive");
  await settleAll();
  assert.deepEqual(alerts, [], "Delete does not open a confirmation");
  assert.equal(listsChat(nav), false, "the row leaves the list at once");
  assert.equal(
    project.calls.some(([method]) => method === "chat:delete"),
    false,
    "the conversation stays while the toast's Undo can bring it back",
  );
  await passUndo(t);
  assert.deepEqual(
    project.calls.map(([method]) => method),
    ["worktree:roots", "worktree:status", "terminal:list", "agent:interrupt", "chat:patch", "chat:delete", "refresh"],
  );
  assert.equal(
    project.calls.some(([method]) => method === "worktree:remove"),
    false,
  );
});

test("the Chat screen Archive falls back to a plain Archive on an older Mac, then opens the sidebar", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const alerts = [];
  const project = archiveProject();
  const screen = chatHost({
    alert: pressDanger(alerts),
    call: async (method, args) =>
      ["worktree:roots", "worktree:status"].includes(method) ? Promise.reject(new Error("Command is not available from mobile")) : project.call(method, args),
  });
  // The turn has ended on the Mac, so nothing is stopped.
  screen.session.snapshot = { ...project.snapshot, runs: { runs: {} } };
  screen.session.client.snapshot = async () => screen.session.snapshot;
  screen.params.id = "5";
  delete screen.params.worktreeId;
  screen.render();
  const archive = chatMenuEntry(screen.render(), "Delete");
  archive.props.onPress();
  await passUndo(t);
  assert.deepEqual(alerts, [], "Delete does not open a confirmation");
  assert.deepEqual(
    screen.calls.map((call) => call.method),
    ["worktree:roots", "chat:patch", "chat:delete"],
  );
  assert.deepEqual(screen.calls[1].args, ["/p", 5, { archived: true, unread: false }]);
  assert.equal(screen.panels.open, "left");
  assert.equal(screen.router.replaced, undefined);
});

test("a new Chat can switch Worktrees and keep each Worktree draft", async () => {
  const screen = chatHost();
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" }, 2: { id: 2, name: "feature" } };
  screen.session.drafts["/p#new:2"] = "feature draft";
  const menu = () => find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose branch");
  assert.ok(menu(), "the new Chat screen must let you choose a Worktree");
  menu().props.onSelect("2");
  assert.equal(screen.params.worktreeId, "2");
  assert.equal(screen.field().value, "feature draft");
  menu().props.onSelect("1");
  assert.equal(screen.field().value, "first message");
  screen.send();
  assert.ok(
    menu().props.sections[0].items.every((item) => item.disabled),
    "cannot change destination during a send",
  );
  menu().props.onSelect("2");
  assert.equal(screen.params.worktreeId, "1");
  screen.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(menu(), undefined, "a sent Chat stays bound to its Worktree");
});

test("new Chats offer Local/New worktree and branches even with one checkout", async () => {
  const screen = chatHost({ effects: true, call: async () => ["main", "release"] });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  const menu = (label) => find(screen.render(), (node) => node.type === "PullDown" && node.props.label === label);
  assert.ok(menu("Choose isolation"));
  assert.equal(menu("Choose branch").props.sections[0].items[0].title, "main");
  await settle();
  menu("Choose isolation").props.onSelect("worktree");
  const branch = menu("Choose branch");
  assert.deepEqual(
    Array.from(branch.props.sections[0].items, (item) => item.title),
    ["main", "release"],
  );
  branch.props.onSelect("release");
  assert.equal(menu("Choose branch").props.nativeTrigger.title, "release");
  assert.equal(screen.field().value, "first message", "changing the base branch keeps the draft");
  assert.equal(screen.calls.filter((call) => call.method === "project:branches").length, 1);
});

test("New worktree creates from the chosen branch on first send and keeps the selected model", async () => {
  const screen = chatHost({
    effects: true,
    call: async (method) => {
      if (method === "project:branches") return ["main", "release"];
      if (method === "worktree:create") return { worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } };
      return { sessionId: 7 };
    },
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  screen.session.preferences["/p#new:1"] = { ...screen.session.defaults, model: "gpt-6-astra" };
  const menu = (label) => find(screen.render(), (node) => node.type === "PullDown" && node.props.label === label);
  menu("Choose isolation").props.onSelect("worktree");
  await settle();
  menu("Choose branch").props.onSelect("release");
  screen.send();
  assert.ok(menu("Choose isolation").props.nativeTrigger.disabled);
  await settle();
  const created = screen.calls.find((call) => call.method === "worktree:create");
  assert.equal(created.args[0].baseBranch, "release");
  assert.equal(created.args[0].prompt, "first message");
  const sent = screen.calls.find((call) => call.method === "chat:send").args[0];
  assert.equal(sent.worktreeId, 9);
  assert.equal(sent.sessionId, 7);
  assert.equal(sent.model, "gpt-6-astra");
  assert.equal(screen.params.id, "7");
});

test("a busy Mac that can't list branches yet still takes a New worktree send from the checkout's branch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let listed = 0;
  const screen = chatHost({
    effects: true,
    call: async (method) => {
      if (method === "project:branches") {
        if (++listed < 3) throw Object.assign(new Error("Your computer is busy right now. Try again in a moment."), { status: 429 });
        return ["main", "release"];
      }
      if (method === "worktree:create") return { worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } };
      return { sessionId: 7 };
    },
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.onSelect("worktree");
  await settle();
  assert.equal(
    find(screen.render(), (node) => node.type === "ErrorNotice"),
    undefined,
    "a busy answer waits for the next try instead of showing",
  );
  screen.send();
  await settle();
  assert.equal(screen.calls.find((call) => call.method === "worktree:create").args[0].baseBranch, "main");
  assert.equal(screen.params.id, "7");
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(listed, 3, "the branch list is read again until the Mac answers");
});

test("retrying a failed first send reuses the created worktree and keeps the draft", async () => {
  let sends = 0;
  const screen = chatHost({
    effects: true,
    call: async (method) => {
      if (method === "project:branches") return ["main"];
      if (method === "worktree:create") return { worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } };
      if (++sends === 1) throw new Error("Connection lost");
      return { sessionId: 7 };
    },
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.onSelect("worktree");
  await settle();
  screen.send();
  await settle();
  assert.equal(screen.field().value, "first message");
  assert.equal(screen.params.id, undefined);
  screen.send();
  await settle();
  assert.equal(screen.calls.filter((call) => call.method === "worktree:create").length, 1);
  assert.equal(screen.params.id, "7");
});

test("new-worktree preparation finishes its send in the background without navigating after switching Projects", async () => {
  const creating = deferred();
  const screen = chatHost({
    effects: true,
    call: (method) =>
      method === "project:branches" ? Promise.resolve(["main"]) : method === "worktree:create" ? creating.promise : Promise.resolve({ sessionId: 7 }),
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.onSelect("worktree");
  await settle();
  screen.send();
  await settle();
  screen.session.snapshot = { ...screen.session.snapshot, project: { ...screen.session.snapshot.project, path: "/other" } };
  screen.render();
  creating.resolve({ worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } });
  await settle();
  assert.equal(screen.calls.filter((call) => call.method === "chat:send").length, 1);
  assert.equal(screen.calls.find((call) => call.method === "chat:send").args[0].projectPath, "/p");
  assert.equal(screen.params.id, undefined);
  // The sent text left the composer when it was sent; the composer is now the next New Chat's, so it stays put.
  assert.equal(screen.session.drafts["/p#new:1"], "");
  assert.equal(screen.session.drafts["/p#7"], undefined);
});

test("the attachment pull-down opens the selected picker and blocks a second pick", async () => {
  const picking = deferred();
  const kinds = [];
  const screen = chatHost({
    pickAttachments: (kind) => {
      kinds.push(kind);
      return picking.promise;
    },
  });
  const menu = () => find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Add photos or files");
  assert.ok(menu(), "attachments must use a pull-down anchored to the +");
  menu().props.onSelect("photos");
  assert.ok(menu().props.sections[0].items.every((item) => item.disabled));
  menu().props.onSelect("files");
  assert.deepEqual(kinds, ["photos"]);
  picking.resolve([]);
  await settle();
  menu().props.onSelect("camera");
  await settle();
  assert.deepEqual(kinds, ["photos", "camera"]);
  screen.session.attachments["/p#new:1"] = Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    name: `${i}.txt`,
    uri: `file:///${i}.txt`,
    image: false,
  }));
  assert.ok(menu().props.sections[0].items.every((item) => !item.disabled));
  menu().props.onSelect("files");
  assert.deepEqual(kinds, ["photos", "camera", "files"], "four attachments do not block another picker");
});

test("text typed during the first send follows the created Chat into its composer", async () => {
  const screen = chatHost();
  screen.send();
  screen.field().onChangeText("next message typed during send");
  screen.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(screen.params.id, "42");
  assert.equal(screen.field().value, "next message typed during send");
  assert.equal(screen.session.drafts["/p#new:1"], undefined);
});

test("while the Tasks panel is out, the Chat under it is hidden from the screen reader", () => {
  const screen = chatHost();
  screen.params.id = "42";
  screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1 };
  const covered = () => find(screen.render(), (node) => node.type === "PanelSwipe").props.covered;
  assert.equal(covered(), false);
  for (const phase of ["open", "closing"]) {
    globalThis.planPanel = { phase };
    try {
      assert.equal(covered(), true, phase);
    } finally {
      delete globalThis.planPanel;
    }
  }
  const tree = screen.render();
  assert.ok(
    find(tree, (node) => node.type === "PanelSwipe" && find(node, (child) => child.type === "KeyboardStickyView")),
    "the composer is inside it",
  );
});

test("the PR pill sends a PR action whose preview is already a card", async () => {
  const url = "https://github.com/o/r/pull/77";
  globalThis.chatPullRequest = {
    number: 77,
    url,
    state: "OPEN",
    checks: "failed",
  };
  try {
    const screen = chatHost();
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = {
      id: 42,
      provider: "codex",
      worktree_id: 1,
    };
    find(screen.render(), (node) => node.type === "PullRequestAction").props.onRun();
    await settle();
    const sent = screen.calls.find((call) => call.method === "chat:send").args[0];
    assert.equal(sent.body, "Fix CI on pull request #77");
    // An older Mac ignores prAction: the prompt still carries the URL and the skill token.
    assert.equal(sent.prompt, `Fix CI on pull request #77 (${url}). /milagre-fix-ci`);
    assert.equal(JSON.stringify(sent.prAction), JSON.stringify({ action: "checks-failed", pr: 77, url }));
    const [pending] = Object.values(screen.session.pendingChats);
    assert.equal(
      JSON.stringify(pending.preview.message.context),
      JSON.stringify({
        kind: "pr-action",
        action: "checks-failed",
        pr: 77,
        url,
      }),
    );
  } finally {
    delete globalThis.chatPullRequest;
  }
});

test("a PR ready to merge shows Merge #n, which opens the PR sheet, and the sheet's Fix in Chat sends in this Chat", async () => {
  const url = "https://github.com/o/r/pull/90";
  globalThis.chatPullRequest = { number: 90, title: "Fix it", url, state: "OPEN", readyToMerge: true };
  globalThis.openedPullRequests = [];
  try {
    const screen = chatHost({ effects: true, call: async () => ({ sessionId: 42 }) });
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1 };
    const tree = screen.render();
    const key = `${screen.session.snapshot.project.path}#42`;
    assert.equal(
      find(tree, (node) => node.type === "PullRequestAction"),
      undefined,
      "a ready PR has no blocker to send",
    );
    find(tree, (node) => node.type === "PullRequestMerge").props.onOpen();
    assert.equal(JSON.stringify(globalThis.openedPullRequests), JSON.stringify([{ worktreeId: "1", number: "90", chat: key }]));
    // The header chip and PR shortcut open it in the app too, not on GitHub.
    const title = find(tree, (node) => node.type === "Screen" && typeof node.props.options?.headerTitle === "function").props.options.headerTitle();
    find(title, (node) => node.type === "HeaderPullRequestChip").props.onPress();
    find(tree, (node) => node.type?.name === "HeaderAction" && node.props.label === "Pull request #90").props.onPress();
    assert.equal(globalThis.openedPullRequests.length, 3);
    assert.equal(screen.external?.length ?? 0, 0);
    screen.render();
    assert.equal(await globalThis.prChat.sendToChat(key, "Fix the failing lint check"), "sent");
    await settle();
    const sent = screen.calls.find((call) => call.method === "chat:send").args[0];
    assert.equal(sent.body, "Fix the failing lint check");
    assert.equal(globalThis.prChat.prefillChat(key, "About PR #90: "), true);
    assert.equal(screen.session.drafts[key], "About PR #90: ");
  } finally {
    delete globalThis.chatPullRequest;
    delete globalThis.openedPullRequests;
  }
});

test("open review threads show a Review pill beside Merge, which opens the PR's threads", () => {
  globalThis.chatPullRequest = { number: 92, title: "Fix it", url: "https://github.com/o/r/pull/92", state: "OPEN", readyToMerge: true };
  const thread = (id, resolved, pending = false) => ({
    id,
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    resolved,
    outdated: false,
    comments: [{ id: `c${id}`, author: "jefo3", body: "?", createdAt: "x", ...(pending ? { pending: true } : {}) }],
  });
  // One open thread, one resolved, one that holds only the viewer's draft: only the first counts.
  globalThis.prDetail = { number: 92, state: "OPEN", threads: [thread("1", false), thread("2", true), thread("3", false, true)] };
  globalThis.openedPrPages = [];
  try {
    const screen = chatHost();
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1 };
    const tree = screen.render();
    assert.ok(
      find(tree, (node) => node.type === "PullRequestMerge"),
      "Merge stays beside it",
    );
    const review = find(tree, (node) => node.type === "PullRequestReview");
    assert.equal(review.props.count, 1);
    review.props.onOpen();
    const key = `${screen.session.snapshot.project.path}#42`;
    assert.equal(JSON.stringify(globalThis.openedPrPages), JSON.stringify([["threads", { worktreeId: "1", number: "92", chat: key }, undefined]]));
    globalThis.prDetail = { ...globalThis.prDetail, state: "MERGED" };
    assert.equal(
      find(screen.render(), (node) => node.type === "PullRequestReview"),
      undefined,
      "a merged PR has no review to answer",
    );
  } finally {
    delete globalThis.chatPullRequest;
    delete globalThis.prDetail;
    delete globalThis.openedPrPages;
  }
});

test("on an iPad the PR opens in the right panel, beside Changes", () => {
  globalThis.chatPullRequest = { number: 91, title: "Fix it", url: "https://github.com/o/r/pull/91", state: "OPEN", readyToMerge: true };
  globalThis.openedPullRequests = [];
  try {
    const screen = chatHost({ screenWidth: 1194 });
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1 };
    find(screen.render(), (node) => node.type === "PullRequestMerge").props.onOpen();
    assert.deepEqual(screen.panels.shown, ["right:pr:#91"]);
    assert.equal(globalThis.openedPullRequests.length, 0);
    chatMenuEntry(screen.render(), "View changes").props.onPress();
    assert.deepEqual(screen.panels.shown, ["right:pr:#91", "right"]);
  } finally {
    delete globalThis.chatPullRequest;
    delete globalThis.openedPullRequests;
  }
});

test("context size and the direct compact button are independent, follow the threshold and preserve the draft", async () => {
  const contextPreferences = { showContextSize: true, compactButtonDisplay: "threshold" };
  const screen = chatHost({ effects: true, contextPreferences, call: async () => ({ sessionId: 42 }) });
  screen.params.id = "42";
  const chat = { id: 42, provider: "claude", worktree_id: 1, contextUsage: { used: 69, size: 100 } };
  screen.session.snapshot.project.state.sessions[42] = chat;
  const compact = (tree) => find(tree, (node) => node.props?.accessibilityLabel === "Compact context");
  const ring = (tree) => find(tree, (node) => node.type === "ContextRing");
  let tree = screen.render();
  assert.ok(ring(tree));
  assert.ok(!compact(tree));
  chat.contextUsage.used = 70;
  tree = screen.render();
  assert.ok(compact(tree));
  assert.equal(compact(tree).props.disabled, false);
  contextPreferences.showContextSize = false;
  tree = screen.render();
  assert.equal(ring(tree).props.showSize, false, "a chevron replaces the size");
  assert.ok(compact(tree));
  chat.contextUsage.used = 20;
  assert.ok(!compact(screen.render()));
  contextPreferences.compactButtonDisplay = "always";
  const chatId = `${screen.session.snapshot.project.path}#42`;
  screen.session.drafts[chatId] = "Keep this draft";
  tree = screen.render();
  compact(tree).props.onPress();
  screen.render();
  await settle();
  assert.equal(screen.calls.filter((call) => call.method === "chat:send").length, 1);
  assert.equal(screen.calls.find((call) => call.method === "chat:send").args[0].compact, true);
  assert.equal(screen.session.drafts[chatId], "Keep this draft");
  chat.archived = true;
  assert.equal(compact(screen.render()).props.disabled, true);
  chat.archived = false;
  screen.session.error = "Disconnected";
  assert.equal(compact(screen.render()).props.disabled, true);
  screen.session.error = "";
  chat.provider = "codex";
  assert.ok(!compact(screen.render()));
});

test("mobile compaction can be queued and cancelled during a turn, and quiet mode hides its controls", async () => {
  const contextSettings = { buttonThreshold: 70, autoThreshold: 85, autoCompact: false };
  const screen = chatHost({ effects: true, contextSettings, call: async () => ({ sessionId: 42 }) });
  screen.session.refresh = async () => {};
  screen.params.id = "42";
  const chat = { id: 42, provider: "claude", worktree_id: 1, contextUsage: { used: 90, size: 100 } };
  screen.session.snapshot.project.state.sessions[42] = chat;
  const chatId = `${screen.session.snapshot.project.path}#42`;
  screen.session.snapshot.runs.runs[chatId] = { text: "Working", steps: [], approvals: [], questions: [] };
  screen.session.drafts[chatId] = "Keep this draft";
  const button = (tree, label) => find(tree, (node) => node.props?.accessibilityLabel === label);
  const compact = button(screen.render(), "Compact context");
  assert.equal(compact.props.disabled, false);
  compact.props.onPress();
  screen.render();
  await settle();
  assert.equal(screen.calls.find((call) => call.method === "chat:send").args[0].compact, true);
  chat.queued = [{ id: "compact-1", context: { kind: "compaction", status: "preparing" } }];
  button(screen.render(), "Cancel queued compaction").props.onPress();
  await settle();
  assert.deepEqual(Array.from(screen.calls.find((call) => call.method === "chat:queue-remove").args), [chatId, "compact-1"]);
  assert.equal(screen.session.drafts[chatId], "Keep this draft");
  chat.queued = [];
  contextSettings.autoCompact = true;
  const quiet = screen.render();
  assert.ok(!button(quiet, "Compact context"));
  assert.ok(!find(quiet, (node) => node.type === "ContextRing"));
  chat.provider = "codex";
  assert.ok(
    find(screen.render(), (node) => node.type === "ContextRing"),
    "unsupported providers keep their usage display",
  );
});

test("Compact now from the context sheet sends /compact to the open Chat with the compact flag and no preview", async () => {
  const screen = chatHost({ effects: true, call: async () => ({ sessionId: 42 }) });
  screen.params.id = "42";
  screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "claude", worktree_id: 1, contextUsage: { used: 897_000, size: 1_000_000 } };
  screen.render();
  const projectPath = screen.session.snapshot.project.path;
  screen.session.requestCompact(`${projectPath}#42`);
  screen.render();
  await settle();
  const sent = screen.calls.find((call) => call.method === "chat:send").args[0];
  assert.equal(sent.body, "/compact");
  assert.equal(sent.prompt, "/compact");
  assert.equal(sent.compact, true);
  assert.equal(sent.sessionId, 42);
  assert.equal(sent.projectPath, projectPath);
  assert.equal(Object.keys(screen.session.pendingChats).length, 0);
  // Rendering again sends nothing more: the counter, not the render, is the trigger.
  screen.render();
  await settle();
  assert.equal(screen.calls.filter((call) => call.method === "chat:send").length, 1);
});

test("a PR the Chat opened from another branch gets the PR pill, as its row shows it", () => {
  const url = "https://github.com/o/r/pull/81";
  globalThis.chatNamedPullRequests = { [url]: { number: 81, url, state: "OPEN", changesRequested: true } };
  try {
    const screen = chatHost();
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1, summary: { count: 2, pullRequests: [url] } };
    const pill = find(screen.render(), (node) => node.type === "PullRequestAction");
    assert.equal(pill?.props.pr.number, 81);
  } finally {
    delete globalThis.chatNamedPullRequests;
  }
});

test("a PR without a number yet shows no PR pill", () => {
  globalThis.chatPullRequest = { url: "https://github.com/o/r/pull/77", state: "OPEN", checks: "failed" };
  try {
    const screen = chatHost();
    screen.params.id = "42";
    screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex", worktree_id: 1 };
    assert.equal(
      find(screen.render(), (node) => node.type === "PullRequestAction"),
      undefined,
    );
  } finally {
    delete globalThis.chatPullRequest;
  }
});

test("a successful first send clears the sent draft", async () => {
  const screen = chatHost();
  screen.send();
  screen.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(screen.params.id, "42");
  assert.equal(screen.field().value, "");
  assert.equal(screen.session.drafts["/p#new:1"], undefined);
});

test("a failed first send restores the sent text alongside the next draft and releases the composer", async () => {
  const screen = chatHost();
  screen.send();
  screen.field().onChangeText("edited during failed send");
  screen.sending.reject(new Error("Connection lost"));
  await settle();
  assert.equal(screen.params.id, undefined);
  assert.equal(screen.field().value, "first message\n\nedited during failed send");
  const button = find(screen.render(), (node) => node.type === "IconButton" && node.props.label === "Send message");
  assert.equal(button.props.disabled, false);
  assert.equal(find(screen.render(), (node) => node.type === "ErrorNotice").props.message, "Connection lost");
});

test("a New Chat opened while another one is still sending starts empty and sends its own", async () => {
  const first = chatHost();
  first.send();
  await settle();
  assert.equal(transcriptMessages(first)[0]?.body, "first message");
  // The drawer's New Chat: another screen for the same Worktree, with the same pending sends and composers.
  const second = chatHost();
  Object.defineProperty(second.session, "pendingChats", { get: () => first.session.pendingChats });
  second.session.setPendingChats = first.session.setPendingChats;
  second.session.drafts = first.session.drafts;
  second.session.setDrafts = (fn) => {
    first.session.drafts = second.session.drafts = fn(second.session.drafts);
  };
  assert.deepEqual(transcriptMessages(second), []);
  assert.equal(second.field().value, "");
  second.field().onChangeText("second message");
  second.send();
  await settle();
  assert.deepEqual(
    second.calls.filter((call) => call.method === "chat:send").map((call) => call.args[0].body),
    ["second message"],
  );
  assert.equal(Object.keys(first.session.pendingChats).length, 2, "both sends are pending, each under its own screen");
  // The first Mac answer reaches only the screen that sent it.
  first.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(first.params.id, "42");
  assert.equal(second.params.id, undefined);
  assert.equal(transcriptMessages(second)[0]?.body, "second message");
});

test("an accepted mobile send releases the composer before a slow refresh finishes", async () => {
  const screen = chatHost();
  const refresh = deferred();
  screen.session.refresh = () => refresh.promise;
  screen.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex" };
  screen.params.id = "7";
  screen.session.drafts["/p#7"] = "Send this";
  screen.send();
  await settle();
  screen.sending.resolve({ sessionId: 7 });
  await settle();
  screen.field().onChangeText("Next message");
  const button = find(screen.render(), (node) => node.type === "IconButton" && node.props.label === "Send message");
  assert.equal(button.props.disabled, false);
  refresh.resolve();
});

test("switching the mounted mobile composer between computers isolates concurrent sends", async () => {
  const sends = [deferred(), deferred()];
  let count = 0;
  const screen = chatHost({ call: (method) => (method === "chat:send" ? sends[count++].promise : Promise.resolve([])) });
  const state = screen.session.snapshot.project.state;
  state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex" };
  screen.params.id = "7";
  screen.session.drafts["/p#7"] = "First computer";
  screen.send();
  await settle();
  // The routed pane stays mounted, including when the other computer uses the same path and Chat id.
  screen.session.client.url = "other-mac";
  screen.field().onChangeText("Second computer");
  let button = find(screen.render(), (node) => node.type === "IconButton" && node.props.label === "Send message");
  assert.equal(button.props.disabled, false, "the first computer's send does not lock the second");
  screen.send();
  await settle();
  assert.equal(count, 2);
  assert.equal(Object.keys(screen.session.pendingChats).length, 2);
  // The first completion must not release the second computer's duplicate-send guard.
  sends[0].resolve({ sessionId: 7 });
  await settle();
  screen.field().onChangeText("Next draft");
  button = find(screen.render(), (node) => node.type === "IconButton" && node.props.label === "Sending...");
  button.props.onPress();
  await settle();
  assert.equal(count, 2);
  assert.equal(button.props.disabled, true);
  sends[1].reject(new Error("Second computer refused the send"));
  await settle();
  assert.equal(screen.field().value, "Second computer\n\nNext draft");
  button = find(screen.render(), (node) => node.type === "IconButton" && node.props.label === "Send message");
  assert.equal(button.props.disabled, false);
});

test("the drawer reopens a New Chat that is still sending", async () => {
  const first = chatHost();
  first.send();
  await settle();
  const [pending] = Object.values(first.session.pendingChats);
  assert.ok(pending.draft);
  const reopened = chatHost();
  reopened.session.pendingChats = first.session.pendingChats;
  reopened.params.draft = pending.draft;
  assert.equal(transcriptMessages(reopened)[0]?.body, "first message");
});

test("a busy Mac takes the first send on a later try, with no error and one message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let tries = 0;
  const screen = chatHost({
    call: (method) => {
      if (method === "project:branches") return Promise.resolve(["main"]);
      if (method !== "chat:send") return Promise.resolve();
      tries++;
      return tries < 3
        ? Promise.reject(Object.assign(new Error("Your computer is busy right now. Try again in a moment."), { status: 429 }))
        : Promise.resolve({ sessionId: 42 });
    },
  });
  screen.send();
  await settle();
  assert.equal(tries, 1);
  assert.equal(transcriptMessages(screen)[0]?.body, "first message", "the message shows as sending meanwhile");
  assert.equal(
    find(screen.render(), (node) => node.type === "ErrorNotice"),
    undefined,
  );
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  await settle();
  const sends = screen.calls.filter((call) => call.method === "chat:send").map((call) => call.args[0].clientMessageId);
  assert.equal(sends.length, 3);
  assert.equal(new Set(sends).size, 1, "every try carries the same id, so the Mac saves it once");
  assert.equal(screen.params.id, "42");
  assert.equal(
    find(screen.render(), (node) => node.type === "ErrorNotice"),
    undefined,
  );
});

test("a send that lands after its New Chat was left keeps out of the next New Chat's composer", async () => {
  const screen = chatHost();
  screen.send();
  await settle();
  screen.session.isSelected = () => false;
  screen.session.drafts = { ...screen.session.drafts, "/p#new:1": "the next chat" };
  screen.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(screen.session.drafts["/p#new:1"], "the next chat");
  assert.equal(screen.session.drafts["/p#42"], undefined);
});

test("an open Chat whose page already holds the sent follow-up shows it once", async (t) => {
  const screen = chatHost({ effects: true });
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.messagesInChats = true;
  state.sessions[42] = { id: 42, worktree_id: 1, provider: "codex", status: "Created", summary: { count: 1 } };
  screen.session.drafts["/p#42"] = "follow up";
  let page = [{ id: 3, session_id: 42, role: "user", body: "start" }];
  globalThis.chatPage = (client, _path, id) =>
    client && id === 42 ? { messages: page, hasMore: false, total: page.length, loading: false, loadEarlier: async () => {} } : undefined;
  t.after(() => delete globalThis.chatPage);
  screen.send();
  await settle();
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.body),
    ["start", "follow up"],
  );
  // A runs update read the page again before the snapshot's summary named the send.
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  page = [...page, { id: 4, session_id: 42, role: "user", body: "follow up", clientMessageId: request.clientMessageId }];
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [3, 4],
  );
});

test("a Chat followed at its bottom lets go of its history as new messages arrive, not while scrolled up", async (t) => {
  const screen = chatHost({ effects: true });
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.messagesInChats = true;
  state.sessions[42] = { id: 42, worktree_id: 1, provider: "codex", status: "Created", summary: { count: 1 } };
  let page = [{ id: 1, session_id: 42, role: "user", body: "start" }];
  let trims = 0;
  globalThis.chatPage = (client, _path, id) =>
    client && id === 42
      ? {
          messages: page,
          hasMore: false,
          total: page.length,
          loading: false,
          loadEarlier: async () => {},
          trim: () => trims++,
        }
      : undefined;
  t.after(() => delete globalThis.chatPage);
  const view = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  view();
  await settle();
  assert.equal(trims, 0, "opening a Chat trims nothing");
  page = [...page, { id: 2, session_id: 42, role: "assistant", body: "reply" }];
  view();
  await settle();
  assert.equal(trims, 1, "a new message at the bottom trims the window");
  view().props.onScroll({ nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 600 } } });
  page = [...page, { id: 3, session_id: 42, role: "assistant", body: "more" }];
  view();
  await settle();
  assert.equal(trims, 1, "a reader scrolled up keeps the history they are reading");
});

test("the transcript follows new content, also after the agent settings sheet opens", () => {
  const screen = chatHost();
  const tree = screen.render();
  const page = find(tree, (node) => node.type === "KeyboardChatScrollView");
  let scrolls = 0;
  page.props.ref.current = {
    scrollToEnd() {
      scrolls++;
    },
  };
  page.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  page.props.onContentSizeChange(0, 400);
  assert.equal(scrolls, 0, "a transcript shorter than the screen never scrolls");
  page.props.onContentSizeChange(0, 900);
  assert.equal(scrolls, 1);
  find(tree, (node) => node.type === "AgentControls").props.onToggle();
  page.props.onContentSizeChange(0, 1000);
  assert.equal(scrolls, 2);
});

test("a long Chat opens hidden and jumps to its newest message without animating", () => {
  const screen = chatHost();
  const page = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  const scrolls = [];
  let first = page();
  first.props.ref.current = {
    scrollToEnd(options) {
      scrolls.push(options);
    },
  };
  assert.equal(first.props.style.opacity, 0);
  first.props.onContentSizeChange(0, 2000);
  assert.equal(scrolls.length, 0, "waits for the viewport before placing");
  first.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  assert.equal(JSON.stringify(scrolls), JSON.stringify([{ animated: false }]));
  // The jump can land frames after a long transcript mounts; until then the top of the Chat would flash.
  assert.equal(page().props.style.opacity, 0, "stays hidden until the scroll view reports its end on screen");
  page().props.onEndVisible(true);
  const placed = page();
  assert.equal(placed.props.style.opacity, 1);
  placed.props.onContentSizeChange(0, 2100);
  assert.equal(JSON.stringify(scrolls), JSON.stringify([{ animated: false }, { animated: false }]));
  screen.params.id = "42";
  screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex" };
  assert.equal(page().props.style.opacity, 0, "switching Chats hides the next transcript until it is placed");
});

test("a long Chat shows itself when a scroll event reaches its end, or after a short wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reveal of ["scroll", "timer"]) {
    const screen = chatHost();
    const page = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
    page().props.ref.current = { scrollToEnd() {} };
    page().props.onContentSizeChange(0, 2000);
    page().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    assert.equal(page().props.style.opacity, 0);
    if (reveal === "scroll")
      page().props.onScroll({ nativeEvent: { contentSize: { height: 2000 }, contentOffset: { y: 1400 }, layoutMeasurement: { height: 600 } } });
    else t.mock.timers.tick(500);
    assert.equal(page().props.style.opacity, 1, reveal);
  }
});

test("a short Chat shows itself at once", () => {
  const screen = chatHost();
  const page = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  page().props.ref.current = { scrollToEnd() {} };
  page().props.onContentSizeChange(0, 400);
  page().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  assert.equal(page().props.style.opacity, 1);
});

test("images that load above the screen leave the visible messages in place", () => {
  const screen = chatHost();
  const page = find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  // A JS jump after onContentSizeChange lands frames late; the native view must hold the first visible message.
  assert.equal(JSON.stringify(page.props.maintainVisibleContentPosition), JSON.stringify({ minIndexForVisible: 0 }));
});

test("first send keeps the placed transcript mounted when the draft adopts its saved Chat", async () => {
  const sending = deferred();
  const screen = chatHost({ effects: true, call: (method) => (method === "project:branches" ? Promise.resolve(["main"]) : sending.promise) });
  const page = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  const initial = page();
  initial.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  initial.props.onContentSizeChange(0, 300);
  assert.equal(page().props.style.opacity, 1);
  screen.send();
  await settle();
  const preview = page();
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  const state = screen.session.snapshot.project.state;
  state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex", status: "Created" };
  state.messages = [{ id: 8, session_id: 7, role: "user", body: "first message", clientMessageId: request.clientMessageId }];
  sending.resolve({ sessionId: 7 });
  await settle();
  assert.equal(screen.params.id, "7");
  assert.equal(page().key, preview.key, "saving the same Chat must not recreate its native scroll view");
  assert.equal(page().props.style.opacity, 1, "acknowledgement must not hide an already placed transcript");
  screen.session.pendingChats = {};
  assert.equal(page().key, preview.key, "retiring the preview keeps its scroll position");
  delete screen.params.id;
  assert.notEqual(page().key, preview.key, "a new draft in the same Worktree must not reuse the saved Chat's scroll state");
  assert.equal(page().props.style.opacity, 0);
  screen.params.id = "42";
  state.sessions[42] = { id: 42, worktree_id: 1, provider: "codex", status: "Created" };
  assert.notEqual(page().key, preview.key, "opening another Chat still resets placement");
  assert.equal(page().props.style.opacity, 0);
});

test("first send stays visible while the saved Chat's first page is still loading", async (t) => {
  const screen = chatHost({ effects: true });
  const state = screen.session.snapshot.project.state;
  state.messagesInChats = true;
  let saved = [];
  let loading = true;
  globalThis.chatPage = (client, _path, id) =>
    client && id === 7 ? { messages: saved, hasMore: false, total: saved.length, loading, loadEarlier: async () => {} } : undefined;
  t.after(() => delete globalThis.chatPage);
  screen.send();
  await settle();
  const input = () => transcriptMessages(screen).find((message) => message.role === "user");
  assert.equal(input()?.body, "first message");
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex", status: "Created", summary: { count: 1, clientMessageIds: [request.clientMessageId] } };
  assert.equal(input()?.body, "first message", "the summary must not remove the preview before the page arrives");
  screen.sending.resolve({ sessionId: 7 });
  await settle();
  screen.session.pendingChats = {};
  assert.equal(input()?.body, "first message", "the input survives acknowledgement while the page loads");
  saved = [{ id: 8, session_id: 7, role: "user", body: "first message", clientMessageId: request.clientMessageId }];
  loading = false;
  assert.equal(input()?.id, 8);
  assert.equal(transcriptMessages(screen).length, 1);
});

test("the message that continued a Chat on another account is a line, not a reply", () => {
  const screen = chatHost();
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.sessions[42] = { id: 42, provider: "claude" };
  const context = { kind: "account-switch", provider: "claude", label: "me@work.com" };
  state.messages = [
    { id: 1, session_id: 42, role: "user", body: "Fix the api" },
    { id: 2, session_id: 42, role: "user", body: "Switched to me@work.com after the usage limit", context },
  ];
  const tree = screen.render();
  assert.deepEqual(find(tree, (node) => node.type === "AccountSwitchDivider").props.context, context);
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [1],
  );
  const rail = find(tree, (node) => node.type === "MessageNavigation");
  assert.equal(rail.props.items.at(-1).label, "Go to Switched to me@work.com after the usage limit, 2 of 2.");
});

test("a Chat whose babysit Heartbeat ended shows the line saying why, and the rail names it", () => {
  const screen = chatHost();
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.sessions[42] = { id: 42, provider: "claude" };
  const context = { kind: "babysit-stopped", routineId: "r1", pr: 7, reason: "merged" };
  state.messages = [
    { id: 1, session_id: 42, role: "user", body: "Open a PR" },
    { id: 2, session_id: 42, role: "assistant", body: "Stopped babysitting PR #7: merged.", context },
  ];
  const tree = screen.render();
  const dividers = [];
  find(tree, (node) => {
    if (node.type === "BabysitStoppedDivider") dividers.push(node.props.context);
    return false;
  });
  assert.deepEqual(dividers, [context]);
  // Not drawn as a reply too.
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [1],
  );
  const rail = find(tree, (node) => node.type === "MessageNavigation");
  assert.equal(rail.props.items.at(-1).label, "Go to Stopped babysitting PR #7: merged, 2 of 2.");
});

test("quiet heartbeats collapse into one line and their replies are hidden", () => {
  const screen = chatHost();
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.sessions[42] = { id: 42, provider: "claude" };
  const run = (id, minute, summary) => ({
    id,
    session_id: 42,
    role: "user",
    body: "Heartbeat",
    context: { kind: "routine-run", routineId: "r1", runId: `run${id}`, name: "Babysit", at: Date.UTC(2026, 9, 16, 10, minute), quiet: true, summary },
  });
  state.messages = [
    { id: 1, session_id: 42, role: "user", body: "Watch CI" },
    run(2, 15, "waiting"),
    { id: 3, session_id: 42, role: "assistant", body: "(pass) waiting" },
    run(4, 30, "CI green"),
    { id: 5, session_id: 42, role: "assistant", body: "(pass) CI green" },
  ];
  const tree = screen.render();
  const dividers = [];
  find(tree, (node) => {
    if (node.type === "RoutineRunDivider") dividers.push(node.props);
    return false;
  });
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].merged.count, 2);
  assert.equal(dividers[0].merged.last.summary, "CI green");
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [1],
  );
});

test("a Linear Run's first message shows the routine divider, then its issue card", () => {
  const screen = chatHost();
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.sessions[42] = { id: 42, provider: "claude" };
  const routine = { routineId: "r1", runId: "run1", name: "Triage", at: Date.UTC(2026, 9, 16, 10, 15), label: "Routine · Triage" };
  state.messages = [
    {
      id: 1,
      session_id: 42,
      role: "user",
      body: "Look at MIL-1",
      context: { kind: "linear-issue", key: "MIL-1", title: "Paste", url: "u", state: { name: "Todo", type: "unstarted", color: "#aaa" }, routine },
    },
    { id: 2, session_id: 42, role: "assistant", body: "On it." },
  ];
  const tree = screen.render();
  const order = [];
  find(tree, (node) => {
    if (node.type === "RoutineRunDivider") order.push(["divider", node.props.context]);
    if (node.type === "ChatReply" && node.props.message) order.push(["reply", node.props.message.id]);
    return false;
  });
  assert.deepEqual(order[0], ["divider", { kind: "routine-run", ...routine }]);
  assert.deepEqual(order.slice(1), [
    ["reply", 1],
    ["reply", 2],
  ]);
  const rail = find(tree, (node) => node.type === "MessageNavigation");
  assert.match(rail.props.items[0].label, /^Go to Routine · Triage · \d\d:\d\d, 1 of 2\.$/);
});

test("the navigation rail skips hidden heartbeat replies and counts what the transcript shows", () => {
  const screen = chatHost();
  screen.params.id = "42";
  const state = screen.session.snapshot.project.state;
  state.sessions[42] = { id: 42, provider: "claude" };
  const run = (id, minute, summary) => ({
    id,
    session_id: 42,
    role: "user",
    body: "Heartbeat",
    context: { kind: "routine-run", routineId: "r1", runId: `run${id}`, name: "Babysit", at: Date.UTC(2026, 9, 16, 10, minute), quiet: true, summary },
  });
  state.messages = [
    { id: 1, session_id: 42, role: "user", body: "Watch CI" },
    run(2, 15, "waiting"),
    { id: 3, session_id: 42, role: "assistant", body: "(pass) waiting" },
    run(4, 30, "CI green"),
    { id: 5, session_id: 42, role: "assistant", body: "(pass) CI green" },
  ];
  const rail = find(screen.render(), (node) => node.type === "MessageNavigation");
  assert.equal(rail.props.items.length, 2);
  assert.match(rail.props.items[0].label, /^Go to user message 1 of 2\. Watch CI$/);
  assert.match(rail.props.items[1].label, /^Go to 2 quiet checks · last \d\d:\d\d: CI green, 2 of 2\.$/);
  assert.ok(rail.props.items.every((item) => !item.label.includes("(pass)")));
});

test("mobile navigation spans a long Chat with at most 15 lines and loads older targets before scrolling", () => {
  const screen = chatHost();
  screen.params.id = "42";
  screen.session.snapshot.project.state.sessions[42] = {
    id: 42,
    provider: "codex",
  };
  screen.session.snapshot.project.state.messages = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    session_id: 42,
    role: "assistant",
    body: `Message ${index + 1}`,
  }));
  const tree = screen.render();
  const rail = find(tree, (node) => node.type === "MessageNavigation");
  assert.ok(rail, "Chats have a navigation rail");
  assert.equal(rail.props.items.length, 15);
  assert.equal(rail.props.items[0].index, 0);
  assert.equal(rail.props.items.at(-1).index, 99);
  const page = find(tree, (node) => node.type === "KeyboardChatScrollView");
  const scrolls = [];
  page.props.ref.current = {
    scrollTo: (options) => scrolls.push(options),
    scrollToEnd: (options) => scrolls.push({ end: true, ...options }),
  };
  rail.props.onSelect(0);
  const earlier = screen.render();
  const target = find(earlier, (node) => node.props?.nativeID === "chat-message-1");
  assert.ok(target, "selecting an unloaded message mounts it");
  target.props.onLayout({ nativeEvent: { layout: { y: 84 } } });
  assert.equal(scrolls.at(-1).y, 12, "the first message stays below the transparent header");
  find(earlier, (node) => node.type === "MessageNavigation").props.onSelect(99);
  assert.equal(scrolls.at(-1).end, true, "the latest tick returns to live output");
});

test("the mobile rail stays above the composer when the keyboard lifts it", () => {
  const keyboard = { height: { value: -300 }, progress: { value: 1 } };
  const { MessageNavigation } = load("message-navigation.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", View: "View" },
    "react-native-reanimated": { default: { View: "AnimatedView" }, useAnimatedStyle: (fn) => fn() },
    "react-native-keyboard-controller": { useReanimatedKeyboardAnimation: () => keyboard },
    "./theme": { colors: {} },
  });
  const props = {
    items: [
      { index: 0, label: "First" },
      { index: 99, label: "Latest" },
    ],
    onSelect() {},
    top: 134,
    bottom: 152,
    keyboardOffset: 24,
  };
  const bottom = (tree) => Object.assign({}, ...[tree.props.style].flat()).bottom;
  assert.equal(bottom(MessageNavigation(props)), 428, "the rail follows the composer by the keyboard height minus its lift offset");
  keyboard.height.value = 0;
  keyboard.progress.value = 0;
  assert.equal(bottom(MessageNavigation(props)), 152, "closing the keyboard restores the rail bounds");
});

test("Go to bottom returns the mobile transcript to the end and resumes following", () => {
  const screen = chatHost({ effects: true });
  const page = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  const jump = () => find(screen.render(), (node) => node.type === "GlassIconButton" && node.props.label === "Go to bottom");
  const scrolls = [];
  page().props.ref.current = {
    scrollToEnd(options) {
      scrolls.push(options);
    },
  };
  page().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  page().props.onContentSizeChange(0, 1800);
  assert.equal(JSON.stringify(scrolls), JSON.stringify([{ animated: false }]), "Opening places the Chat at its end");
  scrolls.length = 0;
  page().props.onEndVisible(true);
  assert.equal(jump(), undefined, "No button when the end is visible, including short chats");
  page().props.onScrollBeginDrag({ nativeEvent: {} });
  page().props.onScroll({ nativeEvent: { contentSize: { height: 1800 }, contentOffset: { y: 200 }, layoutMeasurement: { height: 600 } } });
  page().props.onEndVisible(false);
  assert.ok(jump(), "The keyboard-aware end callback reveals the button");
  page().props.onContentSizeChange(0, 1900);
  assert.equal(scrolls.length, 0, "New output leaves earlier messages in place");
  jump().props.onPress();
  assert.equal(JSON.stringify(scrolls), JSON.stringify([{ animated: false }]), "The jump reaches the end without intermediate scroll events disabling follow");
  assert.equal(jump(), undefined);
  // A native scroll/layout event can arrive before the jump command has caught up with loaded images.
  page().props.onScroll({ nativeEvent: { contentSize: { height: 2000 }, contentOffset: { y: 200 }, layoutMeasurement: { height: 600 } } });
  page().props.onContentSizeChange(0, 2000);
  assert.equal(scrolls.length, 2, "Following resumes after the jump");
  page().props.onScroll({ nativeEvent: { contentSize: { height: 2600 }, contentOffset: { y: 1400 }, layoutMeasurement: { height: 600 } } });
  page().props.onContentSizeChange(0, 2600);
  assert.equal(scrolls.length, 3, "Late image sizes cannot disable following before the end is reached");
  page().props.onScrollBeginDrag?.({ nativeEvent: {} });
  page().props.onScroll({ nativeEvent: { contentSize: { height: 2600 }, contentOffset: { y: 600 }, layoutMeasurement: { height: 600 } } });
  page().props.onContentSizeChange(0, 2800);
  assert.equal(scrolls.length, 3, "Dragging up interrupts the jump and preserves the reading position");
  page().props.onEndVisible(false);
  assert.ok(jump());
  page().props.onEndVisible(true);
  assert.equal(jump(), undefined, "Scrolling back to the end manually hides the button");
  page().props.onEndVisible(false);
  screen.params.id = "42";
  screen.render();
  assert.equal(jump(), undefined, "Switching Chats clears the previous button state");
});

test("live tool activity opens in the activity sheet instead of expanding in the transcript", () => {
  const screen = chatHost();
  screen.params.id = "42";
  screen.session.snapshot.project.state.sessions[42] = { id: 42, provider: "codex" };
  screen.session.snapshot.runs.runs["/p#42"] = { text: "", steps: [], approvals: [], questions: [] };
  const tree = screen.render();
  const pushed = [];
  screen.router.push = (route) => pushed.push(route);
  find(tree, (node) => node.type === "ChatReply").props.onActivity("run");
  assert.equal(JSON.stringify(pushed), JSON.stringify([{ pathname: "/activity", params: { id: "42", message: "run" } }]));
});

test("switching the requested diff hides old content and ignores its late response", async () => {
  const react = hookHost();
  let currentDeps, cleanup, pendingEffect;
  react.useEffect = (effect, deps) => {
    if (!currentDeps || deps.some((value, index) => value !== currentDeps[index])) {
      currentDeps = deps;
      pendingEffect = () => {
        cleanup?.();
        cleanup = effect();
      };
    }
  };
  const first = deferred(),
    second = deferred();
  const client = { call: (_method, args) => (args[0].path === "first" ? first.promise : second.promise) };
  const { useRpc } = load("use-rpc.ts", { react });
  let file = "first";
  const render = () => {
    react.begin();
    const value = useRpc(client, "git:diff-file", [{ path: file }]);
    const effect = pendingEffect;
    pendingEffect = null;
    effect?.();
    return value;
  };
  assert.equal(render().loading, true);
  file = "second";
  assert.equal(render().data, null);
  second.resolve({ patch: "+second" });
  await settle();
  assert.equal(render().data.patch, "+second");
  first.resolve({ patch: "+first" });
  await settle();
  assert.equal(render().data.patch, "+second");
  cleanup?.();
});

test("late Chat rename cannot pop another screen after its form loses focus", async () => {
  const saving = deferred(),
    react = hookHost();
  let cleanup,
    backs = 0;
  const session = {
    client: { call: () => saving.promise },
    snapshot: { project: { path: "/A", state: { sessions: { 1: { id: 1, title: "Chat" } } } }, runs: { runs: {} } },
    isSelected: () => true,
    refresh: async () => {},
  };
  const { default: Form } = load("app/chat-details.tsx", {
    "../archive-progress": archiveProgress,
    "../chat-actions": { runChatAction: async () => {} },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text" },
    "expo-router": {
      Redirect: "Redirect",
      router: { back: () => backs++ },
      useLocalSearchParams: () => ({ id: "1" }),
      useFocusEffect: (fn) => {
        cleanup = fn();
      },
    },
    "../session": { useSession: () => session, useComposer: () => session, usePendingChats: () => session },
    "../use-links": { useLinks: () => linksState() },
    "../chat-links": chatLinks(),
    "../attachment-picker": { pickAttachments: async () => [] },
    "../attachments": require("../apps/mobile/src/attachments.ts"),
    "../status-indicators": { ChatStatus: "ChatStatus", AgentStatus: "AgentStatus", WorktreeStatus: "WorktreeStatus" },
    "../ui": { ...Object.fromEntries(["Button", "ErrorNotice", "Field", "PageScroll"].map((name) => [name, name])), styles: {} },
  });
  react.begin();
  const tree = Form();
  find(tree, (n) => n.type === "Button" && n.props.title === "Save name").props.onPress();
  cleanup?.();
  saving.resolve({});
  await settle();
  assert.equal(backs, 0);
});

test("selection guards expire when Project or connection changes", async () => {
  const render = sessionHost({ call: async (method, args) => (method === "project:recent" ? [] : { path: args?.[0] }), snapshot: async (p) => snapshot(p) });
  await render().connect({ address: "address", token: "token" });
  await render().open("A");
  const first = render();
  assert.equal(first.isSelected(), true);
  await first.open("B");
  assert.equal(first.isSelected(), false);
  const second = render();
  assert.equal(second.isSelected(), true);
  await second.connect({ address: "another-address", token: "token" });
  assert.equal(second.isSelected(), false);
});

test("attachment drafts survive a failed send and move only after a successful first send", async () => {
  const screen = chatHost();
  const photo = { id: "photo", name: "photo.jpg", uri: "file:///photo", image: { id: "photo", name: "photo.jpg", dataUrl: "data:image/jpeg;base64,/9j/" } };
  screen.session.attachments["/p#new:1"] = [photo];
  screen.send();
  await settle();
  screen.sending.reject(new Error("Connection lost"));
  await settle();
  assert.equal(screen.session.attachments["/p#new:1"][0].id, "photo");
  assert.equal(screen.field().value, "first message");
  const next = chatHost();
  next.session.attachments["/p#new:1"] = [photo];
  next.send();
  next.session.attachments["/p#new:1"] = [photo, { ...photo, id: "later" }];
  next.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(next.session.attachments["/p#new:1"], undefined);
  assert.deepEqual(
    Array.from(next.session.attachments["/p#42"], (item) => item.id),
    ["later"],
  );
});

test("reusing an empty Chat preserves its existing text and attachment drafts", async () => {
  const screen = chatHost();
  const photo = { id: "a", name: "a.jpg", uri: "file:///a", image: { id: "a", name: "a.jpg", dataUrl: "data:image/jpeg;base64,/9j/" } };
  screen.session.attachments["/p#42"] = [photo];
  screen.session.drafts["/p#42"] = "unsent in existing Chat";
  screen.send();
  screen.sending.resolve({ sessionId: 42 });
  await settle();
  assert.equal(screen.session.attachments["/p#42"].length, 1);
  assert.equal(screen.session.attachments["/p#42"][0], photo);
  assert.equal(screen.field().value, "unsent in existing Chat");
});

test("cached Chat switches commit before the network, survive route handoff and refresh in place", async () => {
  const update = deferred();
  let waiting = false;
  const copy = (path, title) => ({ ...snapshot(path), project: { path, state: { sessions: { 7: { id: 7, title } } } } });
  const client = { url: "mac", call: async () => [], snapshot: async (path) => (waiting ? update.promise : copy(path, "Cached")) };
  const render = sessionHost(client);
  await render().connect({ address: "mac", token: "token" });
  await render().open("/a");
  await render().open("/b");
  waiting = true;
  assert.equal(render().openCachedChat("/a", 7), client);
  assert.equal(render().snapshot.project.path, "/a", "the target is ready synchronously, before routing");
  assert.equal(render().snapshot.project.state.sessions[7].title, "Cached");
  assert.equal(render().isSelected(), true);
  render().cancelNavigation(); // The drawer's route handoff cancels unfinished navigation, not this committed selection.
  update.resolve(copy("/a", "Updated"));
  await settle();
  assert.equal(render().snapshot.project.state.sessions[7].title, "Updated");
});

test("returning to the visible cached Chat cancels a cold open and restores its active selection", async () => {
  const cold = deferred();
  const client = {
    url: "mac",
    call: async () => [],
    snapshot: async (path) =>
      path === "/cold"
        ? cold.promise
        : {
            project: { path, state: { sessions: { 7: { id: 7 } } } },
            runs: { runs: {} },
          },
  };
  const render = sessionHost(client);
  await render().connect({ address: "mac", token: "token" });
  await render().open("/a");
  const opening = render().open("/cold");
  assert.equal(render().isSelected(), false);
  assert.equal(render().openCachedChat("/a", 7), client);
  assert.equal(render().isSelected(), true);
  assert.equal(render().opening, null);
  cold.resolve(snapshot("/cold"));
  await opening;
  assert.equal(render().snapshot.project.path, "/a");
});

test("a cached Chat on another computer opens offline without borrowing the other computer's state", async () => {
  const update = deferred();
  let waiting = false;
  const clients = Object.fromEntries(
    ["one", "two"].map((url) => [
      url,
      {
        url,
        call: async () => [],
        recentScopes: async () => [],
        open: async (path) => (waiting ? update.promise : { project: { path, state: { sessions: { 7: { id: 7, title: url } } } }, runs: { runs: {} } }),
      },
    ]),
  );
  const render = sessionHost(clients.one, { clientFactory: (host) => clients[host.address] });
  const host = (address) => ({ address, token: "token", name: address });
  await render().connect(host("one"));
  await render().open("/same");
  await render().connect(host("two"));
  await render().open("/same");
  waiting = true;
  assert.equal(render().openCachedChat("/same", 7, host("one")), clients.one);
  assert.equal(render().client.url, "one");
  assert.equal(render().snapshot.project.state.sessions[7].title, "one");
  update.reject(new Error("Offline"));
  await settle();
  assert.equal(render().error, "Offline");
  assert.equal(render().snapshot.project.state.sessions[7].title, "one");
  assert.equal(render().isSelected(), true);
});

test("a cached computer switch keeps sidebar rows while its Project list is pending or fails", async () => {
  const { createAllComputersStore } = require("../apps/mobile/src/all-computers-store.ts");
  const lists = deferred();
  let switching = false;
  const projects = [{ path: "/same", name: "Project" }];
  const clients = Object.fromEntries(
    ["one", "two"].map((url) => [
      url,
      {
        url,
        call: async () => [],
        recentScopes: async () => (switching ? lists.promise : projects),
        open: async (path) => ({ project: { path, state: { sessions: { 7: { id: 7, title: url } } } }, runs: { runs: {} } }),
      },
    ]),
  );
  const render = sessionHost(clients.one, { clientFactory: (host) => clients[host.address] });
  const hosts = ["one", "two"].map((id) => ({ id, address: id, token: "token", name: id, lastUsed: 0 }));
  const store = createAllComputersStore({
    createClient: (host) => clients[host.id],
    applyProjects: async (_id, value) => value,
    now: () => 1,
    random: () => 0.5,
    setTimer: () => null,
    clearTimer() {},
  });
  const sync = () => {
    const session = render();
    store.sync(hosts, {
      hostId: session.client.url,
      client: session.client,
      projects: session.recentLoaded ? session.recent : undefined,
      reload: session.reloadProjects,
    });
    return session;
  };
  await render().connect(hosts[0]);
  await render().open("/same");
  assert.equal(sync().recentLoaded, true);
  await render().connect(hosts[1]);
  await render().open("/same");
  sync();
  switching = true;
  render().openCachedChat("/same", 7, hosts[0]);
  assert.equal(sync().recentLoaded, false, "the new session has not fetched its Project list yet");
  assert.deepEqual(
    Array.from(store.viewOf("one").projects, (project) => project.path),
    ["/same"],
  );
  lists.reject(new Error("Offline"));
  await settle();
  assert.equal(sync().recentLoaded, false);
  assert.deepEqual(
    Array.from(store.viewOf("one").projects, (project) => project.path),
    ["/same"],
  );
  clients.one.recentScopes = async () => [];
  await render().reloadProjects();
  assert.equal(sync().recentLoaded, true, "an authoritative empty answer is loaded");
  assert.equal(store.viewOf("one").projects.length, 0);
});

test("cached Chat revalidation cannot overwrite a later selection or a newer live snapshot", async () => {
  const update = deferred();
  let waiting = false;
  const copy = (path, title) => ({ project: { path, state: { sessions: { 7: { id: 7, title } } } }, runs: { runs: {} } });
  const client = { url: "mac", call: async () => [], snapshot: async (path) => copy(path, "Cached") };
  const render = sessionHost(client);
  await render().connect({ address: "mac", token: "token" });
  await render().open("/a");
  await render().open("/b");
  client.open = async (path) => (waiting ? update.promise : copy(path, "Later selection"));
  waiting = true;
  render().openCachedChat("/a", 7);
  client.snapshot = async (path) => copy(path, "Live update");
  await render().refresh();
  update.resolve(copy("/a", "Old response"));
  await settle();
  assert.equal(render().snapshot.project.state.sessions[7].title, "Live update");
  const late = deferred();
  client.open = (path) => (path === "/b" ? late.promise : Promise.resolve(copy(path, "Live update")));
  render().openCachedChat("/b", 7);
  render().openCachedChat("/a", 7);
  late.reject(new Error("Old failure"));
  await settle();
  assert.equal(render().snapshot.project.path, "/a");
  assert.equal(render().snapshot.project.state.sessions[7].title, "Live update");
  assert.equal(render().error, "", "an old selection's failure cannot become the current Chat's error");
});

test("cached Chat revalidation drops a Chat removed on its computer", async () => {
  const update = deferred();
  let waiting = false;
  const render = sessionHost({
    url: "mac",
    call: async () => [],
    snapshot: async (path) =>
      waiting
        ? update.promise
        : {
            project: { path, state: { sessions: { 7: { id: 7 } } } },
            runs: { runs: {} },
          },
  });
  await render().connect({ address: "mac", token: "token" });
  await render().open("/a");
  await render().open("/b");
  waiting = true;
  render().openCachedChat("/a", 7);
  update.resolve(snapshot("/a"));
  await settle();
  assert.equal(render().snapshot.project.state.sessions[7], undefined);
  assert.match(render().error, /no longer available/);
  assert.equal(render().openCachedChat("/a", 7), null);
});

test("summary-only, missing and other-computer Chats do not qualify for cached navigation", async () => {
  const client = { url: "one", call: async () => [], snapshot: async (path) => snapshot(path) };
  const render = sessionHost(client, { clientFactory: (host) => (host.address === "one" ? client : { ...client, url: "two" }) });
  await render().connect({ address: "one", token: "token" });
  await render().open("/a");
  render().seedPreview(client, "/summary", { project: { path: "/summary", state: { sessions: { 7: { id: 7 } } } }, previewOnly: true });
  assert.equal(render().openCachedChat("/summary", 7), null);
  assert.equal(render().openCachedChat("/a", 7), null);
  assert.equal(render().openCachedChat("/a", 7, { address: "two", token: "token", name: "Two" }), null);
  assert.equal(render().snapshot.project.path, "/a");
});

test("notification navigation reconnects and opens the target Chat only after loading current state", async () => {
  const calls = [];
  const target = { project: { path: "/target", name: "Target", state: { sessions: { 7: { id: 7 } } } }, runs: { runs: {} } };
  const render = sessionHost({
    url: "https://mac.example",
    call: async (method, args) => {
      calls.push({ method, args });
      return method === "project:recent" ? [] : method === "project:open" ? { path: args[0] } : {};
    },
    snapshot: async () => target,
  });
  const opened = await render().openNotificationTarget({ address: "https://mac.example", token: "a".repeat(64), name: "Mac" }, "/target", 7);
  assert.equal(opened, true);
  assert.equal(render().snapshot.project.path, "/target");
  assert.equal(render().hostName, "Mac");
  assert.ok(calls.some((call) => call.method === "project:open" && call.args[0] === "/target"));
});

test("a later disconnect or navigation cancels an outstanding notification target", async () => {
  const loaded = deferred();
  const render = sessionHost({ url: "https://mac.example", call: async () => [], snapshot: () => loaded.promise });
  const opening = render().openNotificationTarget({ address: "https://mac.example", token: "a".repeat(64), name: "Mac" }, "/target", 7);
  await new Promise((resolve) => setTimeout(resolve, 1));
  render().cancelNavigation();
  loaded.resolve({ project: { path: "/target", state: { sessions: { 7: { id: 7 } } } } });
  assert.equal(await opening, false);
  assert.equal(render().client, null);
  assert.equal(render().snapshot, null);
});

test("notification navigation rejects a Chat that no longer exists", async () => {
  const render = sessionHost({ call: async () => [], snapshot: async () => snapshot("/target") });
  await assert.rejects(
    render().openNotificationTarget({ address: "https://mac.example", token: "a".repeat(64), name: "Mac" }, "/target", 7),
    /no longer available/,
  );
  assert.equal(render().client, null);
});

test("a cancelled notification target ignores a later network failure", async () => {
  const loaded = deferred();
  const render = sessionHost({ call: async () => [], snapshot: () => loaded.promise });
  const opening = render().openNotificationTarget({ address: "https://mac.example", token: "a".repeat(64), name: "Mac" }, "/target", 7);
  await new Promise((resolve) => setTimeout(resolve, 1));
  render().cancelNavigation();
  loaded.reject(new Error("Connection lost"));
  assert.equal(await opening, false);
});

// Router 58's stack reducer, the one the app's navigators run.
function expoRouters() {
  return require(require.resolve("expo-router/build/react-navigation/routers/index", { paths: [path.join(__dirname, "../apps/mobile")] }));
}

// Router 58 has no initial-state helper and rejects partial states, so tests seed a complete one.
function stackState(routeNames, routes) {
  return { stale: false, type: "stack", key: "root", index: routes.length - 1, routeKeySeq: 0, routeNames, routes, preloadedRoutes: [] };
}

function pushHost(t, initial = "index") {
  const react = hookHost();
  react.useEffect = react.effect;
  react.useLayoutEffect = react.effect;
  const { StackRouter, StackActions } = expoRouters();
  const stack = StackRouter({ initialRouteName: initial });
  const options = { routeNames: ["index", "projects", "project", "chat"], routeParamList: {}, routeGetIdList: {} };
  let navigation = stackState(options.routeNames, [{ key: `${initial}-root`, name: initial }]);
  let pathname = initial === "index" ? "/" : "/chat";
  let params = initial === "chat" ? { id: "1" } : {};
  const apply = (action) => {
    const result = stack.getStateForAction(navigation, action, options);
    // An unhandled action, like popping the last route, leaves the stack as it was.
    if (typeof result === "object") navigation = result.state;
  };
  const router = {
    dismissAll: () => apply(StackActions.popToTop()),
    replace: (route) => apply(StackActions.replace(route.pathname.slice(1), route.params)),
    dismissTo: (path) => apply(StackActions.popTo(path === "/" ? "index" : path.slice(1))),
    push: (route) => apply(StackActions.push(typeof route === "string" ? route.slice(1) : route.pathname.slice(1), route.params)),
  };
  let generation = 0,
    receive;
  const opening = deferred(),
    opens = [];
  const host = { id: "https://mac.example", address: "https://mac.example", token: "a".repeat(64), name: "Mac", lastUsed: 0 };
  const session = {
    booted: true,
    hosts: [host],
    snapshot: snapshot("/project"),
    client: { url: host.id },
    claimAutoOpen() {},
    cancelNavigation() {
      generation++;
    },
    navigationVersion: () => generation,
    openNotificationTarget: async (...args) => {
      const current = ++generation;
      opens.push(args);
      await opening.promise;
      return current === generation;
    },
  };
  const { usePushState } = load(
    "push.tsx",
    {
      react,
      "react/jsx-runtime": { jsx },
      "react-native": { Alert: { alert() {} }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
      "expo-router": { router, usePathname: () => pathname, useGlobalSearchParams: () => params },
      "./client": {},
      "./relay-native": { relayRuntime: {} },
      "./routes-native": routesNative(),
      "./hosts-native": { savedHosts: { list: async () => [host] } },
      "./session": { useSession: () => session },
      "./push-controller": require("../apps/mobile/src/push-controller.ts"),
      "./live-activity-native": { nativeActivity: null },
      "./push-native": {
        pushStore: { read: async () => ({ enabled: false, pending: [] }) },
        pushNative: {
          available: () => "Simulator",
          listen: async (_view, tap) => {
            receive = tap;
            return () => {};
          },
        },
      },
    },
    "\nexport { usePushState };",
  );
  const render = () => {
    react.begin();
    const value = usePushState();
    react.flush();
    return value;
  };
  t.after(() => react.cleanup());
  render();
  return {
    render,
    opens,
    opening,
    tap: (eventId = "event") => {
      receive({ kind: "milagre-chat", hostId: host.id, projectPath: "/project", sessionId: 2, eventId });
      render();
    },
    switchChat: (id, projectPath, hostId) => {
      params = { id, projectPath, hostId };
      pathname = "/chat";
      render();
    },
    routes: () => navigation.routes,
    back: () => apply({ type: "GO_BACK" }),
    pair: () => {
      const current = ++generation;
      pathname = "/pair";
      params = {};
      render();
      return current === generation;
    },
  };
}

test("a same-screen Chat switch cancels a slow notification target", async (t) => {
  const screen = pushHost(t, "chat");
  screen.tap();
  await settle();
  screen.switchChat("3");
  screen.opening.resolve();
  await settle();
  assert.equal(screen.routes()[0].name, "chat");
  assert.equal(screen.routes()[0].params, undefined);
});

test("switching Projects with the same Chat id cancels a slow notification target", async (t) => {
  const screen = pushHost(t, "chat");
  screen.tap();
  await settle();
  screen.switchChat("1", "/another-project", "https://mac.example");
  screen.opening.resolve();
  await settle();
  assert.equal(screen.routes()[0].params, undefined);
});

test("a cold-start notification opens the target directly without setup screens", async (t) => {
  const screen = pushHost(t);
  screen.tap();
  await settle();
  screen.opening.resolve();
  await settle();
  assert.deepEqual(
    screen.routes().map((route) => route.name),
    ["chat"],
  );
  assert.equal(screen.routes()[0].params.projectPath, "/project");
  assert.equal(screen.routes()[0].params.hostId, "https://mac.example");
});

test("duplicate in-flight taps share one opening and a later tap can open again", async (t) => {
  const screen = pushHost(t);
  screen.tap();
  await settle();
  screen.tap();
  await settle();
  assert.equal(screen.opens.length, 1);
  screen.opening.resolve();
  await settle();
  assert.equal(screen.routes().at(-1).name, "chat");
  screen.tap();
  await settle();
  assert.equal(screen.opens.length, 2);
});

test("route changes preserve a newer normal pairing while cancelling notification work", async (t) => {
  const screen = pushHost(t);
  assert.equal(screen.pair(), true);
  screen.tap();
  await settle();
  assert.equal(screen.pair(), true);
  screen.opening.resolve();
  await settle();
  assert.equal(screen.routes().at(-1).name, "index");
});

test("a notification target clears an older Project loading state", async () => {
  const oldOpening = deferred();
  const render = sessionHost({
    call: async (method, args) =>
      method === "project:recent" ? [] : method === "project:open" ? (args[0] === "/old" ? oldOpening.promise : { path: args[0] }) : {},
    snapshot: async (projectPath) => ({ ...snapshot(projectPath), project: { path: projectPath, state: { sessions: { 2: { id: 2 } } } } }),
  });
  await render().connect({ address: "address", token: "token" });
  const old = render().open("/old");
  assert.equal(render().opening.path, "/old");
  await render().openNotificationTarget({ address: "new", token: "new", name: "Mac" }, "/target", 2);
  oldOpening.resolve({ path: "/old" });
  await old;
  assert.equal(render().snapshot.project.path, "/target");
  assert.equal(render().opening, null);
});

// Render the real activity adapters, disclosure and shimmer against native leaves.
function activityItemHost({ expandReasoning = false, effects = false, active = true, reduced = false, permissionQuery } = {}) {
  const hosts = new Map();
  const animations = [];
  let motionListener;
  let current;
  const react = Object.fromEntries(["useState", "useRef", "useMemo", "useEffect"].map((name) => [name, (...args) => current[name](...args)]));
  react.memo = (fn) => fn;
  const palette = {
    ink: "#fff",
    ink2: "#aaa",
    ink3: "#666",
    field: "#222",
    red: "#f00",
    orange: "#f80",
  };
  const native = {
    Text: "Text",
    View: "View",
    Pressable: "Pressable",
    useColorScheme: () => "dark",
    AccessibilityInfo: {
      isReduceMotionEnabled: permissionQuery ?? (async () => reduced),
      addEventListener: (_name, listener) => {
        motionListener = listener;
        return {
          remove: () => {
            motionListener = null;
          },
        };
      },
    },
    StyleSheet: { create: (value) => value, absoluteFill: {} },
    Animated: {
      Value: class {
        setValue(value) {
          this.value = value;
        }
        interpolate(config) {
          return { ...config, value: this };
        }
      },
      View: "AnimatedView",
      modulo: (value, divisor) => ({ value, divisor }),
      loop: (animation) => Object.assign(animation, { looped: true }),
      timing: (value, config) => {
        const animation = {
          value,
          config,
          start() {},
          stopped: false,
          stop() {
            this.stopped = true;
          },
        };
        animations.push(animation);
        return animation;
      },
    },
    Easing: { bezier: () => () => {}, linear() {} },
  };
  const icons = new Proxy({}, { get: (_, key) => key });
  const common = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": native,
    "@hugeicons/core-free-icons": icons,
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "./display-clock": { useScreenActive: () => active, useDisplayValue: (_interval, compute) => compute(Date.now()) },
    "./icons": { Icon: "Icon", SpinnerRing: "SpinnerRing" },
    "./ui": {
      colors: palette,
      styles: { code: {}, caption: {}, label: {}, muted: {} },
      PageScroll: "ScrollView",
    },
  };
  const running = load("running-logo.tsx", {
    ...common,
    "react-native-svg": { default: "Svg", Path: "Path" },
    "@react-native-masked-view/masked-view": {
      __esModule: true,
      default: "MaskedView",
    },
    "expo-linear-gradient": { LinearGradient: "LinearGradient" },
    "expo-router": { useIsFocused: () => false },
    "./logo": { LEFT: "", RIGHT: "", STAR: "", STAR_BOX: {} },
    "./theme": { useTheme: () => ({ colors: palette, motionScale: 1 }), fonts: { mono: "mono" } },
  });
  const shared = load("activity-item.tsx", {
    ...common,
    "./running-logo": running,
    "./theme": { useTheme: () => ({ colors: palette, motionScale: 1 }), fonts: { mono: "mono" } },
  });
  const ToolRow = load("tool-row.tsx", {
    ...common,
    "./activity-item": shared,
    "./chat-display-setting": { useExpandReasoning: () => [expandReasoning, () => {}] },
    "./markdown": { Markdown: ({ text }) => jsx("Text", { children: text }) },
  }).ToolRow;
  function visit(node, key) {
    if (Array.isArray(node)) return node.map((child, index) => visit(child, `${key}.${child?.props?.id || index}`));
    if (!node || typeof node !== "object" || !node.type) return node;
    if (typeof node.type === "function") {
      current = hosts.get(key) || hookHost({ effects });
      hosts.set(key, current);
      current.begin();
      return visit(node.type(node.props), `${key}.render`);
    }
    return {
      ...node,
      props: {
        ...node.props,
        children: visit(node.props?.children, `${key}.children`),
      },
    };
  }
  return {
    tool: (props) => visit(jsx(ToolRow, props), "tool"),
    title: (props) => visit(jsx(shared.ActivityTitle, props), "title"),
    animations,
    reduce(value) {
      reduced = value;
      motionListener?.(value);
    },
    activate(value) {
      active = value;
    },
    unmount() {
      for (const host of hosts.values()) host.unmount();
    },
  };
}

test("phone titles sweep in one native loop for the whole run and finish with normal chips", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const host = activityItemHost({ effects: true });
  t.after(() => host.unmount());
  const props = { title: "Ran `check`", shimmer: true };
  host.title(props);
  await Promise.resolve();
  assert.ok(find(host.title(props), (node) => node.type === "MaskedView"));
  const animation = host.animations.at(-1);
  assert.equal(animation.looped, true);
  assert.equal(animation.config.toValue, 320);
  assert.equal(animation.config.duration, 1200);
  assert.equal(animation.config.useNativeDriver, true);
  assert.equal(animation.config.isInteraction, false);
  t.mock.timers.tick(60_000);
  assert.ok(
    find(host.title(props), (node) => node.type === "MaskedView"),
    "a long call keeps sweeping",
  );
  assert.equal(host.animations.length, 1, "renders do not restart the loop");
  const finished = host.title({ ...props, shimmer: false });
  assert.equal(
    find(finished, (node) => node.type === "MaskedView"),
    undefined,
  );
  assert.equal(find(finished, (node) => node.type === "Text" && node.props.children === "check").props.style.color, "#fff");
});

test("phone reduced motion and inactive screens keep running titles static with running ink", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const host = activityItemHost({ effects: true });
  t.after(() => host.unmount());
  const props = { title: "Ran `check`", shimmer: true };
  host.title(props);
  await Promise.resolve();
  assert.ok(find(host.title(props), (node) => node.type === "MaskedView"));
  host.reduce(true);
  const reduced = host.title(props);
  assert.equal(
    find(reduced, (node) => node.type === "MaskedView"),
    undefined,
  );
  const chip = find(reduced, (node) => node.type === "Text" && node.props.children === "check");
  assert.equal(chip.props.style.color, "#666");
  assert.equal(chip.props.style.backgroundColor, "#222");
  host.reduce(false);
  assert.ok(find(host.title(props), (node) => node.type === "MaskedView"));
  host.activate(false);
  assert.equal(
    find(host.title(props), (node) => node.type === "MaskedView"),
    undefined,
  );
});
test("phone reactivation waits for fresh reduced-motion permission, including a failed query", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  for (const reject of [false, true]) {
    const pending = deferred();
    let calls = 0;
    const host = activityItemHost({ effects: true, permissionQuery: () => (++calls === 1 ? Promise.resolve(false) : pending.promise) });
    const props = { title: "Ran `check`", shimmer: true };
    host.title(props);
    await Promise.resolve();
    assert.ok(find(host.title(props), (node) => node.type === "MaskedView"));
    host.activate(false);
    host.title(props);
    host.activate(true);
    assert.equal(
      find(host.title(props), (node) => node.type === "MaskedView"),
      undefined,
      "pending permission is conservative on every activation",
    );
    if (reject) pending.reject(new Error("Unavailable"));
    else pending.resolve(true);
    await Promise.resolve();
    assert.equal(
      find(host.title(props), (node) => node.type === "MaskedView"),
      undefined,
    );
    assert.equal(host.animations.length, 1, "reactivation did not start another native animation");
    host.unmount();
  }
});

test("Always expand reasoning opens thinking rows in Activity until tapped, and leaves other tools folded", () => {
  const thinking = {
    step: { id: "t", kind: "thinking", title: "Thought for 4s", status: "done", detail: "Weighing the two fixes." },
    live: false,
    waiting: false,
  };
  const shell = { step: { id: "s", kind: "shell", title: "Ran `npm test`", status: "done", detail: "51 tests passed" }, live: false, waiting: false };
  const shows = (tree, text) => !!find(tree, (node) => node.type === "Text" && node.props.children === text);
  assert.equal(shows(activityItemHost().tool(thinking), "Weighing the two fixes."), false, "off: thinking starts folded");
  const item = activityItemHost({ expandReasoning: true });
  let tree = item.tool(thinking);
  assert.ok(shows(tree, "Weighing the two fixes."), "on: thinking starts open");
  find(tree, (node) => node.props?.accessibilityRole === "button").props.onPress();
  assert.equal(shows(item.tool(thinking), "Weighing the two fixes."), false, "a tap still folds it");
  assert.equal(shows(activityItemHost({ expandReasoning: true }).tool(shell), "51 tests passed"), false, "other tools stay folded");
});

test("tool disclosure reveals late output, while its chat action opens Activity without expanding", () => {
  const item = activityItemHost();
  const props = { step: { id: "s", kind: "shell", title: "Ran `npm test`", status: "running", hasDetail: true }, live: false, waiting: false };
  let tree = item.tool(props);
  find(tree, (node) => node.props?.accessibilityRole === "button").props.onPress();
  assert.ok(find(item.tool(props), (node) => node.type === "Text" && node.props.children === "Loading output…"));
  tree = item.tool({ ...props, step: { ...props.step, detail: "51 tests passed", status: "done" }, live: false });
  assert.ok(find(tree, (node) => node.type === "Text" && node.props.children === "51 tests passed"));
  assert.equal(
    find(tree, (node) => node.type === "MaskedView"),
    undefined,
  );
  let opened = 0;
  const navigated = activityItemHost();
  tree = navigated.tool({
    ...props,
    step: { ...props.step, detail: "Tool output" },
    onPress: () => {
      opened++;
    },
  });
  find(tree, (node) => node.props?.accessibilityRole === "button").props.onPress();
  assert.equal(opened, 1);
  assert.equal(
    find(navigated.tool({ ...props, onPress: () => {} }), (node) => node.type === "ScrollView"),
    undefined,
  );
});

function updatesHost() {
  const react = hookHost();
  const listeners = new Set();
  const state = { status: "idle", error: "" };
  const appState = {
    currentState: "active",
    addEventListener: (_, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  let reloads = 0,
    retries = 0,
    notes = 0;
  const { UpdateSheet, useUpdatePresentation, UpdateSettingsBadge } = load("update-sheet.tsx", {
    react: { ...react, useEffect: react.effect, useSyncExternalStore: (_, get) => get(), useContext: () => ({ state }) },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text", Modal: "Modal", ActivityIndicator: "ActivityIndicator", useColorScheme: () => "dark", AppState: appState },
    "expo-router": {},
    "expo-updates": {},
    "@hugeicons/core-free-icons": { Cancel01Icon: "close" },
    "./update-controller": {},
    "./theme": { colors: {}, hex: () => ({ page: "#17181a" }) },
    "./ui": { PillButton: "PillButton", IconButton: "IconButton" },
  });
  return {
    set(status, error = "", updateId = state.updateId) {
      state.updateId = updateId;
      state.status = status;
      state.error = error;
    },
    render() {
      react.begin();
      useUpdatePresentation(state);
      react.flush();
      react.begin();
      useUpdatePresentation(state);
      react.begin();
      const presentation = useUpdatePresentation(state);
      const content = UpdateSheet({
        state,
        onUpdate: () => {
          reloads++;
        },
        onRetry: () => {
          retries++;
        },
        onDismiss: presentation.dismiss,
        onNotes: () => {
          notes++;
        },
      });
      return { ...presentation, content, badge: UpdateSettingsBadge() };
    },
    foreground() {
      appState.currentState = "active";
      for (const listener of listeners) listener("active");
    },
    background() {
      appState.currentState = "background";
      for (const listener of listeners) listener("background");
    },
    cleanup: react.cleanup,
    listeners,
    reloads: () => reloads,
    retries: () => retries,
    notes: () => notes,
  };
}

test("the update sheet opens only for an actionable update and dismissal survives foreground entry", () => {
  const host = updatesHost();
  for (const status of ["idle", "checking", "downloading", "up-to-date", "disabled"]) {
    host.set(status);
    assert.equal(host.render().presented, false, status);
  }
  host.set("ready");
  const ready = host.render();
  assert.equal(ready.presented, true);
  find(ready.content, (node) => node.type === "IconButton" && node.props.label === "Dismiss update").props.onPress();
  assert.equal(host.render().presented, false);
  host.background();
  assert.equal(host.render().presented, false);
  host.foreground();
  assert.equal(host.render().presented, false);
  host.render().dismiss();
  assert.equal(host.render().presented, false, "swipe dismissal behaves like the close button");
  assert.equal(host.reloads(), 0);
  host.cleanup();
  assert.equal(host.listeners.size, 0);
});

test("closing the update keeps a Settings dot and only a newer update prompts again", () => {
  const host = updatesHost();
  host.set("ready", "", "first");
  const ready = host.render();
  find(ready.content, (node) => node.type === "PillButton" && node.props.title === "What's new").props.onPress();
  assert.equal(host.notes(), 1);
  find(ready.content, (node) => node.type === "IconButton" && node.props.label === "Dismiss update").props.onPress();
  assert.equal(host.render().presented, false);
  assert.ok(host.render().badge);
  host.set("downloading");
  host.set("ready", "", "first");
  assert.equal(host.render().presented, false);
  host.set("ready", "", "second");
  assert.equal(host.render().presented, true);
  host.set("up-to-date");
  assert.equal(host.render().badge, null);
  host.cleanup();
});

test("an update downloaded in the background waits until foreground entry to present", () => {
  const host = updatesHost();
  host.render();
  host.background();
  host.set("ready");
  assert.equal(host.render().presented, false);
  host.foreground();
  assert.equal(host.render().presented, true);
  host.cleanup();
});

test("Closing during retry stays dismissed when the download finishes or polling fails", () => {
  for (const final of ["ready", "error"]) {
    const host = updatesHost();
    host.set("error");
    host.render();
    host.set("downloading");
    find(host.render().content, (node) => node.type === "IconButton" && node.props.label === "Dismiss update").props.onPress();
    host.set(final);
    assert.equal(host.render().presented, false);
    host.foreground();
    assert.equal(host.render().presented, false);
    host.cleanup();
  }
});

test("sheet actions apply or retry, keep progress visible, and recover from reload errors", () => {
  const host = updatesHost();
  host.set("error", "Could not download the update. Try again.");
  assert.equal(host.render().presented, true);
  find(host.render().content, (node) => node.type === "PillButton" && node.props.title === "Try again").props.onPress();
  assert.equal(host.retries(), 1);
  for (const status of ["checking", "downloading"]) {
    host.set(status);
    const progress = host.render();
    assert.equal(progress.presented, true);
    assert.ok(find(progress.content, (node) => node.type === "ActivityIndicator"));
    assert.equal(
      find(progress.content, (node) => node.type === "PillButton" && node.props.title === "Try again"),
      undefined,
    );
  }
  host.set("ready");
  find(host.render().content, (node) => node.type === "PillButton" && node.props.title === "Update now").props.onPress();
  assert.equal(host.reloads(), 1);
  host.set("restarting");
  assert.ok(find(host.render().content, (node) => node.type === "ActivityIndicator"));
  assert.equal(
    find(host.render().content, (node) => node.type === "PillButton"),
    undefined,
  );
  host.set("ready", "Could not apply the update. Try again.");
  const failed = host.render();
  assert.ok(find(failed.content, (node) => node.props?.accessibilityRole === "alert"));
  find(failed.content, (node) => node.type === "PillButton" && node.props.title === "Try again").props.onPress();
  assert.equal(host.reloads(), 2);
  assert.equal(host.retries(), 1, "a reload failure must retry the downloaded update");
  host.cleanup();
});

test("the global shell waits for navigation, pushes once, and preserves each current page", () => {
  const react = hookHost();
  let created = 0,
    navigation;
  const routes = [],
    resets = [];
  let latestTree;
  let navigationListener;
  const navigationRef = {
    getRootState: () => ({ key: "generated-root", routes: [{ name: "__root", state: navigation }] }),
    addListener: (_, listener) => {
      navigationListener = listener;
      return () => {
        navigationListener = undefined;
      };
    },
    dispatch: (action) => {
      assert.equal(action.target, "root");
      const result = stack.getStateForAction(navigation, action, { routeNames: navigation.routeNames, routeParamList: {}, routeGetIdList: {} });
      assert.equal(typeof result, "object", "Router accepts the reset as a complete navigation state");
      resets.push(action.payload);
      navigation = result.state;
    },
  };
  const stack = expoRouters().StackRouter({ initialRouteName: "index" });
  const state = { status: "ready", error: "" };
  const shell = load(
    "update-sheet.tsx",
    {
      react: { ...react, useEffect: react.effect, createContext: () => ({ Provider: "UpdatesProvider" }), useSyncExternalStore: (_, get) => get() },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
      "expo-router": {
        router: { push: (route) => routes.push(route) },
        useRootNavigationState: () => navigation,
        useNavigationContainerRef: () => navigationRef,
      },
      "expo-updates": { isEnabled: true, useUpdates: () => ({}) },
      "@hugeicons/core-free-icons": { Cancel01Icon: "close" },
      "./update-controller": {
        watchUpdates: () => () => {},
        createUpdateController: () => {
          created++;
          return { subscribe() {}, get: () => state, install() {}, check() {}, syncNative() {} };
        },
      },
      "./theme": { colors: {} },
      "./ui": {},
    },
    "\nconst __DEV__ = false;",
  ).UpdateShell;
  for (const page of ["Computers", "Chat", "Settings"]) {
    react.begin();
    const navigator = jsx("Stack", { page });
    const tree = (latestTree = shell({ children: navigator }));
    assert.equal(tree.props.children, navigator);
    assert.equal(tree.props.value.state, state);
    react.flush();
    if (!navigation) {
      assert.deepEqual(routes, []);
      navigation = stackState(["index", "update-sheet", "projects"], [{ key: "computers", name: "index" }]);
      navigationListener();
    }
  }
  assert.equal(created, 1, "navigation keeps one update controller");
  assert.deepEqual(routes, ["/update-sheet"], "pending updates push one sheet above the current route");
  const updateRoute = { key: "pending-update", name: "update-sheet" };
  const destination = { key: "connected-projects", name: "projects", params: { host: "saved" } };
  navigation = { ...navigation, index: 2, routes: [...navigation.routes, updateRoute, destination] };
  navigationListener();
  react.begin();
  shell({ children: jsx("Stack", {}) });
  react.flush();
  assert.equal(resets.length, 1);
  assert.equal(navigation.index, 2);
  assert.equal(navigation.routes[1].key, destination.key, "late navigation retains the destination");
  assert.deepEqual(navigation.routes[1].params, destination.params, "and its params");
  assert.equal(navigation.routes[2].name, "update-sheet");
  assert.ok(navigation.routes[2].key, "Router keys the moved prompt");
  assert.equal(navigation.routes.filter((route) => route.name === "update-sheet").length, 1, "late navigation retains one prompt");
  react.begin();
  shell({ children: jsx("Stack", {}) });
  react.flush();
  navigationListener();
  assert.equal(resets.length, 1, "the focused sheet does not reset navigation again");
  navigation = { ...navigation, index: 0, routes: [navigation.routes[0]] };
  navigationListener();
  assert.equal(routes.length, 2, "a notification reset restores the pending prompt");
  latestTree.props.value.dismiss();
  navigationListener();
  assert.equal(routes.length, 2, "explicit dismissal stops navigation from reopening the prompt");
  react.cleanup();
  assert.equal(navigationListener, undefined);
});

test("Close, swipe and Android back defer; notification reset and route replacement do not", async () => {
  const react = hookHost();
  let dismissals = 0,
    backs = 0,
    event,
    removed;
  const dismiss = () => {
    dismissals++;
  };
  const navigation = {
    addListener: (name, listener) => {
      event = name;
      removed = listener;
      return () => {
        removed = undefined;
      };
    },
  };
  const state = { status: "ready", error: "" };
  const route = load("app/update-sheet.tsx", {
    react: { ...react, useEffect: react.effect },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": {
      router: {
        back: () => {
          backs++;
        },
      },
      useNavigation: () => navigation,
    },
    "../update-sheet": { UpdateSheet: "UpdateSheet", useAppUpdates: () => ({ state, check() {}, install() {}, dismiss }) },
  }).default;
  react.begin();
  const tree = route();
  react.flush();
  assert.equal(event, "removed");
  for (const type of ["RESET", "POP_TO"]) removed({ data: { action: { type } } });
  assert.equal(dismissals, 0, "programmatic navigation keeps the prompt pending");
  for (const type of ["GO_BACK", "POP"]) removed({ data: { action: { type } } });
  assert.equal(dismissals, 2);
  tree.props.onDismiss();
  assert.equal(backs, 1);
  assert.equal(dismissals, 3, "Close defers before removing its route");
  state.status = "restarting";
  react.begin();
  route();
  react.flush();
  assert.equal(dismissals, 3);
  react.cleanup();
  assert.equal(dismissals, 3, "replacing a native sheet route does not defer the prompt");
  // Router 58 reports the removal after the screen's effect cleanup, so the listener outlives it by a microtask.
  removed({ data: { action: { type: "POP" } } });
  assert.equal(dismissals, 4, "a swipe reported after unmount still defers");
  await Promise.resolve();
  assert.equal(removed, undefined);
});

test("a live turn's step whose output the phone left out does not expand, while saved and clipped steps do", () => {
  const pending = "Output appears when the turn finishes.";
  const note = (tree) => find(tree, (node) => node.type === "Text" && node.props.children === pending);
  const button = (tree) => find(tree, (node) => node.props?.accessibilityRole === "button");
  const step = { id: "s", kind: "shell", title: "Ran `npm test`", status: "done", hasDetail: true };
  // Live and slimmed: a muted line, no disclosure, and nothing that loads.
  const item = activityItemHost();
  let tree = item.tool({ step, live: true, waiting: false });
  assert.ok(note(tree));
  assert.equal(button(tree), undefined, "not expandable");
  assert.equal(
    find(tree, (node) => node.type === "Text" && node.props.children === "Loading output…"),
    undefined,
  );
  // In the chat the row opens Activity, which says it, so the chat row stays as it was.
  const chat = activityItemHost().tool({ step, live: true, waiting: false, onPress: () => {} });
  assert.equal(note(chat), undefined);
  // Live with its clipped tail kept: expands and shows it.
  const kept = activityItemHost();
  tree = kept.tool({ step: { ...step, hasDetail: undefined, detail: "…tail of the log" }, live: true, waiting: false });
  assert.equal(note(tree), undefined);
  button(tree).props.onPress();
  assert.ok(
    find(
      kept.tool({ step: { ...step, hasDetail: undefined, detail: "…tail of the log" }, live: true, waiting: false }),
      (node) => node.type === "Text" && node.props.children === "…tail of the log",
    ),
  );
  // Saved message: hasDetail still means "fetch", shown as loading while it does.
  const saved = activityItemHost();
  tree = saved.tool({ step, live: false, waiting: false });
  assert.equal(note(tree), undefined);
  button(tree).props.onPress();
  assert.ok(find(saved.tool({ step, live: false, waiting: false }), (node) => node.type === "Text" && node.props.children === "Loading output…"));
});

test("relay transports: one per Mac, replaced by a new code, closed in the background and on forget", async () => {
  const listeners = [],
    made = [];
  const identity = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
  const phoneRandom = (n) => new Uint8Array(n);
  const { relayRuntime } = load("relay-native.ts", {
    "expo-crypto": { randomUUID: require("node:crypto").randomUUID },
    "react-native": {
      AppState: {
        addEventListener: (_event, listener) => {
          listeners.push(listener);
          return { remove() {} };
        },
      },
    },
    // oxlint-disable-next-line typescript/no-extraneous-class -- empty classes stub expo-file-system constructors in the test
    "expo-file-system": { Directory: class {}, File: class {}, Paths: {} },
    "./relay-transport": {
      createRelayTransport: (options) => {
        const transport = {
          options,
          closed: 0,
          close() {
            transport.closed++;
          },
        };
        made.push(transport);
        return transport;
      },
    },
    "./phone-identity": { phoneIdentity: async () => identity, phoneRandom },
    "./phone-name-native": { phoneName: "Victor's iPhone" },
    "./routes-native": routesNative(),
  });
  const link = (hostId, key = "K".repeat(43)) => ({ url: "wss://relay.milagre.cloud", hostId, key });
  const a = await relayRuntime.transport({ relay: link("A".repeat(22)), token: "a".repeat(64) });
  assert.equal(await relayRuntime.transport({ relay: link("A".repeat(22)), token: "a".repeat(64) }), a, "one transport per Mac");
  assert.equal(a.options.identity, identity);
  assert.equal(a.options.random, phoneRandom);
  assert.equal(a.options.name, "Victor's iPhone");
  assert.equal(a.options.hostId, "A".repeat(22));
  const b = await relayRuntime.transport({ relay: link("B".repeat(22)), token: "a".repeat(64) });
  assert.notEqual(b, a);
  // A new pairing code for the same Mac replaces its transport.
  const a2 = await relayRuntime.transport({ relay: link("A".repeat(22)), token: "c".repeat(64) });
  assert.notEqual(a2, a);
  assert.equal(a.closed, 1);
  // The background closes every open transport; they stay in place to reopen on the next request.
  for (const listener of listeners) listener("inactive");
  assert.deepEqual([a2.closed, b.closed], [0, 0]);
  for (const listener of listeners) listener("background");
  assert.deepEqual([a2.closed, b.closed], [1, 1]);
  assert.equal(await relayRuntime.transport({ relay: link("B".repeat(22)), token: "a".repeat(64) }), b);
  // Forget closes the transport and drops it: the next use builds a new one.
  relayRuntime.forget("B".repeat(22));
  assert.equal(b.closed, 2);
  const b2 = await relayRuntime.transport({ relay: link("B".repeat(22)), token: "a".repeat(64) });
  assert.notEqual(b2, b);
  relayRuntime.forget("nobody");
  for (const listener of listeners) listener("background");
  assert.equal(b.closed, 2, "a forgotten transport is not closed again");
});

test("refreshing saved hosts during startup cannot cancel the claimed auto-open", async () => {
  const react = hookHost();
  react.useEffect = react.effect;
  const host = { id: "mac", address: "mac", name: "Mac", token: "token" };
  const opened = [],
    routes = [];
  let claimed = false;
  const session = {
    booted: true,
    hosts: [host],
    lastLocation: { hostId: "mac", projectPath: "/p", chatId: 1 },
    client: null,
    loadHosts: async () => [host],
    connect: async (value) => {
      opened.push(value.id);
      return true;
    },
    claimAutoOpen: () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    navigationVersion: () => 0,
  };
  const { default: Screen } = load("app/index.tsx", {
    "../update-sheet": { UpdateSettingsBadge: "UpdateSettingsBadge", useAppUpdates: () => ({ state: { status: "idle" } }) },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Alert: {},
      Platform: { OS: "ios" },
      RefreshControl: "RefreshControl",
      Text: "Text",
      View: "View",
    },
    "expo-router": {
      Stack: {
        Screen: "Screen",
        Toolbar: Object.assign(() => null, {
          Button: "Button",
          Spacer: "Spacer",
        }),
      },
      router: { replace: (route) => routes.push(route) },
      useFocusEffect() {},
    },
    "@hugeicons/core-free-icons": {},
    "react-native-safe-area-context": {
      useSafeAreaInsets: () => ({ bottom: 0 }),
      useSafeAreaFrame: () => ({ height: 844 }),
    },
    "../session": { useSession: () => session },
    "../push": { usePush: () => ({}) },
    "../computer-actions": { forgetComputer() {}, renameComputer() {}, pingComputer: async () => "online", isDesktopComputer: () => false },
    "../routes-native": routesNative(),
    "../icons": { Icon: "Icon" },
    "../ui": {
      colors: {},
      styles: {},
      ErrorNotice: "ErrorNotice",
      ListRow: "ListRow",
      PageScroll: "PageScroll",
    },
  });
  react.begin();
  Screen();
  react.flush();
  session.hosts = [...session.hosts];
  react.begin();
  Screen();
  react.flush();
  await settle();
  assert.deepEqual(opened, ["mac"]);
  assert.equal(routes[0].pathname, "/projects");
  assert.equal(routes[0].params.resume, "1");
  react.cleanup();
});

test("first send immediately shows input and a running Chat in the drawer before uploads or setup finish", async () => {
  const upload = deferred(),
    creating = deferred();
  const screen = chatHost({ effects: true, call: (method) => (method === "project:branches" ? Promise.resolve(["main"]) : creating.promise) });
  screen.session.client.upload = () => upload.promise;
  screen.session.attachments["/p#new:1"] = [{ id: "file", name: "notes.txt", uri: "file:///phone/notes.txt", base64: "Zm9v" }];
  find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Choose isolation").props.onSelect("worktree");
  await settle();
  screen.send();
  assert.equal(screen.field().value, "", "clear the composer before the first await");
  const reply = find(screen.render(), (node) => node.type === "ChatReply" && node.props.message?.role === "user");
  assert.equal(reply.props.message.body, "first message");
  assert.deepEqual(Array.from(reply.props.message.files), ["notes.txt"]);
  assert.ok(find(screen.render(), (node) => node.type === "ThinkingIndicator"));
  const nav = navigationHost(Promise.resolve(), { session: { ...screen.session, recent: [{ path: "/p" }] } });
  const row = nav.rows().props.data.find((row) => row.kind === "chat");
  assert.equal(row.chat.title, "first message");
  assert.equal(row.mark, "running");
  nav.open(nav.row("chat")).props.onPress();
  assert.equal(nav.routes[0].params.worktreeId, "1");
  assert.equal(nav.routes[0].params.id, undefined, "a preview never opens a negative host Chat id");
  screen.field().onChangeText("next draft");
  upload.resolve({ path: "/p/notes.txt" });
  await settle();
  assert.equal(screen.calls.filter((call) => call.method === "worktree:create").length, 1);
  creating.reject(new Error("Setup failed"));
  await settle();
  assert.equal(screen.field().value, "first message\n\nnext draft");
  assert.equal(screen.session.attachments["/p#new:1"][0].id, "file");
  nav.session.pendingChats = screen.session.pendingChats;
  assert.equal(nav.rows().props.data.filter((row) => row.kind === "chat").length, 0, "failed preparation removes its drawer preview");
});

test("canonical mobile input replaces the preview before acknowledgement and keeps the next draft", async () => {
  const sending = deferred();
  const screen = chatHost({ effects: true, call: (method) => (method === "project:branches" ? Promise.resolve(["main"]) : sending.promise) });
  screen.send();
  await settle();
  screen.field().onChangeText("next draft");
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  const state = screen.session.snapshot.project.state;
  state.sessions[7] = { id: 7, worktree_id: 1, agent_name: "main", title: "first message", status: "Created" };
  state.messages = [{ id: 8, session_id: 7, role: "user", body: "first message", context: null, clientMessageId: request.clientMessageId }];
  const nav = navigationHost(Promise.resolve(), { session: { ...screen.session, recent: [{ path: "/p" }] } });
  assert.equal(nav.rows().props.data.filter((row) => row.kind === "chat").length, 1);
  assert.equal(nav.rows().props.data.find((row) => row.kind === "chat").chat.id, 7);
  assert.equal(find(screen.render(), (node) => node.type === "ChatReply" && node.props.message?.role === "user").props.message.id, 8);
  sending.resolve({ sessionId: 7 });
  await settle();
  assert.equal(screen.params.id, "7");
  assert.equal(screen.field().value, "next draft");
});

test("mobile keeps an acknowledged Chat preview until its own host snapshot contains the input", () => {
  const { createPendingChat } = require("@milagre/shared/chats");
  const state = { next_id: 4, projects: {}, worktrees: {}, sessions: {}, messages: [], tasks: {} };
  const preview = createPendingChat({ state, worktreeId: 1, body: "Hello", provider: "codex", model: "m" });
  const provider = sessionHost({});
  const props = { hostId: "mac", snapshot: { project: { path: "/p", state } } };
  provider.pending(props).setPendingChats(() => ({ first: { preview, hostId: "mac", projectPath: "/p", accepted: false } }));
  const saved = { ...state, messages: [{ ...preview.message, id: 8, session_id: 7 }] };
  const updated = { ...props, snapshot: { project: { path: "/p", state: saved } } };
  assert.ok(provider.pending(updated).pendingChats.first, "live input alone cannot release a send still awaiting acknowledgement");
  provider.pending(updated).setPendingChats((current) => ({ first: { ...current.first, accepted: true } }));
  assert.ok(provider.pending({ ...updated, hostId: "other" }).pendingChats.first, "another host cannot retire the preview");
  assert.ok(provider.pending(props).pendingChats.first, "acknowledgement alone keeps the preview while the snapshot catches up");
  assert.ok(provider.pending(updated).pendingChats.first, "a returning origin route still needs to adopt its saved Chat");
  provider.pending(updated).setPendingChats((current) => ({ first: { ...current.first, promoted: true } }));
  provider.pending(updated);
  assert.equal(provider.pending(updated).pendingChats.first, undefined);
});

test("reopening a pending mobile Chat adopts its saved id before the preview retires", async () => {
  const sending = deferred();
  const screen = chatHost({ effects: true, call: (method) => (method === "project:branches" ? Promise.resolve(["main"]) : sending.promise) });
  screen.send();
  await settle();
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  const state = screen.session.snapshot.project.state;
  state.sessions[2] = { id: 2, worktree_id: 1, provider: "codex", status: "Created" };
  screen.params.id = "2";
  screen.render();
  delete screen.params.id;
  screen.render();
  state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex", status: "Created" };
  state.messages = [{ id: 8, session_id: 7, role: "user", body: "first message", context: null, clientMessageId: request.clientMessageId }];
  sending.resolve({ sessionId: 7 });
  await settle();
  screen.render();
  assert.equal(screen.params.id, "7", "the focused screen adopts its own pending Chat after returning");
  screen.session.pendingChats = {};
  assert.equal(find(screen.render(), (node) => node.type === "ChatReply" && node.props.message?.role === "user").props.message.id, 8);
});

test("an accepted preview cannot assign its Chat id to a different requested Project while that Project loads", () => {
  const screen = chatHost({ effects: true });
  screen.session.open = async () => null;
  const { createPendingChat } = require("@milagre/shared/chats");
  const preview = createPendingChat({ state: screen.session.snapshot.project.state, worktreeId: 1, body: "Hello", provider: "codex", model: "m" });
  screen.session.pendingChats["mac|/p#new:1"] = {
    preview: { ...preview, targetSessionId: 7 },
    hostId: "mac",
    projectPath: "/p",
    originChatId: "/p#new:1",
    originSessionId: null,
    worktreeId: 1,
    newWorktree: false,
    accepted: true,
  };
  screen.params.projectPath = "/other";
  screen.render();
  assert.equal(screen.params.id, undefined);
  assert.equal(screen.session.pendingChats["mac|/p#new:1"].promoted, undefined);
});

function simulatorHost(client, file = "simulator.tsx", { modules = {}, native: nativeExtra = {} } = {}) {
  const react = hookHost({ effects: true }),
    files = new Map(),
    listeners = new Set();
  let writeError = null;
  const native = {
    useColorScheme: () => "light",
    Text: "Text",
    View: "View",
    Pressable: "Pressable",
    AppState: {
      currentState: "active",
      addEventListener(_name, fn) {
        listeners.add(fn);
        return {
          remove() {
            listeners.delete(fn);
          },
        };
      },
    },
    ...nativeExtra,
  };
  class File {
    constructor(_cache, name) {
      this.uri = "file:///cache/" + name;
    }
    writeSync(value) {
      if (writeError) throw writeError;
      files.set(this.uri, value);
    }
    get exists() {
      return files.has(this.uri);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const source = load(
    file,
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": native,
      "expo-router": {
        router: { back() {}, push() {} },
        useFocusEffect: (fn) => react.effect(fn, [fn]),
      },
      "react-native-safe-area-context": {
        useSafeAreaInsets: () => ({ bottom: 34 }),
      },
      "@expo/dom-webview": { DomWebView: "DomWebView" },
      "expo-file-system": { File, Paths: { cache: "/cache" } },
      "expo-clipboard": { setStringAsync: async () => {} },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/simulator-receiver": require("../packages/shared/src/simulator-receiver.mjs"),
      "@milagre/shared/simulator": { SIMLOCK_DEVICE_PREFIX: "simlock:" },
      "./session": { useSession: () => ({ client }) },
      "./icons": { Icon: "Icon" },
      "./status-pill": { StatusPill: "StatusPill" },
      "./design-tokens": {
        type: { caption2: 11, caption1: 12, footnote: 13, subheadline: 15, callout: 16, body: 17, title3: 20, title2: 22, title1: 28, largeTitle: 34 },
        radius: { chip: 6, control: 10, card: 14, sheet: 20, full: 999 },
      },
      "./theme": {
        hex: () => ({
          page: "#fafafb",
          surface: "#ffffff",
          ink: "#1f2124",
          ink2: "#62656b",
          line: "#ecedef",
          hover: "#f4f5f6",
          accent: "#0285ff",
        }),
      },
      "./ui": {
        CircleButton: "CircleButton",
        PageScroll: "PageScroll",
        PillButton: "PillButton",
        ErrorNotice: "ErrorNotice",
        colors: {},
        styles: {},
      },
      ...modules,
    },
    file === "simulator.tsx"
      ? "\nexports.TestSimulatorWebView = SimulatorWebView;"
      : file === "ports.tsx"
        ? // The Chat screen reads the ports once and hands them to the pill (app/chat.tsx).
          "\nexports.TestChatPorts = ({ chatId }) => PortsChip({ chatId, ports: useChatPorts(useSession().client, chatId).ports });"
        : "",
  );
  return {
    source,
    files,
    failWrites(error) {
      writeError = error;
    },
    setClient(value) {
      client = value;
    },
    background() {
      native.AppState.currentState = "background";
      for (const fn of listeners) fn("background");
    },
    foreground() {
      native.AppState.currentState = "active";
      for (const fn of listeners) fn("active");
    },
    render(name, props) {
      react.begin();
      const tree = source[name](props);
      react.flush();
      return tree;
    },
    cleanup() {
      react.cleanup();
    },
  };
}

test("mobile simulator receiver is an OTA JS string cached locally; backgrounding closes a late open", async () => {
  const gate = deferred(),
    calls = [],
    injected = [];
  const client = {
    call: async (method, args) => {
      calls.push([method, args]);
      return method === "simulator:open" ? gate.promise : null;
    },
  };
  const h = simulatorHost(client);
  h.render("TestSimulatorWebView", { client, deviceId: "sim", chatId: "/p#7" });
  await settle();
  const tree = h.render("TestSimulatorWebView", { client, deviceId: "sim", chatId: "/p#7" });
  assert.equal(tree.type, "DomWebView");
  assert.match(tree.props.source.uri, /^file:\/\/\/cache\//);
  assert.match(h.files.get(tree.props.source.uri), /RTCPeerConnection/);
  assert.equal(tree.props.useExpoModulesBridge, false);
  tree.props.ref.current = { injectJavaScript: (value) => injected.push(value) };
  tree.props.onMessage({ nativeEvent: { data: JSON.stringify({ channel: "milagre-simulator", id: 1, method: "open", args: { deviceId: "sim" } }) } });
  assert.equal(calls.find(([method]) => method === "simulator:open")[1][0].chatId, "/p#7");
  h.background();
  gate.resolve({ viewerId: "late-viewer" });
  await settle();
  assert.ok(injected.some((script) => script.includes("simulatorDispose")));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([method]) => method === "simulator:close"))), ["simulator:close", [{ viewerId: "late-viewer" }]]);
  h.cleanup();
  assert.equal(h.files.size, 0);
});

test("mobile simulator forwards Duo pose and angle actions through its scoped viewer bridge", async () => {
  const calls = [],
    client = {
      call: async (method, args) => {
        calls.push([method, args]);
        return method === "simulator:open" ? { viewerId: "duo-viewer", iceServers: [] } : { accepted: true };
      },
    };
  const h = simulatorHost(client);
  h.render("TestSimulatorWebView", { client, deviceId: "duo", chatId: "/p#7" });
  await settle();
  const view = h.render("TestSimulatorWebView", { client, deviceId: "duo", chatId: "/p#7" });
  const receive = (id, method, args) => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ channel: "milagre-simulator", id, method, args }) } });
  receive(1, "open", { deviceId: "duo" });
  await settle();
  for (const [index, event] of [
    { kind: "pose", pose: "book" },
    { kind: "hinge", angle: 123 },
  ].entries()) {
    const args = { viewerId: "duo-viewer", sequence: index + 1, generation: 4, event };
    receive(index + 2, "input", args);
    await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["simulator:input", [args]]);
  }
  h.cleanup();
});

test("mobile simulator chooses the sole running device, but a list never starts capture", async () => {
  const device = { id: "one", name: "iPhone", platform: "ios", version: "26.2" };
  for (const devices of [[device], [device, { ...device, id: "two" }]]) {
    const calls = [];
    const h = simulatorHost({
      url: "mac",
      call: async (method) => {
        calls.push(method);
        return { chatId: "/p#7", supported: true, devices, attached: devices, available: [] };
      },
    });
    h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
    await settle();
    const tree = h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
    assert.equal(tree.props.style.paddingBottom, 34, "controls clear the phone home indicator");
    assert.equal(!!find(tree, (node) => node.props?.deviceId === "one"), devices.length === 1);
    assert.deepEqual(calls, ["simulator:list"]);
    if (devices.length === 2) assert.ok(find(tree, (node) => node.type === "Pressable"));
    h.cleanup();
  }
});

test("mobile simulator status messages update its header without reopening the cached viewer", async () => {
  const device = {
    id: "sim",
    name: "QA phone",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    platform: "ios",
    version: "27",
  };
  const updates = [],
    calls = [];
  const client = {
    call: async (method) => {
      calls.push(method);
      return null;
    },
  };
  const h = simulatorHost(client);
  const props = {
    client,
    deviceId: "sim",
    device,
    chatId: "/p#7",
    onConnection: (value) => updates.push(value),
  };
  h.render("TestSimulatorWebView", props);
  await settle();
  const view = h.render("TestSimulatorWebView", props);
  const uri = view.props.source.uri;
  const config = JSON.parse(
    h.files
      .get(uri)
      .match(/data-config="([^"]+)"/)[1]
      .replaceAll("&quot;", '"'),
  );
  assert.equal(config.touchControls, true);
  assert.equal(config.device.deviceType, device.deviceType);
  view.props.onMessage({
    nativeEvent: {
      data: JSON.stringify({
        channel: "milagre-simulator",
        event: "state",
        state: "live",
      }),
    },
  });
  view.props.onMessage({
    nativeEvent: {
      data: JSON.stringify({
        channel: "milagre-simulator",
        event: "state",
        state: "bogus",
      }),
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [
    { deviceId: "sim", state: "connecting" },
    { deviceId: "sim", state: "live" },
  ]);
  assert.equal(calls.length, 0, "status events must not enter the RPC bridge");
  const changed = {
    ...props,
    device: {
      ...device,
      name: "Renamed phone",
      deviceType: undefined,
      version: "27.1",
    },
  };
  h.render("TestSimulatorWebView", changed);
  await settle();
  const next = h.render("TestSimulatorWebView", changed);
  assert.equal(next.props.source.uri, uri, "discovery and connection updates preserve the video session");
  h.cleanup();
});

test("mobile simulator header follows background, resume and host loss without depending on WebView messages", async (t) => {
  const device = {
    id: "sim",
    name: "Pixel 9",
    platform: "android",
    version: "16",
  };
  const h = simulatorHost({
    url: "mac",
    call: async () => ({
      chatId: "/p#7",
      supported: true,
      devices: [device],
      attached: [device],
      available: [],
    }),
  });
  t.after(() => h.cleanup());
  const props = { hostId: "mac", chatId: "/p#7" };
  const render = () => h.render("SimulatorSheet", props);
  render();
  await settle();
  const viewer = find(render(), (node) => node.props?.deviceId === "sim");
  viewer.props.onConnection({ deviceId: "sim", state: "live" });
  assert.ok(find(render(), (node) => node.props?.accessibilityLabel === "Live"));
  h.background();
  const paused = render();
  assert.ok(find(paused, (node) => node.props?.accessibilityLabel === "Paused"));
  assert.equal(
    find(paused, (node) => node.props?.deviceId === "sim"),
    undefined,
    "background unmounts the viewer before any paused message is required",
  );
  h.foreground();
  assert.ok(
    find(render(), (node) => node.props?.accessibilityLabel === "Connecting"),
    "a replacement viewer has not become live yet",
  );
  find(render(), (node) => node.props?.deviceId === "sim").props.onConnection({
    deviceId: "sim",
    state: "live",
  });
  h.setClient(null);
  assert.ok(find(render(), (node) => node.props?.accessibilityLabel === "Disconnected"));
});

test("mobile simulator cache failures report disconnected, and Retry starts a fresh connecting state", async (t) => {
  const updates = [];
  const h = simulatorHost({ call: async () => null });
  t.after(() => h.cleanup());
  h.failWrites(new Error("Cache is unavailable"));
  const props = {
    client: {},
    deviceId: "sim",
    chatId: "/p#7",
    onConnection: (value) => updates.push(value),
  };
  h.render("TestSimulatorWebView", props);
  await settle();
  const failure = h.render("TestSimulatorWebView", props);
  assert.ok(find(failure, (node) => node.props?.accessibilityRole === "alert"));
  assert.equal(updates.at(-1)?.state, "error");
  h.failWrites(null);
  find(failure, (node) => node.props?.title === "Retry").props.onPress();
  h.render("TestSimulatorWebView", props);
  assert.equal(updates.at(-1)?.state, "connecting");
  await settle();
  assert.equal(h.render("TestSimulatorWebView", props).type, "DomWebView");
});

test("simulator sheet preserves its native header and bounds chooser/viewer content below it", async (t) => {
  const device = { id: "one", name: "iPhone", platform: "ios", version: "27" };
  for (const devices of [[device], [device, { ...device, id: "two" }]]) {
    const h = simulatorHost({ url: "mac", call: async () => ({ chatId: "/p#7", supported: true, devices, attached: devices, available: [] }) });
    t.after(() => h.cleanup());
    h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
    await settle();
    const tree = h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
    const [header, body] = tree.props.children;
    assert.equal(header.props.collapsable, false, "Fabric must preserve one header view for native sheet sizing");
    assert.equal(header.props.style.flexShrink, 0);
    assert.equal(body.type, "View");
    assert.equal(body.props.collapsable, false);
    assert.equal(body.props.style.flex, 1);
    assert.equal(body.props.style.minHeight, 0);
    const scroll = find(body, (node) => node.type === "PageScroll");
    if (devices.length === 2) {
      assert.equal(scroll.props.contentInsetAdjustmentBehavior, "never", "the body already sits below its own header");
      assert.equal(scroll.props.automaticallyAdjustContentInsets, false);
      assert.equal(scroll.props.style.flex, 1);
    } else
      assert.ok(
        find(body, (node) => node.props?.deviceId === "one"),
        "the live viewer uses the same bounded body",
      );
    h.cleanup();
  }
});

function browserHost(client) {
  const react = hookHost({ effects: true }),
    files = new Map(),
    listeners = new Set(),
    pushed = [],
    writes = [];
  const native = {
    useColorScheme: () => "light",
    Text: "Text",
    View: "View",
    Pressable: "Pressable",
    AppState: {
      currentState: "active",
      addEventListener(_name, fn) {
        listeners.add(fn);
        return {
          remove() {
            listeners.delete(fn);
          },
        };
      },
    },
  };
  class File {
    constructor(_cache, name) {
      this.uri = "file:///cache/" + name;
    }
    writeSync(value, options) {
      files.set(this.uri, value);
      writes.push([this.uri, options?.encoding ?? "utf8"]);
    }
    get exists() {
      return files.has(this.uri);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const source = load(
    "browser.tsx",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": native,
      "expo-router": {
        router: {
          back() {},
          push(value) {
            pushed.push(value);
          },
        },
        useFocusEffect: (fn) => react.effect(fn, [fn]),
      },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
      "@expo/dom-webview": { DomWebView: "DomWebView" },
      "expo-file-system": { File, Paths: { cache: "/cache" } },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/browser-receiver": require("../packages/shared/src/browser-receiver.mjs"),
      "./session": { useSession: () => ({ client }) },
      "./icons": { Icon: "Icon" },
      "./status-pill": { StatusPill: "StatusPill" },
      "./design-tokens": {
        type: { caption2: 11, caption1: 12, footnote: 13, subheadline: 15, callout: 16, body: 17, title3: 20, title2: 22, title1: 28, largeTitle: 34 },
        radius: { chip: 6, control: 10, card: 14, sheet: 20, full: 999 },
      },
      "./theme": {
        hex: () => ({ page: "#fafafb", surface: "#ffffff", ink: "#1f2124", ink2: "#62656b", line: "#ecedef", hover: "#f4f5f6", accent: "#0285ff" }),
      },
      "./ui": { CircleButton: "CircleButton", PageScroll: "PageScroll", PillButton: "PillButton", colors: {}, styles: {} },
    },
    "\nexports.TestBrowserWebView = BrowserWebView;",
  );
  return {
    source,
    files,
    writes,
    pushed,
    background() {
      native.AppState.currentState = "background";
      for (const fn of listeners) fn("background");
    },
    render(name, props) {
      react.begin();
      const tree = source[name](props);
      react.flush();
      return tree;
    },
    cleanup() {
      react.cleanup();
    },
  };
}
const BROWSER_PAGE = { id: "browser-1:" + "A".repeat(32), title: "Login", url: "https://example.com/login", browser: "Chrome 141", source: "agent" };

test("mobile browser link selects the requested page among several and retries without leaving the app", async (t) => {
  const requested = { ...BROWSER_PAGE, id: "requested-page", source: "panel", url: "http://localhost:5173/" };
  const calls = [];
  let attempt = 0;
  const h = browserHost({
    url: "mac",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "browser:open-page") {
        if (++attempt === 1) throw new Error("Open Milagre on your computer and retry.");
        return requested;
      }
      return { supported: true, targets: [BROWSER_PAGE, requested], others: [] };
    },
  });
  t.after(() => h.cleanup());
  const render = () => h.render("BrowserSheet", { hostId: "mac", chatId: "/p#1", url: "http://localhost:5173" });
  assert.match(JSON.stringify(render()), /Opening page/);
  await settle();
  assert.match(JSON.stringify(render()), /Open Milagre on your computer/);
  find(render(), (node) => node.props.title === "Retry").props.onPress();
  render();
  await settle();
  assert.equal(find(render(), (node) => node.props.targetId === requested.id).props.targetId, requested.id);
  assert.equal(calls.filter(([method]) => method === "browser:open-page").length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([method]) => method === "browser:open-page")[1])), [{ chatId: "/p#1", url: "http://localhost:5173" }]);
});

test("mobile browser shortcut lists only this Chat and hides until the Chat has a page", async (t) => {
  for (const [list, visible] of [
    [{ supported: true, targets: [], others: [] }, false],
    [{ supported: true, targets: [BROWSER_PAGE], others: [] }, true],
    // An attachable browser alone is not a page of this Chat.
    [{ supported: true, targets: [], others: [{ id: "b", browser: "Chrome 141", pages: 1, title: "Mine" }] }, false],
  ]) {
    const calls = [];
    const h = browserHost({
      url: "mac",
      call: async (method, args) => {
        calls.push([method, args]);
        return list;
      },
    });
    t.after(() => h.cleanup());
    h.render("useBrowserShortcut", { chatId: "/p#1" });
    await settle();
    const tree = h.render("useBrowserShortcut", { chatId: "/p#1" });
    assert.equal(!!tree, visible);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["browser:list", [{ chatId: "/p#1" }]]]);
    if (visible) {
      tree.onPress();
      assert.deepEqual(JSON.parse(JSON.stringify(h.pushed[0])), { pathname: "/browser-sheet", params: { hostId: "mac", chatId: "/p#1" } });
    }
    h.cleanup();
  }
  const h = browserHost({
    url: "mac",
    call: async () => {
      throw new Error("unexpected");
    },
  });
  assert.equal(h.render("useBrowserShortcut", {}), null, "a new Chat has no agent yet");
  h.cleanup();
});

test("mobile browser shortcut opens in the Chat's iPad panel when available", async (t) => {
  const tabs = [];
  const h = browserHost({
    url: "mac",
    call: async () => ({ supported: true, targets: [BROWSER_PAGE], others: [] }),
  });
  t.after(() => h.cleanup());
  const props = { chatId: "/p#1", openInPanel: (tab) => tabs.push(tab) };
  h.render("useBrowserShortcut", props);
  await settle();
  h.render("useBrowserShortcut", props).onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(tabs)), [{ kind: "browser", target: { hostId: "mac", chatId: "/p#1" } }]);
  assert.deepEqual(h.pushed, [], "a docked Browser does not also open a phone sheet");
});

test("mobile browser sheet opens a sole page directly, lists several, and attaches explicitly", async (t) => {
  const other = { id: "b", browser: "Chrome 141", pages: 2, title: "Mine" };
  for (const [list, direct] of [
    [{ supported: true, targets: [BROWSER_PAGE], others: [] }, true],
    [{ supported: true, targets: [BROWSER_PAGE, { ...BROWSER_PAGE, id: "browser-1:" + "B".repeat(32) }], others: [other] }, false],
  ]) {
    const calls = [];
    const h = browserHost({
      url: "mac",
      call: async (method, args) => {
        calls.push([method, args]);
        return method === "browser:attach"
          ? { ...list, targets: [...list.targets, { ...BROWSER_PAGE, id: "b:" + "C".repeat(32), source: "attached" }], others: [] }
          : list;
      },
    });
    t.after(() => h.cleanup());
    h.render("BrowserSheet", { hostId: "mac", chatId: "/p#1" });
    await settle();
    const tree = h.render("BrowserSheet", { hostId: "mac", chatId: "/p#1" });
    assert.equal(tree.props.style.paddingBottom, 34, "controls clear the phone home indicator");
    const [header, body] = tree.props.children;
    assert.equal(header.props.collapsable, false);
    assert.equal(body.props.collapsable, false);
    assert.equal(!!find(body, (node) => node.props?.targetId === BROWSER_PAGE.id), direct);
    assert.deepEqual(
      calls.map(([method]) => method),
      ["browser:list"],
      "listing starts no capture",
    );
    if (!direct) {
      const attach = find(body, (node) => node.type === "PillButton" && node.props.title === "Attach");
      attach.props.onPress();
      await settle();
      assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["browser:attach", [{ chatId: "/p#1", browserId: "b" }]]);
      // Only attached pages offer Detach, and it names the browser, not the page.
      const after = h.render("BrowserSheet", { hostId: "mac", chatId: "/p#1" });
      const detaches = [];
      find(after, (node) => {
        if (node.type === "PillButton" && node.props.title === "Detach") detaches.push(node);
        return false;
      });
      assert.equal(detaches.length, 1);
      detaches[0].props.onPress();
      await settle();
      assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["browser:detach", [{ chatId: "/p#1", browserId: "b" }]]);
    }
    h.cleanup();
  }
});

test("mobile browser frames are written to local files; only their address enters the WebView", async () => {
  const injected = [];
  const client = {
    call: async (method) =>
      method === "browser:open"
        ? { viewerId: "viewer", target: BROWSER_PAGE }
        : method === "browser:frame"
          ? { sequence: 7, data: "anBlZw==", viewport: { width: 800, height: 600 }, generation: 1 }
          : null,
  };
  const h = browserHost(client);
  h.render("TestBrowserWebView", { client, chatId: "/p#1", targetId: BROWSER_PAGE.id, onPage() {} });
  await settle();
  const tree = h.render("TestBrowserWebView", { client, chatId: "/p#1", targetId: BROWSER_PAGE.id, onPage() {} });
  assert.equal(tree.type, "DomWebView");
  assert.equal(tree.props.useExpoModulesBridge, false);
  assert.match(h.files.get(tree.props.source.uri), /milagre-browser/);
  tree.props.ref.current = { injectJavaScript: (value) => injected.push(value) };
  tree.props.onMessage({
    nativeEvent: { data: JSON.stringify({ channel: "milagre-browser", id: 1, method: "open", args: { chatId: "/p#1", targetId: BROWSER_PAGE.id } }) },
  });
  await settle();
  tree.props.onMessage({
    nativeEvent: { data: JSON.stringify({ channel: "milagre-browser", id: 2, method: "frame", args: { viewerId: "viewer", after: 0 } }) },
  });
  await settle();
  const reply = injected.find((script) => script.includes('"id":2'));
  assert.ok(reply.includes("file:///cache/browser-"), "the WebView gets a file address");
  assert.ok(!reply.includes("anBlZw=="), "frame bytes stay out of injected script");
  assert.deepEqual(h.writes.at(-1)[1], "base64");
  h.background();
  await settle();
  assert.ok(injected.some((script) => script.includes("browserDispose")));
  h.cleanup();
  assert.equal(h.files.size, 0, "the viewer page and frames are deleted");
});

for (const provider of ["claude", "codex"])
  test(`mobile Accounts selects by tapping the row and manages accounts through its menu (${provider})`, async () => {
    const react = hookHost({ effects: true });
    const calls = [];
    const accounts = {
      providers: [
        { provider: "antigravity", installed: false, selectedId: "default", accounts: [{ id: "default", label: "Default account", state: "unknown" }] },
        {
          provider,
          selectedId: "default",
          accounts: [
            {
              id: "default",
              provider,
              label: "Connected CLI account",
              state: "ready",
            },
            {
              id: "work",
              provider,
              label: "Work",
              email: "work@example.test",
              plan: provider === "claude" ? "self_serve_business_polite" : "business",
              state: "ready",
            },
          ],
        },
      ],
    };
    const session = {
      hostName: "Preview Mac",
      refreshProviders: async () => {
        calls.push(["refreshProviders"]);
      },
      client: {
        call: async (method, args = []) => {
          calls.push([method, ...args]);
          const group = accounts.providers.find((group) => group.provider === provider);
          if (method === "accounts:select") group.selectedId = args[1];
          if (method === "accounts:login") group.accounts.find((a) => a.id === args[1]).state = "signing-in";
          if (method === "accounts:cancel") group.accounts.find((a) => a.id === args[1]).state = "signed-out";
          if (method === "accounts:remove") {
            group.accounts = group.accounts.filter((a) => a.id !== args[1]);
            group.selectedId = "default";
          }
          return structuredClone(accounts);
        },
      },
    };
    const { AccountsForComputer: AccountsSection } = load("accounts-section.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/providers": require("@milagre/shared/providers"),
      "./session": { useSession: () => session },
      "./icons": { ProviderLogo: "ProviderLogo", Icon: "Icon" },
      "./ui": {
        PillButton: "Button",
        Field: "Field",
        IconButton: "IconButton",
        PullDown: "PullDown",
        colors: {},
        styles: {},
      },
    });
    const render = () => {
      react.begin();
      return AccountsSection();
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const menu = () => find(render(), (n) => n.type === "PullDown" && n.props.label === "Actions for work@example.test");
    try {
      render();
      await settle();
      assert.equal(
        find(render(), (n) => n.type === "ProviderLogo" && n.props.provider === "antigravity"),
        undefined,
        "Uninstalled providers have no account group",
      );
      const row = find(render(), (n) => n.type === "Pressable" && n.props.accessibilityRole === "radio" && n.props.accessibilityLabel === "work@example.test");
      assert.ok(row, "The account row is a directly selectable control");
      assert.match(row.props.accessibilityHint, /^Business account\./);
      assert.equal(JSON.stringify(row).includes("self_serve_business_polite"), false);
      row.props.onPress();
      await settle();
      assert.ok(calls.some((c) => c.join(":") === `accounts:select:${provider}:work`));
      assert.equal(find(render(), (n) => n.props.accessibilityLabel === "work@example.test").props.accessibilityState.checked, true);
      assert.ok(calls.some((c) => c[0] === "refreshProviders"));
      assert.equal(
        find(render(), (n) => n.props.title === "Add account"),
        undefined,
      );
      assert.equal(
        find(render(), (n) => n.type === "Field"),
        undefined,
      );
      assert.equal(
        menu()
          .props.sections.flatMap((s) => s.items.map((i) => i.title))
          .join(","),
        "Re-authenticate,Remove",
      );
      menu().props.onSelect("login");
      await settle();
      assert.ok(calls.some((c) => c.join(":") === `accounts:login:${provider}:work`));
      menu().props.onSelect("cancel");
      await settle();
      assert.ok(calls.some((c) => c.join(":") === `accounts:cancel:${provider}:work`));
      menu().props.onSelect("remove");
      await settle();
      assert.ok(calls.some((c) => c.join(":") === `accounts:remove:${provider}:work`));
      assert.equal(
        find(render(), (n) => n.props.accessibilityLabel === "work@example.test"),
        undefined,
      );
    } finally {
      react.unmount();
    }
  });

function ongoingChatHost(options = {}) {
  const screen = chatHost({ effects: true, ...options });
  screen.params.id = "7";
  const state = screen.session.snapshot.project.state;
  state.sessions[7] = { id: 7, worktree_id: 1, agent_name: "main", title: "Existing Chat", provider: "codex", status: "Idle" };
  state.messages = [
    { id: 2, session_id: 7, role: "user", body: "Original question", context: null },
    { id: 3, session_id: 7, role: "assistant", body: "Previous answer", context: null },
  ];
  screen.session.drafts["/p#7"] = "Follow-up message";
  return screen;
}

function transcriptMessages(screen) {
  const messages = [];
  find(screen.render(), (node) => {
    if (node.type === "ChatReply" && node.props.message) messages.push(node.props.message);
    return false;
  });
  return messages;
}

test("an ongoing mobile Chat shows a follow-up before attachment upload finishes and keeps its history", async () => {
  const upload = deferred();
  const screen = ongoingChatHost();
  screen.session.client.upload = () => upload.promise;
  screen.session.attachments["/p#7"] = [{ id: "file", name: "notes.txt", uri: "file:///notes.txt", base64: "YQ==" }];
  screen.send();
  const messages = transcriptMessages(screen);
  assert.deepEqual(
    messages.map((message) => message.body),
    ["Original question", "Previous answer", "Follow-up message"],
  );
  assert.equal(screen.field().value, "");
  assert.deepEqual(Array.from(messages.at(-1).files), ["notes.txt"]);
  assert.equal(
    screen.calls.some((call) => call.method === "chat:send"),
    false,
    "the preview is visible before uploading or contacting the agent",
  );
  upload.resolve({ path: "/p/notes.txt" });
  await settle();
  const request = screen.calls.find((call) => call.method === "chat:send").args[0];
  assert.equal(request.sessionId, 7);
  assert.equal(request.clientMessageId, messages.at(-1).clientMessageId);
  screen.sending.resolve({ sessionId: 7 });
  await settle();
});

test("an ongoing mobile Chat replaces only the acknowledged follow-up and preserves the next draft", async () => {
  const screen = ongoingChatHost();
  screen.send();
  await settle();
  const preview = transcriptMessages(screen).find((message) => message.body === "Follow-up message");
  assert.ok(preview, "a follow-up renders while the send response is still pending");
  screen.field().onChangeText("Follow-up message");
  const state = screen.session.snapshot.project.state;
  state.messages = [...state.messages, { ...preview, id: 4, session_id: 7 }];
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [2, 3, 4],
    "the canonical message replaces its preview without dropping history or duplicating input",
  );
  screen.sending.resolve({ sessionId: 7 });
  await settle();
  assert.equal(screen.field().value, "Follow-up message", "an intentionally repeated next draft survives acknowledgement");
  assert.equal(screen.params.id, "7");
});

test("a mobile follow-up to a running turn appears immediately and restores text and files after failure", async () => {
  const screen = ongoingChatHost();
  screen.session.snapshot.runs.runs["/p#7"] = { startedAt: Date.now(), questions: [], approvals: [], steps: [], body: "Still working" };
  screen.session.attachments["/p#7"] = [{ id: "file", name: "notes.txt", uri: "file:///notes.txt", path: "/p/notes.txt" }];
  screen.send();
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.body),
    ["Original question", "Previous answer", "Follow-up message"],
  );
  const order = [];
  find(screen.render(), (node) => {
    if (node.type === "ChatReply") order.push(node.props.run ? "Live reply" : node.props.message.body);
    return false;
  });
  assert.deepEqual(order, ["Original question", "Previous answer", "Live reply", "Follow-up message"], "steering input follows the reply already in progress");
  screen.field().onChangeText("Next draft");
  screen.sending.reject(new Error("Connection lost"));
  await settle();
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.body),
    ["Original question", "Previous answer"],
  );
  assert.equal(screen.field().value, "Follow-up message\n\nNext draft");
  assert.equal(screen.session.attachments["/p#7"][0].id, "file");
  assert.equal(find(screen.render(), (node) => node.type === "ErrorNotice").props.message, "Connection lost");
});

test("a mobile follow-up keeps the existing Chat in its drawer position", () => {
  const screen = ongoingChatHost();
  const state = screen.session.snapshot.project.state;
  state.next_id = 30;
  state.sessions[20] = { id: 20, worktree_id: 1, agent_name: "main", title: "Newer Chat", status: "Idle" };
  state.messages.push({ id: 21, session_id: 20, role: "user", body: "Newer question", context: null });
  screen.send();
  const nav = navigationHost(Promise.resolve(), { session: { ...screen.session, recent: [{ path: "/p" }] } });
  assert.deepEqual(
    Array.from(
      nav.rows().props.data.filter((row) => row.kind === "chat"),
      (row) => row.chat.id,
    ),
    [20, 7],
  );
});

test("a mobile follow-up keeps its drawer position when the host sends summaries without messages", () => {
  const screen = ongoingChatHost();
  const state = screen.session.snapshot.project.state;
  state.next_id = 30;
  state.sessions[7].summary = { count: 20, firstId: 8, lastId: 19 };
  state.sessions[20] = { id: 20, worktree_id: 1, agent_name: "main", title: "Newer Chat", status: "Idle", summary: { count: 1, firstId: 21, lastId: 21 } };
  state.messages = [];
  state.messagesInChats = true;
  screen.send();
  const nav = navigationHost(Promise.resolve(), { session: { ...screen.session, recent: [{ path: "/p" }] } });
  assert.deepEqual(
    Array.from(
      nav.rows().props.data.filter((row) => row.kind === "chat"),
      (row) => row.chat.id,
    ),
    [20, 7],
  );
});

test("mobile opens a long Chat with its newest 40 messages and loads another page on request", () => {
  const screen = ongoingChatHost();
  screen.session.snapshot.project.state.messages = Array.from({ length: 1000 }, (_, index) => ({
    id: index + 1,
    session_id: 7,
    role: index % 2 ? "assistant" : "user",
    body: "Message " + index,
    context: null,
  }));
  assert.equal(transcriptMessages(screen).length, 40);
  assert.equal(transcriptMessages(screen)[0].id, 961);
  find(screen.render(), (node) => node.type === "PillButton" && node.props.title?.startsWith("Show earlier messages")).props.onPress();
  assert.equal(transcriptMessages(screen).length, 80);
  assert.equal(transcriptMessages(screen)[0].id, 921);
  assert.equal(transcriptMessages(screen).at(-1).id, 1000);
});

test("scrolling up loads older mobile messages once and preserves the reading position", async (t) => {
  const screen = ongoingChatHost();
  screen.session.snapshot.project.state.messagesInChats = true;
  const message = (id) => ({
    id,
    session_id: 7,
    role: "user",
    body: `Message ${id}`,
    context: null,
  });
  let held = Array.from({ length: 40 }, (_, i) => message(61 + i));
  const request = deferred();
  let reads = 0;
  globalThis.chatPage = (client, path, id) =>
    id === 7 && client
      ? {
          messages: held,
          total: 100,
          hasMore: true,
          loading: false,
          loadEarlier: async () => {
            reads++;
            await request.promise;
            held = [...Array.from({ length: 40 }, (_, i) => message(21 + i)), ...held];
          },
        }
      : undefined;
  t.after(() => delete globalThis.chatPage);
  const offsets = [];
  const scroller = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  scroller().props.ref.current = {
    scrollTo: (value) => offsets.push(value),
    scrollToEnd() {},
  };
  scroller().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  scroller().props.onContentSizeChange(390, 4000);
  const move = (y) =>
    scroller().props.onScroll({
      nativeEvent: {
        contentOffset: { y },
        contentSize: { height: 4000 },
        layoutMeasurement: { height: 600 },
      },
    });
  move(3400);
  assert.equal(reads, 0, "opening at the newest message must not fetch history");
  find(screen.render(), (node) => node.props?.nativeID === "chat-message-61").props.onLayout({ nativeEvent: { layout: { y: 100 } } });
  move(100);
  move(50);
  assert.equal(reads, 1, "repeated scroll events share one request");
  request.resolve();
  await settle();
  assert.equal(transcriptMessages(screen)[0].id, 21);
  find(screen.render(), (node) => node.props?.nativeID === "chat-message-61").props.onLayout({ nativeEvent: { layout: { y: 2100 } } });
  assert.equal(offsets.at(-1).y, 2050, "the previous first message keeps its screen position, including scrolling during the read");
});

test("a native position correction before the anchor's layout does not move older mobile messages twice", async (t) => {
  const screen = ongoingChatHost();
  screen.session.snapshot.project.state.messagesInChats = true;
  const message = (id) => ({ id, session_id: 7, role: "user", body: `Message ${id}`, context: null });
  let held = Array.from({ length: 40 }, (_, i) => message(61 + i));
  globalThis.chatPage = (client, path, id) =>
    id === 7 && client
      ? {
          messages: held,
          total: 100,
          hasMore: true,
          loading: false,
          loadEarlier: async () => {
            held = [...Array.from({ length: 40 }, (_, i) => message(21 + i)), ...held];
          },
        }
      : undefined;
  t.after(() => delete globalThis.chatPage);
  const offsets = [];
  const scroller = () => find(screen.render(), (node) => node.type === "KeyboardChatScrollView");
  scroller().props.ref.current = { scrollTo: (value) => offsets.push(value), scrollToEnd() {} };
  scroller().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
  scroller().props.onContentSizeChange(390, 4000);
  const move = (y, height = 4000) =>
    scroller().props.onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height }, layoutMeasurement: { height: 600 } } });
  move(3400);
  find(screen.render(), (node) => node.props?.nativeID === "chat-message-61").props.onLayout({ nativeEvent: { layout: { y: 100 } } });
  move(100);
  move(50);
  await settle();
  assert.equal(transcriptMessages(screen)[0].id, 21);
  // maintainVisibleContentPosition already moved the offset by the 2000 points the older page added.
  move(2050, 6000);
  find(screen.render(), (node) => node.props?.nativeID === "chat-message-61").props.onLayout({ nativeEvent: { layout: { y: 2100 } } });
  assert.equal(offsets.at(-1)?.y ?? 2050, 2050, "the anchor lands where the native correction left it");
});

test("failed mobile history stays retryable without dropping the current messages", async (t) => {
  const screen = ongoingChatHost();
  screen.session.snapshot.project.state.messagesInChats = true;
  const messages = Array.from({ length: 40 }, (_, i) => ({
    id: i + 61,
    session_id: 7,
    role: "user",
    body: `Message ${i}`,
    context: null,
  }));
  globalThis.chatPage = (client, path, id) =>
    id === 7 && client
      ? {
          messages,
          total: 100,
          hasMore: true,
          loading: false,
          loadEarlier: async () => {
            throw new Error("Computer offline");
          },
        }
      : undefined;
  t.after(() => delete globalThis.chatPage);
  await find(screen.render(), (node) => node.props?.title?.startsWith("Show earlier messages")).props.onPress();
  const notice = find(screen.render(), (node) => node.type === "ErrorNotice" && node.props.message.includes("Computer offline"));
  assert.ok(notice?.props.retry, "history failure needs a visible retry");
  assert.equal(transcriptMessages(screen).length, 40);
});

test("the mobile paste action adds a clipboard screenshot to the draft", async () => {
  const image = {
    id: "clipboard",
    name: "Pasted image.jpg",
    uri: "file:///paste.jpg",
    image: { id: "clipboard", name: "Pasted image.jpg", dataUrl: "data:image/jpeg;base64,YQ==" },
  };
  const screen = chatHost({
    pickAttachments: async (kind) => {
      assert.equal(kind, "paste");
      return [image];
    },
  });
  const menu = find(screen.render(), (node) => node.type === "PullDown" && node.props.label === "Add photos or files");
  assert.ok(menu.props.sections[0].items.some((item) => item.id === "paste"));
  menu.props.onSelect("paste");
  await settle();
  assert.equal(screen.session.attachments["/p#new:1"][0].image.dataUrl, "data:image/jpeg;base64,YQ==");
  assert.equal(screen.field().value, "first message [Image #1] ");
});

test("native image paste adds a screenshot and its inline reference", async () => {
  const source = { uri: "file:///native.png", width: 1170, height: 2532 };
  const image = {
    id: "paste",
    name: "Pasted image.jpg",
    uri: "file:///compressed.jpg",
    image: { id: "paste", name: "Pasted image.jpg", dataUrl: "data:image/jpeg;base64,YQ==" },
  };
  const loading = deferred();
  const screen = chatHost({
    preparePastedImage: async (value) => {
      assert.equal(value, source);
      return loading.promise;
    },
  });
  assert.equal(typeof screen.field().onImagePaste, "function");
  screen.field().onImagePaste(source);
  screen.field().onImagePaste(source);
  loading.resolve(image);
  await settle();
  assert.equal(screen.session.attachments["/p#new:1"].length, 1);
  assert.equal(screen.session.attachments["/p#new:1"][0].image.dataUrl, "data:image/jpeg;base64,YQ==");
  assert.equal(screen.field().value, "first message [Image #1] ");
});

test("the Ultracode announcer plays once and pauses when its overlay closes", async () => {
  const react = hookHost({ effects: true });
  const events = [];
  const player = { volume: 1, play: () => events.push("play"), pause: () => events.push("pause") };
  const { useUltracodeAudio } = load("ultracode-audio.ts", {
    react,
    "expo-audio": {
      useAudioPlayer: () => player,
      useAudioPlayerStatus: () => ({ isLoaded: true }),
      setAudioModeAsync: async (mode) => {
        assert.equal(mode.playsInSilentMode, false);
        assert.equal(mode.shouldPlayInBackground, false);
      },
    },
    "../assets/ultracode.mp3": 1,
  });
  react.begin();
  useUltracodeAudio();
  await settle();
  react.begin();
  useUltracodeAudio();
  await settle();
  assert.equal(player.volume, 0.8);
  assert.deepEqual(events, ["play"]);
  react.unmount();
  assert.deepEqual(events, ["play", "pause"]);
});

test("native paste targets only the registered field and detaches when it closes", async () => {
  const react = hookHost({ effects: true });
  let receive;
  const registrations = [];
  const pasted = [];
  const { useImagePaste } = load("use-image-paste.ts", {
    react,
    "react-native": { findNodeHandle: (view) => view.tag },
    "expo-modules-core": {
      requireOptionalNativeModule: () => ({
        addListener: (_event, listener) => {
          receive = listener;
          return { remove: () => registrations.push("removed") };
        },
        attachAsync: async (tag) => {
          registrations.push(["attach", tag]);
          return true;
        },
        detachAsync: async (tag) => {
          registrations.push(["detach", tag]);
        },
      }),
    },
  });
  react.begin();
  const field = useImagePaste((image) => pasted.push(image));
  field.ref.current = { tag: 77 };
  field.onLayout();
  receive({ target: 88, uri: "file:///other.png", width: 1, height: 1 });
  receive({ target: 77, uri: "file:///ours.png", width: 1, height: 1 });
  assert.equal(pasted.length, 1);
  assert.equal(pasted[0].uri, "file:///ours.png");
  react.unmount();
  assert.deepEqual(registrations, [["attach", 77], "removed", ["detach", 77]]);
});

test("a native paste finishing after switching Chats does not attach to the next Chat", async () => {
  const loading = deferred();
  const screen = chatHost({ effects: true, preparePastedImage: () => loading.promise });
  screen.field().onImagePaste({ uri: "file:///native.png", width: 10, height: 10 });
  screen.params.id = "7";
  screen.render();
  loading.resolve({ id: "paste", uri: "file:///compressed.jpg", name: "paste.jpg" });
  await settle();
  assert.equal(screen.session.attachments["/p#7"], undefined);
  assert.equal(screen.session.attachments["/p#new:1"], undefined);
});

test("native pasted temporary images are deleted after compression fails", async () => {
  const deleted = [];
  const { preparePastedImage } = load("attachment-picker.ts", {
    "expo-document-picker": {},
    "expo-image-picker": {},
    "expo-clipboard": {},
    "expo-file-system": {
      File: class {
        constructor(uri) {
          this.uri = uri;
        }
        delete() {
          deleted.push(this.uri);
        }
      },
    },
    "expo-image-manipulator": {
      SaveFormat: { JPEG: "jpeg" },
      ImageManipulator: {
        manipulate: () => ({
          resize() {},
          release() {},
          renderAsync: async () => {
            throw new Error("Decode failed");
          },
        }),
      },
    },
    "./attachments": require("../apps/mobile/src/attachments.ts"),
  });
  await assert.rejects(preparePastedImage({ uri: "file:///native.png", width: 10, height: 10 }), /Decode failed/);
  assert.deepEqual(deleted, ["file:///native.png"]);
});

test("clipboard screenshots use the same compressed image payload as picked photos", async () => {
  const { pickAttachments } = load("attachment-picker.ts", {
    "expo-document-picker": { getDocumentAsync: async () => ({ canceled: true }) },
    "expo-image-picker": {},
    "expo-file-system": {},
    "expo-clipboard": { getImageAsync: async () => ({ data: "data:image/png;base64,c2NyZWVu", size: { width: 1170, height: 2532 } }) },
    "expo-image-manipulator": {
      SaveFormat: { JPEG: "jpeg" },
      ImageManipulator: {
        manipulate: (uri) => {
          assert.equal(uri, "data:image/png;base64,c2NyZWVu");
          return {
            resize: (size) => assert.equal(size.height, 1024),
            release() {},
            renderAsync: async () => ({ release() {}, saveAsync: async () => ({ uri: "file:///compressed.jpg", base64: "YQ==" }) }),
          };
        },
      },
    },
    "./attachments": require("../apps/mobile/src/attachments.ts"),
  });
  const [photo] = await pickAttachments("paste");
  assert.equal(photo.image.dataUrl, "data:image/jpeg;base64,YQ==");
  assert.equal(photo.uri, "file:///compressed.jpg");
});

test("an empty or denied clipboard gives a useful error without adding an attachment", async () => {
  const { pickAttachments } = load("attachment-picker.ts", {
    "expo-document-picker": { getDocumentAsync: async () => ({ canceled: true }) },
    "expo-image-picker": {},
    "expo-file-system": {},
    "expo-clipboard": { getImageAsync: async () => null },
    "expo-image-manipulator": {},
    "./attachments": require("../apps/mobile/src/attachments.ts"),
  });
  await assert.rejects(pickAttachments("paste"), /Copy an image.*paste access/);
});

test("revisited mobile transcripts render their cached messages before refresh, including offline", async () => {
  const react = hookHost();
  const { useChatPage, prefetchChatPage } = load("chat-pages.ts", {
    react: { ...react, useEffect: react.effect, useSyncExternalStore: (_subscribe, read) => read() },
  });
  let requests = 0;
  let offline = false;
  const pending = deferred();
  const client = {
    url: "cached-transcripts",
    chatMessages: async (_path, id) => {
      requests++;
      if (offline) return pending.promise;
      return { messages: [{ id, session_id: id, role: "user", body: `Chat ${id}` }], total: 1, hasMore: false };
    },
  };
  const render = (id, host = client) => {
    react.begin();
    const value = useChatPage(host, "/p", id);
    react.flush();
    return value;
  };
  prefetchChatPage(client, "/p", 7);
  prefetchChatPage(client, "/p", 7);
  assert.equal(requests, 1, "navigation prefetches share the first read");
  await settle();
  render(8);
  await settle();
  offline = true;
  const count = requests;
  prefetchChatPage(client, "/p", 7);
  assert.equal(requests, count, "a cached prefetch needs no network");
  const cached = render(7);
  assert.equal(cached.loading, false);
  assert.equal(cached.messages[0].body, "Chat 7");
  pending.reject(new Error("Offline"));
  await settle();
  assert.equal(render(7).messages[0].body, "Chat 7");
  assert.equal(render(7, { ...client, url: "another-computer" }).messages.length, 0);
  await settle();
});

test("mobile message prefetch waits for a restarted computer's Project to open before retrying", async () => {
  const react = hookHost();
  const { useChatPage, prefetchChatPage, noteChatProjectOpening } = load("chat-pages.ts", {
    react: { ...react, useEffect: () => {}, useSyncExternalStore: (_subscribe, read) => read() },
  });
  let reads = 0;
  const opened = deferred();
  const client = {
    url: "restarted",
    chatMessages: async () => {
      if (++reads === 1) throw new Error("Open the Project before reading its messages.");
      return { messages: [{ id: 1, session_id: 7, body: "Reconnected" }], hasMore: false, total: 1 };
    },
  };
  const render = () => {
    react.begin();
    return useChatPage(client, "/p", 7);
  };
  noteChatProjectOpening(client, "/p", opened.promise);
  prefetchChatPage(client, "/p", 7);
  await settle();
  assert.equal(reads, 1);
  assert.equal(render().error, undefined);
  opened.resolve({});
  await settle();
  assert.equal(reads, 2);
  assert.equal(render().messages[0].body, "Reconnected");
});

test("a route handoff never reads the new Chat id from the previous computer or Project", (t) => {
  const screen = ongoingChatHost();
  screen.session.open = () => new Promise(() => {});
  screen.session.snapshot.project.state.messagesInChats = true;
  const reads = [];
  globalThis.chatPage = (client, path, id) => {
    if (client) reads.push([client.url, path, id]);
  };
  t.after(() => delete globalThis.chatPage);
  screen.params.projectPath = "/destination";
  screen.render();
  assert.equal(reads.length, 0);
  screen.params.projectPath = "/p";
  screen.params.hostId = "other-computer";
  screen.render();
  assert.equal(reads.length, 0);
});

test("a mobile tail refresh retains history loaded while it was in flight", async () => {
  const react = hookHost();
  const { useChatPage } = load("chat-pages.ts", {
    react: {
      ...react,
      useEffect: react.effect,
      useSyncExternalStore: (_subscribe, read) => read(),
    },
  });
  const message = (id) => ({
    id,
    session_id: 7,
    role: "user",
    body: `Message ${id}`,
    context: null,
  });
  const tail = deferred();
  const client = {
    url: "refresh-race",
    chatMessages: async (path, id, options) => {
      if (options.before) return { messages: [message(1), message(2)], hasMore: false, total: 4 };
      if (options.turns === 2) return tail.promise;
      return { messages: [message(3), message(4)], hasMore: true, total: 4 };
    },
  };
  let revision = 1;
  function render() {
    react.begin();
    const result = useChatPage(client, "/p", 7, revision);
    react.flush();
    return result;
  }
  render();
  await settle();
  revision++;
  render();
  await render().loadEarlier();
  assert.equal(render().messages.length, 4);
  tail.resolve({
    messages: [message(3), message(4), message(5)],
    hasMore: true,
    total: 5,
  });
  await settle();
  assert.deepEqual(
    Array.from(render().messages, (item) => item.id),
    [1, 2, 3, 4, 5],
  );
  assert.equal(render().hasMore, false);
});

test("concurrent mobile history readers share a page and can retry after a failure", async () => {
  const react = hookHost();
  const { useChatPage } = load("chat-pages.ts", {
    react: {
      ...react,
      useEffect: react.effect,
      useSyncExternalStore: (_subscribe, read) => read(),
    },
  });
  const message = (id) => ({
    id,
    session_id: 7,
    role: "user",
    body: `Message ${id}`,
    context: null,
  });
  let request = deferred(),
    reads = 0;
  const client = {
    url: "concurrent-history",
    chatMessages: async (path, id, options) => {
      if (options.before) {
        reads++;
        return request.promise;
      }
      return { messages: [message(3), message(4)], hasMore: true, total: 4 };
    },
  };
  function render() {
    react.begin();
    const result = useChatPage(client, "/p", 7);
    react.flush();
    return result;
  }
  render();
  await settle();
  const first = render().loadEarlier(),
    second = render().loadEarlier();
  const results = Promise.allSettled([first, second]);
  assert.equal(reads, 1);
  request.reject(new Error("Offline"));
  assert.ok((await results).every((result) => result.status === "rejected"));
  request = deferred();
  const retry = render().loadEarlier();
  request.resolve({
    messages: [message(1), message(2)],
    hasMore: false,
    total: 4,
  });
  await retry;
  assert.deepEqual(
    Array.from(render().messages, (item) => item.id),
    [1, 2, 3, 4],
  );
});

test("with a host that keeps messages by Chat, the screen shows its Chat's page and reads the next one on request", async (t) => {
  const screen = ongoingChatHost();
  const state = screen.session.snapshot.project.state;
  state.messages = [];
  state.messagesInChats = true;
  const message = (id) => ({ id, session_id: 7, role: id % 2 ? "assistant" : "user", body: "Message " + id, context: null });
  let held = Array.from({ length: 40 }, (_, index) => message(961 + index));
  const asked = [];
  globalThis.chatPage = (client, projectPath, chatId) =>
    chatId === 7 && client
      ? {
          messages: held,
          hasMore: true,
          total: 1000,
          loading: false,
          loadEarlier: async () => {
            asked.push(projectPath);
            held = [...Array.from({ length: 40 }, (_, index) => message(921 + index)), ...held];
          },
        }
      : undefined;
  t.after(() => delete globalThis.chatPage);
  assert.deepEqual([transcriptMessages(screen).length, transcriptMessages(screen)[0].id], [40, 961]);
  const earlier = () => find(screen.render(), (node) => node.type === "PillButton" && node.props.title?.startsWith("Show earlier messages"));
  assert.equal(earlier().props.title, "Show earlier messages (960)");
  await earlier().props.onPress();
  assert.deepEqual(asked, ["/p"]);
  assert.deepEqual([transcriptMessages(screen).length, transcriptMessages(screen)[0].id], [80, 921]);
});

test("legacy mobile follow-up retires after acceptance and an untagged saved input", async () => {
  const screen = ongoingChatHost();
  screen.session.snapshot.project.state.next_id = 4;
  screen.send();
  await settle();
  const state = screen.session.snapshot.project.state;
  state.messages.push({ id: 4, session_id: 7, role: "user", body: "Follow-up message", context: null });
  screen.sending.resolve({ sessionId: 7 });
  await settle();
  assert.deepEqual(
    transcriptMessages(screen).map((message) => message.id),
    [2, 3, 4],
  );
  const provider = sessionHost({});
  const props = { hostId: "mac", snapshot: screen.session.snapshot };
  provider.pending(props).setPendingChats(() => screen.session.pendingChats);
  provider.pending(props);
  assert.deepEqual(Object.keys(provider.pending(props).pendingChats), []);
});

test("pending snapshot acknowledgement does not disable mobile Stop", async () => {
  const screen = ongoingChatHost();
  screen.session.snapshot.runs.runs["/p#7"] = { startedAt: Date.now(), questions: [], approvals: [], steps: [] };
  screen.send();
  await settle();
  screen.sending.resolve({ sessionId: 7 });
  await settle();
  assert.ok(Object.keys(screen.session.pendingChats).length);
  const stop = find(screen.render(), (node) => node.props?.label === "Stop");
  assert.equal(stop.props.disabled, false);
  stop.props.onPress();
  await settle();
  assert.ok(screen.calls.some((call) => call.method === "agent:interrupt"));
});

test("a phone Chat on a provider that can't steer shows its queue over the composer, with Send now and Remove", async () => {
  const screen = ongoingChatHost();
  const state = screen.session.snapshot.project.state;
  state.sessions[7] = {
    ...state.sessions[7],
    provider: "antigravity",
    queued: [{ id: "q1", body: "then add tests", model: "gemini-3-pro", provider: "antigravity", queuedAt: 1 }],
  };
  screen.session.snapshot.runs.runs["/p#7"] = { startedAt: Date.now(), questions: [], approvals: [], steps: [] };
  const tree = screen.render();
  const queue = find(tree, (node) => node.type === "QueuedMessages");
  assert.deepEqual([queue.props.items.map((item) => item.body), queue.props.held, queue.props.running], [["then add tests"], false, true]);
  assert.equal(find(tree, (node) => node.type === "PromptField").props.placeholder, "Queue a message for the next turn");
  queue.props.onSendNow("q1");
  await settle();
  queue.props.onRemove("q1");
  await settle();
  assert.deepEqual(
    screen.calls.filter((call) => call.method.startsWith("chat:queue")).map((call) => [call.method, [...call.args]]),
    [
      ["chat:queue-send", ["/p#7", "q1"]],
      ["chat:queue-remove", ["/p#7", "q1"]],
    ],
  );
});

test("mobile file attachment chips open their contents", () => {
  const pushed = [];
  const react = hookHost();
  const { FileChip } = load("file-chip.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", View: "View", Text: "Text" },
    "expo-router": { router: { push: (target) => pushed.push(target) } },
    "./ui": { colors: {} },
  });
  react.begin();
  const chip = FileChip({ path: "/project/ui.tsx" });
  const button = find(chip, (node) => node.type === "Pressable");
  assert.equal(button.props.accessibilityRole, "button");
  button.props.onPress();
  assert.equal(pushed[0].pathname, "/file-preview");
  assert.equal(pushed[0].params.path, "/project/ui.tsx");
});

test("mobile file preview renders text and reports unreadable, empty, and truncated files", () => {
  const react = hookHost();
  let result = { data: null, error: "", refresh() {} };
  const { default: FilePreview } = load("app/file-preview.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    // oxlint-disable-next-line typescript/no-extraneous-class -- empty stub standing in for expo-file-system's File constructor
    "expo-file-system": { File: class {}, FileMode: { ReadOnly: "readOnly" } },
    "react-native": { Platform: { OS: "ios" }, Text: "Text", View: "View" },
    "expo-router": { Stack: { Screen: "Screen" }, useLocalSearchParams: () => ({ path: "/project/ui.tsx" }) },
    "../session": { useSession: () => ({ client: {} }) },
    "../use-rpc": {
      useRpc: (client, method, args) => {
        assert.equal(method, "attachment:preview");
        assert.equal(args[0], "/project/ui.tsx");
        return result;
      },
    },
    "../save-attachment": { saveAttachment: async () => true },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "../file-code": { FileCode: "FileCode" },
    "../markdown": { Markdown: "Markdown" },
    "@milagre/shared/file-link": require("../packages/shared/src/file-link.mjs"),
    "../ui": { colors: {}, styles: {}, Button: "Button", ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
  });
  const render = () => {
    react.begin();
    return FilePreview();
  };
  const text = (value) => find(render(), (node) => node.type === "Text" && node.props.children === value);
  assert.ok(text("Reading file…"));
  result = { ...result, data: { text: 'export const ui = "hello";', binary: false, truncated: true } };
  assert.equal(find(render(), (node) => node.type === "FileCode").props.text, result.data.text);
  assert.equal(find(render(), (node) => node.type === "FileCode").props.name, "ui.tsx");
  assert.ok(text("Showing the first 256 KB."));
  result = { ...result, data: { text: "", binary: false, truncated: false } };
  assert.ok(text("This file is empty."));
  result = { ...result, data: { text: "", binary: true, truncated: false } };
  assert.ok(text("This file does not have a text preview."));
  result = { ...result, data: null, error: "File no longer exists." };
  assert.equal(find(render(), (node) => node.type === "ErrorNotice").props.message, result.error);
});

test("mobile file preview shows Markdown formatted, with the source a tap away", () => {
  const react = hookHost();
  const result = { data: { text: "# Spec\n\nSee [goals](goals.md).", binary: false, truncated: false }, error: "", refresh() {} };
  const { default: FilePreview } = load("app/file-preview.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    // oxlint-disable-next-line typescript/no-extraneous-class -- empty stub standing in for expo-file-system's File constructor
    "expo-file-system": { File: class {}, FileMode: { ReadOnly: "readOnly" } },
    "react-native": { Platform: { OS: "ios" }, Text: "Text", View: "View" },
    "expo-router": {
      Stack: { Screen: "Screen", Toolbar: Object.assign(() => null, { Button: "ToolbarButton" }) },
      useLocalSearchParams: () => ({ path: "/project/docs/spec.md" }),
    },
    "../session": { useSession: () => ({ client: {} }) },
    "../use-rpc": { useRpc: () => result },
    "../save-attachment": { saveAttachment: async () => true },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "../file-code": { FileCode: "FileCode" },
    "../markdown": { Markdown: "Markdown" },
    "@milagre/shared/file-link": require("../packages/shared/src/file-link.mjs"),
    "../ui": { colors: {}, styles: {}, Button: "Button", ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
  });
  const render = () => {
    react.begin();
    return FilePreview();
  };
  const formatted = find(render(), (node) => node.type === "Markdown");
  assert.equal(formatted.props.text, result.data.text);
  assert.equal(formatted.props.basePath, "/project/docs", "relative links in the file resolve against its folder");
  const toggle = find(render(), (node) => node.type === "ToolbarButton");
  assert.equal(toggle.props.children, "Source");
  toggle.props.onPress();
  assert.equal(
    find(render(), (node) => node.type === "Markdown"),
    undefined,
  );
  assert.equal(find(render(), (node) => node.type === "FileCode").props.text, result.data.text);
  assert.equal(find(render(), (node) => node.type === "ToolbarButton").props.children, "Formatted");
});

test("mobile picked files preview locally before sending", async () => {
  const react = hookHost({ effects: true });
  let closed = false;
  const bytes = new TextEncoder().encode("export const draft = true;");
  const { default: FilePreview } = load("app/file-preview.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-file-system": {
      FileMode: { ReadOnly: "readOnly" },
      File: class {
        constructor(uri) {
          assert.equal(uri, "file:///phone/ui.tsx");
          this.size = bytes.length;
        }
        open(mode) {
          assert.equal(mode, "readOnly");
          return {
            readBytesSync(length) {
              assert.equal(length, bytes.length);
              return bytes;
            },
            close() {
              closed = true;
            },
          };
        }
      },
    },
    "react-native": { Platform: { OS: "ios" }, Text: "Text", View: "View" },
    "expo-router": { Stack: { Screen: "Screen" }, useLocalSearchParams: () => ({ uri: "file:///phone/ui.tsx", name: "ui.tsx" }) },
    "../session": { useSession: () => ({ client: null }) },
    "../use-rpc": {
      useRpc: (client) => {
        assert.equal(client, null, "local files do not read from the computer");
        return {};
      },
    },
    "../save-attachment": { saveAttachment: async () => true },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "../file-code": { FileCode: "FileCode" },
    "../markdown": { Markdown: "Markdown" },
    "@milagre/shared/file-link": require("../packages/shared/src/file-link.mjs"),
    "../ui": { colors: {}, styles: {}, Button: "Button", ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
  });
  react.begin();
  FilePreview();
  await settle();
  react.begin();
  assert.ok(find(FilePreview(), (node) => node.type === "FileCode" && node.props.text === "export const draft = true;" && node.props.name === "ui.tsx"));
  assert.equal(closed, true);
});

test("mobile file downloads write binary bytes, cancel quietly, and remove partial files on failure", async () => {
  let canceled = false;
  let failed = false;
  let created = 0;
  let removed = 0;
  let closed = 0;
  const written = [];
  const { saveAttachment } = load("save-attachment.ts", {
    "@milagre/shared/attachment-download": require("@milagre/shared/attachment-download"),
    "expo-file-system": {
      // oxlint-disable-next-line typescript/no-extraneous-class -- constructor stub; this test downloads from the Mac
      File: class {},
      FileMode: { WriteOnly: "w" },
      Directory: {
        pickDirectoryAsync: async () => {
          if (canceled) throw new Error("File picking was cancelled by the user");
          return {
            createFile: (name, type) => {
              assert.equal(name, "archive.zip");
              assert.equal(type, "application/zip");
              created++;
              return {
                delete: () => removed++,
                open: () => ({
                  close: () => closed++,
                  writeBytes: async (bytes) => {
                    if (failed) throw new Error("Disk full");
                    written.push(Buffer.from(bytes));
                  },
                }),
              };
            },
          };
        },
      },
    },
  });
  const request = { name: "archive.zip", read: async () => ({ size: 4, version: "v1", base64: "UEsA/w==" }), progress() {} };
  assert.equal(await saveAttachment(request), true);
  assert.deepEqual(Buffer.concat(written), Buffer.from([80, 75, 0, 255]));
  assert.equal(closed, 1);
  canceled = true;
  assert.equal(await saveAttachment(request), false);
  assert.equal(created, 1, "canceling the picker creates no file");
  canceled = false;
  failed = true;
  await assert.rejects(saveAttachment(request), /Disk full/);
  assert.equal(closed, 2);
  assert.equal(removed, 1, "a failed download removes its partial file");
});

test("mobile ZIP preview offers Download, progress, success and retryable errors", async () => {
  const react = hookHost();
  const gate = deferred();
  let failure = false;
  const { default: FilePreview } = load("app/file-preview.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    // oxlint-disable-next-line typescript/no-extraneous-class -- constructor stub; this test downloads from the Mac
    "expo-file-system": { File: class {}, FileMode: {} },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { Stack: { Screen: "Screen" }, useLocalSearchParams: () => ({ path: "/remote/archive.zip" }) },
    "../session": {
      useSession: () => ({
        client: {
          call: async (method, args) => {
            assert.equal(method, "attachment:read");
            assert.deepEqual(Array.from(args), ["/remote/archive.zip", 0], "the first chunk omits the optional version over JSON RPC");
            return {};
          },
        },
      }),
    },
    "../use-rpc": { useRpc: () => ({ data: { binary: true }, refresh() {} }) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "../file-code": { FileCode: "FileCode" },
    "../markdown": { Markdown: "Markdown" },
    "@milagre/shared/file-link": require("@milagre/shared/file-link"),
    "../ui": { Button: "Button", ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
    "../save-attachment": {
      saveAttachment: async (options) => {
        if (failure) throw new Error("Connection lost");
        options.progress(50, 100);
        await options.read(0);
        await gate.promise;
        return true;
      },
    },
  });
  const render = () => {
    react.begin();
    return FilePreview();
  };
  find(render(), (node) => node.type === "Button").props.onPress();
  await settle();
  assert.equal(find(render(), (node) => node.type === "Button").props.title, "Downloading… 50%");
  gate.resolve();
  await settle();
  assert.ok(find(render(), (node) => node.type?.name === "Toast" && node.props.text === "File saved."));
  assert.equal(
    find(render(), (node) => node.type === "Text" && node.props.children === "File saved."),
    undefined,
    "success is not left in the preview content",
  );
  failure = true;
  find(render(), (node) => node.type === "Button").props.onPress();
  await settle();
  assert.equal(find(render(), (node) => node.type === "ErrorNotice").props.message, "Connection lost");
  assert.equal(find(render(), (node) => node.type === "Button").props.loading, false);
});

test("mobile TSX preview colors native text in both themes and preserves selection", () => {
  const react = hookHost();
  let scheme = "light";
  const { FileCode } = load("file-code.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", useColorScheme: () => scheme },
    "@milagre/shared/file-syntax": require("@milagre/shared/file-syntax"),
    "./theme": { fonts: { mono: "Menlo" }, useTheme: () => ({ colors: resolvePalette("milagre-blue", scheme), scheme }) },
  });
  const text = 'export const Card = () => (\r\n  <section title="hello">Welcome</section>\r\n);\r\n';
  const render = () => {
    react.begin();
    return FileCode({ text, name: "Card.tsx" });
  };
  const light = render();
  const selectable = find(light, (node) => node.type === "Text" && node.props.selectable);
  assert.equal(selectable.props.children.map((node) => node.props.children).join(""), text);
  const keyword = (tree) => find(tree, (node) => node.type === "Text" && node.props.children === "export").props.style.color;
  const tag = (tree) => find(tree, (node) => node.type === "Text" && node.props.children === "section").props.style.color;
  assert.notEqual(keyword(light), tag(light));
  scheme = "dark";
  const dark = render();
  assert.notEqual(keyword(dark), keyword(light));
  assert.notEqual(keyword(dark), tag(dark));
});

for (const provider of ["claude", "codex"])
  test(`mobile Project Accounts assigns within a scope and restores inheritance (${provider})`, async () => {
    const react = hookHost({ effects: true });
    const calls = [];
    const login = deferred();
    const snapshot = {
      scopeKey: "/p",
      providers: [
        {
          provider,
          accountId: null,
          effectiveId: "default",
          defaultId: "default",
          accounts: [
            {
              id: "default",
              provider,
              label: "CLI",
              email: "default@example.test",
              state: "ready",
            },
            {
              id: "work",
              provider,
              label: "Work",
              email: "work@example.test",
              plan: "business",
              state: "ready",
            },
            { id: "out", provider, label: "Expired", state: "signed-out" },
            {
              id: "gone",
              provider,
              label: "Removed account",
              state: "error",
              missing: true,
              message: "Choose a saved account.",
            },
          ],
        },
      ],
    };
    const session = {
      snapshot: { project: { path: "/p" } },
      refreshProviders: async () => calls.push(["refreshProviders"]),
      client: {
        call: async (method, args = []) => {
          calls.push([method, ...args]);
          if (method === "accounts:scopes")
            return [
              {
                key: "/p",
                name: "Project",
                kind: "project",
                projects: [{ id: "p", path: "/p", name: "Project" }],
              },
              {
                key: "milagre-link:two",
                name: "Linked work",
                kind: "link",
                projects: [{ id: "p", path: "/p", name: "Project" }],
              },
            ];
          if (method === "accounts:login") return login.promise;
          if (method === "accounts:scope") return { ...structuredClone(snapshot), scopeKey: args[0] };
          if (method === "accounts:assign") {
            snapshot.providers[0].accountId = args[2];
            snapshot.providers[0].effectiveId = args[2] || "default";
          }
          return structuredClone(snapshot);
        },
      },
    };
    const { ProjectAccountsSection } = load("project-accounts-section.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Text: "Text",
        View: "View",
        Pressable: "Pressable",
        StyleSheet: { hairlineWidth: 1 },
      },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/providers": require("@milagre/shared/providers"),
      "./session": { useSession: () => session },
      "./icons": { Icon: "Icon", ProviderLogo: "ProviderLogo" },
      "./project-icon": {
        ProjectIcon: "ProjectIcon",
        ProjectIcons: "ProjectIcons",
      },
      "./ui": {
        ListRow: "ListRow",
        PageScroll: "PageScroll",
        PullDown: "PullDown",
        colors: {},
        styles: {},
      },
      "expo-router": { router: { push() {} } },
    });
    // Renders nested function components in place, sharing one hook host in a stable order.
    const expand = (node) =>
      Array.isArray(node)
        ? node.map(expand)
        : node && typeof node.type === "function"
          ? expand(node.type(node.props))
          : node?.props?.children !== undefined
            ? {
                ...node,
                props: { ...node.props, children: expand(node.props.children) },
              }
            : node;
    const render = () => {
      react.begin();
      return expand(ProjectAccountsSection());
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
      render();
      await settle();
      render();
      await settle();
      const menu = () => find(render(), (n) => n.type === "PullDown" && n.props.label === `${provider === "claude" ? "Claude" : "Codex"} account`);
      assert.ok(menu(), "Provider selector loads for the current Project");
      const items = menu().props.sections.flatMap((s) => s.items);
      assert.equal(items.find((i) => i.id === "out").disabled, true);
      assert.equal(
        items.find((i) => i.id === "gone"),
        undefined,
        "Removed accounts are not offered",
      );
      assert.equal(
        find(render(), (n) => n.props.title === "Re-authenticate"),
        undefined,
        "A ready account needs no sign-in",
      );
      assert.ok(
        find(render(), (n) => n.type === "Text" && n.props.children === "Default"),
        "Inherited account is tagged Default",
      );
      assert.match(items.find((i) => i.id === "__default__").title, /default@example.test/);
      menu().props.onSelect("work");
      await settle();
      assert.ok(calls.some((c) => c[0] === "accounts:assign" && c[1] === "/p" && c[2] === provider && c[3] === "work"));
      menu().props.onSelect("__default__");
      await settle();
      assert.ok(calls.some((c) => c[0] === "accounts:assign" && c[3] === null));
      assert.ok(calls.some((c) => c[0] === "refreshProviders"));
      assert.equal(find(render(), (n) => n.type === "ListRow" && n.props.title === "Project").props.leading.props.path, "/p");
      // An assignment that later signed out offers Re-authenticate for that account only.
      menu().props.onSelect("out");
      await settle();
      render();
      find(render(), (n) => n.props.title === "Re-authenticate").props.onPress();
      find(render(), (n) => n.props.title === "Project").props.onPress();
      find(render(), (n) => n.props.title === "Linked work").props.onPress();
      render();
      await settle();
      const scopeReads = calls.filter((c) => c[0] === "accounts:scope").length;
      login.resolve({});
      await settle();
      assert.equal(
        calls.filter((c) => c[0] === "accounts:scope").length,
        scopeReads,
        "Finishing login from an old scope must not invalidate current scope reads",
      );
      assert.ok(menu());
      assert.equal(find(render(), (n) => n.props.title === "Linked work").props.leading.type, "ProjectIcons");
    } finally {
      react.unmount();
    }
  });

test("mobile provider discovery uses the selected scope and ignores late responses after switching", async () => {
  const stale = deferred();
  const requests = [],
    sockets = [];
  const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
  const render = sessionHost(
    {
      call: async (method, args) => {
        if (method === "project:recent") return [];
        if (method === "agent:models" || method === "agent:cli-status") {
          requests.push([method, ...(args || [])]);
          if (args?.[0] === "A") return stale.promise;
          return { source: args?.[0] || "default" };
        }
        return {};
      },
      snapshot: async (path) => snapshot(path),
      live: (_path, options) => {
        sockets.push(options);
        return { close() {} };
      },
    },
    { effects: true, AppState },
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await render().connect({ address: "mac", token: "token" });
    await render().open("A");
    render();
    await render().open("B");
    render();
    await settle();
    assert.equal(render().models.source, "B");
    stale.resolve({ source: "A" });
    await settle();
    assert.equal(render().models.source, "B");
    assert.equal(render().cliStatus.source, "B");
    const before = render().providerRevision;
    sockets.at(-1).onSignal("accounts");
    await settle();
    assert.ok(render().providerRevision > before);
    assert.ok(requests.some((request) => request.join(":") === "agent:models:B"));
    assert.ok(requests.some((request) => request.join(":") === "agent:cli-status:B"));
  } finally {
    render.unmount();
  }
});

test("mobile Project Accounts opens from Settings as a native stack screen", () => {
  const opened = [];
  const { SettingsView } = loadSettings({ client: { url: "http://mac", call: async () => null } });
  find(SettingsView({ onOpen: (page) => opened.push(page) }), (n) => n.props.title === "Project Accounts").props.onPress();
  assert.deepEqual(opened, ["project-accounts"]);
  const { default: Screen } = load("app/(settings)/project-accounts.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": { Stack: { Screen: "Screen" } },
    "../ui": { PageScroll: "PageScroll" },
    "../project-accounts-section": { ProjectAccountsSection: "ProjectAccountsSection" },
  });
  assert.equal(find(Screen(), (n) => n.type === "Screen").props.options.title, "Project Accounts");
  assert.ok(find(Screen(), (n) => n.type === "ProjectAccountsSection"));
});

test("new mobile Chat has no simulator pill; an existing Chat carries its identity", () => {
  const fresh = chatHost();
  assert.equal(
    find(fresh.render(), (n) => n.type === "SimulatorChip"),
    undefined,
  );
  const existing = ongoingChatHost();
  assert.equal(find(existing.render(), (n) => n.type === "SimulatorChip").props.chatId, "/p#7");
  assert.equal(
    find(fresh.render(), (n) => n.type === "PortsChip"),
    undefined,
  );
  assert.equal(find(existing.render(), (n) => n.type === "PortsChip").props.chatId, "/p#7");
  // A Terminal opens in a sent Chat's Worktree, so a new Chat has no Terminal pill either.
  assert.equal(
    find(fresh.render(), (n) => n.type === "TerminalChip"),
    undefined,
  );
  assert.equal(find(existing.render(), (n) => n.type === "TerminalChip").props.chatId, "/p#7");
});

test("mobile simulator pill stays hidden until this Chat has attachments, including stopped devices", async (t) => {
  const device = { id: "a", name: "My iPhone", platform: "ios", version: "27" };
  for (const attached of [[], [device]]) {
    const gate = deferred();
    const h = simulatorHost({ url: "mac", call: () => gate.promise });
    t.after(() => h.cleanup());
    const render = () => h.render("SimulatorChip", { chatId: "/p#7" });
    assert.equal(render(), null, "loading must not flash an empty pill");
    gate.resolve({ chatId: "/p#7", supported: true, devices: [], attached, available: [device] });
    await settle();
    if (attached.length) assert.equal(render().props.accessibilityLabel, "Simulators, 1 attached to this Chat");
    else assert.equal(render(), null, "other running devices must not show the pill");
    h.cleanup();
  }
});

test("mobile simulator pill disappears after the last attachment is removed", async (t) => {
  const device = { id: "a", name: "My iPhone", platform: "ios", version: "27" };
  let attached = [device];
  const h = simulatorHost({ url: "mac", call: async () => ({ chatId: "/p#7", supported: true, devices: attached, attached }) });
  t.after(() => h.cleanup());
  const render = () => h.render("SimulatorChip", { chatId: "/p#7" });
  render();
  await settle();
  assert.ok(render());
  attached = [];
  h.foreground();
  await settle();
  assert.equal(render(), null);
});

test("mobile picker leases a model from the Simlock pool and returns it from the list", async () => {
  const a = { id: "a", name: "My iPhone", platform: "ios", version: "27" };
  const leased = { id: "simlock:l1", name: "iPhone 17 (Simlock)", platform: "ios", version: "27.0" };
  let attached = [a];
  const calls = [];
  const h = simulatorHost({
    url: "mac",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "simlock:settings:read") return { enabled: true };
      if (method === "simlock:models") return { models: [{ platform: "ios", model: "iPhone 17", version: "27.0", kind: "phone" }], leases: [] };
      if (method === "simlock:lease") {
        attached = [...attached, leased];
        return { deviceId: leased.id, leaseId: "l1", platform: "ios", name: "iPhone 17", version: "27.0", chatId: "/p#7" };
      }
      if (method === "simulator:detach") attached = attached.filter((d) => d.id !== args[0].deviceId);
      return { chatId: "/p#7", supported: true, devices: attached, attached, available: [] };
    },
  });
  const render = () => h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  find(render(), (n) => n.props.accessibilityLabel === "My iPhone, choose simulator").props.onPress();
  find(render(), (n) => n.props.title === "Attach simulator").props.onPress();
  render();
  await settle();
  find(render(), (n) => n.props.accessibilityLabel === "Lease iPhone 17").props.onPress();
  await settle();
  // The sheet runs in the harness's own realm: compare plain values.
  assert.equal(
    JSON.stringify(calls.find(([method]) => method === "simlock:lease")[1]),
    JSON.stringify([{ chatId: "/p#7", platform: "ios", model: "iPhone 17" }]),
  );
  assert.ok(
    find(render(), (n) => n.props.deviceId === "simlock:l1"),
    "the leased device opens",
  );
  find(render(), (n) => n.props.accessibilityLabel === "iPhone 17 (Simlock), choose simulator").props.onPress();
  find(render(), (n) => n.props.label === "Return iPhone 17 (Simlock) to the Simlock pool").props.onPress();
  await settle();
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["simulator:detach", [{ chatId: "/p#7", deviceId: "simlock:l1" }]]));
  h.cleanup();
});

test("mobile picker says why an enabled Simlock pool can't be reached, and shows nothing for a Mac without one", async () => {
  const a = { id: "a", name: "My iPhone", platform: "ios", version: "27" };
  for (const [settings, models, expected] of [
    [
      async () => ({ enabled: true }),
      async () => Promise.reject(new Error("The Simlock gateway refused the agent token.")),
      "The Simlock gateway refused the agent token.",
    ],
    [
      async () => ({ enabled: true }),
      async () => Promise.reject(new Error("Could not reach the Simlock gateway at http://pool:4700.")),
      "Could not reach the Simlock gateway at http://pool:4700.",
    ],
    [async () => Promise.reject(new Error("Unknown command: simlock:settings:read")), async () => ({ models: [] }), null],
  ]) {
    const h = simulatorHost({
      url: "mac",
      call: async (method) => {
        if (method === "simlock:settings:read") return settings();
        if (method === "simlock:models") return models();
        return { chatId: "/p#7", supported: true, devices: [a], attached: [a], available: [] };
      },
    });
    const render = () => h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
    render();
    await settle();
    find(render(), (n) => n.props.accessibilityLabel === "My iPhone, choose simulator").props.onPress();
    find(render(), (n) => n.props.title === "Attach simulator").props.onPress();
    render();
    await settle();
    await settle();
    const alert = find(render(), (n) => n.props.accessibilityRole === "alert" && String(n.props.children).includes("Simlock"));
    if (expected) assert.equal(String(alert?.props.children), expected);
    else {
      assert.equal(alert, undefined);
      assert.equal(
        find(render(), (n) => n.props.accessibilityLabel === "Lease from Simlock"),
        undefined,
      );
    }
    h.cleanup();
  }
});

test("mobile picker exposes other devices only in Attach and detach updates this Chat", async () => {
  const a = { id: "a", name: "My iPhone", platform: "ios", version: "27" };
  const b = { id: "b", name: "Other device", platform: "android", version: "16" };
  let attached = [a];
  const calls = [];
  const h = simulatorHost({
    url: "mac",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "simulator:attach") attached.push(b);
      if (method === "simulator:detach") attached = attached.filter((d) => d.id !== args[0].deviceId);
      return { chatId: "/p#7", supported: true, devices: attached, attached, available: [a, b].filter((d) => !attached.some((x) => x.id === d.id)) };
    },
  });
  const render = () => h.render("SimulatorSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  assert.equal(
    find(render(), (n) => n.props.label === "Back to devices"),
    undefined,
    "the viewer has no back button",
  );
  find(render(), (n) => n.props.accessibilityLabel === "My iPhone, choose simulator").props.onPress();
  assert.equal(
    find(render(), (n) => n.props.accessibilityLabel === "Attach Other device"),
    undefined,
  );
  find(render(), (n) => n.props.title === "Attach simulator").props.onPress();
  find(render(), (n) => n.props.accessibilityLabel === "Attach Other device").props.onPress();
  await settle();
  assert.ok(find(render(), (n) => n.props.deviceId === "b"));
  find(render(), (n) => n.props.accessibilityLabel === "Other device, choose simulator").props.onPress();
  find(render(), (n) => n.props.label === "Detach Other device from Chat").props.onPress();
  await settle();
  assert.equal(
    find(render(), (n) => n.props.label === "Detach Other device from Chat"),
    undefined,
  );
  // Simulator calls are this Chat's; the attach list also reads the Mac's Simlock pool, which isn't per Chat.
  for (const [method, args] of calls) if (method.startsWith("simulator:")) assert.equal(args[0].chatId, "/p#7");
  assert.ok(
    calls.some(([method]) => method === "simlock:settings:read"),
    "Attach looks for a Simlock pool",
  );
  h.cleanup();
});

/** The toast pill (primitives/toast.tsx) saying `text`; the trees here don't draw a component's own children. */
function toastPill(tree, text) {
  return find(tree, (node) => node.type?.name === "ToastPill" && node.props.text === text);
}

/** Whether the list has a Chat row. */
function listsChat(nav) {
  return nav.rows().props.data.some((item) => item.kind === "chat");
}

// The progress drawn over an archiving Chat's row.
function archiveIndicator(tree) {
  const component = find(tree, (node) => node.type === archiveProgress.ArchivingOverlay);
  return component && find(component.type(component.props), (node) => node.props.accessibilityRole === "progressbar");
}

test("a sidebar deletion takes the Chat's row out of the list and brings it back on failure", async () => {
  const project = archiveProject();
  const patch = deferred();
  const nav = navigationHost(deferred().promise, {
    alert: pressDanger([]),
    session: {
      client: { ...project.client, url: "mac", call: (method, args) => (method === "chat:patch" ? patch.promise : project.call(method, args)) },
      recent: [{ path: "/p" }],
      snapshot: project.snapshot,
      expectActivity() {},
      refresh: async () => {},
    },
  });
  nav.more(nav.row("chat")).props.onSelect("archive");
  await settleAll();
  assert.equal(listsChat(nav), false, "the row goes at once, with the toast's Undo");
  assert.equal(archiveStore.archiveActivity().deleted, "mac|/p#5");
  patch.reject(new Error("disk full"));
  await settleAll();
  assert.ok(nav.row("chat"), "a failed deletion brings the row back");
  assert.equal(archiveIndicator(nav.row("chat")), undefined);
  assert.equal(archiveStore.archiveActivity().deleted, "", "and its toast goes");
  assert.equal(project.calls.filter(([method]) => method === "worktree:roots").length, 1);
  assert.equal(find(nav.render(), (node) => node.type === "ErrorNotice").props.message, "Could not delete Chat: disk full");
  archiveStore.clearArchiveNotice();
});

/** Two Computers, each with Chat /p#5 ("Fix"); `fail` makes one Computer's hide fail. */
function twoComputerArchive({ fail } = {}) {
  const mac = archiveProject();
  const studio = archiveProject();
  const studioCall = (method, args) => (fail === "studio" && method === "chat:patch" ? Promise.reject(new Error("disk full")) : studio.call(method, args));
  // A deleted Chat leaves its Computer's Project, as the Mac's state does.
  const macCall = (method, args) => {
    if (method === "chat:delete") delete mac.snapshot.project.state.sessions[args[1]];
    return mac.call(method, args);
  };
  const nav = navigationHost(deferred().promise, {
    alert: pressDanger([]),
    session: {
      client: { ...mac.client, call: macCall, url: "mac" },
      recent: [{ path: "/p" }],
      snapshot: mac.snapshot,
      expectActivity() {},
      refresh: async () => {},
    },
    computers: [
      { hostId: "mac", name: "MacBook", state: "online", projects: [{ path: "/p" }], copies: { "/p": mac.snapshot } },
      {
        hostId: "studio",
        name: "Studio",
        state: "online",
        projects: [{ path: "/p" }],
        copies: { "/p": studio.snapshot },
        client: { url: "studio", call: studioCall, snapshot: studio.client.snapshot },
      },
    ],
  });
  const hosts = () =>
    nav
      .rows()
      .props.data.filter((item) => item.kind === "chat")
      .map((item) => item.hostId);
  const remove = (hostId) => {
    const at = hosts().indexOf(hostId);
    nav.more(nav.row("chat", at)).props.onSelect("archive");
  };
  return { nav, mac, studio, hosts, remove };
}

test("deleting a Chat hides and undoes only its own Computer's row when another Computer has the same path and id", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { nav, mac, studio, hosts, remove } = twoComputerArchive();
  same(hosts().sort(), ["mac", "studio"]);
  remove("mac");
  await settleAll();
  same(hosts(), ["studio"], "Studio's Chat stays listed while the Mac's is deleted");
  assert.equal(archiveStore.archiveActivity().deleted, "mac|/p#5");
  toastPill(nav.render(), "Chat deleted").props.onUndo();
  await settleAll();
  same(hosts().sort(), ["mac", "studio"]);
  assert.equal(
    mac.calls.some(([method]) => method === "chat:delete"),
    false,
  );
  assert.equal(studio.calls.length, 0, "nothing reached Studio");
});

test("deletions of the same Chat on two Computers run apart, and one's failure brings back only its own row", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { nav, mac, studio, hosts, remove } = twoComputerArchive({ fail: "studio" });
  remove("mac");
  await settleAll();
  remove("studio");
  await settleAll();
  same(hosts(), ["studio"], "Studio's failed deletion brings back only Studio's row");
  assert.equal(find(nav.render(), (node) => node.type === "ErrorNotice").props.message, "Could not delete Chat: disk full");
  archiveStore.clearArchiveNotice();
  assert.equal(archiveStore.archiveActivity().hidden.has("mac|/p#5"), true, "the Mac's deletion is still waiting out its Undo");
  await passUndo(t);
  assert.ok(
    mac.calls.some(([method]) => method === "chat:delete"),
    "the Mac's Chat is deleted after its Undo time",
  );
  assert.equal(
    studio.calls.some(([method]) => method === "chat:delete"),
    false,
  );
  same(hosts(), ["studio"]);
});

test("an Undo on the list's toast brings the deleted Chat back without deleting it", async () => {
  const project = archiveProject();
  const nav = navigationHost(deferred().promise, {
    alert: pressDanger([]),
    session: { client: { ...project.client, url: "mac" }, recent: [{ path: "/p" }], snapshot: project.snapshot, expectActivity() {}, refresh: async () => {} },
  });
  nav.more(nav.row("chat")).props.onSelect("archive");
  await settleAll();
  toastPill(nav.render(), "Chat deleted").props.onUndo();
  await settleAll();
  assert.ok(nav.row("chat"), "the row is back");
  assert.equal(
    project.calls.some(([method]) => method === "chat:delete" || method === "worktree:remove"),
    false,
  );
  assert.deepEqual(
    project.calls.filter(([method]) => method === "chat:patch").map((call) => call[3]),
    [{ archived: true, unread: false }, { archived: false }],
  );
});

test("deleting the open Chat from the sidebar stays in place through the deletion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = archiveProject();
  const patch = deferred();
  const nav = navigationHost(deferred().promise, {
    alert: pressDanger([]),
    activeChatId: 5,
    session: {
      client: { ...project.client, url: "mac", call: (method, args) => (method === "chat:patch" ? patch.promise : project.call(method, args)) },
      recent: [{ path: "/p" }],
      snapshot: project.snapshot,
      expectActivity() {},
      refresh: async () => {},
    },
  });
  nav.more(nav.row("chat")).props.onSelect("archive");
  await settleAll();
  assert.deepEqual(nav.routes, [], "deleting must not close or replace the sidebar");
  patch.resolve();
  await passUndo(t);
  assert.deepEqual(nav.routes, []);
  assert.equal(archiveStore.archiveActivity().chats.has("/p#5"), false);
});

test("the Chat screen opens its sidebar once on archive without replacing the screen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = archiveProject();
  const patch = deferred();
  const screen = chatHost({ alert: pressDanger([]), call: (method, args) => (method === "chat:patch" ? patch.promise : project.call(method, args)) });
  screen.session.snapshot = project.snapshot;
  screen.session.client.snapshot = async () => project.snapshot;
  screen.params.id = "5";
  delete screen.params.worktreeId;
  const menuAction = () => chatMenuEntry(screen.render(), "Delete");
  menuAction().props.onPress();
  await settleAll();
  assert.equal(screen.panels.open, "left", "shows the sidebar before the archive ends");
  assert.deepEqual(screen.panels.shown, ["left"]);
  assert.equal(screen.router.replaced, undefined, "no route replacement can reset or slide the sidebar");
  assert.ok(archiveStore.archiveActivity().chats.has("/p#5"), "the list shows the archive on the Chat's row");
  // The phone moves on to another Chat while the archive runs.
  screen.router.replaced = "/chat?id=9";
  patch.resolve();
  await passUndo(t);
  assert.equal(screen.router.replaced, "/chat?id=9", "the end of the archive does not pull the phone back to the list");
  assert.equal(archiveStore.archiveActivity().chats.has("/p#5"), false);
  assert.deepEqual(screen.panels.shown, ["left"], "completion must not reopen the sidebar");
});

test("mobile Ports pill requests only its Chat and hides empty or mismatched responses", async (t) => {
  for (const reply of [
    { chatId: "/p#7", ports: [] },
    { chatId: "/p#8", ports: [{ port: 3000, pid: 22 }] },
    { chatId: "/p#7", ports: [{ port: 3000, pid: 22 }] },
  ]) {
    const calls = [];
    const h = simulatorHost(
      {
        url: "mac",
        call: async (...args) => {
          calls.push(args);
          return reply;
        },
      },
      "ports.tsx",
    );
    t.after(() => h.cleanup());
    const render = () => h.render("TestChatPorts", { chatId: "/p#7" });
    assert.equal(render(), null);
    await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["chat:ports", ["/p#7"]]]);
    if (reply.chatId === "/p#7" && reply.ports.length) assert.equal(render().props.accessibilityLabel, "Ports, 1 listening");
    else assert.equal(render(), null);
  }
});

test("mobile Ports sheet stops only this Chat's process and refuses another host", async (t) => {
  const calls = [];
  let ports = [{ port: 3000, pid: 22, command: "node", address: "127.0.0.1" }];
  const client = {
    url: "mac",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "agent:stop-port") {
        ports = [];
        return true;
      }
      return { chatId: "/p#7", ports };
    },
  };
  const h = simulatorHost(client, "ports.tsx");
  t.after(() => h.cleanup());
  const render = () => h.render("PortsSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  await find(render(), (n) => n.props.accessibilityLabel === "Stop port 3000").props.onPress();
  await settle();
  assert.ok(calls.some(([method, args]) => method === "agent:stop-port" && args[0] === "/p#7" && args[1] === 22));
  assert.equal(
    find(render(), (n) => n.props.accessibilityLabel === "Stop port 3000"),
    undefined,
  );
  const other = simulatorHost(client, "ports.tsx");
  t.after(() => other.cleanup());
  calls.length = 0;
  other.render("PortsSheet", { hostId: "other", chatId: "/p#7" });
  await settle();
  assert.deepEqual(calls, []);
});

test("mobile Ports sheet opens both LAN and loopback servers internally and copies a reachable address", async (t) => {
  const opened = [],
    copied = [];
  const ports = [
    { port: 5173, pid: 22, command: "node", address: "*" },
    { port: 3000, pid: 23, command: "node", address: "127.0.0.1" },
  ];
  const client = { url: "mac", call: async () => ({ chatId: "/p#7", ports }) };
  const h = simulatorHost(client, "ports.tsx", {
    native: { Linking: { openURL: async (url) => opened.push(url) } },
    modules: {
      "./browser-link": { openBrowserLink: (...args) => opened.push(args) },
      "expo-clipboard": { setStringAsync: async (value) => copied.push(value) },
      "./routes-native": { useReachableHost: (id) => (id === "mac" ? "100.69.206.111" : null) },
    },
  });
  t.after(() => h.cleanup());
  const render = () => h.render("PortsSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  find(render(), (n) => n.props.accessibilityLabel === "Open http://localhost:5173").props.onPress();
  find(render(), (n) => n.props.accessibilityLabel === "Open http://localhost:3000").props.onPress();
  assert.deepEqual(opened, [
    ["mac", "/p#7", "http://localhost:5173", null],
    ["mac", "/p#7", "http://localhost:3000", null],
  ]);
  assert.match(JSON.stringify(render()), /localhost only/);
  await find(render(), (n) => n.props.accessibilityLabel === "Copy address for port 5173").props.onPress();
  assert.deepEqual(copied, ["http://100.69.206.111:5173"]);
});

test("mobile Ports sheet drops a server Stop ended before the host's list comes back", async (t) => {
  let refetch = null;
  let stopped = false;
  const ports = [
    { port: 3000, pid: 22, command: "node", address: "127.0.0.1" },
    { port: 8081, pid: 23, command: "node", address: "*" },
  ];
  const client = {
    url: "mac",
    call: async (method) => {
      if (method === "agent:stop-port") {
        stopped = true;
        return true;
      }
      // The list after Stop hasn't come back yet.
      if (stopped) return new Promise((resolve) => (refetch = resolve));
      return { chatId: "/p#7", ports };
    },
  };
  const h = simulatorHost(client, "ports.tsx");
  t.after(() => h.cleanup());
  const render = () => h.render("PortsSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  void find(render(), (n) => n.props.accessibilityLabel === "Stop port 3000").props.onPress();
  await settle();
  assert.equal(
    find(render(), (n) => n.props.accessibilityLabel === "Stop port 3000"),
    undefined,
    "the stopped row leaves at once",
  );
  assert.ok(
    find(render(), (n) => n.props.accessibilityLabel === "Stop port 8081"),
    "the other server stays",
  );
  assert.equal(typeof refetch, "function", "the list is read again right after Stop");
  // The host's list has the last word.
  refetch({ chatId: "/p#7", ports: [ports[1]] });
  await settle();
  assert.equal(
    find(render(), (n) => n.props.accessibilityLabel === "Stop port 3000"),
    undefined,
  );
});

/** The viewers' chrome (viewer-chrome.tsx) as it runs, its native pieces faked. */
function viewerChrome(react) {
  return load("viewer-chrome.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable", TextInput: "TextInput" },
    "@hugeicons/core-free-icons": {},
    "./icons": { Icon: "Icon" },
    "./ui": { tap() {} },
  });
}

function artifactHost(client, pushes = [], router = { back() {} }, feature = designsOn, openTab = null) {
  const react = hookHost({ effects: true }),
    files = new Map(),
    share = load("share-availability.ts", {});
  const appListeners = new Set();
  // The cache, as expo-file-system's File and Directory see it: a file is its bytes (or the text written to it).
  class Directory {
    constructor(_cache, name) {
      this.uri = "file:///cache/" + name;
    }
    get exists() {
      return true;
    }
    create() {}
  }
  class File {
    constructor(parent, name) {
      this.uri = (parent instanceof Directory ? parent.uri + "/" : "file:///cache/") + name;
    }
    writeSync(value) {
      files.set(this.uri, value);
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return files.get(this.uri)?.length ?? 0;
    }
    create() {
      files.set(this.uri, new Uint8Array());
    }
    open() {
      return {
        writeBytes: (bytes) => files.set(this.uri, new Uint8Array([...files.get(this.uri), ...bytes])),
        close() {},
      };
    }
    move(target) {
      if (files.has(target.uri)) throw new Error("exists");
      files.set(target.uri, files.get(this.uri));
      files.delete(this.uri);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const source = load(
    "artifact.tsx",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Text: "Text",
        View: "View",
        Pressable: "Pressable",
        TextInput: "TextInput",
        StyleSheet: { absoluteFill: {} },
        AppState: {
          addEventListener: (_event, listener) => {
            appListeners.add(listener);
            return { remove: () => appListeners.delete(listener) };
          },
        },
      },
      "expo-router": { router: { back: () => router.back(), push: (route) => pushes.push(route) } },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 47, bottom: 34 }) },
      "@expo/dom-webview": { DomWebView: "DomWebView" },
      "expo-file-system": { File, Paths: { cache: "/cache" } },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
      "./design-outbox": require("../apps/mobile/src/design-outbox.ts"),
      "./design-page-share": { DesignPageShareSheet: "DesignPageShareSheet" },
      "./panel-tabs": { usePanelTabs: () => openTab },
      // A page's files come into the cache (artifact-files.ts); a page without files shows at once.
      "./artifact-files": load("artifact-files.ts", {
        react,
        "expo-file-system": { Directory, File, FileMode: {}, Paths: { cache: "/cache" } },
        "@milagre/shared/attachment-download": require("../packages/shared/src/attachment-download.mjs"),
        "@milagre/shared/artifact-assets": require("../packages/shared/src/artifact-assets.mjs"),
      }),
      "./session": { useSession: () => ({ client, designs: feature }) },
      "./use-design-catalog": load("use-design-catalog.ts", {
        react: { ...react, useSyncExternalStore: (_subscribe, read) => read() },
        "./design-catalog": require("../apps/mobile/src/design-catalog.ts"),
      }),
      "./icons": { Icon: "Icon" },
      "./ui": { PillButton: "PillButton", PullDown: "PullDown", tap() {}, colors: {}, styles: {} },
      "./pele-script": { PELE_SCRIPT: "var pele={};" },
      "./share-availability": share,
      "./viewer-chrome": viewerChrome(react),
    },
    "\nexports.TestArtifactWebView = ArtifactWebView;\nexports.ArtifactCard = ArtifactCard;",
  );
  const injected = [];
  const host = {
    files,
    share,
    setClient(next) {
      client = next;
    },
    appState(status) {
      for (const listener of appListeners) listener(status);
    },
    render(name, props) {
      react.begin();
      const tree = source[name](props);
      react.flush();
      return tree;
    },
    /** What the sheet told the page's helper, as commands. */
    commands() {
      return injected.map((script) => JSON.parse(/run\((.*)\);true;$/s.exec(script)[1]));
    },
    /** The page's helper saying something to the sheet, through the shell. */
    say(tree, message) {
      find(tree, (node) => node.type?.name === "ArtifactWebView").props.onMessage(JSON.stringify(message));
    },
    /** The sheet with its page loaded and its helper ready. */
    async open(props) {
      host.render("ArtifactSheet", props);
      await settle();
      host.render("ArtifactSheet", props);
      await settle();
      let tree = host.render("ArtifactSheet", props);
      const page = find(tree, (node) => node.type?.name === "ArtifactWebView");
      assert.ok(page, "the page opens");
      page.props.ref.current = { injectJavaScript: (script) => injected.push(script) };
      host.say(tree, { t: "ready" });
      tree = host.render("ArtifactSheet", props);
      return tree;
    },
    cleanup() {
      react.cleanup();
    },
  };
  return host;
}

/** DesignsSheet with its native pieces faked; `open` walks it to a loaded design on a canvas page that said ready. */
function designsHost(client, router = { back() {} }, feature = designsOn, pushes = []) {
  let reconnects = 0;
  const react = hookHost({ effects: true }),
    files = new Map(),
    injected = [],
    share = load("share-availability.ts", {});
  const appListeners = new Set();
  class File {
    constructor(_cache, name) {
      this.uri = "file:///cache/" + name;
    }
    writeSync(value) {
      files.set(this.uri, value);
    }
    get exists() {
      return files.has(this.uri);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const source = load(
    "designs-sheet.tsx",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Alert: { alert() {} },
        Text: "Text",
        View: "View",
        Pressable: "Pressable",
        TextInput: "TextInput",
        StyleSheet: { absoluteFill: {} },
        AppState: {
          addEventListener: (_event, listener) => {
            appListeners.add(listener);
            return { remove: () => appListeners.delete(listener) };
          },
        },
      },
      "expo-router": { router: { back: () => router.back(), push: (route) => pushes.push(route) } },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 47, bottom: 34 }) },
      "react-native-reanimated": {
        __esModule: true,
        default: { View: "Animated.View", createAnimatedComponent: (component) => component },
        FadeOut: { duration: () => ({}) },
        Easing: { inOut: () => () => 0, quad: () => 0 },
        useAnimatedProps: (fn) => fn,
        useAnimatedStyle: (fn) => fn,
        useReducedMotion: () => true,
        useSharedValue: (value) => ({ value, set() {} }),
        withRepeat: (value) => value,
        withTiming: (value) => value,
      },
      "react-native-svg": { __esModule: true, default: "Svg", Circle: "Circle", Path: "Path" },
      "@expo/dom-webview": { DomWebView: "DomWebView" },
      "expo-file-system": { File, Paths: { cache: "/cache" } },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
      "./design-outbox": require("../apps/mobile/src/design-outbox.ts"),
      "./session": { useSession: () => ({ client, designs: feature, reconnects }) },
      "./use-design-catalog": { markDesignDeleted() {} },
      "./icons": { Icon: "Icon", SpinnerRing: "SpinnerRing" },
      "./ui": { PillButton: "PillButton", PullDown: "PullDown", tap() {} },
      "./share-availability": share,
      "./viewer-chrome": viewerChrome(react),
    },
    "\nexports.TestDesignsCanvas = DesignsCanvas;",
  );
  const host = {
    files,
    shareAvailabilityChanged: (...args) => share.shareAvailabilityChanged(...args),
    setClient(next) {
      client = next;
    },
    reconnect() {
      reconnects++;
    },
    appState(status) {
      for (const listener of appListeners) listener(status);
    },
    render(name, props) {
      react.begin();
      const tree = source[name](props);
      react.flush();
      return tree;
    },
    /** What the sheet told the canvas page, as commands. */
    commands() {
      return injected.map((script) => JSON.parse(/run\((.*)\);true;$/s.exec(script)[1]));
    },
    /** The canvas page saying something to the sheet. */
    say(tree, message) {
      find(tree, (node) => node.type?.name === "DesignsCanvas").props.onMessage(JSON.stringify(message));
    },
    async open(props) {
      host.render("DesignsSheet", props);
      await settle();
      host.render("DesignsSheet", props);
      await settle();
      let tree = host.render("DesignsSheet", props);
      const canvas = find(tree, (node) => node.type?.name === "DesignsCanvas");
      assert.ok(canvas, "the designs open on their canvas");
      canvas.props.ref.current = { injectJavaScript: (script) => injected.push(script) };
      host.say(tree, { t: "ready" });
      tree = host.render("DesignsSheet", props);
      return tree;
    },
    cleanup() {
      react.cleanup();
    },
  };
  return host;
}
const menuItems = (tree) => find(tree, (node) => node.type === "PullDown")?.props.sections.flatMap((section) => section.items) ?? [];

test("structured designs on mobile open on their canvas, with versions in the menu and no edit controls", async () => {
  const { createExampleDesign, designHtml } = require("../packages/shared/src/design.mjs");
  const document = createExampleDesign();
  const latest = {
    id: "fieldnotes",
    version: 2,
    latest: 2,
    versions: 2,
    title: "Fieldnotes",
    format: "design",
    width: 390,
    height: 844,
    html: designHtml(document),
    document,
  };
  const calls = [];
  const client = {
    url: "mac",
    call: async (method, [request]) => {
      calls.push([method, request]);
      if (method === "artifact:list") return [latest];
      if (method === "artifact:get") return { ...latest, version: request.version ?? 2 };
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      throw new Error(`Unexpected request: ${method}`);
    },
  };
  const h = designsHost(client);
  const props = { hostId: "mac", chatId: "/p#7", id: "fieldnotes", version: "2" };
  let tree = await h.open(props);
  const commands = h.commands();
  assert.deepEqual(commands.find((command) => command.t === "set").rows, [{ group: "", designs: [{ id: "fieldnotes", w: 390, h: 844 }] }]);
  assert.equal(commands.find((command) => command.t === "set").focus, "fieldnotes");
  assert.equal(
    commands.find((command) => command.t === "html" && command.id === "fieldnotes").doc,
    require("../packages/shared/src/artifact.ts").artifactDocument(latest.html),
    "the design goes on the canvas",
  );
  assert.equal(
    find(tree, (node) => /^Edit|^Save$|^Layers$|^Inspect$/.test(node.props?.title ?? "")),
    undefined,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(menuItems(tree).map((item) => item.id))), ["choose", "version:2", "version:1", "delete"]);
  find(tree, (node) => node.type === "PullDown").props.onSelect("version:1");
  h.render("DesignsSheet", props);
  await settle();
  tree = h.render("DesignsSheet", props);
  assert.equal(calls.at(-1)[1].version, 1);
  find(tree, (node) => node.type === "PullDown").props.onSelect("version:2");
  h.render("DesignsSheet", props);
  await settle();
  assert.equal(calls.at(-1)[0], "artifact:get");
  assert.equal(calls.at(-1)[1].version, 2, "returning to the latest version pins the current summary's saved design");
  h.cleanup();
});

test("canvas fonts are injected once per page and replayed before documents after reload", async () => {
  const { createExampleDesign } = require("../packages/shared/src/design.mjs");
  const document = createExampleDesign();
  const designs = ["one", "two", "three", "four"].map((id) => ({
    id,
    version: 1,
    latest: 1,
    versions: 1,
    title: id,
    format: "design",
    width: 390,
    height: 844,
    document,
    html: "<html><head></head><body></body></html>",
  }));
  const calls = [];
  const client = {
    url: "mac",
    call: async (method, [request] = []) => {
      if (method === "artifact:list") return designs;
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      calls.push(request);
      return {
        ...designs.find((item) => item.id === request.id),
        fontKey: "shared",
        ...(request.fonts.have.includes("shared") ? {} : { fontCss: "@font-face{test:yes}" }),
      };
    },
  };
  const h = designsHost(client);
  const props = { hostId: "mac", chatId: "/p#7", id: "one" };
  let tree = await h.open(props);
  await settle();
  tree = h.render("DesignsSheet", props);
  const first = h.commands();
  assert.equal(first.filter((command) => command.t === "fonts").length, 1);
  assert.equal(first.filter((command) => command.t === "html").length, 4);
  assert.ok(first.findIndex((command) => command.t === "fonts") < first.findIndex((command) => command.t === "html"));
  assert.ok(
    calls.slice(1).every((request) => request.fonts.have.includes("shared")),
    "the opened design warms all lanes",
  );
  h.say(tree, { t: "ready" });
  h.render("DesignsSheet", props);
  const replay = h.commands().slice(first.length);
  assert.equal(replay.filter((command) => command.t === "fonts").length, 1);
  assert.equal(replay.filter((command) => command.t === "html").length, 4);
  assert.ok(replay.findIndex((command) => command.t === "fonts") < replay.findIndex((command) => command.t === "html"));
  h.cleanup();
});

test("a superseding canvas effect reuses an outstanding design read", async () => {
  const { createExampleDesign } = require("../packages/shared/src/design.mjs");
  const design = {
    id: "one",
    version: 1,
    latest: 1,
    versions: 1,
    title: "One",
    format: "design",
    width: 390,
    height: 844,
    document: createExampleDesign(),
    html: "<html><head></head></html>",
  };
  let finish;
  let gets = 0;
  const client = {
    url: "mac",
    call: async (method) => {
      if (method === "artifact:list") return [design];
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      gets++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const h = designsHost(client);
  const props = { hostId: "mac", chatId: "/p#7", id: "one" };
  await h.open(props);
  assert.equal(gets, 1);
  h.reconnect();
  h.render("DesignsSheet", props);
  await settle();
  assert.equal(gets, 1, "the new effect subscribes to the original read");
  finish(design);
  await settle();
  h.render("DesignsSheet", props);
  assert.equal(h.commands().filter((command) => command.t === "html").length, 1);
  h.cleanup();
});

test("a design card opens its Chat's design full screen; a new Chat's card can't", () => {
  const pushes = [];
  const h = artifactHost({ url: "mac" }, pushes);
  const step = { id: "s1", kind: "artifact", title: "Showed `Login`", status: "done", artifact: { id: "login", version: 2, title: "Login" } };
  const card = h.render("ArtifactCard", { step, chatId: "/p#7" });
  card.props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(pushes)), [{ pathname: "/artifact-sheet", params: { hostId: "mac", chatId: "/p#7", id: "login", version: "2" } }]);
  assert.equal(h.render("ArtifactCard", { step, chatId: "/p#new:1" }).props.disabled, true);
});

test("the designs sheet loads the version it opened, on a canvas page that runs only its own script", async () => {
  const { createExampleDesign, designHtml } = require("../packages/shared/src/design.mjs");
  const document = createExampleDesign();
  const calls = [];
  const client = {
    url: "mac",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "artifact:list") return [{ id: "login", format: "design", version: 2, title: "Login", versions: 2, width: 390, height: 844 }];
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      return {
        id: "login",
        format: "design",
        document,
        version: 1,
        latest: 2,
        versions: 2,
        title: "Login",
        width: 390,
        height: 844,
        html: designHtml(document),
      };
    },
  };
  const h = designsHost(client);
  await h.open({ hostId: "mac", chatId: "/p#7", id: "login", version: "1" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([method]) => method === "artifact:get"))), [
    ["artifact:get", [{ chatId: "/p#7", id: "login", version: 1, fonts: { have: [] } }]],
  ]);
  for (const method of ["artifact:sharing-status", "artifact:list", "artifact:comments"])
    assert.ok(
      calls.some(([called]) => called === method),
      method,
    );
  const web = designsHost(client);
  web.render("TestDesignsCanvas", { ref: { current: null }, onMessage() {} });
  const frame = find(web.render("TestDesignsCanvas", { ref: { current: null }, onMessage() {} }), (node) => node.type === "DomWebView");
  assert.ok(frame);
  assert.equal(frame.props.useExpoModulesBridge, false);
  assert.equal(typeof frame.props.onMessage, "function", "the canvas script reports holds, pins and the view");
  // The page runs only the canvas script, by its hash; each design's frame is made sandboxed with no scripts.
  const page = web.files.get(frame.props.source.uri);
  assert.match(page, /script-src 'sha256-/);
  assert.doesNotMatch(page, /script-src 'unsafe-inline'/);
  assert.match(page, /frame-src 'none'/);
  web.cleanup();
  assert.equal(web.files.size, 0);
  h.cleanup();
});

test("on the designs sheet, a held spot's comment and the choice wait for Send, which hands one message to the Chat", async () => {
  const { createExampleDesign, designHtml } = require("../packages/shared/src/design.mjs");
  const document = createExampleDesign();
  const outbox = require("../apps/mobile/src/design-outbox.ts");
  let backs = 0;
  const recorded = [];
  const client = {
    url: "mac",
    call: async (method, args) => {
      if (method === "artifact:add-comments") recorded.push(...args[0].comments);
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      return method === "artifact:list"
        ? [{ id: "home", format: "design", version: 1, title: "Home", versions: 1, width: 390, height: 844 }]
        : { id: "home", format: "design", document, version: 1, latest: 1, versions: 1, title: "Home", width: 390, height: 844, html: designHtml(document) };
    },
  };
  const h = designsHost(client, { back: () => backs++ });
  const props = { hostId: "mac", chatId: "/p#7", id: "home", version: "1" };
  let tree = await h.open(props);
  const sendButton = (node) => node.type?.name === "SendButton";
  assert.equal(find(tree, sendButton), undefined, "nothing to send yet");
  find(tree, (node) => node.type === "PullDown").props.onSelect("choose");
  tree = h.render("DesignsSheet", props);
  assert.equal(outbox.peekDesignMessage("mac|/p#7"), null, "choosing alone sends nothing");
  assert.equal(menuItems(tree).find((item) => item.id === "choose").checked, true);
  // Holding the design opens a comment at that spot once the canvas has brought it into view.
  h.say(tree, { t: "press", id: "home", x: 0.5, y: 0.25 });
  tree = h.render("DesignsSheet", props);
  assert.deepEqual(
    h.commands().find((command) => command.t === "reveal"),
    { t: "reveal", id: "home", x: 0.5, y: 0.25 },
  );
  h.say(tree, { t: "anchor", sx: 40, sy: 120 });
  tree = h.render("DesignsSheet", props);
  const box = find(tree, (node) => node.type?.name === "CommentBox");
  assert.deepEqual(JSON.parse(JSON.stringify(box.props.at)), { x: 40, y: 120 });
  box.props.onChange("Bigger title");
  box.props.onDone();
  tree = h.render("DesignsSheet", props);
  assert.equal(
    find(tree, (node) => node.type?.name === "CommentBox"),
    undefined,
  );
  const pins = h.commands().findLast((command) => command.t === "pins").pins;
  assert.deepEqual(
    pins.map(({ id, x, y, n }) => ({ id, x, y, n })),
    [{ id: "home", x: 0.5, y: 0.25, n: 1 }],
  );
  find(tree, sendButton).props.onPress();
  await settle();
  const message = outbox.peekDesignMessage("mac|/p#7");
  const id = /\(comment ([a-f0-9]{8})\)/.exec(message.text)?.[1];
  assert.equal(
    message.text,
    `I chose the design "Home" (home, version 1). Continue from this one.\n\nA comment on the designs:\n\n1. (comment ${id}) On the design "Home" (home, version 1), 50% across and 25% down: Bigger title\n\nRead the latest design with design_read, then revise its layers with design_apply and expectedVersion. Keep its id. Once you have addressed a comment, resolve it with artifact_resolve_comment and its comment id.`,
  );
  assert.equal(recorded.length, 0, "the comments are recorded only once the message went");
  outbox.designMessageSent("mac|/p#7", message);
  await settle();
  assert.deepEqual(
    recorded.map((comment) => [comment.id, comment.text, comment.x, comment.y]),
    [[id, "Bigger title", 0.5, 0.25]],
  );
  assert.equal(outbox.peekDesignMessage("mac|/p#7"), null, "a message is sent once");
  assert.equal(backs, 1);
  h.cleanup();
});

test("feedback from the designs shows as a card of the choice and each comment", async () => {
  const h = artifactHost({ url: "mac", call: async () => [{ id: "home", format: "design", version: 2, title: "Home" }] });
  const { parseDesignFeedback, designFeedbackMessage } = require("../packages/shared/src/artifact.ts");
  const home = { id: "home", version: 2, title: "Home" };
  const feedback = parseDesignFeedback(designFeedbackMessage({ choice: home, comments: [{ design: home, x: 0.5, y: 0.2, text: "Bigger title" }] }));
  h.render("DesignFeedbackCard", { feedback, chatId: "/p#7" });
  await settle();
  const tree = h.render("DesignFeedbackCard", { feedback, chatId: "/p#7" });
  const texts = [];
  const walk = (node) => {
    if (typeof node === "string" || typeof node === "number") texts.push(String(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node?.props) walk(node.props.children);
  };
  walk(tree);
  const all = texts.join("|");
  assert.match(all, /Chose \|?Home/);
  assert.match(all, /Bigger title/);
  assert.doesNotMatch(all, /artifact_show/, "the agent's instructions stay out of sight");
  h.cleanup();
});

test("a reply shows the thinking it wrote nothing after, once it waits on a question or ends, not while working", () => {
  const react = { memo: (fn) => fn, useCallback: (fn) => fn, useEffect() {}, useRef: () => ({}), useState: (value) => [value, () => {}] };
  const { ChatReply } = load("chat-reply.tsx", {
    "./advisor-result-card": { AdvisorResultCard: "AdvisorResultCard" },
    "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
    "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
    react: { ...react, useMemo: (compute) => compute() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View", useColorScheme: () => "dark" },
    "react-native-svg": { default: "Svg", Path: "Path" },
    "expo-router": { router: {} },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "./file-chip": { FileChip: "FileChip" },
    "./markdown": { Markdown: "Markdown" },
    "./icons": { Icon: "Icon" },
    "./activity-item": { ActivityTitle: "ActivityTitle" },
    "./tool-row": { ToolRow: "ToolRow" },
    "./artifact": { ArtifactCards: "ArtifactCards", DesignFeedbackCard: "DesignFeedbackCard" },
    "@milagre/shared/page-comments": { parsePageComments: () => null },
    "./page-comments-card": { PageCommentsCard: "PageCommentsCard" },
    "./answer-card": { AnswerCard: "AnswerCard" },
    "./chat-display-setting": { useToolCallDisplay: () => ["compact", () => {}] },
    "./pr-action-card": { PullRequestActionCard: "PullRequestActionCard" },
    "./linear-issue-card": { LinearIssueCard: "LinearIssueCard" },
    "./heartbeat-card": { HeartbeatCard: "HeartbeatCard" },
    "./computer-use-card": { ComputerUseCard: "ComputerUseCard" },
    "./usage-limit-card": { UsageLimitCard: "UsageLimitCard" },
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
    "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
    "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
    "./theme": { hex: () => "#000" },
    "./viewer-store": { showImages() {} },
    "./ui": { colors: {}, styles: { card: {}, row: {}, muted: {} } },
  });
  // Answers to the agent's questions show as a card, not as the summary text.
  const answered = [{ header: "Color", question: "Which color?", answers: ["Red"] }];
  const answerTree = ChatReply({
    message: { id: 1, session_id: 1, body: "Red", context: null, role: "user", answered },
    onActivity() {},
    media: (path) => path,
  });
  const findType = (node, type) =>
    Array.isArray(node) ? node.some((child) => findType(child, type)) : !!node?.props && (node.type === type || findType(node.props.children, type));
  assert.ok(findType(answerTree, "AnswerCard"));
  // So does a PR-blocker pill's action, instead of its body text.
  const prTree = ChatReply({
    message: {
      id: 2,
      session_id: 1,
      body: "Fix CI on pull request #77",
      context: { kind: "pr-action", action: "checks-failed", pr: 77, url: "https://github.com/o/r/pull/77" },
      role: "user",
    },
    onActivity() {},
    media: (path) => path,
  });
  assert.ok(findType(prTree, "PullRequestActionCard"));
  assert.ok(!findType(prTree, "Text"), "no bubble with the body text");
  // And a Chat's first message when it was started from a Linear issue.
  const issueTree = ChatReply({
    message: {
      id: 3,
      session_id: 1,
      body: "Work on Linear issue ENG-12: Fix login\n\nhttps://linear.app/acme/issue/ENG-12",
      context: {
        kind: "linear-issue",
        key: "ENG-12",
        title: "Fix login",
        url: "https://linear.app/acme/issue/ENG-12",
        state: { name: "Todo", type: "unstarted", color: "#aaa" },
      },
      role: "user",
    },
    onActivity() {},
    media: (path) => path,
  });
  assert.ok(findType(issueTree, "LinearIssueCard"));
  assert.ok(!findType(issueTree, "Text"), "no bubble with the prompt text");
  const conclusion = "T3 Code tries every route in parallel.";
  const steps = [
    { id: "t1", kind: "thinking", title: "Thought", status: "done", detail: "Looking.", offset: 9 },
    { id: "a", kind: "other", title: "Ran an agent", status: "done", offset: 9 },
    { id: "t2", kind: "thinking", title: "Thought", status: "done", detail: conclusion, offset: 9 },
  ];
  const run = (questions) => ({ text: "Checking.", model: "m", startedAt: 0, steps, approvals: [], questions, answered: {} });
  const markdown = (tree) => {
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === "Markdown") texts.push(node.props.text);
      walk(node.props?.children);
    };
    walk(tree);
    return texts;
  };
  const props = { media: () => null, onActivity() {} };
  assert.deepEqual(markdown(ChatReply({ ...props, run: run([{ requestId: "q" }]) })), ["Checking.", conclusion]);
  assert.deepEqual(markdown(ChatReply({ ...props, run: run([]) })), ["Checking."]);
  assert.deepEqual(markdown(ChatReply({ ...props, message: { id: 1, session_id: 1, role: "assistant", body: "Checking.", steps } })), [
    "Checking.",
    conclusion,
  ]);
  assert.deepEqual(
    markdown(ChatReply({ ...props, message: { id: 1, session_id: 1, role: "assistant", body: "Checking. Done.", steps: [{ ...steps[2], offset: 0 }] } })),
    ["Checking. Done."],
  );
});

test("mobile Full detail shows each tool call and the notes between them in the Chat, with no activity fold", () => {
  const react = { memo: (fn) => fn, useCallback: (fn) => fn, useEffect() {}, useRef: () => ({}), useState: (value) => [value, () => {}] };
  const reply = (display) =>
    load("chat-reply.tsx", {
      "./advisor-result-card": { AdvisorResultCard: "AdvisorResultCard" },
      "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
      "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
      react: { ...react, useMemo: (compute) => compute() },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View", useColorScheme: () => "dark" },
      "react-native-svg": { default: "Svg", Path: "Path" },
      "expo-router": { router: {} },
      "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
      "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
      "./file-chip": { FileChip: "FileChip" },
      "./markdown": { Markdown: "Markdown" },
      "./icons": { Icon: "Icon" },
      "./activity-item": { ActivityTitle: "ActivityTitle" },
      "./tool-row": { ToolRow: "ToolRow" },
      "./artifact": { ArtifactCards: "ArtifactCards", DesignFeedbackCard: "DesignFeedbackCard" },
      "@milagre/shared/page-comments": { parsePageComments: () => null },
      "./page-comments-card": { PageCommentsCard: "PageCommentsCard" },
      "./answer-card": { AnswerCard: "AnswerCard" },
      "./chat-display-setting": { useToolCallDisplay: () => [display, () => {}] },
      "./pr-action-card": { PullRequestActionCard: "PullRequestActionCard" },
      "./linear-issue-card": { LinearIssueCard: "LinearIssueCard" },
      "./heartbeat-card": { HeartbeatCard: "HeartbeatCard" },
      "./computer-use-card": { ComputerUseCard: "ComputerUseCard" },
      "./usage-limit-card": { UsageLimitCard: "UsageLimitCard" },
      "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
      "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
      "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
      "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
      "./theme": { hex: () => "#000" },
      "./viewer-store": { showImages() {} },
      "./ui": { colors: {}, styles: { card: {}, row: {}, muted: {} } },
    }).ChatReply;
  const body = "Running the tests.Tests pass, reading the config.Done.";
  const steps = [
    { id: "a", kind: "shell", title: "Ran `npm test`", status: "done", offset: 18 },
    { id: "b", kind: "read", title: "Read `package.json`", status: "done", offset: 49 },
    { id: "c", kind: "search", title: "Searched for `muriloMode`", status: "done", offset: 49 },
  ];
  const props = { media: () => null, onActivity() {}, message: { id: 1, session_id: 1, role: "assistant", body, steps } };
  const shown = (tree) => {
    const rows = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === "ToolRow") rows.push(node.props.step.id);
      else if (node.type === "Markdown") rows.push(node.props.text);
      else if (typeof node.type === "function" && node.type.name === "ActivityRow") rows.push("fold");
      walk(node.props?.children);
    };
    walk(tree);
    return rows;
  };
  assert.deepEqual(shown(reply("compact")(props)), ["fold", "Done."], "Compact: the activity folds into one row");
  assert.deepEqual(
    shown(reply("full")(props)),
    ["Running the tests.", "a", "Tests pass, reading the config.", "b", "c", "Done."],
    "Full detail: every step and note, in order",
  );
  const opened = [];
  const live = { text: "", steps: steps.map((step) => ({ ...step, offset: 0, status: "running" })), approvals: [{ stepId: "b" }], questions: [] };
  const tree = reply("full")({ ...props, message: undefined, run: live, onActivity: (...args) => opened.push(args) });
  find(tree, (node) => node.type === "ToolRow" && node.props.step.id === "b").props.onPress();
  assert.deepEqual(opened, [["run", "b"]], "tapping a call opens that exact call in the sheet");
  assert.equal(find(tree, (node) => node.type === "ToolRow" && node.props.step.id === "a").props.waiting, false);
  assert.equal(find(tree, (node) => node.type === "ToolRow" && node.props.step.id === "b").props.waiting, true);
});

test("mobile activity sheet opens the selected call without paging and keeps approval asks in Chat", () => {
  const react = hookHost();
  let params = { id: "1", message: "run", stepId: "b" };
  const steps = ["a", "b", "c"].map((id) => ({ id, kind: "shell", title: `Ran ${id}`, status: "running" }));
  const run = { text: "", steps, approvals: [{ requestId: "approval-b", stepId: "b" }], questions: [] };
  const { default: ActivitySheet } = load("app/activity.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { useLocalSearchParams: () => params, router: { back() {} } },
    "@hugeicons/core-free-icons": { Cancel01Icon: "cancel" },
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "../tool-row": { ToolRow: "ToolRow" },
    "../markdown": { Markdown: "Markdown" },
    "../chat-pages": { useChatPage: () => ({ messages: [], loading: false, trim() {} }) },
    "../questions": { Approval: "Approval" },
    "../ui": { CircleButton: "CircleButton", PageScroll: "PageScroll", PillButton: "PillButton" },
    "../session": {
      useSession: () => ({
        snapshot: { project: { path: "/project", state: { messages: [] } }, runs: { runs: { "/project#1": run } } },
        client: null,
      }),
    },
  });
  const render = () => {
    react.begin();
    return ActivitySheet();
  };
  let tree = render();
  assert.equal(find(tree, (node) => node.type === "Text" && node.props.accessibilityRole === "header").props.children, "Tool call");
  assert.equal(find(tree, (node) => node.type === "ToolRow").props.expanded, true);
  assert.equal(
    find(tree, (node) => node.type === "PillButton"),
    undefined,
    "the selected call has no paging controls",
  );
  assert.equal(find(tree, (node) => node.type === "ToolRow").props.waiting, true);
  assert.equal(
    find(tree, (node) => node.type === "Approval"),
    undefined,
    "selected call details never contain an approval ask",
  );
  params = { ...params, stepId: "c" };
  tree = render();
  assert.equal(
    find(tree, (node) => node.type === "Approval"),
    undefined,
    "another call never inherits this approval",
  );
  params = { id: "1", message: "run" };
  tree = render();
  assert.equal(
    find(tree, (node) => node.type === "Approval"),
    undefined,
    "the all-calls view keeps asks in Chat too",
  );
});

test("mobile Chat shows linked and unlinked approval asks once in its normal approval area", async () => {
  const screen = ongoingChatHost();
  const answers = [];
  const original = screen.session.client.call;
  screen.session.client.call = (method, args) => {
    if (method !== "agent:respond-permission") return original(method, args);
    answers.push(args[0]);
    return Promise.resolve(true);
  };
  screen.session.snapshot.runs.runs["/p#7"] = {
    text: "Checking.",
    startedAt: Date.now(),
    questions: [],
    answered: {},
    steps: [{ id: "shell", kind: "shell", title: "Ran tests", status: "running" }],
    approvals: [{ requestId: "linked", stepId: "shell" }, { requestId: "unlinked" }],
  };
  const approvals = [];
  find(screen.render(), (node) => {
    if (node.type === "Approval") approvals.push(node);
    return false;
  });
  assert.deepEqual(
    approvals.map((node) => node.props.approval.requestId),
    ["linked", "unlinked"],
  );
  approvals[0].props.respond("allow");
  await settle();
  assert.equal(JSON.stringify(answers), JSON.stringify([{ chatId: "/p#7", requestId: "linked", decision: "allow" }]));
});

test("mobile tool output retries after reconnect and clears the failed-read controls after success", async () => {
  const react = hookHost({ effects: true });
  const requests = [];
  const saved = {
    id: 9,
    session_id: 1,
    role: "assistant",
    body: "Checked.",
    steps: [{ id: "call", kind: "shell", title: "Ran tests", status: "done", hasDetail: true }],
  };
  const session = {
    reconnects: 0,
    snapshot: { project: { path: "/project", state: { messages: [saved] } }, runs: { runs: {} } },
    client: {
      message: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
  };
  const { default: ActivitySheet } = load("app/activity.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { useLocalSearchParams: () => ({ id: "1", message: "9", stepId: "call" }), router: { back() {} } },
    "@hugeicons/core-free-icons": { Cancel01Icon: "cancel" },
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "../tool-row": { ToolRow: "ToolRow" },
    "../markdown": { Markdown: "Markdown" },
    "../chat-pages": { useChatPage: () => ({ messages: [], loading: false, trim() {} }) },
    "../questions": { Approval: "Approval" },
    "../ui": { CircleButton: "CircleButton", PageScroll: "PageScroll", PillButton: "PillButton" },
    "../session": { useSession: () => session },
  });
  const render = () => {
    react.begin();
    return ActivitySheet();
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  render();
  requests[0].reject(new Error("Connection lost"));
  await settle();
  let tree = render();
  find(tree, (node) => node.type === "PillButton" && node.props.title === "Try again").props.onPress();
  render();
  assert.equal(requests.length, 2, "manual retry starts a fresh read");
  requests[1].reject(new Error("Still offline"));
  await settle();
  tree = render();
  assert.ok(find(tree, (node) => node.type === "PillButton" && node.props.title === "Try again"));
  session.reconnects++;
  tree = render();
  assert.equal(requests.length, 3, "the same client automatically retries on reconnect");
  assert.equal(
    find(tree, (node) => node.type === "PillButton"),
    undefined,
    "a new connection leaves the stale error state",
  );
  requests[2].resolve({ ...saved, steps: [{ ...saved.steps[0], detail: "$ tests\n38 passed" }] });
  await settle();
  tree = render();
  assert.equal(find(tree, (node) => node.type === "ToolRow").props.step.detail, "$ tests\n38 passed");
  assert.equal(
    find(tree, (node) => node.type === "PillButton"),
    undefined,
    "success removes the old retry button",
  );
  react.unmount();
});

test("mobile usage identifies the account by email, falls back to its label, and accepts older hosts", () => {
  const { ProviderRows } = load(
    "usage-section.tsx",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: {},
      "react-native": { Text: "Text", View: "View" },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/providers": { providerName: () => "Codex" },
      "@milagre/shared/usage": { formatUpdatedAgo: () => "Updated just now" },
      "./icons": {},
      "./ui": { colors: {}, styles: {} },
      "./session": {},
      "./use-usage": {},
    },
    "\nexport { ProviderRows };\n",
  );
  const provider = { provider: "codex", status: "ok", windows: [], updatedAt: new Date().toISOString() };
  for (const account of [
    { id: "work", label: "Work", email: "work@example.test" },
    { id: "work", label: "Work" },
  ]) {
    const tree = ProviderRows({ provider: { ...provider, account }, now: Date.now() });
    const label = find(tree, (node) => node.type === "Text" && node.props.children === (account.email || account.label));
    assert.ok(label, "The account identity is visible");
    assert.equal(label.props.selectable, true);
    assert.equal(
      find(tree, (node) => node.type === "Text" && node.props.children === "Codex"),
      undefined,
    );
  }
  assert.doesNotThrow(() => ProviderRows({ provider, now: Date.now() }));
});

function subagentGlance() {
  const react = hookHost();
  const glance = load("subagent-glance.tsx", {
    "./display-clock": { useDisplayNow: () => 0 },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, name) => String(name) }),
    "@milagre/shared/agent-activity": require("@milagre/shared/agent-activity"),
    "@milagre/shared/subagent-glance": require("@milagre/shared/subagent-glance"),
    "./icons": { Icon: "Icon", ProviderLogo: "ProviderLogo", SpinnerRing: "SpinnerRing" },
    "./theme": { fonts: { mono: "mono" } },
    "react-native-svg": { default: "Svg", Circle: "Circle", Ellipse: "Ellipse", Polygon: "Polygon", Rect: "Rect" },
  });
  // Function components render in place, so the tree shows what they draw.
  const draw = (node) => {
    if (Array.isArray(node)) return node.map(draw);
    if (!node || typeof node !== "object" || !node.type) return node;
    if (typeof node.type === "function") return draw(node.type(node.props));
    return { ...node, props: { ...node.props, children: draw(node.props?.children) } };
  };
  const render = (Component, props) => {
    react.begin();
    return draw(jsx(Component, props));
  };
  return { ...glance, render };
}
// The text a tree shows: each element's text on its own, its pieces joined as React joins them.
const texts = (tree) => {
  const walk = (node) => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    return node?.props ? ` ${walk(node.props.children)} ` : "";
  };
  return walk(tree).replace(/\s+/g, " ");
};
const glanceAgent = {
  id: "auth",
  title: "Review authentication",
  status: "running",
  startedAt: 1000,
  updatedAt: 2000,
  latestActivity: "Ran `npm test -- auth`",
  progress: { steps: 2, said: "Now running the auth suite.", tools: { reads: 3, commands: 1 } },
  transcript: [
    { id: "m1", kind: "message", text: "The refresh path skips the expiry check. I will confirm it." },
    { id: "t1", kind: "tool", tool: "read", text: "Read `auth.ts`" },
    { id: "m2", kind: "message", text: "Now running the auth suite." },
    { id: "t2", kind: "tool", tool: "shell", text: "Ran `npm test -- auth`" },
  ],
};

test("mobile subagent rows say what it does now and how far it got, and a finished one its outcome", () => {
  const { SubagentRow, render } = subagentGlance();
  const row = render(SubagentRow, { agent: glanceAgent, provider: "claude", now: 66000, onPress() {} });
  const shown = texts(row);
  for (const text of ["Review authentication", "1m 05s", "Now running the auth suite.", "Step 2 · 3 files read · 1 command"])
    assert.ok(shown.includes(text), text);
  const planned = texts(
    render(SubagentRow, {
      agent: {
        ...glanceAgent,
        tasks: [
          { id: "0", content: "Read", status: "completed" },
          { id: "1", content: "Test", status: "in_progress" },
        ],
      },
      provider: "claude",
      now: 66000,
      onPress() {},
    }),
  );
  assert.ok(planned.includes("1 of 2 · 3 files read · 1 command"));
  const done = {
    ...glanceAgent,
    status: "completed",
    endedAt: 11000,
    transcript: [...glanceAgent.transcript, { id: "result", kind: "message", text: "Expiry is skipped on refresh. Patch attached." }],
  };
  const finished = texts(render(SubagentRow, { agent: done, provider: "claude", now: 66000, onPress() {} }));
  assert.ok(finished.includes("Expiry is skipped on refresh."));
  assert.ok(finished.includes("10s"), "a finished subagent's time stops at its end");
});

test("mobile draws a QA persona subagent with its name, QA tag and persona card", () => {
  const { SubagentRow, WholeSubagentDetail, render } = subagentGlance();
  const agent = { ...glanceAgent, agentType: "qa-mobile", title: "Checkout on a phone" };
  const row = texts(render(SubagentRow, { agent, provider: "claude", now: 66000, onPress() {} }));
  for (const text of ["Mobile", "QA", "Now running the auth suite."]) assert.ok(row.includes(text), text);
  assert.ok(!row.includes("Checkout on a phone"), "the persona's name stands in for the title");
  const detail = texts(render(WholeSubagentDetail, { agent, read: async () => agent }));
  for (const text of ["The mobile user", "Does everything on a small phone over slow 3G", "375 × 812", "Slow 3G"]) assert.ok(detail.includes(text), text);
});

test("mobile subagent detail shows its plan with what it does now, else its steps; the log waits behind Full log", () => {
  const { WholeSubagentDetail, render } = subagentGlance();
  const tasks = [
    { id: "0", content: "Read the refresh code", status: "completed" },
    { id: "1", content: "Run the auth tests", activeForm: "Running the auth tests", status: "in_progress" },
    { id: "2", content: "Write it up", status: "pending" },
  ];
  const plan = texts(render(WholeSubagentDetail, { agent: { ...glanceAgent, tasks } }));
  for (const text of [
    "Plan",
    "1 of 3 done",
    "Running the auth tests",
    "Now running the auth suite.",
    "Ran npm test -- auth · 3 files read · 1 command so far",
    "Write it up",
  ])
    assert.ok(plan.includes(text), text);
  assert.equal(plan.includes("Read `auth.ts`"), false, "tool calls stay in the log");
  const steps = render(WholeSubagentDetail, { agent: glanceAgent });
  const shown = texts(steps);
  for (const text of [
    "Now · step 2",
    "Now running the auth suite.",
    "Earlier",
    "The refresh path skips the expiry check.",
    "1 file read",
    "Full log (4 entries)",
  ])
    assert.ok(shown.includes(text), text);
  find(steps, (node) => node.props?.accessibilityState?.expanded === false).props.onPress();
  assert.ok(texts(render(WholeSubagentDetail, { agent: glanceAgent })).includes("Read `auth.ts`"), "Full log shows the calls");
});

test("mobile subagent detail reads the whole transcript when the host sent only its end", async () => {
  const react = hookHost({ effects: true });
  const { WholeSubagentDetail } = load("subagent-glance.tsx", {
    "./display-clock": { useDisplayNow: () => 0 },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, name) => String(name) }),
    "@milagre/shared/agent-activity": require("@milagre/shared/agent-activity"),
    "@milagre/shared/subagent-glance": require("@milagre/shared/subagent-glance"),
    "./icons": { Icon: "Icon", ProviderLogo: "ProviderLogo", SpinnerRing: "SpinnerRing" },
    "./theme": { fonts: { mono: "mono" } },
    "react-native-svg": { default: "Svg", Circle: "Circle", Ellipse: "Ellipse", Polygon: "Polygon", Rect: "Rect" },
  });
  const tail = { ...glanceAgent, transcript: glanceAgent.transcript.slice(-2), transcriptLength: 4 };
  let reads = 0;
  const read = async () => (reads++, glanceAgent);
  const use = () => {
    react.begin();
    const agent = WholeSubagentDetail({ agent: tail, read }).props.agent;
    react.flush();
    return agent;
  };
  assert.equal(use().transcript.length, 2, "the end shows until the read lands");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, 1);
  assert.equal(use().transcript.length, 4);
  const short = { ...glanceAgent, transcriptLength: undefined };
  react.begin();
  assert.equal(WholeSubagentDetail({ agent: short, read }).props.agent, short, "a whole transcript isn't read again");
});

test("mobile main sync switch re-reads the Mac's default on focus and shows a refused save", async () => {
  const react = hookHost();
  const focused = [];
  const pushed = [];
  let saved = false;
  const client = {
    async call(method) {
      if (method === "main-sync:default:read") return { syncMain: saved };
      throw new Error("This demo computer only opens its demo project.");
    },
  };
  const { GeneralSection } = load("general-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/main-sync": require("@milagre/shared/main-sync"),
    "@milagre/shared/auto-update": require("@milagre/shared/auto-update"),
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { router: { push: (path) => pushed.push(path) }, useFocusEffect: (fn) => focused.push(fn) },
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => ({ client, hosts: [] }) },
    "./icons": { Icon: "Icon" },
    "./ui": { ErrorNotice: "ErrorNotice", ListRow: "ListRow", Toggle: "Toggle", styles: {} },
    "./settings-list": { Row: "Row" },
    "@milagre/shared/done": require("@milagre/shared/done"),
    "./done-retention": require("../apps/mobile/src/done-retention.ts"),
    "./mac-update": { useMacUpdate: () => ({ update: undefined, restarting: false }), MacUpdateRows: "MacUpdateRows" },
  });
  const render = () => {
    react.begin();
    return GeneralSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const toggle = () => find(render(), (n) => n.props?.title === "Sync source branch before new Worktrees");
  find(render(), (n) => n.type === "ListRow" && n.props.title === "Plan usage").props.onPress();
  assert.deepEqual(pushed, ["/usage"]);
  focused.at(-1)();
  await settle();
  assert.equal(toggle().props.selected, false);
  // Turned on from the Mac while the phone was elsewhere: coming back to the screen shows it.
  saved = true;
  focused.at(-1)();
  await settle();
  assert.equal(toggle().props.selected, true);
  toggle().props.onPress();
  await settle();
  assert.equal(toggle().props.selected, true, "a refused save puts the switch back");
  assert.equal(find(render(), (n) => n.type === "ErrorNotice").props.message, "This demo computer only opens its demo project.");
});

test("mobile Auto update switch shows the Mac's setting, saves a change and hides for an older Mac", async () => {
  const react = hookHost();
  const focused = [];
  const calls = [];
  let saved = false;
  let older = false;
  const client = {
    async call(method, args) {
      calls.push([method, ...args]);
      if (method === "app-update:auto:read") {
        if (older) throw new Error("Unknown method");
        return { autoUpdate: saved };
      }
      if (method === "app-update:auto:save") {
        saved = args[0];
        return { autoUpdate: saved };
      }
      if (method === "main-sync:default:read") return { syncMain: false };
      throw new Error("Unknown method");
    },
  };
  const { GeneralSection } = load("general-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/main-sync": require("@milagre/shared/main-sync"),
    "@milagre/shared/auto-update": require("@milagre/shared/auto-update"),
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { router: { push() {} }, useFocusEffect: (fn) => focused.push(fn) },
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => ({ client, hosts: [] }) },
    "./icons": { Icon: "Icon" },
    "./ui": { ErrorNotice: "ErrorNotice", ListRow: "ListRow", Toggle: "Toggle", styles: {} },
    "./settings-list": { Row: "Row" },
    "@milagre/shared/done": require("@milagre/shared/done"),
    "./done-retention": require("../apps/mobile/src/done-retention.ts"),
    "./mac-update": { useMacUpdate: () => ({ update: undefined, restarting: false }), MacUpdateRows: "MacUpdateRows" },
  });
  const render = () => {
    react.begin();
    return GeneralSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const toggle = () => find(render(), (n) => n.props?.title === "Auto update");
  assert.equal(toggle(), undefined, "nothing shows before the Mac answers");
  for (const fn of focused.splice(0)) fn();
  await settle();
  assert.equal(toggle().props.selected, false);
  toggle().props.onPress();
  await settle();
  assert.deepEqual(calls.at(-1), ["app-update:auto:save", true]);
  assert.equal(toggle().props.selected, true);
  older = true;
  render();
  for (const fn of focused.splice(0)) fn();
  await settle();
  assert.equal(toggle(), undefined, "an older Mac has no Auto update to show");
});

test("mobile General lists the Mac's Done retention, saves a pick there and hides for an older Mac", async () => {
  const react = hookHost();
  const focused = [];
  const calls = [];
  let older = false;
  let hours = 24;
  const client = {
    async call(method, args) {
      calls.push([method, ...args]);
      if (older) throw new Error("Command is not available from mobile");
      if (method === "done:settings:read") return { retentionHours: hours };
      if (method === "done:settings:save") return { retentionHours: (hours = args[0].retentionHours) };
      throw new Error("Unknown method");
    },
  };
  const { GeneralSection } = load("general-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/main-sync": require("@milagre/shared/main-sync"),
    "@milagre/shared/auto-update": require("@milagre/shared/auto-update"),
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { router: { push() {} }, useFocusEffect: (fn) => focused.push(fn) },
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => ({ client, hosts: [] }) },
    "./icons": { Icon: "Icon" },
    "./ui": { ErrorNotice: "ErrorNotice", ListRow: "ListRow", Toggle: "Toggle", styles: {} },
    "./settings-list": { Row: "Row" },
    "@milagre/shared/done": require("@milagre/shared/done"),
    "./done-retention": require("../apps/mobile/src/done-retention.ts"),
    "./mac-update": { useMacUpdate: () => ({ update: undefined, restarting: false }), MacUpdateRows: "MacUpdateRows" },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The list is its own component inside General: render it as React would.
  const section = () => {
    react.begin();
    const element = find(GeneralSection(), (node) => typeof node.type === "function" && node.type.name === "DoneRetention");
    return element.type(element.props);
  };
  const rows = () => {
    const tree = section();
    return tree ? allNodes(tree, (node) => node.type === "Row") : [];
  };
  assert.equal(rows().length, 0, "nothing shows before the Mac answers");
  for (const fn of focused.splice(0)) fn();
  await settle();
  same(
    rows().map((row) => [row.props.title, row.props.selected]),
    [
      ["1 hour", false],
      ["8 hours", false],
      ["24 hours", true],
      ["3 days", false],
      ["1 week", false],
      ["Never", false],
    ],
  );
  rows()[0].props.onPress();
  await settle();
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["done:settings:save", { retentionHours: 1 }]));
  assert.equal(rows()[0].props.selected, true);
  older = true;
  section();
  for (const fn of focused.splice(0)) fn();
  await settle();
  assert.equal(rows().length, 0, "an older Mac has no Done retention to show");
});

test("mobile General shows the Mac's Milagre update, checks, installs after asking, and hides on an older Mac", async (t) => {
  const react = hookHost();
  const focused = [];
  const calls = [];
  const asked = [];
  let answer = true;
  // What the Mac answers: its desktop app's update (app-update:state), null with no desktop app open, or an older Mac's 403.
  let state = { status: "downloaded", version: "0.233.0", progress: 100, current: "0.232.0" };
  let older = false;
  const client = {
    url: "https://santo",
    async call(method, args) {
      calls.push([method, ...args]);
      if (method.startsWith("app-update:") && method !== "app-update:auto:read" && older)
        throw Object.assign(new Error("Command is not available from mobile"), { status: 403 });
      if (method === "app-update:state") return state;
      if (method === "app-update:check") return (state = { ...state, status: "checking" });
      if (method === "app-update:install") return (state = { ...state, status: "installing" });
      if (method === "app-update:auto:read") return { autoUpdate: false };
      throw new Error("Unknown method");
    },
  };
  const ui = { Button: "Button", ErrorNotice: "ErrorNotice", ListRow: "ListRow", Toggle: "Toggle", useStyles: () => fakeStyles };
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { router: { push() {} }, useFocusEffect: (fn) => focused.push(fn) },
    "@milagre/shared/app-update": require("@milagre/shared/app-update"),
    "./confirm-store": { confirm: async (...question) => (asked.push(question), answer) },
    "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
    "./ui": ui,
    "./theme": themeHooks,
  };
  const { GeneralSection } = load("general-section.tsx", {
    ...modules,
    "@milagre/shared/main-sync": require("@milagre/shared/main-sync"),
    "@milagre/shared/auto-update": require("@milagre/shared/auto-update"),
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => ({ client, hosts: [{ id: "https://santo", name: "Santo" }] }) },
    "./icons": { Icon: "Icon" },
    "./settings-list": { Row: "Row" },
    "@milagre/shared/done": require("@milagre/shared/done"),
    "./done-retention": require("../apps/mobile/src/done-retention.ts"),
    "./mac-update": load("mac-update.tsx", modules),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The update's rows are their own component inside General: render them as React would.
  const rows = () => {
    react.begin();
    const element = find(GeneralSection(), (node) => typeof node.type === "function" && node.type.name === "MacUpdateRows");
    return element?.type(element.props) ?? null;
  };
  const texts = () => allNodes(rows(), (node) => node.type === "Text").map((node) => [node.props.children].flat().join(""));
  const button = (title) => find(rows(), (node) => node.type === "Button" && node.props.title === title);
  // One visit to the screen: the last visit's effects (and the update's follow timer) end first.
  const cleanups = [];
  t.after(() => cleanups.forEach((cleanup) => cleanup?.()));
  const focus = async () => {
    for (const cleanup of cleanups.splice(0)) cleanup?.();
    focused.length = 0;
    rows();
    for (const fn of focused.splice(0)) cleanups.push(fn());
    await settle();
  };
  assert.equal(rows(), null, "nothing shows before the Mac answers");
  await focus();
  assert.deepEqual(texts(), ["Milagre on Santo", "0.232.0", "Update available: v0.233.0", "Milagre 0.233.0 is ready to install."]);
  // Installing asks first: it restarts Milagre on the Mac. Cancel starts nothing.
  answer = false;
  await button("Install & restart").props.onPress();
  await settle();
  assert.deepEqual(asked, [["Restart Milagre on Santo to install v0.233.0?", "Running Chats are saved and resume after the restart.", "Install & restart"]]);
  assert.equal(
    calls.some(([method]) => method === "app-update:install"),
    false,
  );
  answer = true;
  button("Install & restart").props.onPress();
  await settle();
  assert.deepEqual(calls.at(-1), ["app-update:install"]);
  assert.equal(button("Install & restart"), undefined);
  assert.equal(button("Restarting…").props.disabled, true);
  assert.ok(texts().includes("Saving your work and restarting Milagre."));
  // Back after the restart, on the new version: Check for updates again.
  state = { status: "up-to-date", version: null, progress: 0, current: "0.233.0" };
  await focus();
  assert.deepEqual(texts(), ["Milagre on Santo", "0.233.0", "Milagre is up to date."]);
  button("Check for updates").props.onPress();
  await settle();
  assert.deepEqual(calls.at(-1), ["app-update:check"]);
  assert.equal(button("Restarting…"), undefined);
  assert.equal(button("Check for updates").props.disabled, true, "a check under way waits");
  // A download shows its progress.
  state = { status: "downloading", version: "0.234.0", progress: 42, current: "0.233.0" };
  await focus();
  assert.ok(texts().includes("Downloading Milagre 0.234.0… 42%"));
  assert.equal(find(rows(), (node) => node.props?.accessibilityRole === "progressbar").props.accessibilityValue.now, 42);
  // No desktop app open on the Mac: one line saying where to open it.
  state = null;
  await focus();
  assert.deepEqual(texts(), ["Open Milagre on Santo to check for updates."]);
  // An older Mac has none of this; its Auto update still shows.
  older = true;
  await focus();
  assert.equal(rows(), null);
  react.begin();
  assert.ok(find(GeneralSection(), (node) => node.props?.title === "Auto update"));
});

// Settings with every import faked; `state` is read on each render, so a test can change the Mac or the Linear answer.
function loadSettings(state) {
  return load("app/(settings)/settings.tsx", {
    react: { useState: () => [state.linear ?? null, (value) => (state.set ??= []).push(value)], useCallback: (fn) => fn },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
      Platform: { OS: "ios" },
      Linking: { openURL: async (url) => (state.urls ??= []).push(url) },
      Alert: { alert() {} },
    },
    "expo-router": {
      Stack: { Screen: "Screen", Toolbar: Object.assign(() => null, { Button: "Button", View: "View" }) },
      router: { push: (target) => (state.pushed ??= []).push(target), navigate: (target) => (state.pushed ??= []).push(target) },
      useFocusEffect: (fn) => (state.focus ??= []).push(fn),
    },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/chat-display": { chatListLabel: (value) => (value === "list" ? "One list" : "Grouped by Project") },
    "@milagre/shared/site-links": require("@milagre/shared/site-links"),
    "../session": {
      useSession: () => ({
        recent: state.recent ?? [],
        client: state.client ?? null,
        hosts: state.client ? [{ id: state.client.url, name: "Studio", address: "http://192.168.0.2:8797" }] : (state.hosts ?? []),
        hostName: "Studio",
      }),
    },
    "../project-icon": { ProjectIcon: "ProjectIcon" },
    "../push": { usePush: () => ({ state: { enabled: true } }) },
    "../update-sheet": { useAppUpdates: () => ({ state: { status: "up-to-date" }, check: async () => {} }) },
    "../icons": { Icon: "Icon" },
    "../milagre-mark": { MilagreMark: "MilagreMark" },
    // Group and Row are drawn by settings-list; the test reads their props.
    "../settings-list": { Group: function Group() {}, Row: "Row" },
    "../use-computer-status": { useComputerStatus: () => state.reachability ?? {} },
    "../use-routines": {
      useRoutinesAvailable: () => state.routinesAvailable ?? false,
      useRoutines: () => ({ routines: state.routines ?? [], loading: false }),
    },
    "../chat-display-setting": { useChatList: () => ["list"] },
    "../app-version": { appVersionLine: () => "0.1.0 · 31 · d3dac403 · 5f83390" },
    "../theme": { useTheme: () => ({ colors: { green: "green", lineStrong: "gray" }, settings: { mode: "system" } }) },
    "../ui": { HeaderButton: "HeaderButton", PageScroll: "PageScroll", useStyles: () => ({ card: {}, separator: {} }) },
  });
}

// The groups Settings renders, each with its rows' titles and values.
function settingsGroups(tree) {
  const groups = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function" && node.type.name === "Group") {
      const rows = [node.props.children].flat(Infinity).filter((row) => row && typeof row === "object");
      groups.push({ title: node.props.title, rows: rows.map((row) => [row.props.title, row.props.value ?? ""]), elements: rows });
      return;
    }
    for (const child of [node.props?.children].flat(Infinity)) visit(child);
  };
  visit(tree);
  return groups;
}

test("mobile Settings splits this device from the connected Mac, lists Connections only when the Mac can change Linear, and ends with the version", async () => {
  const state = {};
  const { SettingsView } = loadSettings(state);
  // No Mac: the phone's own settings and About only; Routines waits for a computer and Computers says none is paired.
  const alone = SettingsView({ onOpen() {} });
  assert.deepEqual(
    settingsGroups(alone).map((group) => group.title),
    ["This device", "About"],
  );
  const tile = (tree, title) => find(tree, (n) => typeof n.type === "function" && n.type.name === "Tile" && n.props.title === title);
  assert.equal(tile(alone, "Computers").props.value, "None paired");
  assert.equal(tile(alone, "Routines").props.disabled, true);
  assert.equal(tile(alone, "Routines").props.value, "No computer connected");
  // A Mac that answers for Linear lists Connections; an older Mac that answers null keeps it hidden.
  state.client = { url: "http://studio", call: async () => ({ enabled: false }) };
  state.focus = [];
  SettingsView({ onOpen() {} });
  state.focus.at(-1)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.set.at(-1).client, state.client);
  assert.equal(state.set.at(-1).enabled, false);
  state.client = { url: "http://studio", call: async () => null };
  SettingsView({ onOpen() {} });
  state.focus.at(-1)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.set.at(-1), null);
  assert.ok(!settingsGroups(SettingsView({ onOpen() {} })).some((group) => group.rows.some(([title]) => title === "Connections")));
  state.client = { url: "http://studio", call: async () => ({ enabled: true }) };
  state.linear = { client: state.client, enabled: true };
  state.recent = [{ path: "/work/milagre", name: "milagre" }];
  const opened = [];
  const tree = SettingsView({ onOpen: (page) => opened.push(page) });
  const groups = settingsGroups(tree);
  assert.deepEqual(
    groups.map(({ title, rows }) => [title, rows]),
    [
      [
        "This device",
        [
          ["Notifications", "On"],
          ["Appearance", "System"],
          ["Browser", "Milagre"],
          ["Chat", "One list"],
          ["Archived Chats", ""],
          ["Experimental", ""],
        ],
      ],
      [
        "Studio",
        [
          ["General", ""],
          ["Accounts", ""],
          ["Project Accounts", ""],
          ["Connections", "Linear"],
          ["Skills", ""],
          ["MCP", ""],
          ["Milagre", ""],
        ],
      ],
      ["Projects", [["milagre", ""]]],
      [
        "About",
        [
          ["Privacy policy", ""],
          ["Support", ""],
          ["App update", "Up to date"],
        ],
      ],
    ],
  );
  for (const row of [...groups[0].elements, ...groups[1].elements]) row.props.onPress();
  assert.deepEqual(opened, [
    "notifications",
    "appearance",
    "browser-settings",
    "chat-display",
    "archived",
    "experimental",
    "general",
    "accounts",
    "project-accounts",
    "connections",
    "skills",
    "mcp",
    "local-mcp",
  ]);
  // Privacy policy and Support open Milagre's site in the browser.
  groups[3].elements[0].props.onPress();
  groups[3].elements[1].props.onPress();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(state.urls, ["https://milagre.cloud/privacy", "https://milagre.cloud/support"]);
  // The tiles: the green dot and counts follow the computers' answers; Routines counts what is on once the Mac has them.
  state.reachability = { a: "online", b: "online", c: "offline" };
  assert.equal(tile(SettingsView({ onOpen() {} }), "Computers").props.value, "2 online · 1 offline");
  assert.equal(tile(SettingsView({ onOpen() {} }), "Computers").props.dot, "green");
  state.reachability = { a: "offline" };
  assert.equal(tile(SettingsView({ onOpen() {} }), "Computers").props.value, "Offline");
  assert.equal(tile(SettingsView({ onOpen() {} }), "Computers").props.dot, "gray");
  state.reachability = { a: "checking" };
  assert.equal(tile(SettingsView({ onOpen() {} }), "Computers").props.value, "Checking…");
  assert.equal(tile(SettingsView({ onOpen() {} }), "Routines").props.value, "Update your Mac");
  state.routinesAvailable = true;
  state.routines = [{ enabled: true }, { enabled: false }, { enabled: true }];
  const available = tile(SettingsView({ onOpen() {} }), "Routines");
  assert.equal(available.props.value, "2 on");
  assert.equal(available.props.disabled, false);
  const routed = [];
  tile(SettingsView({ onOpen: (page) => routed.push(page) }), "Routines").props.onPress();
  tile(SettingsView({ onOpen: (page) => routed.push(page) }), "Computers").props.onPress();
  assert.deepEqual(routed, ["routines", "computers"]);
  // The version line closes the page.
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "0.1.0 · 31 · d3dac403 · 5f83390"));
  const page = (file, title, section, name, extra = {}) => {
    const { default: Screen } = load(file, {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "expo-router": { Stack: { Screen: "Screen" } },
      "react-native": { Text: "Text", View: "View" },
      "../ui": { PageScroll: "PageScroll", useStyles: () => ({}) },
      [`../${section}`]: { [name]: name },
      ...extra,
    });
    const rendered = Screen();
    assert.equal(find(rendered, (n) => n.type === "Screen").props.options.title, title);
    assert.ok(find(rendered, (n) => n.type === name));
    return rendered;
  };
  page("app/(settings)/general.tsx", "General", "general-section", "GeneralSection");
  page("app/(settings)/connections.tsx", "Connections", "linear-section", "LinearSection");
  // Milagre: Designs and artifacts first, then the Milagre MCP.
  const milagre = page("app/(settings)/local-mcp.tsx", "Milagre", "local-mcp-section", "LocalMcpSection", {
    "../published-pages-section": { PublishedPagesSection: "PublishedPagesSection" },
    "../theme": { useTheme: () => ({ colors: {} }) },
  });
  assert.ok(find(milagre, (n) => n.type === "PublishedPagesSection"));
  assert.ok(find(milagre, (n) => n.type === "Text" && n.props.children === "Designs and artifacts"));
  page("app/(settings)/experimental.tsx", "Experimental", "experimental-section", "ExperimentalSection");
  page("app/(settings)/babysit-prs.tsx", "Babysit PRs", "babysit-section", "BabysitSection");
});

test("mobile Linear page shows the Mac's Linear switch and status, re-read on focus", async () => {
  const react = hookHost();
  const focused = [];
  let status = { connected: false };
  const saves = [];
  const client = {
    async call(method, args) {
      if (method === "linear:enabled:read") return { enabled: true };
      if (method === "linear:status") return status;
      if (method === "linear:enabled:save") {
        saves.push(args[0]);
        return { enabled: args[0] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const modules = (session) => ({
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/linear": require("../packages/shared/src/linear.ts"),
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn) },
    "./session": { useSession: () => session },
    "./ui": { ErrorNotice: "ErrorNotice", Toggle: "Toggle", styles: {} },
  });
  const { LinearSection } = load("linear-section.tsx", modules({ client }));
  const render = () => {
    react.begin();
    return LinearSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const text = (tree, value) => find(tree, (n) => n.type === "Text" && n.props.children === value);
  render();
  focused.at(-1)();
  await settle();
  let tree = render();
  assert.equal(find(tree, (n) => n.props?.title === "Linear").props.selected, true);
  assert.ok(text(tree, "Connect Linear from Settings on your Mac"));
  // Connected on the Mac while the phone was elsewhere: coming back to the page shows it, one line per workspace.
  const acme = {
    id: "acme",
    viewer: { name: "Victor", email: "v@x" },
    organization: { name: "Acme", urlKey: "acme" },
  };
  const beta = {
    id: "beta",
    viewer: { name: "Vic", email: "v@b" },
    organization: { name: "Beta Labs", urlKey: "beta" },
  };
  status = {
    connected: true,
    viewer: acme.viewer,
    organization: acme.organization,
    workspaces: [acme, beta],
  };
  focused.at(-1)();
  await settle();
  tree = render();
  assert.ok(text(tree, "Connected to Acme, as Victor"));
  assert.ok(text(tree, "Connected to Beta Labs, as Vic"));
  find(tree, (n) => n.props?.title === "Linear").props.onPress();
  await settle();
  assert.deepEqual(saves, [false]);
  assert.equal(text(render(), "Connected to Acme, as Victor"), undefined, "the status hides while the switch is off");

  const offline = load("linear-section.tsx", modules({ client: null })).LinearSection;
  react.begin();
  const empty = offline();
  assert.ok(text(empty, "Connect to a Mac to change its Linear connection."));
  assert.equal(
    find(empty, (n) => n.props?.title === "Linear"),
    undefined,
  );
  // The Linear switch no longer lives on the Experimental page.
  const experimental = load("experimental-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn), router: { push() {} } },
    "./ultracode-fatality-setting": { useUltracodeFatality: () => [false, () => {}] },
    "./floating-inbox-setting": { useFloatingInbox: () => [false, () => {}], useFloatingInboxActivity: () => [true, () => {}] },
    "./icons": { Icon: "Icon" },
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => ({ designs: designsOn, client }) },
    "./settings-list": { Row: "Row" },
    "./ui": { ErrorNotice: "ErrorNotice", Toggle: "Toggle", styles: {} },
  }).ExperimentalSection;
  react.begin();
  const experimentalTree = experimental();
  assert.ok(find(experimentalTree, (n) => n.props?.title === "Ultracode Fatality"));
  assert.equal(
    find(experimentalTree, (n) => n.props?.title === "Linear"),
    undefined,
  );
});

test("mobile Accounts page shows the Mac's usage-limit auto-switch, saved on the Mac and rolled back when refused", async () => {
  const react = hookHost();
  const focused = [];
  const saves = [];
  let refuse = false;
  const client = {
    async call(method, args) {
      if (method === "limits:auto-switch:read") return { autoSwitch: false };
      if (method === "limits:auto-switch:save") {
        saves.push(args[0]);
        if (refuse) throw new Error("This computer does not allow changing this setting from a phone.");
        return { autoSwitch: args[0] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const modules = (session) => ({
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn) },
    "./session": { useSession: () => session },
    "./ui": { ErrorNotice: "ErrorNotice", Toggle: "Toggle", styles: {} },
  });
  const { LimitAutoSwitchSection } = load("limit-switch-section.tsx", modules({ client }));
  const render = () => {
    react.begin();
    return LimitAutoSwitchSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const title = "Switch accounts at usage limits";
  assert.equal(
    find(render(), (n) => n.props?.title === title),
    undefined,
    "hidden until the Mac answers",
  );
  for (const effect of focused.splice(0)) effect();
  await settle();
  let tree = render();
  assert.equal(find(tree, (n) => n.props?.title === title).props.selected, false);
  assert.ok(find(tree, (n) => n.type === "Text" && String(n.props.children).startsWith("When a Chat hits its plan")));
  find(tree, (n) => n.props?.title === title).props.onPress();
  await settle();
  assert.deepEqual(saves, [true]);
  assert.equal(find(render(), (n) => n.props?.title === title).props.selected, true);
  refuse = true;
  find(render(), (n) => n.props?.title === title).props.onPress();
  await settle();
  tree = render();
  assert.deepEqual(saves, [true, false]);
  assert.equal(find(tree, (n) => n.props?.title === title).props.selected, true, "a refused save puts the switch back");
  assert.match(find(tree, (n) => n.type === "ErrorNotice").props.message, /does not allow/);
  const older = load("limit-switch-section.tsx", modules({ client: { call: async () => null } })).LimitAutoSwitchSection;
  react.begin();
  older();
  for (const effect of focused.splice(0)) effect();
  await settle();
  react.begin();
  assert.equal(
    find(older(), (n) => n.props?.title === title),
    undefined,
    "an older Mac answers null: no switch",
  );
});

test("mobile Experimental page has no Routines switch (Routines left Experimental)", async () => {
  const react = hookHost();
  const focused = [];
  const saves = [];
  let refuse = false;
  const client = {
    async call(method, args) {
      if (method === "routines:enabled:read") return { enabled: false };
      if (method === "routines:enabled:save") {
        saves.push(args[0]);
        if (refuse) throw new Error("This computer does not allow changing this setting from a phone.");
        return { enabled: args[0] };
      }
      return null;
    },
  };
  const modules = (session) => ({
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/linear": require("../packages/shared/src/linear.ts"),
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn), router: { push() {} } },
    "@milagre/shared/themes": { DEFAULT_THEME_ID: "milagre-blue", seedsFrom: (id) => ({ from: id }) },
    "./custom-theme-section": { CustomThemeSection: "CustomThemeSection" },
    "./ultracode-fatality-setting": { useUltracodeFatality: () => [false, () => {}] },
    "./floating-inbox-setting": { useFloatingInbox: () => [false, () => {}], useFloatingInboxActivity: () => [true, () => {}] },
    "./push": { usePush: () => ({ state: null }) },
    "./icons": { Icon: "Icon" },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/notification-chimes": require("@milagre/shared/notification-chimes"),
    "./session": { useSession: () => ({ designs: { ...designsOn }, ...session }) },
    "./settings-list": { Row: "Row" },
    "./ui": { ErrorNotice: "ErrorNotice", ListRow: "ListRow", PillButton: "PillButton", Toggle: "Toggle", styles: {} },
  });
  const { ExperimentalSection } = load("experimental-section.tsx", modules({ client }));
  const render = () => {
    react.begin();
    return ExperimentalSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(
    find(render(), (n) => n.props?.title === "Routines"),
    undefined,
  );
});

test("mobile Experimental shows the Mac's Device notes switch with its token warning, off by default, and saves a tap", async () => {
  const react = hookHost({ effects: true });
  const focused = [];
  const calls = [];
  let saved = { enabled: false };
  let failSave = false;
  let olderHost = false;
  const client = {
    async call(method, args) {
      calls.push([method, args]);
      if (method === "device-notes:read") {
        if (olderHost) throw new Error("Unknown command: device-notes:read");
        return saved;
      }
      if (method === "device-notes:save") {
        if (failSave) throw new Error("Device notes save failed");
        return (saved = { enabled: args[0] });
      }
      return null;
    },
  };
  const { ExperimentalSection } = load("experimental-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn), router: { push() {} } },
    "./ultracode-fatality-setting": { useUltracodeFatality: () => [false, () => {}] },
    "./floating-inbox-setting": { useFloatingInbox: () => [false, () => {}], useFloatingInboxActivity: () => [true, () => {}] },
    "./session": { useSession: () => ({ client }) },
    "./settings-list": { Row: "Row" },
    "./ui": { Toggle: "Toggle" },
  });
  const render = () => {
    react.begin();
    return ExperimentalSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const toggle = () => find(render(), (n) => n.type === "Toggle" && n.props.title === "Device notes");
  assert.equal(toggle(), undefined, "nothing shows before the Mac answers");
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(toggle().props.selected, false);
  assert.ok(find(render(), (n) => n.type === "Text" && n.props.children === "Adds about 100 tokens to every message you send from another device."));
  toggle().props.onPress();
  await settle();
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["device-notes:save", [true]]));
  assert.equal(toggle().props.selected, true);
  failSave = true;
  toggle().props.onPress();
  await settle();
  assert.equal(toggle().props.selected, true, "failed save restores the daemon's value");
  assert.ok(find(render(), (n) => n.type === "Text" && n.props.children === "Device notes save failed"));
  failSave = false;
  toggle().props.onPress();
  await settle();
  assert.equal(toggle().props.selected, false, "retry saves successfully");
  assert.equal(
    find(render(), (n) => n.type === "Text" && n.props.children === "Device notes save failed"),
    undefined,
  );
  saved = { enabled: true };
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(toggle().props.selected, true, "returning to the screen reads changes made on desktop");
  olderHost = true;
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(toggle(), undefined, "an older host hides the unsupported setting");
});

test("desktop Device notes guards same-render saves and ignores stale initial reads", async () => {
  const react = hookHost({ effects: true });
  const initialRead = deferred();
  const requests = [];
  let changed;
  const bridge = {
    readDeviceNotesEnabled: () => initialRead.promise,
    onDeviceNotesEnabledChanged: (fn) => {
      changed = fn;
      return () => {};
    },
    saveDeviceNotesEnabled: (enabled) => {
      const reply = deferred();
      requests.push({ enabled, ...reply });
      return reply.promise;
    },
  };
  const { useDeviceNotesEnabled } = load(
    "../../desktop/app/src/lib/device-notes.ts",
    { react, "test-bridge": bridge },
    '\nconst window = { milagre: require("test-bridge") };',
  );
  const render = () => {
    react.begin();
    return useDeviceNotesEnabled();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  render();
  changed({ enabled: true });
  const setting = render();
  const pending = setting.save(false);
  await setting.save(true);
  assert.equal(requests.length, 1, "same-render calls cannot overlap before the checkbox disables");
  assert.equal(render().saving, true);
  assert.equal(render().enabled, true);
  requests[0].reject(new Error("Device notes save failed"));
  await pending;
  assert.equal(render().enabled, true);
  assert.equal(render().error, "Device notes save failed");
  const retry = render().save(false);
  requests[1].resolve({ enabled: false });
  await retry;
  initialRead.resolve({ enabled: true });
  await settle();
  assert.equal(render().enabled, false, "a delayed initial read cannot replace a later event/save");
  assert.equal(render().saving, false);
  assert.equal(render().error, "");
  const final = render().save(true);
  const beforeUnmount = render();
  react.unmount();
  requests[2].resolve({ enabled: true });
  await final;
  assert.equal(render().enabled, beforeUnmount.enabled, "late save reply is ignored after unmount");
});

test("mobile Device notes serializes taps, retains confirmed values and ignores replies from a previous Mac", async () => {
  const react = hookHost({ effects: true });
  let focus;
  let blur;
  const requests = [];
  const makeClient = (name) => ({
    call(method, args) {
      if (!method.startsWith("device-notes:")) return Promise.resolve(null);
      const reply = deferred();
      requests.push({ name, method, args, ...reply });
      return reply.promise;
    },
  });
  let client = makeClient("A");
  const { ExperimentalSection } = load("experimental-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": {
      useFocusEffect: (fn) => {
        focus = fn;
      },
      router: { push() {} },
    },
    "./ultracode-fatality-setting": { useUltracodeFatality: () => [false, () => {}] },
    "./floating-inbox-setting": { useFloatingInbox: () => [false, () => {}], useFloatingInboxActivity: () => [true, () => {}] },
    "./session": { useSession: () => ({ client }) },
    "./settings-list": { Row: "Row" },
    "./ui": { Toggle: "Toggle" },
  });
  const render = () => {
    react.begin();
    return ExperimentalSection();
  };
  const toggle = () => find(render(), (n) => n.type === "Toggle" && n.props.title === "Device notes");
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const refocus = () => {
    blur?.();
    render();
    blur = focus();
  };
  refocus();
  requests.at(-1).resolve({ enabled: false });
  await settle();
  const first = toggle();
  first.props.onPress();
  first.props.onPress(); // Same render: a state-only guard is too late.
  toggle().props.onPress();
  assert.equal(requests.filter((r) => r.method === "device-notes:save").length, 1, "only one write may be pending");
  assert.equal(toggle().props.disabled, true);
  assert.equal(toggle().props.selected, false, "pending save retains the confirmed value, like desktop");
  const firstSave = requests.at(-1);
  refocus();
  assert.equal(requests.at(-1), firstSave, "focus cannot race a pending write with an older read");
  firstSave.reject(new Error("Device notes save failed"));
  await settle();
  assert.equal(toggle().props.disabled, false);
  assert.equal(toggle().props.selected, false);
  assert.ok(find(render(), (n) => n.props?.children === "Device notes save failed"));
  toggle().props.onPress();
  requests.at(-1).resolve({ enabled: true });
  await settle();
  assert.equal(toggle().props.selected, true, "retry confirms the saved value");

  refocus();
  const delayedRead = requests.at(-1);
  toggle().props.onPress();
  requests.at(-1).resolve({ enabled: false });
  await settle();
  delayedRead.resolve({ enabled: true });
  await settle();
  assert.equal(toggle().props.selected, false, "a read started before a save cannot overwrite its acknowledgement");

  for (const fail of [false, true]) {
    toggle().props.onPress();
    const oldSave = requests.at(-1);
    client = makeClient(fail ? "C" : "B");
    refocus();
    assert.equal(toggle(), undefined, "a new Mac does not display the previous Mac's value");
    requests.at(-1).resolve({ enabled: false });
    await settle();
    toggle().props.onPress();
    const newSave = requests.at(-1);
    if (fail) oldSave.reject(new Error("Previous Mac failed"));
    else oldSave.resolve({ enabled: true });
    await settle();
    assert.equal(toggle().props.selected, false);
    assert.equal(toggle().props.disabled, true, "old replies cannot unlock the new Mac's pending save");
    assert.equal(
      find(render(), (n) => n.props?.children === "Previous Mac failed"),
      undefined,
    );
    newSave.resolve({ enabled: true });
    await settle();
    assert.equal(toggle().props.selected, true);
    assert.equal(toggle().props.disabled, false);
  }
  toggle().props.onPress();
  const finalSave = requests.at(-1);
  blur?.();
  react.unmount();
  finalSave.reject(new Error("Unmounted save"));
  await settle();
});

test("mobile Experimental shows a Babysit PRs row that opens its page, hidden for an older Mac", async () => {
  const react = hookHost();
  const focused = [];
  const pushed = [];
  let answer = { enabled: true };
  const client = {
    async call(method) {
      if (method === "babysit:settings:read") return answer;
      return null;
    },
  };
  const { ExperimentalSection } = load("experimental-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn), router: { push: (path) => pushed.push(path) } },
    "./ultracode-fatality-setting": { useUltracodeFatality: () => [false, () => {}] },
    "./floating-inbox-setting": { useFloatingInbox: () => [false, () => {}], useFloatingInboxActivity: () => [true, () => {}] },
    "./session": { useSession: () => ({ client }) },
    "./settings-list": { Row: "Row" },
    "./ui": { Toggle: "Toggle" },
  });
  const render = () => {
    react.begin();
    return ExperimentalSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const row = () => find(render(), (n) => n.type === "Row" && n.props.title === "Babysit PRs");
  assert.equal(row(), undefined, "nothing shows before the Mac answers");
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(row().props.value, "On");
  assert.ok(
    find(render(), (n) => n.type === "Text" && n.props.children === "Watch every PR a Chat opens and fix review comments, failed checks and conflicts."),
  );
  row().props.onPress();
  assert.deepEqual(pushed, ["/babysit-prs"]);
  // Turned off on the Mac while the phone was on the page: coming back shows it.
  answer = { enabled: false };
  render();
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(row().props.value, "Off");
  answer = null;
  render();
  for (const effect of focused.splice(0)) effect();
  await settle();
  assert.equal(row(), undefined, "an older Mac answers null: no row");
});

test("mobile Babysit PRs page shows the four groups and saves each change to the Mac", async () => {
  const react = hookHost();
  const focused = [];
  const babysit = require("@milagre/shared/babysit");
  let stored = { ...babysit.BABYSIT_DEFAULTS, wake: [...babysit.BABYSIT_DEFAULTS.wake] };
  const saves = [];
  const client = {
    async call(method, args) {
      if (method === "babysit:settings:read") return stored;
      if (method === "babysit:settings:save") {
        // The page runs in its own realm; a plain copy compares by value.
        saves.push(JSON.parse(JSON.stringify(args[0])));
        stored = { ...stored, ...args[0] };
        return stored;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const store = load("babysit-settings.ts", {});
  const { BabysitSection } = load("babysit-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable" },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn) },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/babysit": babysit,
    "./babysit-settings": store,
    "./icons": { Icon: "Icon" },
    "./session": { useSession: () => ({ client }) },
    "./settings-list": { Group: "Group", Row: "Row" },
    "./ui": { ErrorNotice: "ErrorNotice", Segmented: "Segmented", Toggle: "Toggle" },
  });
  const render = () => {
    react.begin();
    return BabysitSection();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const node = (predicate) => find(render(), predicate);
  const toggle = (title) => node((n) => n.type === "Toggle" && n.props.title === title);
  assert.equal(render(), null, "nothing shows before the Mac answers");
  for (const effect of focused.splice(0)) effect();
  await settle();
  const tree = render();
  const groups = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "Group" && n.props.title) groups.push(n.props.title);
    for (const child of [n.props?.children].flat(Infinity)) walk(child);
  })(tree);
  assert.deepEqual(groups, ["Babysit PRs", "When something needs fixing", "Stop babysitting when", "Your instructions"]);
  assert.equal(toggle("Babysit new PRs").props.selected, false);
  assert.ok(
    node(
      (n) =>
        n.type === "Text" &&
        n.props.children === "Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done.",
    ),
  );
  toggle("Babysit new PRs").props.onPress();
  await settle();
  assert.deepEqual(saves.at(-1), { enabled: true });
  assert.equal(toggle("Babysit new PRs").props.selected, true);
  // Each level is a radio card; Fix and push is the default and starts selected.
  const level = (title) => node((n) => n.props?.accessibilityRole === "radio" && String(n.props.accessibilityLabel).startsWith(title));
  assert.equal(level("Fix and push.").props.accessibilityState.checked, true);
  level("Fix, push, reply and re-request review.").props.onPress();
  await settle();
  assert.deepEqual(saves.at(-1), { level: 5 });
  assert.equal(level("Fix, push, reply and re-request review.").props.accessibilityState.checked, true);
  // Wake chips toggle and keep the settings' order.
  node((n) => n.props?.accessibilityLabel === "Branch behind base").props.onPress();
  await settle();
  assert.deepEqual(saves.at(-1), { wake: ["comments", "checks", "conflicts", "behind"] });
  // A number rule always sends its whole object.
  node((n) => n.type === "Segmented" && n.props.label === "Watch the PR for").props.onChange("14");
  await settle();
  assert.deepEqual(saves.at(-1), { stopAfterDays: { on: true, days: 14 } });
  toggle("It failed to fix the same problem").props.onPress();
  await settle();
  assert.deepEqual(saves.at(-1), { stopAfterFailures: { on: true, times: 3 } });
  node((n) => n.type === "Segmented" && n.props.label === "Check every").props.onChange("5");
  await settle();
  assert.deepEqual(saves.at(-1), { intervalMinutes: 5 });
  // Instructions save when the field loses focus, with only a Saved mark under it.
  const field = () => node((n) => n.type === "TextInput" && n.props.accessibilityLabel === "Your instructions");
  assert.equal(
    node((n) => n.type === "Text" && n.props.children === "Saved"),
    undefined,
  );
  field().props.onFocus();
  field().props.onChangeText("Never force-push.");
  render();
  field().props.onBlur();
  await settle();
  assert.deepEqual(saves.at(-1), { instructions: "Never force-push." });
  assert.ok(node((n) => n.type === "Text" && n.props.children === "Saved"));
  assert.equal(field().props.value, "Never force-push.");
  // Reset puts every value back, even with a field focused and half typed: the typed text is dropped.
  field().props.onFocus();
  field().props.onChangeText("Half typed");
  render();
  const savesBeforeReset = saves.length;
  node((n) => n.type === "Row" && n.props.title === "Reset all to defaults").props.onPress();
  await settle();
  assert.deepEqual(saves.at(-1), { ...babysit.BABYSIT_DEFAULTS });
  assert.equal(toggle("Babysit new PRs").props.selected, false);
  assert.equal(field().props.value, "");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(saves.length, savesBeforeReset + 1, "only the reset saves, not the half-typed text");
  assert.equal(field().props.value, "");
  // Each PR keeps its settings.
  assert.equal(
    node((n) => n.type === "Group" && n.props.title === "When something needs fixing").props.footer,
    "Each PR keeps the settings it started with: changes here apply to PRs opened afterwards.",
  );
});

test("mobile ChatReply shows the usage-limit card instead of the failed line, with a Project only when it can switch", () => {
  const react = { memo: (fn) => fn, useCallback: (fn) => fn, useEffect() {}, useRef: () => ({}), useState: (value) => [value, () => {}] };
  const { ChatReply } = load("chat-reply.tsx", {
    "./advisor-result-card": { AdvisorResultCard: "AdvisorResultCard" },
    "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
    "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
    react: { ...react, useMemo: (compute) => compute() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View", useColorScheme: () => "dark" },
    "react-native-svg": { default: "Svg", Path: "Path" },
    "expo-router": { router: {} },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "./file-chip": { FileChip: "FileChip" },
    "./markdown": { Markdown: "Markdown" },
    "./icons": { Icon: "Icon" },
    "./activity-item": { ActivityTitle: "ActivityTitle" },
    "./tool-row": { ToolRow: "ToolRow" },
    "./artifact": { ArtifactCards: "ArtifactCards", DesignFeedbackCard: "DesignFeedbackCard" },
    "@milagre/shared/page-comments": { parsePageComments: () => null },
    "./page-comments-card": { PageCommentsCard: "PageCommentsCard" },
    "./answer-card": { AnswerCard: "AnswerCard" },
    "./chat-display-setting": { useToolCallDisplay: () => ["compact", () => {}] },
    "./pr-action-card": { PullRequestActionCard: "PullRequestActionCard" },
    "./linear-issue-card": { LinearIssueCard: "LinearIssueCard" },
    "./heartbeat-card": { HeartbeatCard: "HeartbeatCard" },
    "./computer-use-card": { ComputerUseCard: "ComputerUseCard" },
    "./usage-limit-card": { UsageLimitCard: "UsageLimitCard" },
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
    "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
    "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
    "./theme": { hex: () => "#000" },
    "./viewer-store": { showImages() {} },
    "./ui": { colors: {}, styles: { card: {}, row: {}, muted: {} } },
  });
  const limit = { kind: "limit", provider: "claude", accountId: "a", resetsAt: "2026-10-13T15:10:00.000Z" };
  const message = { id: 9, session_id: 4, role: "assistant", body: "You've hit your session limit", outcome: "failed", context: limit };
  const tree = ChatReply({ message, media: () => null, onActivity() {}, limitProjectPath: "/work/app" });
  const card = find(tree, (n) => n.type === "UsageLimitCard");
  assert.deepEqual({ ...card.props.limit }, limit);
  assert.equal(card.props.sessionId, 4);
  assert.equal(card.props.projectPath, "/work/app");
  assert.equal(
    find(tree, (n) => n.type === "Text" && n.props.children === "The turn failed. Review the response before trying again."),
    undefined,
    "the generic failure line stays out of a limit reply",
  );
  assert.equal(find(ChatReply({ message, media: () => null, onActivity() {} }), (n) => n.type === "UsageLimitCard").props.projectPath, undefined);
  // A failed reply without the limit keeps its line and gets no card.
  const failed = ChatReply({ message: { ...message, context: null }, media: () => null, onActivity() {} });
  assert.equal(
    find(failed, (n) => n.type === "UsageLimitCard"),
    undefined,
  );
  assert.ok(find(failed, (n) => n.type === "Text" && n.props.children === "The turn failed. Review the response before trying again."));
});

test("mobile ChatReply marks a Delegation and its report with their sender, never as the user's own message", () => {
  const react = { memo: (fn) => fn, useCallback: (fn) => fn, useEffect() {}, useRef: () => ({}), useState: (value) => [value, () => {}] };
  const { ChatReply } = load("chat-reply.tsx", {
    "./advisor-result-card": { AdvisorResultCard: "AdvisorResultCard" },
    "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
    "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
    react: { ...react, useMemo: (compute) => compute() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View", useColorScheme: () => "dark" },
    "react-native-svg": { default: "Svg", Path: "Path" },
    "expo-router": { router: {} },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "./file-chip": { FileChip: "FileChip" },
    "./markdown": { Markdown: "Markdown" },
    "./icons": { Icon: "Icon" },
    "./activity-item": { ActivityTitle: "ActivityTitle" },
    "./tool-row": { ToolRow: "ToolRow" },
    "./artifact": { ArtifactCards: "ArtifactCards", DesignFeedbackCard: "DesignFeedbackCard" },
    "@milagre/shared/page-comments": { parsePageComments: () => null },
    "./page-comments-card": { PageCommentsCard: "PageCommentsCard" },
    "./answer-card": { AnswerCard: "AnswerCard" },
    "./chat-display-setting": { useToolCallDisplay: () => ["compact", () => {}] },
    "./pr-action-card": { PullRequestActionCard: "PullRequestActionCard" },
    "./linear-issue-card": { LinearIssueCard: "LinearIssueCard" },
    "./heartbeat-card": { HeartbeatCard: "HeartbeatCard" },
    "./computer-use-card": { ComputerUseCard: "ComputerUseCard" },
    "./usage-limit-card": { UsageLimitCard: "UsageLimitCard" },
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
    "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
    "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
    "./theme": { hex: () => "#000" },
    "./viewer-store": { showImages() {} },
    "./ui": { colors: {}, styles: { card: {}, row: {}, muted: {} } },
  });
  const header = (tree) => find(tree, (n) => typeof n.type === "function" && n.type.name === "LinkedHeader");
  const opened = [];
  const delegation = { kind: "delegation", delegationId: "d", from: "/api#2", fromLabel: "api / main / Plan" };
  const sent = ChatReply({
    message: { id: 3, session_id: 4, role: "user", body: "Rename the route", context: delegation },
    media: () => null,
    onActivity() {},
    onOpenChat: (key) => opened.push(key),
  });
  assert.deepEqual(header(sent).props.context, delegation);
  assert.equal(find(sent, (n) => n.type === "Text" && n.props.children === "Rename the route").type, "Text");
  assert.equal(sent.props.style.alignSelf, undefined, "left-aligned, not the user's right-hand bubble");
  // The header's text and tap are the shared ones: tapping opens the sending Chat.
  const line = header(sent).type(header(sent).props);
  assert.equal(find(line, (n) => n.type === "Text").props.children, "Delegation from api / main / Plan");
  line.props.onPress();
  assert.deepEqual(opened, ["/api#2"]);
  const report = { kind: "delegation-report", delegationId: "d", from: "/web#3", fromLabel: "web / main / Fix", status: "done" };
  const back = ChatReply({ message: { id: 5, session_id: 2, role: "assistant", body: "Renamed it.", context: report }, media: () => null, onActivity() {} });
  assert.deepEqual(header(back).props.context, report);
  // An ordinary message has no sender line.
  assert.equal(
    header(ChatReply({ message: { id: 6, session_id: 2, role: "user", body: "Hi", context: null }, media: () => null, onActivity() {} })),
    undefined,
  );
});

test("mobile usage-limit card lists the other accounts, switches on tap, and offers Add or Manage accounts when none can be used", async () => {
  const react = hookHost({ effects: true });
  const pushed = [];
  let snapshot;
  const calls = [];
  let failSwitch = null;
  const client = {
    async call(method, args) {
      calls.push([method, args]);
      if (method === "accounts:scope") return snapshot;
      if (method === "chat:limit-switch") {
        if (failSwitch) throw new Error(failSwitch);
        return { continued: true, label: "b@x.com" };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const session = { client, providerRevision: 0 };
  const { UsageLimitCard } = load("usage-limit-card.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", StyleSheet: { hairlineWidth: 1 }, Text: "Text", View: "View" },
    "expo-router": { router: { push: (href) => pushed.push(href) } },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "./icons": { Icon: "Icon" },
    "./session": { useSession: () => session },
    "./ui": { ErrorNotice: "ErrorNotice", PillButton: "PillButton" },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const render = (props) => {
    react.begin();
    return UsageLimitCard(props);
  };
  const limit = { kind: "limit", provider: "claude", accountId: "a", resetsAt: "2099-10-13T15:10:00.000Z" };
  const account = (id, extra = {}) => ({ id, label: id, email: `${id}@x.com`, state: "ready", ...extra });
  const group = (accounts) => ({ scopeKey: "/work/app", providers: [{ provider: "claude", effectiveId: "a", selectedId: "a", accounts }] });
  const rows = (tree) =>
    [find(tree, (n) => n.type === "View" && n.props.style?.borderTopWidth === 1)].flatMap((box) => (box ? [box.props.children].flat() : []));
  const texts = (tree) => {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (n.type === "Text" && typeof n.props.children === "string") out.push(n.props.children);
      walk(n.props?.children);
    };
    walk(tree);
    return out;
  };

  // Not the last message (or a turn runs): the headline only, and no accounts are fetched.
  const idle = render({ limit, sessionId: 4 });
  assert.ok(texts(idle).includes("Claude hit its usage limit"));
  assert.equal(calls.length, 0);

  snapshot = group([account("a"), account("b", { plan: "Max" }), account("c", { state: "signed-out" })]);
  react.unmount();
  let tree = render({ limit, sessionId: 4, projectPath: "/work/app" });
  await settle();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["accounts:scope", ["/work/app", false]]));
  tree = render({ limit, sessionId: 4, projectPath: "/work/app" });
  const choices = rows(tree);
  assert.equal(choices.length, 2);
  assert.equal(JSON.stringify(texts(choices[0])), JSON.stringify(["Switch to b@x.com", "Personal"]));
  assert.equal(choices[0].props.disabled, false);
  assert.equal(choices[1].props.disabled, true, "a signed-out account is dimmed and cannot be picked");
  assert.equal(
    find(tree, (n) => n.type === "PillButton"),
    undefined,
    "a usable account hides Add and Manage",
  );

  // A refused switch shows its message inline and keeps the rows.
  failSwitch = "Open the project before switching its account.";
  choices[0].props.onPress();
  tree = render({ limit, sessionId: 4, projectPath: "/work/app" });
  assert.ok(
    find(tree, (n) => n.type === "ActivityIndicator"),
    "a spinner marks the tapped row",
  );
  await settle();
  tree = render({ limit, sessionId: 4, projectPath: "/work/app" });
  assert.equal(find(tree, (n) => n.type === "ErrorNotice").props.message, failSwitch);
  assert.equal(rows(tree).length, 2);

  failSwitch = null;
  rows(tree)[0].props.onPress();
  await settle();
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(["chat:limit-switch", ["/work/app", 4, "claude", "b"]]));
  tree = render({ limit, sessionId: 4, projectPath: "/work/app" });
  assert.ok(texts(tree).includes("Switched to b@x.com. Continuing…"));
  assert.equal(rows(tree).length, 0, "the rows give way to the result");
  // The result stays once the continued turn makes the card non-interactive.
  assert.ok(texts(render({ limit, sessionId: 4 })).includes("Switched to b@x.com. Continuing…"));

  // Every other account unusable: Manage accounts. No other account at all: Add account.
  for (const [accounts, title] of [
    [[account("a"), account("c", { state: "signed-out" })], "Manage accounts"],
    [[account("a")], "Add account"],
  ]) {
    snapshot = group(accounts);
    react.unmount();
    const fresh = hookHost({ effects: true });
    Object.assign(react, fresh);
    render({ limit, sessionId: 4, projectPath: "/work/app" });
    await settle();
    const button = find(render({ limit, sessionId: 4, projectPath: "/work/app" }), (n) => n.type === "PillButton");
    assert.equal(button.props.title, title);
    button.props.onPress();
    assert.equal(pushed.at(-1), "/accounts");
  }
});

test("mobile Appearance Custom theme switch selects Custom on, Milagre Blue off, and shows the editor only while on", () => {
  const react = hookHost();
  const saved = [];
  let settings = {
    colorTheme: "nord",
    customThemeEnabled: false,
    customTheme: null,
  };
  const { AppearanceSection } = load("appearance-section.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "ios" } },
    "expo-haptics": {},
    "@milagre/shared/themes": {
      DEFAULT_THEME_ID: "milagre-blue",
      seedsFrom: (id) => ({ from: id }),
      themes: [],
      themeSwatch: () => ({}),
    },
    "./custom-theme-section": { CustomThemeSection: "CustomThemeSection" },
    "./theme": {
      useTheme: () => ({
        colors: fakePalette,
        scheme: "dark",
        settings,
        set(patch) {
          saved.push(patch);
          settings = { ...settings, ...patch };
        },
      }),
    },
    "./ui": { PullDown: "PullDown", Segmented: "Segmented", Toggle: "Toggle", styles: {} },
  });
  const render = () => {
    react.begin();
    return AppearanceSection();
  };
  let tree = render();
  assert.equal(
    find(tree, (n) => n.type === "CustomThemeSection"),
    undefined,
  );
  find(tree, (n) => n.props?.title === "Custom theme").props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), {
    customThemeEnabled: true,
    customTheme: { from: "nord" },
    colorTheme: "custom",
  });
  tree = render();
  assert.ok(find(tree, (n) => n.type === "CustomThemeSection"));
  find(tree, (n) => n.props?.title === "Custom theme").props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), {
    customThemeEnabled: false,
    colorTheme: "milagre-blue",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(settings.customTheme)), { from: "nord" }, "the seeds are kept");
  assert.equal(
    find(render(), (n) => n.type === "CustomThemeSection"),
    undefined,
  );
  // Text and motion rows are pull-down choices, not segmented controls; picking one saves it.
  const textSize = find(render(), (n) => n.props?.label === "Text size");
  assert.ok(textSize && typeof textSize.type === "function", "Text size is a Choice row");
  assert.deepEqual(
    textSize.props.options.map((option) => option.value),
    ["small", "default", "large", "larger"],
  );
  textSize.props.onChange("large");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { textSize: "large" });
  const providerIcons = find(render(), (n) => n.props?.label === "Provider icons");
  assert.deepEqual(
    providerIcons.props.options.map((option) => option.value),
    ["original", "simplified"],
  );
  providerIcons.props.onChange("simplified");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { providerIcons: "simplified" });
  assert.equal(
    find(render(), (n) => n.type === "Segmented" && n.props?.label !== "Mode"),
    undefined,
    "only Mode stays segmented",
  );
});

test("mobile advisor Stop and Retry call the owning Chat and show failures without hiding records", async () => {
  const host = subagentsHost({
    call: async () => {
      throw Error("Advisor Account unavailable");
    },
  });
  host.state.sessions[7].subagents = [
    { id: "advisor:running", title: "Security", source: "milagre-advisor", provider: "codex", status: "running", transcript: [] },
    { id: "advisor:failed", title: "Plan", source: "milagre-advisor", provider: "claude", status: "failed", retryable: true, transcript: [] },
  ];
  await host.button("Stop Security").props.onPress();
  assert.deepEqual(host.calls[0], { method: "advisor:stop", args: ["/project#7", "advisor:running"] });
  assert.ok(find(host.render(), (node) => node.type === "ErrorNotice" && node.props.message === "Advisor Account unavailable"));
  assert.equal(host.state.sessions[7].subagents.length, 2);
  await host.button("Retry Plan").props.onPress();
  assert.deepEqual(host.calls[1], { method: "advisor:retry", args: ["/project#7", "advisor:failed"] });
});

const linearIssue = {
  key: "ENG-12",
  title: "Fix login",
  url: "https://linear.app/acme/issue/ENG-12",
  branchName: "eng-12-fix-login",
  state: { name: "In Progress", type: "started", color: "#f2c94c" },
};

test("a new Chat presents setup, prompt and action controls in focus order", () => {
  const screen = chatHost({ linear: { active: true } });
  const order = [];
  find(screen.render(), (node) => {
    const label = node.props?.label ?? node.props?.accessibilityLabel;
    if (["Choose isolation", "Choose branch", "Start from a Linear issue", "Add photos or files", "Send message"].includes(label)) order.push(label);
    if (["PromptField", "AgentControls", "PermissionChip"].includes(node.type)) order.push(node.type);
    return false;
  });
  assert.deepEqual(order, [
    "Choose isolation",
    "Choose branch",
    "Start from a Linear issue",
    "PromptField",
    "Add photos or files",
    "AgentControls",
    "PermissionChip",
    "Send message",
  ]);
});

test("a new Chat offers a Linear issue chip only while Linear is on and connected", () => {
  const chip = (screen) => find(screen.render(), (node) => node.props?.accessibilityLabel === "Start from a Linear issue");
  assert.ok(!chip(chatHost({ linear: { active: false } })), "off hides the chip");
  assert.ok(chip(chatHost({ linear: { active: true } })), "on and connected shows it after the branch picker");
});

test("picking a Linear issue starts a Chat in its own worktree with the issue as the first message", async () => {
  const { issueFirstMessage } = require("@milagre/shared/linear");
  const screen = chatHost({
    effects: true,
    linear: { active: true },
    call: async (method) => {
      if (method === "project:branches") return ["main"];
      if (method === "linear:issues") return { issues: [linearIssue] };
      if (method === "worktree:create") return { worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } };
      return { sessionId: 7 };
    },
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  find(screen.render(), (node) => node.props?.accessibilityLabel === "Start from a Linear issue").props.onPress();
  await settle();
  // Objects built inside the Chat's vm realm: compare as JSON, not by prototype.
  assert.equal(JSON.stringify(screen.calls.find((call) => call.method === "linear:issues").args), "[{}]");
  const request = screen.choices.at(-1);
  assert.equal(request.title, "Start from a Linear issue");
  assert.equal(JSON.stringify(request.items), JSON.stringify([{ id: "ENG-12", title: "ENG-12 Fix login", subtitle: "In Progress" }]));
  // The branch list lands after the sheet opened; the screen re-renders with it before the pick.
  screen.render();
  request.onSelect("ENG-12");
  await settle();
  const created = screen.calls.find((call) => call.method === "worktree:create").args[0];
  assert.equal(created.issueKey, "ENG-12");
  assert.equal(created.baseBranch, "main");
  const sent = screen.calls.find((call) => call.method === "chat:send").args[0];
  assert.equal(sent.body, issueFirstMessage(linearIssue, "first message"));
  // The Mac reads the issue again and writes the card; the typed text rides along as its note.
  assert.equal(JSON.stringify(sent.linearIssue), JSON.stringify({ key: "ENG-12", note: "first message" }));
  assert.equal(screen.params.id, "7");
});

test("with two Linear workspaces the issue sheet has a tab each, and the picked issue's workspace creates the Chat", async () => {
  const workspaces = [
    { id: "acme", name: "Acme" },
    { id: "beta", name: "Beta Labs" },
  ];
  const screen = chatHost({
    effects: true,
    linear: { active: true },
    call: async (method, args) => {
      if (method === "project:branches") return ["main"];
      if (method === "linear:issues") {
        const workspace = args[0]?.workspace === "beta" ? "beta" : "acme";
        const issues = workspace === "beta" ? [{ ...linearIssue, key: "OPS-7", workspace }] : [{ ...linearIssue, workspace }];
        return { issues, workspace, workspaces };
      }
      if (method === "worktree:create") return { worktreeId: 9, project: { state: { sessions: { 7: { id: 7, worktree_id: 9 } } } } };
      return { sessionId: 7 };
    },
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, name: "main" } };
  find(screen.render(), (node) => node.props?.accessibilityLabel === "Start from a Linear issue").props.onPress();
  await settle();
  const request = screen.choices.at(-1);
  assert.equal(
    JSON.stringify(request.tabs),
    JSON.stringify([
      { id: "acme", label: "Acme" },
      { id: "beta", label: "Beta Labs" },
    ]),
  );
  assert.equal(request.tab, "acme");
  // The sheet's tab reads the other workspace; the same key in two workspaces never collides.
  const beta = await request.load("beta", false);
  assert.equal(JSON.stringify(beta.map((item) => item.id)), JSON.stringify(["beta:OPS-7"]));
  assert.equal(JSON.stringify(screen.calls.findLast((call) => call.method === "linear:issues").args), JSON.stringify([{ fresh: false, workspace: "beta" }]));
  screen.render();
  request.onSelect("beta:OPS-7");
  await settle();
  const created = screen.calls.find((call) => call.method === "worktree:create").args[0];
  assert.equal(created.issueKey, "OPS-7");
  assert.equal(created.issueWorkspace, "beta");
});

test("a Chat row shows its Worktree's Linear issue even without pull requests", () => {
  const external = [];
  const { ChatPullRequestChips } = load("chat-pull-request-chips.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "expo-linking": { openURL: async (url) => external.push(url) },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/pr-blockers": require("@milagre/shared/pr-blockers"),
    "@milagre/shared/linear": require("@milagre/shared/linear"),
    "./icons": { Icon: "Icon" },
    "./ui": { PullDown: "PullDown", colors: { ink2: "ink2", green: "green", purple: "purple", red: "red", orange: "orange" } },
  });
  const tree = ChatPullRequestChips({ pullRequests: [], linearIssue });
  const link = find(tree, (node) => node.props?.accessibilityLabel === "Open Linear issue ENG-12");
  assert.ok(find(link, (node) => node.type === "Text" && node.props.children === "ENG-12 · In Progress"));
  link.props.onPress({ stopPropagation() {} });
  assert.deepEqual(external, [linearIssue.url]);
  assert.equal(ChatPullRequestChips({ pullRequests: [] }), null, "no pull requests and no issue renders nothing");
});

/** A Chat on its own Worktree (path /p/wt), with the Linear issue picker answering with ENG-12. */
function linkableChat({ linear = { active: true }, worktree = { path: "/p/wt", name: "feature" }, call, alert } = {}) {
  const screen = chatHost({
    effects: true,
    linear,
    alert,
    call:
      call ??
      (async (method) => {
        if (method === "project:branches") return ["main"];
        if (method === "linear:issues") return { issues: [linearIssue] };
        if (method === "worktree:link-issue") return { project: { state: {} }, mode: "stored", branch: worktree.name };
        if (method === "worktree:unlink-issue") return { project: { state: {} } };
        return {};
      }),
  });
  screen.session.snapshot.project.state.worktrees = { 1: { id: 1, project_id: 1, ...worktree } };
  screen.session.snapshot.project.state.sessions = { 7: { id: 7, worktree_id: 1, title: "Chat", archived: false, subagents: [] } };
  screen.params.id = "7";
  delete screen.params.worktreeId;
  return screen;
}
function chatMenuEntries(tree) {
  const menu = find(tree, (node) => node.type === "PullDown" && node.props.label === "Chat actions");
  return (menu?.props.sections ?? [])
    .flatMap((section) => section.items)
    .map((item) => ({
      props: { ...item, children: item.title, onPress: () => menu.props.onSelect(item.id) },
    }));
}
const chatMenuEntry = (tree, label) => chatMenuEntries(tree).find((entry) => entry.props.children === label);
const menuEntry = (screen, label) => chatMenuEntry(screen.render(), label);

test("a Chat's own Worktree offers Link issue only while Linear is on", () => {
  assert.ok(menuEntry(linkableChat({ linear: { active: true } }), "Link issue…"), "on shows Link");
  assert.ok(!menuEntry(linkableChat({ linear: { active: false } }), "Link issue…"), "off hides Link");
  assert.ok(!menuEntry(linkableChat({ worktree: { path: "/p", name: "main" } }), "Link issue…"), "the main checkout offers no Link");
});

test("picking a Linear issue links it to the Chat's Worktree and toasts the PR hint when stored", async () => {
  const { LINK_PR_HINT } = require("@milagre/shared/linear");
  const alerts = [];
  const shown = [];
  const screen = linkableChat({ alert: (...args) => shown.push(args) });
  const originalCall = screen.session.client.call;
  screen.session.client.call = (method, args) => {
    if (method === "worktree:link-issue") alerts.push(["link", args]);
    return originalCall(method, args);
  };
  menuEntry(screen, "Link issue…").props.onPress();
  await settle();
  const request = screen.choices.at(-1);
  assert.equal(request.title, "Link a Linear issue");
  request.onSelect("ENG-12");
  await settle();
  // Objects built inside the Chat's vm realm: compare as JSON, not by prototype.
  assert.equal(JSON.stringify(alerts[0]), JSON.stringify(["link", [{ projectPath: "/p", worktreeId: 1, key: "ENG-12" }]]));
  assert.equal(screen.calls.at(-1).method, "worktree:link-issue");
  // The stored result toasts the PR hint, which names the key the branch doesn't; no alert to dismiss.
  assert.equal(shown.length, 0, "no alert");
  assert.ok(toastPill(screen.render(), `Issue linked. ${LINK_PR_HINT("ENG-12")}`), "the toast shows the hint");
});

test("a stored Linear issue is hidden everywhere while Linear is off", () => {
  const { LINK_PR_HINT } = require("@milagre/shared/linear");
  const screen = linkableChat({ linear: { active: false }, worktree: { path: "/p/wt", name: "feature", linearIssue: "ENG-12" } });
  assert.ok(!menuEntry(screen, "Unlink issue"), "no Unlink");
  assert.ok(!menuEntry(screen, LINK_PR_HINT("ENG-12")), "no hint");
});

test("a Worktree another Chat shares offers no Link, and Unlink has a native link icon", () => {
  const shared = linkableChat();
  shared.session.snapshot.project.state.sessions[8] = { id: 8, worktree_id: 1, title: "Other", archived: false, subagents: [] };
  assert.ok(!menuEntry(shared, "Link issue…"), "a shared Worktree offers no Link");
  const stored = linkableChat({ worktree: { path: "/p/wt", name: "feature", linearIssue: "ENG-12" } });
  assert.equal(menuEntry(stored, "Unlink issue").props.systemImage, "link");
});

test("a stored Linear issue shows Unlink, which calls worktree:unlink-issue, and the hint while the branch lacks the key", async () => {
  const { LINK_PR_HINT } = require("@milagre/shared/linear");
  const screen = linkableChat({ worktree: { path: "/p/wt", name: "feature", linearIssue: "ENG-12" } });
  assert.ok(!menuEntry(screen, "Link issue…"), "a stored issue hides Link");
  assert.ok(chatMenuEntry(screen.render(), LINK_PR_HINT("ENG-12")), "hint shows");
  menuEntry(screen, "Unlink issue").props.onPress();
  await settle();
  const unlink = screen.calls.find((call) => call.method === "worktree:unlink-issue");
  assert.equal(JSON.stringify(unlink.args), JSON.stringify([{ projectPath: "/p", worktreeId: 1 }]));
});

test("no PR hint when the branch already names the stored issue", () => {
  const { LINK_PR_HINT } = require("@milagre/shared/linear");
  const screen = linkableChat({ worktree: { path: "/p/wt", name: "eng-12-fix-login", linearIssue: "ENG-12" } });
  assert.ok(!chatMenuEntry(screen.render(), LINK_PR_HINT("ENG-12")));
});

function activityProviderHost({ enabled = true, enabledRead } = {}) {
  const react = hookHost();
  const retained = [],
    synced = [];
  let hosts = [{ id: "mac", name: "Mac", token: "paired" }];
  let reads = 0;
  let requests = 0;
  const nativeActivity = {
    availableAsync: async () => true,
    retainHostsAsync: async (ids) => retained.push([...ids]),
    syncAsync: async (id) => synced.push(id),
  };
  const { ActivityProvider } = load("live-activity.tsx", {
    react: { ...react, useEffect: react.effect, createContext: () => ({ Provider: "ActivityProvider" }) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
    "./session": { useSession: () => ({ hosts }) },
    "./client": {
      createClient: () => ({
        call: async () => {
          requests++;
          return { version: 1 };
        },
      }),
    },
    "./hosts-native": { savedHosts: { list: async () => hosts } },
    "./relay-native": { relayRuntime: {} },
    "./push-native": { pushStore: { read: async () => ({ deviceId: "device", pending: [] }) } },
    "./live-activity-native": { nativeActivity },
    "./live-activity-store": {
      activityEnabled: () => (++reads > 1 && enabledRead ? enabledRead() : Promise.resolve(enabled)),
      activityMode: async () => "all",
      saveActivityEnabled: async () => {},
      saveActivityMode: async () => {},
    },
  });
  const render = () => {
    react.begin();
    ActivityProvider({ children: null });
    react.flush();
  };
  return {
    render,
    retained,
    synced,
    requests: () => requests,
    forget: () => {
      hosts = [];
    },
    cleanup: () => react.cleanup(),
  };
}

test("disabled activity reconciles orphan native activities on startup", async () => {
  const fixture = activityProviderHost({ enabled: false });
  fixture.render();
  await settle();
  fixture.render();
  await settle();
  assert.deepEqual(fixture.retained, [[]]);
  assert.deepEqual(fixture.synced, []);
  fixture.cleanup();
});

test("a refresh stopped during settings read cannot recreate a forgotten activity", async () => {
  const read = deferred();
  const fixture = activityProviderHost({ enabledRead: () => read.promise });
  fixture.render();
  await settle();
  fixture.render();
  await settle();
  assert.equal(fixture.requests(), 1);
  fixture.forget();
  fixture.render();
  await settle();
  read.resolve(true);
  await settle();
  assert.deepEqual(fixture.synced, []);
  assert.deepEqual(fixture.retained.at(-1), []);
  fixture.cleanup();
});

test("an answer completing after computer removal cannot update its activity", async () => {
  const response = deferred(),
    completed = [],
    ended = [];
  let hosts = [{ id: "mac", token: "paired" }];
  let listener;
  const { installActivityAnswers } = load("live-activity-native.ts", {
    "expo-modules-core": {
      requireOptionalNativeModule: () => ({
        addListener: (_event, handle) => {
          listener = handle;
        },
        pendingActionsAsync: async () => [],
        completeAsync: async (...args) => completed.push(args),
        endAsync: async (id) => ended.push(id),
      }),
    },
    "./client": { createClient: () => ({ call: () => response.promise }) },
    "./hosts-native": { savedHosts: { list: async () => hosts } },
    "./push-native": { pushStore: { read: async () => ({ deviceId: "device", pending: [] }) } },
    "./live-activity-store": { activityEnabled: async () => true, activityMode: async () => "all" },
    "./relay-native": { relayRuntime: {} },
  });
  installActivityAnswers();
  listener({ id: "action", hostId: "mac", target: "question", position: 1, option: 0 });
  await settle();
  hosts = [];
  response.resolve({ status: "accepted", content: { version: 1 } });
  await settle();
  assert.deepEqual(ended, ["mac"]);
  assert.deepEqual(completed, [["action", "mac", "unknown", null]]);
});

function genuiHost({ send = async () => true, streaming = false, withoutProvider = false } = {}) {
  const react = hookHost({ effects: true });
  const actions = [];
  const contexts = new Map();
  react.createContext = (initial) => {
    const context = { initial };
    contexts.set(context, initial);
    return context;
  };
  react.useContext = (context) => contexts.get(context);
  react.Component = class {
    constructor(props) {
      this.props = props;
    }
    render() {
      return this.props.children;
    }
  };
  const source = load(
    "genui/GenerativeUI.tsx",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { View: "View" },
      "@milagre/shared/genui-renderer": { Renderer: "Renderer" },
      "@milagre/shared/genui": require("../packages/shared/src/genui.ts"),
      "./library": { genuiLibrary: "library" },
    },
    "\nexports.TestContexts = { send: SendContext, streaming: MarkdownStreamingContext };",
  );
  contexts.set(source.TestContexts.send, withoutProvider ? {} : { send });
  contexts.set(source.TestContexts.streaming, streaming);
  return {
    actions,
    render(code) {
      react.begin();
      const tree = source.GenerativeUI({ code, fallback: "Fallback" });
      react.flush();
      return tree;
    },
  };
}

test("a genui block renders through the Renderer and a @ToAssistant action sends its message once", async () => {
  const sent = [];
  let release;
  const h = genuiHost({
    send: (text) =>
      new Promise((resolve) => {
        sent.push(text);
        release = resolve;
      }),
  });
  const renderer = find(h.render("root = Stack([])"), (node) => node.type === "Renderer");
  assert.equal(renderer.props.library, "library");
  assert.equal(renderer.props.isStreaming, false);
  const tap = () => renderer.props.onAction({ type: "continue_conversation", params: {}, humanFriendlyMessage: "Merge them" });
  void tap();
  void tap();
  await settle();
  assert.deepEqual(sent, ["Merge them"], "the second tap during a send is ignored");
  release(true);
  await settle();
  renderer.props.onAction({ type: "open_url", params: { url: "https://example.com" }, humanFriendlyMessage: "" });
  await settle();
  assert.deepEqual(sent, ["Merge them"], "only continue_conversation sends");
});

test("a genui block over the text cap, or without a root once the reply finished, shows the fallback", () => {
  const { genuiLimits } = require("../packages/shared/src/genui.ts");
  const h = genuiHost();
  assert.equal(h.render("x".repeat(genuiLimits.text + 1)).props.children, "Fallback");
  const tree = h.render('nothing = Heading("no root")');
  find(tree, (node) => node.type === "Renderer").props.onParseResult({ root: null, meta: {} });
  const after = h.render('nothing = Heading("no root")');
  assert.equal(JSON.stringify(after).includes("Fallback"), true);
});

test("while streaming, a rootless block stays a live Renderer, not the fallback", () => {
  const h = genuiHost({ streaming: true });
  const tree = h.render('root = Stack([title])\ntitle = Heading("Strea');
  const renderer = find(tree, (node) => node.type === "Renderer");
  assert.equal(renderer.props.isStreaming, true);
  renderer.props.onParseResult({ root: null, meta: {} });
  assert.equal(JSON.stringify(h.render('root = Stack([title])\ntitle = Heading("Strea').props.children).includes("Fallback"), false);
});

test("the phone library binds a renderer to every component of the contract and a button triggers its action", () => {
  const { GENUI_COMPONENTS } = require("../packages/shared/src/genui.ts");
  const triggered = [];
  const components = load("genui/components.tsx", {
    react: hookHost(),
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "react-native-svg": { default: "Svg", Circle: "Circle", Polyline: "Polyline", Rect: "Rect", Text: "SvgText" },
    "@milagre/shared/genui-renderer": {
      useTriggerAction:
        () =>
        (...args) =>
          triggered.push(args),
      useIsStreaming: () => false,
    },
    "@milagre/shared/genui": require("../packages/shared/src/genui.ts"),
    "../ui": { Button: "Button", PageScroll: "PageScroll" },
    "./charts": load("genui/charts.tsx", {
      "@milagre/shared/genui": require("../packages/shared/src/genui.ts"),
      react: hookHost(),
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { Text: "Text", View: "View" },
      "react-native-svg": { default: "Svg", Circle: "Circle", Polyline: "Polyline", Rect: "Rect", Text: "SvgText" },
    }),
  });
  assert.deepEqual(Object.keys(components.renderers), Object.keys(GENUI_COMPONENTS));
  const action = { steps: [{ type: "continue_conversation", message: "Go" }] };
  const button = components.renderers.Button({ props: { label: "Go", action }, renderNode: () => null });
  find(button, (node) => node.type === "Button").props.onPress();
  assert.deepEqual(triggered, [["Go", undefined, action]]);
  const table = components.renderers.Table({ props: { columns: ["a", "b"], rows: [["1"]] }, renderNode: () => null });
  assert.match(JSON.stringify(table), /"1"/);
});

test("genui buttons disable during a send, recover from rejection, and stay disabled outside Chat", async () => {
  const pending = deferred();
  const sent = [];
  const h = genuiHost({
    send: (message) => {
      sent.push(message);
      return pending.promise;
    },
  });
  const renderer = () => find(h.render("root = Stack([])"), (node) => node.type === "Renderer");
  const action = { type: "continue_conversation", params: {}, humanFriendlyMessage: "Retry" };
  const first = renderer().props.onAction(action);
  await renderer().props.onAction(action);
  assert.equal(renderer().props.isStreaming, true);
  assert.deepEqual(sent, ["Retry"]);
  pending.reject(new Error("Offline"));
  await first;
  assert.equal(renderer().props.isStreaming, false);
  await renderer().props.onAction(action);
  assert.deepEqual(sent, ["Retry", "Retry"]);
  const outside = genuiHost({ withoutProvider: true });
  assert.equal(find(outside.render("root = Stack([])"), (node) => node.type === "Renderer").props.isStreaming, true);
});

test("mobile markdown routes openui fences and passes streaming state", () => {
  const h = markdownHost();
  const tree = h.render("```OpenUI title=Example\nroot = Stack([])\n", true);
  const block = find(tree, (node) => node.type === "GenerativeUI");
  assert.equal(block.props.code, "root = Stack([])");
  assert.equal(find(tree, (node) => node.type === "MarkdownStreamingContext").props.value, true);
  assert.equal(
    find(h.render("```ts\nconst x = 1\n```"), (node) => node.type === "GenerativeUI"),
    undefined,
  );
});

test("mobile markdown routes mermaid fences to the diagram, with the code as its fallback", () => {
  const h = markdownHost();
  const block = find(h.render("```mermaid\nflowchart LR\n  A --> B\n```"), (node) => node.type === "MermaidBlock");
  assert.equal(block.props.code, "flowchart LR\n  A --> B");
  assert.ok(
    find(block.props.plain, (node) => node.props?.children === "flowchart LR\n  A --> B"),
    "the plain code block rides along",
  );
  assert.equal(
    find(h.render("```ts\nconst x = 1\n```"), (node) => node.type === "MermaidBlock"),
    undefined,
  );
});

test("new Chat restores worktree choices on reopen, falls back from a removed branch and never starts a Linear issue", async () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItemAsync: async (key, value) => data.set(key, value) };
  const create = () => require("../apps/mobile/src/chat-defaults-store.ts").createChatDefaultsStore(storage);
  const first = chatHost({ effects: true, chatDefaults: create(), call: async () => ["main", "release"] });
  const menu = (screen, label) => find(screen.render(), (node) => node.type === "PullDown" && node.props.label === label);
  first.render();
  await settle();
  menu(first, "Choose isolation").props.onSelect("worktree");
  menu(first, "Choose branch").props.onSelect("release");
  await settle();
  const reopened = chatHost({ effects: true, chatDefaults: create(), linear: { active: true }, call: async () => ["main", "release"] });
  reopened.render();
  await settle();
  assert.equal(menu(reopened, "Choose isolation").props.nativeTrigger.title, "New worktree");
  assert.equal(menu(reopened, "Choose branch").props.nativeTrigger.title, "release");
  assert.equal(
    reopened.calls.some((call) => call.method === "worktree:create"),
    false,
  );
  assert.equal(reopened.field().value, "first message");
  const removed = chatHost({ effects: true, chatDefaults: create(), call: async () => ["main"] });
  removed.render();
  await settle();
  assert.equal(menu(removed, "Choose branch").props.nativeTrigger.title, "main");
});

test("Composer restores model and permission defaults after relaunch without a provider switch", async () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItemAsync: async (key, value) => data.set(key, value) };
  const create = () => require("../apps/mobile/src/chat-defaults-store.ts").createChatDefaultsStore(storage);
  const first = sessionHost({ call: async () => {} }, { chatDefaults: create() });
  first
    .composer()
    .setDefaultModel({ ...require("../apps/mobile/src/turn-options.ts").defaultPreferences, provider: "claude", model: "claude-opus-5-5", pickedOn: "codex" });
  await settle();
  const reopened = sessionHost({ call: async () => {} }, { effects: true, chatDefaults: create(), permission: "full" });
  reopened.composer();
  await settle();
  const defaults = reopened.composer().defaults;
  assert.equal(defaults.provider, "claude");
  assert.equal(defaults.model, "claude-opus-5-5");
  assert.equal(defaults.permissionMode, "full");
  assert.equal(defaults.pickedOn, undefined);
});

test("the phone Designs setting keeps the last confirmed value through refresh and reconnects", async () => {
  const { createDesignsSetting } = require("../apps/mobile/src/designs-setting.ts");
  let read = deferred();
  const calls = [];
  const setting = createDesignsSetting({
    call(method, args) {
      calls.push([method, args]);
      return read.promise;
    },
  });
  // An older Mac can still report Designs off.
  const first = setting.refresh();
  assert.equal(setting.getSnapshot().enabled, null);
  read.resolve({ enabled: false });
  await first;
  assert.equal(setting.getSnapshot().stale, false);
  assert.equal(setting.getSnapshot().enabled, false);
  read = deferred();
  const retry = setting.refresh();
  read.resolve({ enabled: true });
  await retry;
  assert.equal(setting.getSnapshot().enabled, true);
  read = deferred();
  const checking = setting.refresh();
  assert.equal(setting.getSnapshot().enabled, true, "refresh does not unmount an open design");
  assert.equal(setting.getSnapshot().stale, true);
  read.reject(new Error("Offline"));
  await checking;
  assert.equal(setting.getSnapshot().enabled, true);
  assert.equal(setting.getSnapshot().error, "Offline");
  read = deferred();
  const stale = setting.refresh();
  setting.unavailable("Reconnect");
  read.resolve({ enabled: false });
  await stale;
  assert.equal(setting.getSnapshot().enabled, true, "a read from before disconnection cannot overwrite the last confirmation");
  assert.equal(setting.getSnapshot().stale, true);
  assert.equal(setting.getSnapshot().error, "Reconnect");
  read = deferred();
  const reconnected = setting.refresh();
  read.resolve({ enabled: false });
  await reconnected;
  assert.equal(setting.getSnapshot().enabled, false, "confirmed remote OFF applies while the last value was ON");
  assert.equal(setting.getSnapshot().stale, false);
  assert.ok(
    calls.every(([method]) => method === "designs:enabled:read"),
    "the phone only reads the setting",
  );
  setting.dispose();
  const unsupported = createDesignsSetting({ call: async () => null });
  await unsupported.refresh();
  assert.match(unsupported.getSnapshot().error, /Update Milagre/);
  assert.equal(unsupported.getSnapshot().enabled, null, "a new or unsupported host has no previous confirmation");
  unsupported.dispose();
});

test("the phone receives Designs changes without an open Project and clears only that host's pending feedback", async () => {
  const react = hookHost({ effects: true });
  const outbox = require("../apps/mobile/src/design-outbox.ts");
  let enabled = true,
    events,
    closed = 0;
  const client = {
    url: "design-host",
    call: async () => ({ enabled }),
    live(projectPath, options) {
      assert.equal(projectPath, "");
      events = options;
      return {
        close() {
          closed++;
        },
      };
    },
  };
  const { useDesigns } = load("use-designs.ts", {
    react: { ...react, useSyncExternalStore: (_subscribe, read) => read() },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
    },
    "./designs-setting": require("../apps/mobile/src/designs-setting.ts"),
    "./design-outbox": outbox,
  });
  const render = () => {
    react.begin();
    return useDesigns(client);
  };
  render();
  await settle();
  assert.equal(render().enabled, true);
  const pending = { text: "Request", onSent() {} };
  outbox.postDesignMessage("design-host|/p#7", pending);
  outbox.postDesignMessage("other-host|/p#7", pending);
  const artifactPending = { ...pending, kind: "artifacts" };
  outbox.postDesignMessage("design-host|/p#8", artifactPending);
  enabled = false;
  events.onSignal("designs");
  assert.equal(render().enabled, true, "the current design stays mounted until the host confirms OFF");
  assert.equal(render().stale, true);
  await settle();
  assert.equal(render().enabled, false);
  assert.equal(outbox.peekDesignMessage("design-host|/p#7"), null);
  assert.equal(outbox.peekDesignMessage("other-host|/p#7"), pending);
  assert.equal(outbox.peekDesignMessage("design-host|/p#8"), artifactPending, "turning Designs off keeps Artifact feedback");
  outbox.designMessageSent("design-host|/p#8", artifactPending);
  events.onStatus(true);
  await settle();
  events.onStatus(false);
  assert.equal(render().enabled, false);
  assert.equal(render().stale, true);
  assert.match(render().error, /Reconnect/);
  react.cleanup();
  outbox.clearDesignMessages("other-host");
  assert.equal(closed, 1);
});

test("a confined phone uses its allowed scope, then reuses the Project socket without resetting its confirmed Designs value", async () => {
  const react = hookHost({ effects: true });
  let enabled = true,
    events,
    closed = 0,
    reads = 0;
  const scopes = [];
  const client = {
    url: "confined-design-host",
    call: async () => {
      reads++;
      return { enabled };
    },
    live(scope, options) {
      assert.equal(scope, "/allowed", "a confined phone must not try the rejected global scope");
      scopes.push(scope);
      events = options;
      return { close: () => closed++ };
    },
  };
  const { useDesigns } = load("use-designs.ts", {
    react: { ...react, useSyncExternalStore: (_subscribe, read) => read() },
    "react-native": {
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove() {} }),
      },
    },
    "./designs-setting": require("../apps/mobile/src/designs-setting.ts"),
    "./design-outbox": require("../apps/mobile/src/design-outbox.ts"),
  });
  let activeClient = client,
    projectPath;
  const render = () => {
    react.begin();
    return useDesigns(activeClient, projectPath, "/allowed");
  };
  render();
  await settle();
  events.onStatus(true);
  await settle();
  assert.equal(render().enabled, true);
  projectPath = "/allowed";
  assert.equal(render().enabled, true);
  render().connectionChanged(true);
  await settle();
  assert.deepEqual(scopes, ["/allowed"], "opening the Project reuses its Session socket");
  assert.equal(closed, 1);
  const afterOpen = reads;
  render().connectionChanged(true);
  await settle();
  assert.equal(reads, afterOpen, "repeated connected status does not refetch the setting");
  enabled = false;
  await render().refresh(); // Session forwards its Project socket's designs signal here.
  assert.equal(render().enabled, false);
  render().connectionChanged(false);
  assert.equal(render().enabled, false);
  assert.equal(render().stale, true);
  enabled = true;
  render().connectionChanged(true);
  await settle();
  assert.equal(render().enabled, true);
  const firstAnswer = deferred();
  activeClient = {
    ...client,
    url: "another-host",
    call: () => firstAnswer.promise,
  };
  assert.equal(render().enabled, null, "another host never inherits a previous host's confirmation");
  firstAnswer.resolve({ enabled: false });
  await settle();
  assert.equal(render().enabled, false);
  react.cleanup();
});

test("legacy design feedback remains plain readable transcript text, including when mixed with structured feedback", async () => {
  const legacy = { id: "old", title: "Old landing", version: 2 };
  const modern = {
    id: "new",
    format: "design",
    title: "New landing",
    version: 1,
  };
  const client = { url: "mixed-feedback-host", call: async () => [modern] };
  const feedback = {
    choice: legacy,
    comments: [{ design: legacy, id: "comment-old", text: "Keep the warmer colors." }],
  };
  const h = artifactHost(client);
  h.render("DesignFeedbackCard", { chatId: "/p#7", feedback });
  await settle();
  const plain = h.render("DesignFeedbackCard", { chatId: "/p#7", feedback });
  assert.equal(plain.type, "Text");
  assert.equal(plain.props.children, "Chose Old landing (version 2).\n\nOld landing (version 2): Keep the warmer colors.");
  assert.doesNotMatch(plain.props.children, /design_read|design_apply|artifact_show|comment-old/);
  const mixed = h.render("DesignFeedbackCard", {
    chatId: "/p#7",
    feedback: {
      ...feedback,
      comments: [...feedback.comments, { design: modern, text: "Enlarge the heading." }],
    },
  });
  assert.ok(find(mixed, (node) => node.props.accessibilityLabel === "Feedback on the designs"));
  assert.ok(find(mixed, (node) => node.type === "Text" && node.props.children === plain.props.children));
  assert.ok(find(mixed, (node) => node.type === "Text" && node.props.children === "Enlarge the heading."));
  h.cleanup();
});

test("turning Designs off closes an open phone review and preserves plain feedback without design widgets or fetching", async () => {
  const { createExampleDesign, designHtml } = require("../packages/shared/src/design.mjs");
  const document = createExampleDesign();
  const artifact = {
    id: "sample",
    format: "design",
    title: "Sample",
    version: 1,
    latest: 1,
    versions: 1,
    width: 390,
    height: 844,
    document,
    html: designHtml(document),
  };
  const calls = [];
  const client = {
    url: "off-host",
    call: async (method) => {
      calls.push(method);
      return method === "artifact:list"
        ? [artifact]
        : method === "artifact:comments"
          ? []
          : method === "artifact:sharing-status"
            ? { available: false }
            : artifact;
    },
  };
  const feature = { ...designsOn };
  let backs = 0;
  const h = designsHost(client, { back: () => backs++ }, feature);
  const props = { hostId: client.url, chatId: "/p#7", id: "sample" };
  let tree = await h.open(props);
  assert.ok(find(tree, (node) => node.type === "PullDown"));
  feature.enabled = false;
  calls.length = 0;
  tree = h.render("DesignsSheet", props);
  assert.equal(backs, 1);
  assert.equal(
    find(tree, (node) => node.type === "PullDown" || node.type?.name === "DesignsCanvas"),
    undefined,
  );
  assert.deepEqual(calls, []);
  h.cleanup();
  const cards = artifactHost(client, [], undefined, feature);
  assert.equal(
    cards.render("ArtifactCards", {
      chatId: "/p#7",
      steps: [{ id: "s", artifact }],
    }),
    null,
  );
  cards.cleanup();
  const feedback = artifactHost(client, [], undefined, feature);
  const plain = feedback.render("DesignFeedbackCard", {
    chatId: "/p#7",
    feedback: {
      choice: artifact,
      comments: [
        {
          design: artifact,
          id: "123abc",
          x: 0.2,
          text: "Make the heading larger.",
        },
      ],
    },
  });
  assert.equal(plain.type, "Text");
  assert.equal(plain.props.children, "Chose Sample (version 1).\n\nSample (version 1): Make the heading larger.");
  assert.doesNotMatch(plain.props.children, /design_read|design_apply|artifact_show|123abc/);
  feedback.cleanup();
  assert.deepEqual(calls, [], "off does not fetch saved designs or feedback");
});

test("phone cards preserve unmarked structured designs while excluding unverified refs, with one shared catalog per Chat", async () => {
  const catalog = require("../apps/mobile/src/design-catalog.ts");
  let calls = 0;
  const client = {
    url: "catalog-host",
    call: async (method) => {
      if (method !== "artifact:list") throw Error("Unknown artifact");
      calls++;
      return [
        { id: "structured", format: "design", version: 2 },
        { id: "fresh", format: "design", version: 1 },
        { id: "retired", version: 1 },
      ];
    },
  };
  const steps = [
    { id: "first", artifact: { id: "structured", version: 1, title: "Kept" } },
    { id: "second", artifact: { id: "retired", version: 1, title: "HTML" } },
    {
      id: "third",
      artifact: { id: "fresh", format: "design", version: 1, title: "New" },
    },
  ];
  const h = artifactHost(client);
  const before = h.render("ArtifactCards", { steps, chatId: "/p#7" });
  assert.equal(before.props.step.artifact.id, "fresh", "marked structured refs render immediately");
  await settle();
  const tree = h.render("ArtifactCards", { steps, chatId: "/p#7" });
  assert.equal(tree.props.accessibilityLabel, "2 designs: Kept, New. Open full screen");
  const other = artifactHost(client);
  other.render("ArtifactCards", { steps, chatId: "/p#7" });
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(
    catalog.designCatalog(client, "/p#7").map((design) => design.id),
    ["structured", "fresh"],
  );
  steps[0].artifact.version = 2;
  h.render("ArtifactCards", { steps, chatId: "/p#7" });
  await settle();
  assert.equal(calls, 2, "a completed new version refreshes the catalog");
  h.cleanup();
  other.cleanup();
});

test("phone cards drop a design the host no longer lists, and one deleted on the phone", async () => {
  const catalog = require("../apps/mobile/src/design-catalog.ts");
  const client = {
    url: "deleted-host",
    call: async (method) => {
      if (method !== "artifact:list") throw Error("Unknown artifact");
      return [
        { id: "kept", format: "design", version: 1 },
        { id: "other", format: "design", version: 1 },
      ];
    },
  };
  const steps = ["kept", "other", "gone"].map((id) => ({ id, artifact: { id, format: "design", version: 1, title: id[0].toUpperCase() + id.slice(1) } }));
  const h = artifactHost(client);
  h.render("ArtifactCards", { steps, chatId: "/p#8" });
  await settle();
  assert.equal(h.render("ArtifactCards", { steps, chatId: "/p#8" }).props.accessibilityLabel, "2 designs: Kept, Other. Open full screen");
  catalog.markDesignDeleted(client, "/p#8", "other");
  assert.equal(h.render("ArtifactCards", { steps, chatId: "/p#8" }).props.step.artifact.id, "kept");
  h.cleanup();
});

test("the phone refuses a retired HTML design response even while Designs is enabled", async () => {
  const h = artifactHost({
    url: "legacy-host",
    call: async (method) => (method === "artifact:list" ? [] : { id: "old", version: 1, html: "<h1>Retired</h1>" }),
  });
  const props = { hostId: "legacy-host", chatId: "/p#7", id: "old" };
  h.render("ArtifactSheet", props);
  await settle();
  const tree = h.render("ArtifactSheet", props);
  assert.equal(
    find(tree, (node) => node.props.html),
    undefined,
  );
  assert.equal(
    find(tree, (node) => node.props.title === "Choose"),
    undefined,
  );
  assert.ok(find(tree, (node) => node.props.children === "This page is no longer available."));
  h.cleanup();
});

test("mobile page sharing opens the Chat's Share sheet over the designs, regardless of the selected design or version", async () => {
  const design = { id: "one", version: 1, latest: 2, versions: 2, title: "One", format: "design", document: {}, html: "<main>One</main>" };
  const feature = { ...designsOn };
  const client = {
    url: "mac",
    call: async (method) =>
      method === "artifact:sharing-status" ? { available: true } : method === "artifact:list" ? [design, { ...design, id: "two" }] : design,
  };
  const pushes = [];
  const h = designsHost(client, { back() {} }, feature, pushes);
  const props = { hostId: "mac", chatId: "/p#7", id: "one", version: "1" };
  let tree = await h.open(props);
  find(tree, (node) => node.type === "PullDown").props.onSelect("share");
  assert.deepEqual(
    JSON.parse(JSON.stringify(pushes)),
    [{ pathname: "/design-share-sheet", params: { hostId: "mac", chatId: "/p#7" } }],
    "no design id or version: sharing captures the whole page",
  );
  // The sheet's own health check reaches the designs it opened from.
  h.shareAvailabilityChanged("mac", "/p#7", false);
  tree = h.render("DesignsSheet", props);
  assert.equal(
    menuItems(tree).find((item) => item.id === "share"),
    undefined,
    "a failed health check in the sheet hides the entry point",
  );
  h.shareAvailabilityChanged("mac", "/p#7", true);
  tree = h.render("DesignsSheet", props);
  assert.ok(menuItems(tree).find((item) => item.id === "share"));
  h.shareAvailabilityChanged("mac", "/p#8", false);
  tree = h.render("DesignsSheet", props);
  assert.ok(
    menuItems(tree).find((item) => item.id === "share"),
    "another Chat's sheet changes nothing here",
  );
  feature.enabled = false;
  tree = h.render("DesignsSheet", props);
  assert.equal(
    menuItems(tree).find((item) => item.id === "share"),
    undefined,
  );
  h.cleanup();
});

test("mobile Share stays hidden until the current host is healthy and refreshes on foreground", async () => {
  const design = { id: "one", version: 1, title: "One", format: "design", document: {}, html: "<main>One</main>" };
  const requests = [];
  const makeClient = (url) => ({
    url,
    call(method) {
      if (method !== "artifact:sharing-status") return Promise.resolve(method === "artifact:list" ? [design] : method === "artifact:comments" ? [] : design);
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  const h = designsHost(makeClient("first"));
  const props = { hostId: "first", chatId: "/p#7", id: "one" };
  const render = () => h.render("DesignsSheet", props);
  const share = () => menuItems(render()).find((item) => item.id === "share");
  render();
  await settle();
  assert.equal(share(), undefined, "initial health request has no Share flash");
  requests[0].resolve({ available: false });
  await settle();
  assert.equal(share(), undefined, "unavailable hosts hide Share");
  for (const message of ["Unknown method", "Forbidden"]) {
    h.appState("active");
    requests.at(-1).reject(new Error(message));
    await settle();
    assert.equal(share(), undefined, "older hosts and confined phones hide Share");
  }
  h.appState("active");
  requests.at(-1).resolve({ available: true });
  await settle();
  assert.ok(share());
  h.appState("background");
  assert.equal(share(), undefined);
  h.appState("active");
  const stale = requests.at(-1);
  assert.equal(share(), undefined, "foreground check is pending");
  h.setClient(makeClient("second"));
  props.hostId = "second";
  assert.equal(share(), undefined, "host switches cannot reuse a healthy status");
  stale.resolve({ available: true });
  await settle();
  assert.equal(share(), undefined, "old host response is ignored");
  requests.at(-1).resolve({ available: true });
  await settle();
  assert.ok(share());
  props.chatId = "/p#8";
  assert.equal(share(), undefined, "a different page waits for its own health check");
  requests.at(-1).resolve({ available: true });
  await settle();
  assert.ok(share());
  h.appState("active");
  const older = requests.at(-1);
  h.appState("active");
  requests.at(-1).resolve({ available: false });
  await settle();
  older.resolve({ available: true });
  await settle();
  assert.equal(share(), undefined, "a superseded successful response cannot restore Share");
  h.cleanup();
});

test("mobile publishing checks availability, retries, and keeps history available in the global manager", async () => {
  const react = hookHost({ effects: true });
  let state = {
    shares: [],
    loading: false,
    loaded: true,
    busy: null,
    error: "",
    checking: true,
    availability: null,
  };
  const calls = [];
  const store = {
    getSnapshot: () => state,
    subscribe() {
      return () => {};
    },
    refresh() {
      calls.push("history");
    },
    checkAvailability() {
      calls.push("status");
    },
    async publish(title) {
      calls.push(["publish", title]);
      const updated = state.shares.length ? { updatedAt: 2 } : {};
      state = { ...state, shares: [{ id: "snapshot", title, url: "https://share.milagre.cloud/s/snapshot", designCount: 2, createdAt: 1, ...updated }] };
    },
    async revoke(id) {
      calls.push(["revoke", id]);
      state = { ...state, shares: state.shares.filter((share) => share.id !== id) };
    },
    dispose() {},
  };
  const { DesignPageShareSheet } = load("design-page-share.tsx", {
    react: { ...react, useSyncExternalStore: (_subscribe, read) => read() },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View",
      Text: "Text",
      TextInput: "TextInput",
      Platform: { OS: "ios" },
      Linking: {},
      Share: {},
    },
    "expo-clipboard": { setStringAsync: async (url) => calls.push(["copy", url]) },
    "@hugeicons/core-free-icons": { ArrowLeft01Icon: "back" },
    "./design-page-sharing": { createDesignPageSharing: () => store },
    "./ui": {
      CircleButton: "CircleButton",
      PageScroll: "PageScroll",
      PillButton: "PillButton",
    },
  });
  const availability = [];
  const onAvailabilityChange = (available) => availability.push(available);
  const render = (chatId) => {
    react.begin();
    return DesignPageShareSheet({ client: {}, chatId, onClose() {}, onAvailabilityChange });
  };
  const text = (tree, value) => find(tree, (n) => typeof n.props?.children === "string" && n.props.children.includes(value));
  let tree = render("chat");
  assert.equal(availability.at(-1), null);
  assert.ok(find(tree, (n) => n.props?.children === "Share"));
  assert.equal(find(tree, (n) => n.props?.title === "Publish").props.disabled, true);
  assert.ok(find(tree, (n) => n.props?.children === "Checking the sharing service..."));
  assert.ok(text(tree, "Anyone with the link can view it."));
  state = {
    ...state,
    checking: false,
    availability: { available: false, reason: "Not deployed" },
  };
  tree = render("chat");
  assert.equal(find(tree, (n) => n.props?.title === "Publish").props.disabled, true);
  assert.ok(find(tree, (n) => n.props?.children === "Not deployed"));
  assert.equal(availability.at(-1), false, "dialog health failure updates the entry gate");
  find(tree, (n) => n.props?.title === "Retry check").props.onPress();
  assert.equal(calls.at(-1), "status");
  state = { ...state, availability: { available: true } };
  assert.equal(find(render("chat"), (n) => n.props?.title === "Publish").props.disabled, false);
  assert.equal(availability.at(-1), true);
  find(render("chat"), (n) => n.props?.title === "Publish").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render("chat");
  assert.deepEqual(calls.at(-1), ["copy", "https://share.milagre.cloud/s/snapshot"], "publishing copies the link right away");
  assert.ok(toastPill(tree, "Published. Link copied."), "a toast says what happened");
  assert.equal(
    find(tree, (n) => n.props?.title === "Publish"),
    undefined,
    "a shared page offers an update instead",
  );
  assert.ok(find(tree, (n) => n.props?.title === "Update snapshot"));
  assert.ok(find(tree, (n) => n.props?.accessibilityLabel === "Snapshot link"));
  assert.ok(text(tree, "Published "));
  assert.equal(text(tree, "Published snapshots"), undefined, "no history list under the link");
  find(tree, (n) => n.props?.title === "Copy link").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["copy", "https://share.milagre.cloud/s/snapshot"]);
  find(render("chat"), (n) => n.props?.title === "Update snapshot").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render("chat");
  assert.deepEqual(calls.at(-2), ["publish", "Designs"], "only an older host needs the title");
  assert.deepEqual(calls.at(-1), ["copy", "https://share.milagre.cloud/s/snapshot"]);
  assert.equal(state.shares.length, 1, "the update keeps one link");
  assert.ok(toastPill(tree, "Snapshot updated. Link copied."));
  assert.ok(text(tree, "Updated "));
  find(tree, (n) => n.props?.title === "Revoke link").props.onPress();
  tree = render("chat");
  assert.ok(find(tree, (n) => n.props?.children === "Remove this page? Copies may remain online."));
  find(tree, (n) => n.props?.title === "Revoke link" && !n.props.secondary).props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  tree = render("chat");
  assert.deepEqual(calls.at(-1), ["revoke", "snapshot"]);
  assert.ok(
    find(tree, (n) => n.props?.title === "Publish"),
    "after revoking, Publish creates a new link",
  );
  assert.equal(
    find(tree, (n) => n.props?.accessibilityLabel === "Snapshot link"),
    undefined,
  );
  assert.ok(toastPill(tree, "Link revoked. Copies may remain online."));
  tree = render(undefined);
  assert.equal(
    find(tree, (n) => n.props?.title === "Publish"),
    undefined,
  );
  assert.equal(
    find(tree, (n) => n.props?.accessibilityLabel === "Page title"),
    undefined,
  );
  assert.ok(find(tree, (n) => n.props?.children === "Published pages"));
});

test("mobile Published pages entry requires owner access", async () => {
  for (const allowed of [true, false]) {
    const react = hookHost();
    const focuses = [];
    const pushed = [];
    const session = {
      client: {
        call: async (method) => {
          if (method === "artifact:all-page-shares") {
            if (!allowed) throw new Error("403");
            return [];
          }
          return null;
        },
      },
    };
    const { PublishedPagesSection } = load("published-pages-section.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { View: "View", Text: "Text" },
      "expo-router": {
        useFocusEffect: (fn) => focuses.push(fn),
        router: { push: (path) => pushed.push(path) },
      },
      "./session": { useSession: () => session },
      "./ui": { ListRow: "ListRow", useStyles: () => ({}) },
    });
    const render = () => {
      react.begin();
      return PublishedPagesSection();
    };
    // Nothing shows while the Mac is asked, so a refused owner check never flashes the row.
    assert.equal(render(), null);
    focuses[0]();
    await settle();
    const tree = render();
    const row = find(tree, (n) => n.props?.title === "Published pages");
    assert.equal(!!row, allowed);
    assert.equal(!!find(tree, (n) => n.type === "Toggle"), false, "Designs can't be turned off");
    if (allowed) {
      row.props.onPress();
      assert.deepEqual(pushed, ["/published-pages"]);
    } else assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "Only the Mac's owner can manage its published pages."));
  }
});

test("local MCP phone settings configure a client, disable it and copy a custom design-only connection", async () => {
  const hooks = hookHost({ effects: true });
  const shared = require("../packages/shared/src/local-mcp.ts");
  const { useLocalMcp } = load("../../../packages/shared/src/use-local-mcp.ts", { react: hooks });
  const records = [],
    calls = [];
  let clients = [{ id: "codex", label: "Codex CLI", state: "off", enabled: false, configPath: "/fixture/config.toml" }];
  let copied = "";
  const client = {
    call: async (method, args) => {
      calls.push({ method, args });
      if (method === "local-mcp:status")
        return { url: "http://127.0.0.1:1234/mcp", connections: [...records], clients, projects: [], groups: [{ id: "designs", enabled: true }] };
      if (method === "local-mcp:enableClient") {
        clients = clients.map((c) =>
          c.id === args[0] ? { ...c, enabled: true, state: "configured", connection: { ...args[1], id: "managed", clientId: c.id } } : c,
        );
        return clients[0];
      }
      if (method === "local-mcp:disableClient") {
        clients = clients.map((c) => ({ ...c, enabled: false, state: "off", connection: undefined }));
        return clients[0];
      }
      if (method === "local-mcp:create") {
        const connection = { ...args[0], id: "c", revision: 1, createdAt: "now" };
        records.push(connection);
        return { connection, url: "http://127.0.0.1:1234/mcp", token: "phone-fixture" };
      }
      if (method === "local-mcp:revoke") {
        records[0] = { ...records[0], revokedAt: "now" };
        return;
      }
      throw Error("Unexpected method " + method);
    },
  };
  const componentJsx = (type, props, key) => (typeof type === "function" ? type(props) : jsx(type, props, key));
  const { LocalMcpSection } = load("local-mcp-section.tsx", {
    react: hooks,
    "react/jsx-runtime": { jsx: componentJsx, jsxs: componentJsx },
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    "expo-clipboard": {
      setStringAsync: async (text) => {
        copied = text;
      },
    },
    "@milagre/shared/local-mcp": shared,
    "@milagre/shared/use-local-mcp": { useLocalMcp },
    "./session": { useSession: () => ({ client }) },
    "./icons": { Icon: "Icon" },
    "@hugeicons/core-free-icons": { Tick02Icon: "tick" },
    "./ui": { Button: "Button", Field: "Field", Toggle: "Toggle" },
  });
  const render = () => {
    hooks.begin();
    return LocalMcpSection();
  };
  render();
  await settle();
  assert.equal(
    find(render(), (node) => node.type === "Field"),
    undefined,
  );
  find(render(), (node) => node.type === "Toggle" && node.props.title === "Codex CLI").props.onPress();
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === "All Projects",
  ).props.onPress();
  find(render(), (node) => node.type === "Button" && node.props.title === "Enable Codex CLI").props.onPress();
  await settle();
  assert.equal(find(render(), (node) => node.type === "Toggle" && node.props.title === "Codex CLI").props.selected, true);
  assert.ok(find(render(), (node) => node.type === "Text" && node.props.children === "All Projects · Read only"));
  assert.equal(calls.find((call) => call.method === "local-mcp:enableClient").args[1].grants.projects.projectPaths, "*");
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "button" && node.props.accessibilityLabel === "Set up Codex CLI",
  ).props.onPress();
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === "Designs only",
  ).props.onPress();
  find(render(), (node) => node.type === "Field" && node.props.label === "Chat reference").props.onChangeText("/project#2");
  find(render(), (node) => node.type === "Button" && node.props.title === "Save access").props.onPress();
  await settle();
  assert.equal(find(render(), (node) => node.type === "Toggle" && node.props.title === "Codex CLI").props.selected, true);
  assert.deepEqual(calls.findLast((call) => call.method === "local-mcp:enableClient").args[1].grants, {
    designs: { chatId: "/project#2", designIds: "*", capabilities: ["read"] },
  });
  find(render(), (node) => node.type === "Toggle" && node.props.title === "Codex CLI").props.onPress();
  await settle();
  assert.equal(find(render(), (node) => node.type === "Toggle" && node.props.title === "Codex CLI").props.selected, false);
  assert.equal(
    find(render(), (node) => node.type === "Button" && node.props.title === "Create MCP config"),
    undefined,
  );
  find(render(), (node) => node.type === "Toggle" && node.props.title === "Custom MCP").props.onPress();
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === "All Projects",
  ).props.onPress();
  assert.equal(find(render(), (node) => node.type === "Button" && node.props.title === "Create configuration").props.disabled, true);
  find(render(), (node) => node.type === "Field" && node.props.label === "Connection name").props.onChangeText("Designs phone");
  assert.equal(find(render(), (node) => node.type === "Button" && node.props.title === "Create configuration").props.disabled, false);
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "radio" && node.props.accessibilityLabel === "Designs only",
  ).props.onPress();
  find(render(), (node) => node.type === "Field" && node.props.label === "Chat reference").props.onChangeText("/project#2");
  find(render(), (node) => node.type === "Field" && node.props.label === "Design IDs").props.onChangeText("one, two");
  find(
    render(),
    (node) => node.type === "Pressable" && node.props.accessibilityRole === "checkbox" && node.props.accessibilityLabel === "Allow design edits",
  ).props.onPress();
  find(render(), (node) => node.type === "Button" && node.props.title === "Create configuration").props.onPress();
  await settle();
  assert.deepEqual(calls.find((call) => call.method === "local-mcp:create").args[0].grants, {
    designs: { chatId: "/project#2", designIds: ["one", "two"], capabilities: ["read", "write"] },
  });
  find(render(), (node) => node.type === "Button" && node.props.title === "Copy MCP config").props.onPress();
  await settle();
  assert.equal(JSON.parse(copied).mcpServers.milagre.headers.Authorization, "Bearer phone-fixture");
  find(render(), (node) => node.type === "Toggle" && node.props.title === "Custom MCP").props.onPress();
  assert.equal(
    find(render(), (node) => node.type === "Button" && node.props.title === "Manage custom connections (1)"),
    undefined,
  );
  assert.equal(records[0].revokedAt, undefined);
  find(render(), (node) => node.type === "Toggle" && node.props.title === "Custom MCP").props.onPress();
  assert.equal(
    find(render(), (node) => node.type === "Button" && node.props.title === "Copy MCP config"),
    undefined,
  );
  find(render(), (node) => node.type === "Button" && node.props.title === "Manage custom connections (1)").props.onPress();
  find(render(), (node) => node.type === "Button" && node.props.title === "Revoke").props.onPress();
  await settle();
  assert.equal(
    find(render(), (node) => node.type === "Button" && node.props.title === "Revoke"),
    undefined,
  );
});

test("local MCP shared state refreshes a failed revoke and ignores an older status reply", async () => {
  const hooks = hookHost({ effects: true });
  const { useLocalMcp } = load("../../../packages/shared/src/use-local-mcp.ts", { react: hooks });
  let enabled = true;
  let late;
  const api = {
    status: async () => (late ? late.promise : { clients: [{ id: "codex", enabled }], connections: [], projects: [], groups: [] }),
    disableClient: async () => {
      enabled = false;
      throw Error("private credential must never appear in the UI");
    },
  };
  const render = () => {
    hooks.begin();
    return useLocalMcp(api);
  };
  render();
  await settle();
  assert.equal(render().status.clients[0].enabled, true);
  late = deferred();
  const oldReply = late;
  const oldRefresh = render().refresh();
  late = undefined;
  assert.equal(await render().disableClient("codex"), false);
  assert.equal(render().status.clients[0].enabled, false);
  assert.match(render().error, /Could not confirm access was revoked/);
  assert.equal(render().error.includes("private credential"), false);
  oldReply.resolve({ clients: [{ id: "codex", enabled: true }], connections: [], projects: [], groups: [] });
  await oldRefresh;
  assert.equal(render().status.clients[0].enabled, false);
  assert.match(render().error, /Could not confirm access was revoked/);
});

test("an Artifact page's files download into the phone's cache once, and the page shows them from there", async () => {
  const bytes = Buffer.alloc(300 * 1024, 5);
  const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const asset = { name: "clip.mp4", hash, size: bytes.length, type: "video/mp4" };
  const page = { id: "current", format: "html", title: "Demo", version: 1, latest: 1, html: '<video src="assets/clip.mp4"></video>', assets: [asset] };
  const reads = [];
  const client = {
    url: "artifact-host",
    call: async (method, args) => {
      if (method === "artifact:comments") return [];
      if (method === "artifact:sharing-status") return { available: false };
      if (method === "artifact:asset") {
        reads.push(args[0]);
        const offset = args[0].offset;
        return { ...asset, offset, base64: bytes.subarray(offset, offset + 256 * 1024).toString("base64") };
      }
      return page;
    },
  };
  const h = artifactHost(client);
  const tree = await h.open({ hostId: client.url, chatId: "/p#7", id: "current" });
  const view = find(tree, (node) => node.type?.name === "ArtifactWebView");
  assert.equal(view.props.html, `<video src="file:///cache/artifact-files/${hash}"></video>`);
  assert.equal(view.props.files, true, "the page's policy lets it load files from the cache");
  assert.deepEqual(
    reads.map((read) => read.offset),
    [0, 256 * 1024],
  );
  assert.deepEqual(Buffer.from(h.files.get(`file:///cache/artifact-files/${hash}`)), bytes);
  // Opened again, the phone has the file already.
  h.cleanup();
  const again = artifactHost(client);
  for (const [key, value] of h.files) again.files.set(key, value);
  await again.open({ hostId: client.url, chatId: "/p#7", id: "current" });
  assert.equal(reads.length, 2, "nothing downloads twice");
  again.cleanup();
});

test("HTML artifact opens the current single page with Designs off, without versions or Choose", async () => {
  const page = { id: "current", format: "html", title: "How it works", version: 1, latest: 1, html: "<h1>Current explanation</h1>" };
  const calls = [];
  const client = {
    url: "artifact-host",
    call: async (method, args) => {
      calls.push([method, args]);
      if (method === "artifact:list") return [page];
      if (method === "artifact:sharing-status") return { available: true };
      if (method === "artifact:comments") return [];
      return page;
    },
  };
  const feature = { ...designsOn, enabled: false };
  let backs = 0;
  const pushes = [];
  const h = artifactHost(client, pushes, { back: () => backs++ }, feature);
  const props = { hostId: client.url, chatId: "/p#7", id: "historical-id", version: "3" };
  let tree = await h.open(props);
  assert.equal(backs, 0);
  assert.ok(find(tree, (n) => n.props?.html === page.html));
  assert.ok(find(tree, (n) => n.props?.label === "Close artifact"));
  assert.ok(
    find(tree, (n) => n.props?.children === "How it works"),
    "the header names the page",
  );
  assert.equal(
    find(tree, (n) => n.type?.name === "SendButton"),
    undefined,
    "nothing to send yet",
  );
  assert.equal(
    find(
      tree,
      (n) =>
        n.props?.title === "Choose" ||
        n.props?.title === "Comment" ||
        n.props?.children === "Experimental" ||
        /version|Previous design|Next design/.test(n.props?.label ?? ""),
    ),
    undefined,
  );
  assert.deepEqual(
    h.commands().find((command) => command.t === "mode"),
    { t: "mode", input: "touch", comment: false },
  );
  page.html = "<h1>Updated in the same page</h1>";
  h.appState("active");
  h.render("ArtifactSheet", props);
  await settle();
  tree = h.render("ArtifactSheet", props);
  assert.ok(find(tree, (n) => n.props?.html === page.html));
  // Share is in ⋯, and opens the Chat's Share sheet for its Artifact page.
  const menu = find(tree, (n) => n.type === "PullDown");
  assert.deepEqual(JSON.parse(JSON.stringify(menu.props.sections.flatMap((section) => section.items).map((item) => item.id))), ["share"]);
  menu.props.onSelect("share");
  assert.deepEqual(JSON.parse(JSON.stringify(pushes.at(-1))), {
    pathname: "/design-share-sheet",
    params: { hostId: client.url, chatId: "/p#7", kind: "artifacts" },
  });
  assert.ok(calls.some(([method, args]) => method === "artifact:sharing-status" && args[0]?.kind === "artifacts"));
  h.share.shareAvailabilityChanged(client.url, "/p#7", false, "artifacts");
  assert.equal(
    find(h.render("ArtifactSheet", props), (n) => n.type === "PullDown"),
    undefined,
    "the Share sheet says sharing went away",
  );
  h.cleanup();
});

test("on the Artifact page, a held spot's comment waits for Send, which hands one message to the Chat with the text near it", async () => {
  const outbox = require("../apps/mobile/src/design-outbox.ts");
  const page = { id: "explainer", format: "html", title: "Routes", version: 4, latest: 4, html: "<main><h2>Why requests queue</h2></main>" };
  const recorded = [];
  let backs = 0;
  const client = {
    url: "mac",
    call: async (method, args) => {
      if (method === "artifact:add-comments") recorded.push(...args[0].comments);
      if (method === "artifact:comments")
        return [
          { id: "11111111", design: { id: "explainer", version: 4, title: "Routes" }, x: 0.1, y: 0.2, anchor: "main:1@0,0", text: "Earlier", createdAt: 5 },
          { id: "22222222", design: { id: "explainer", version: 3, title: "Routes" }, x: 0.1, y: 0.2, text: "On an older page", createdAt: 4 },
        ];
      if (method === "artifact:sharing-status") return { available: false };
      return page;
    },
  };
  const h = artifactHost(client, [], { back: () => backs++ });
  const props = { hostId: "mac", chatId: "/p#9", id: "explainer", kind: "html" };
  let tree = await h.open(props);
  const pinsSent = () => h.commands().findLast((command) => command.t === "pins");
  assert.deepEqual(
    pinsSent().pins.map(({ k, a, n }) => ({ k, a, n })),
    [{ k: "sent:11111111", a: "main:1@0,0", n: 1 }],
    "the page shows what was sent on it as it is now",
  );
  // Holding the page pins a comment there; the page scrolls it into view and says where it landed.
  h.say(tree, { t: "press", x: 0.4, y: 0.6, a: "main:1/h2:1@0.5,0.5", near: "Why requests queue", sx: 120, sy: 640 });
  tree = h.render("ArtifactSheet", props);
  const reveal = h.commands().find((command) => command.t === "reveal");
  assert.ok(reveal, "the new pin is brought into view");
  const waiting = pinsSent().pins.find((pin) => pin.k === reveal.k);
  assert.deepEqual(
    { x: waiting.x, y: waiting.y, a: waiting.a, n: waiting.n, hide: waiting.hide },
    { x: 0.4, y: 0.6, a: "main:1/h2:1@0.5,0.5", n: 1, hide: true },
  );
  assert.equal(pinsSent().watch, reveal.k, "the page reports where the open pin is");
  find(tree, (node) => node.props?.onLayout).props.onLayout({ nativeEvent: { layout: { width: 390, height: 700 } } });
  h.say(tree, { t: "anchor", k: reveal.k, sx: 60, sy: 110, shown: true });
  tree = h.render("ArtifactSheet", props);
  const box = find(tree, (node) => node.type?.name === "CommentBox");
  assert.deepEqual(JSON.parse(JSON.stringify(box.props.at)).y, 110);
  box.props.onChange("Add the retry timing");
  box.props.onDone();
  tree = h.render("ArtifactSheet", props);
  assert.equal(
    find(tree, (node) => node.type?.name === "CommentBox"),
    undefined,
  );
  find(tree, (node) => node.type?.name === "SendButton").props.onPress();
  await settle();
  const message = outbox.peekDesignMessage("mac|/p#9");
  const id = /\(comment ([a-f0-9]{8})\)/.exec(message.text)?.[1];
  assert.match(
    message.text,
    new RegExp(
      `^A comment on the artifact:\\n\\n1\\. \\(comment ${id}\\) On the artifact "Routes" \\(explainer\\), 40% across and 60% down, near "Why requests queue": Add the retry timing\\n\\n`,
    ),
  );
  outbox.designMessageSent("mac|/p#9", message);
  await settle();
  assert.deepEqual(
    recorded.map(({ id: commentId, anchor, near, design }) => ({ commentId, anchor, near, version: design.version })),
    [{ commentId: id, anchor: "main:1/h2:1@0.5,0.5", near: "Why requests queue", version: 4 }],
  );
  assert.equal(backs, 1);
  h.cleanup();
});

test("HTML cards stay visible with Designs off and open without historical version selection", async () => {
  const pushes = [];
  const client = {
    url: "html-card-host",
    call: async (method) => (method === "artifact:list" ? [{ id: "current", format: "html", version: 1 }] : { id: "current", format: "html", version: 1 }),
  };
  const h = artifactHost(client, pushes, undefined, { ...designsOn, enabled: false });
  const step = { id: "old-step", artifact: { id: "old", title: "Explanation", version: 9 } };
  h.render("ArtifactCards", { steps: [step], chatId: "/p#7" });
  await settle();
  const tree = h.render("ArtifactCards", { steps: [step], chatId: "/p#7" });
  assert.ok(find(tree, (n) => n.props.kind === "html"));
  const card = h.render("ArtifactCard", { step, chatId: "/p#7", kind: "html" });
  assert.equal(card.props.accessibilityLabel, "Artifact Explanation. Open full screen");
  card.props.onPress();
  assert.equal(pushes[0].params.kind, "html");
  assert.equal(pushes[0].params.version, undefined);
  h.cleanup();
});

test("Artifact feedback sends from the Chat while Designs is off", async () => {
  const outbox = require("../apps/mobile/src/design-outbox.ts");
  let recorded = 0;
  const message = { kind: "artifacts", text: "Make the explanation shorter.", onSent: () => recorded++ };
  outbox.postDesignMessage("mac|/p#7", message);
  const h = chatHost({ effects: true, call: async () => ({}) });
  h.params.id = "7";
  h.session.designs = { ...designsOn, enabled: false };
  h.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1, provider: "codex" };
  h.render();
  await settle();
  assert.ok(
    h.calls.some((call) => call.method === "chat:send"),
    "Artifact feedback reaches the agent while Designs is off",
  );
  assert.equal(recorded, 1);
  assert.equal(outbox.peekDesignMessage("mac|/p#7"), null);
});

test("mobile catalog verifies historical HTML aliases without guessing disabled structured refs", async () => {
  const { readDesignCatalog, designCatalog } = require("../apps/mobile/src/design-catalog.ts");
  const reads = [];
  const client = {
    call: async (method, args) => {
      if (method === "artifact:list") return [{ id: "current", format: "html", version: 3 }];
      reads.push(args[0].id);
      if (args[0].id === "old-html") return { id: "current", format: "html", version: 3 };
      throw Error("Designs is off");
    },
  };
  await readDesignCatalog(client, "/p#7", "old-html:1|structured:1", ["old-html", "structured"]);
  const catalog = designCatalog(client, "/p#7");
  assert.equal(catalog.find((item) => item.id === "old-html").format, "html");
  assert.equal(
    catalog.find((item) => item.id === "structured"),
    undefined,
  );
  await readDesignCatalog(client, "/p#7", "old-html:1|structured:1", ["old-html", "structured"]);
  assert.deepEqual(reads, ["old-html", "structured"], "each revision resolves unknown ids once");
});

test("unmarked design cards reload their catalog after Designs is turned on", async () => {
  const feature = { ...designsOn, enabled: false };
  const client = {
    url: "toggle-catalog",
    call: async (method) => {
      if (method === "artifact:list") return feature.enabled ? [{ id: "structured", format: "design", version: 1 }] : [];
      throw Error("Designs is off");
    },
  };
  const h = artifactHost(client, [], undefined, feature);
  const props = { steps: [{ id: "step", artifact: { id: "structured", title: "Screen", version: 1 } }], chatId: "/p#7" };
  h.render("ArtifactCards", props);
  await settle();
  assert.equal(h.render("ArtifactCards", props), null);
  feature.enabled = true;
  h.render("ArtifactCards", props);
  await settle();
  const tree = h.render("ArtifactCards", props);
  assert.equal(tree.props.step.artifact.id, "structured");
  feature.enabled = false;
  h.render("ArtifactCards", props);
  await settle();
  assert.equal(h.render("ArtifactCards", props), null);
  feature.enabled = true;
  h.render("ArtifactCards", props);
  await settle();
  assert.equal(h.render("ArtifactCards", props).props.step.artifact.id, "structured", "seen revisions are invalidated on a second enable");
  h.cleanup();
});

function canvasHost() {
  const react = hookHost();
  react.useSyncExternalStore = (_subscribe, read) => read();
  const routes = [];
  const now = Date.now();
  const chat = (id, worktree_id, title, extra = {}) => ({
    id,
    worktree_id,
    agent_name: "Claude",
    status: "Stopped",
    title,
    provider: "claude",
    summary: { count: 2, lastAt: now - 25 * 60000 },
    ...extra,
  });
  const tree = (id, path, name, diff) => ({ id, project_id: 1, path, name, diff });
  const copy = (path, worktrees, sessions, runs = {}) => ({
    project: {
      path,
      state: {
        next_id: 50,
        projects: {},
        worktrees: Object.fromEntries(worktrees.map((item) => [item.id, item])),
        sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
        messages: [],
        tasks: {},
      },
    },
    runs: { runs },
  });
  const copies = {
    "/a": copy(
      "/a",
      [tree(1, "/a", "main", { added: 212, removed: 148 }), tree(4, "/a-done", "finished-work"), tree(8, "/a-filters", "sidebar-filters")],
      [chat(2, 1, "Build UI"), chat(5, 4, "Archived", { archived: true }), chat(9, 8, "Sidebar filters"), chat(10, 8, "Review filters", { provider: "codex" })],
      { "/a#2": { approvals: [{ id: "x" }], questions: [] }, "/a#10": { approvals: [], questions: [{ id: "q" }] } },
    ),
    "/b": copy("/b", [tree(1, "/b", "main")], [chat(2, 1, "Add API", { provider: "codex" })], { "/b#2": { approvals: [], questions: [] } }),
    "/old": copy("/old", [tree(1, "/old", "main")], [chat(2, 1, "Old work", { archived: true })]),
  };
  const session = {
    client: { url: "ws://mac" },
    snapshot: null,
    recent: [
      { path: "/a", name: "Frontend" },
      { path: "/b", name: "Backend" },
      { path: "/old", name: "Old" },
      { path: "/hidden", name: "Hidden", hidden: true },
    ],
    cachedProject: (path) => copies[path],
    previewProject: async () => {},
    reloadProjects: async () => {},
  };
  const projects = [
    { id: "pa", path: "/a", name: "Frontend" },
    { id: "pb", path: "/b", name: "Backend" },
  ];
  const links = {
    available: true,
    links: [
      { id: "l1", a: { project_id: "pa", worktree_path: "/a" }, b: { project_id: "pb", worktree_path: "/b" }, created_at: "" },
      { id: "l2", a: { project_id: "pa" }, b: { project_id: "pb" }, created_at: "" },
    ],
    projects,
    projectIdOf: (path) => projects.find((project) => project.path === path)?.id,
    refresh: async () => {},
  };
  const { default: CanvasScreen } = load("app/canvas.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      ...Object.fromEntries(["Pressable", "RefreshControl", "Text", "View"].map((name) => [name, name])),
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    },
    "expo-router": {
      useIsFocused: () => true,
      Redirect: "Redirect",
      Stack: { Screen: "StackScreen" },
      router: { canDismiss: () => false, dismissAll() {}, replace: (href) => routes.push(href) },
    },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/chat-links": require("@milagre/shared/chat-links"),
    "@milagre/shared/canvas": require("../packages/shared/src/canvas.ts"),
    "../session": { useSession: () => session },
    "../use-links": { useLinks: () => links },
    "../attention": { useAttention: () => [] },
    "../chat-links": chatLinks(),
    "../status-indicators": { ChatMarkIcon: "ChatMarkIcon" },
    "../icons": { Icon: "Icon", ProviderLogo: "ProviderLogo" },
    "../project-icon": { ProjectIcon: "ProjectIcon" },
    "../ui": { ErrorNotice: "ErrorNotice", PageScroll: "PageScroll" },
  });
  const render = () => {
    react.begin();
    return CanvasScreen();
  };
  return { render, routes };
}
const allNodes = (node, keep, found = []) => {
  if (!node || typeof node !== "object") return found;
  if (keep(node)) found.push(node);
  for (const child of [node.props?.children].flat(Infinity)) allNodes(child, keep, found);
  return found;
};
const textOf = (node) =>
  [node?.props?.children]
    .flat(Infinity)
    .map((child) => (child && typeof child === "object" ? textOf(child) : (child ?? "")))
    .join("");

test("the phone canvas lists the sidebar's chats by Project and Worktree, with live states and Links", () => {
  const host = canvasHost();
  const tree = host.render();
  const headers = allNodes(tree, (node) => node.props?.accessibilityRole === "header").map(textOf);
  assert.deepEqual(headers, ["Frontend", "Backend"], "a Project with only archived chats and a hidden Project stay off");
  const cards = allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "Card");
  assert.deepEqual(
    cards.map((card) => card.props.worktree.branch),
    ["main", "sidebar-filters", "main"],
  );
  const rendered = cards.map((card) => card.type(card.props));
  const labels = (card) => allNodes(card, (node) => node.props?.accessibilityRole === "button").map((node) => node.props.accessibilityLabel);
  assert.deepEqual(labels(rendered[0]), ["Build UI, Waiting for you, main"]);
  assert.deepEqual(labels(rendered[1]), ["Sidebar filters, Idle · 25m ago", "Review filters, Asking you"]);
  assert.deepEqual(labels(rendered[2]), ["Add API, Running, main"]);
  assert.equal(rendered[0].props.style.borderColor, "orange", "a chat waiting for you outlines its card");
  assert.equal(rendered[1].props.style.borderColor, "accent");
  // The Worktree Link reads on both cards; the Project Link on the section headers.
  assert.deepEqual(cards[0].props.worktree.linked, ["Backend / main"]);
  assert.deepEqual(cards[2].props.worktree.linked, ["Frontend / main"]);
  const chips = allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "LinkChip").map((chip) => chip.props.label);
  assert.deepEqual(chips, ["All of Backend", "All of Frontend"]);
  // A chat opens like the sidebar opens one.
  allNodes(rendered[2], (node) => node.props?.accessibilityRole === "button")[0].props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes)), [{ pathname: "/chat", params: { projectPath: "/b", hostId: "ws://mac", id: "2" } }]);
});

test("the phone canvas filter keeps the cards that need you, and counts each choice", () => {
  const host = canvasHost();
  const radios = allNodes(host.render(), (node) => node.props?.accessibilityRole === "radio");
  assert.deepEqual(
    radios.map((radio) => radio.props.accessibilityLabel),
    ["All, 4", "Needs you, 2", "Running, 1"],
  );
  radios[1].props.onPress();
  const tree = host.render();
  const cards = allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "Card");
  assert.deepEqual(
    cards.map((card) => card.props.worktree.branch),
    ["main", "sidebar-filters"],
  );
  assert.deepEqual(allNodes(tree, (node) => node.props?.accessibilityRole === "header").map(textOf), ["Frontend"]);
});

test("mobile notification chime sheet: a tap plays the chime and saves it with the push registration; the row shows it", () => {
  const played = [];
  const saved = [];
  const push = { state: { enabled: true, chime: undefined }, preferences: async (value) => saved.push(value) };
  const sheet = () =>
    load("app/chime-sheet.tsx", {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { hairlineWidth: 1 } },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
      "@hugeicons/core-free-icons": {},
      "@milagre/shared/notification-chimes": require("@milagre/shared/notification-chimes"),
      "../icons": { Icon: "Icon" },
      "../notification-chime-audio": { playNotificationChime: (chime) => played.push(chime) },
      "../push": { usePush: () => push },
    }).default;
  const ChimeSheet = sheet();
  const radio = (tree, label) => find(tree, (n) => n.type === "Pressable" && n.props.accessibilityLabel === label);
  let tree = ChimeSheet();
  assert.equal(radio(tree, "System default").props.accessibilityState.checked, true, "an older saved state has no chime: the system sound");
  assert.equal(radio(tree, "Miracle").props.accessibilityState.checked, false);
  radio(tree, "Miracle").props.onPress();
  assert.deepEqual(played, ["miracle"]);
  assert.equal(JSON.stringify(saved), '[{"chime":"miracle"}]');
  push.state = { enabled: true, chime: "miracle" };
  tree = ChimeSheet();
  assert.equal(radio(tree, "Miracle").props.accessibilityState.checked, true);
  // Tapping the chosen one again only plays it.
  radio(tree, "Miracle").props.onPress();
  assert.deepEqual(played, ["miracle", "miracle"]);
  assert.equal(saved.length, 1);
  assert.ok(find(tree, (n) => n.type === "Text" && String(n.props.children).includes("Tap one to hear it")));
  push.state = { enabled: false, chime: "miracle" };
  assert.ok(
    find(ChimeSheet(), (n) => n.type === "Text" && String(n.props.children).includes("Turn on notifications")),
    "says why nothing will ring",
  );
  const labels = [];
  const all = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Pressable") labels.push(node.props.accessibilityLabel);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) all(child);
  };
  all(ChimeSheet());
  assert.deepEqual(labels, ["System default", "Miracle", "FAAAH", "Bombastic side eye", "Vine boom", "Metal pipe", "Bruh", "Emotional damage"]);
});

test("undo changes on the phone: task list, conflict-only choice, stale preview refresh, restore and the Redo line", async (t) => {
  const react = hookHost({ effects: true });
  t.after(() => react.cleanup());
  const checkpoints = load("../../../packages/shared/src/checkpoints.ts", {});
  const hook = load("../../../packages/shared/src/use-checkpoints.ts", { react, "./checkpoints": checkpoints });
  const redirect = {
    id: "task-2",
    kind: "task",
    createdAt: Date.now(),
    completedAt: Date.now(),
    excluded: 0,
    permissionMode: "ask",
    messageId: 13,
    prompt: "After login, open the account page",
    changed: 3,
  };
  const settings = { ...redirect, id: "task-1", messageId: 11, prompt: "Add an account settings page", changed: 4 };
  const files = [
    { key: "0:src/login.ts", path: "src/login.ts", worktree: "/p", action: "replace", conflict: true },
    { key: "0:src/redirect.ts", path: "src/redirect.ts", worktree: "/p", action: "delete", conflict: false },
    { key: "0:src/login.test.ts", path: "src/login.test.ts", worktree: "/p", action: "replace", conflict: false },
  ];
  const calls = [];
  let stale = true;
  const api = {
    list: async (request) => (calls.push(["list", request]), [redirect, settings]),
    preview: async (request) => (calls.push(["preview", request]), { ...redirect, token: `preview-${calls.length}`, files }),
    restore: async (request) => {
      calls.push(["restore", request]);
      if (stale) {
        stale = false;
        throw new Error("Files changed. Preview again before restoring");
      }
      return { restored: 2, kept: 1, recoveryId: "recovery", checkpointId: "task-2", redo: false };
    },
  };
  const panel = load("undo-panel.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", StyleSheet: { absoluteFill: {}, hairlineWidth: 1 }, Text: "Text", View: "View" },
    "@sbaiahmed1/react-native-blur": { LiquidGlassView: "LiquidGlassView" },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "@milagre/shared/checkpoints": checkpoints,
    "./icons": { Icon: "Icon" },
    "./ui": { IconButton: "IconButton", PageScroll: "PageScroll", PillButton: "PillButton", Segmented: "Segmented" },
  });
  const opened = [];
  // Function components render in place, so the tree holds only host elements.
  const expand = (node) =>
    !node || typeof node !== "object"
      ? node
      : Array.isArray(node)
        ? node.map(expand)
        : typeof node.type === "function"
          ? expand(node.type(node.props))
          : { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  const nodes = (node) => (!node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]);
  const strings = (node) =>
    typeof node === "string" ? [node] : !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(strings) : strings(node.props?.children);
  let review;
  const render = () => {
    react.begin();
    review = hook.useCheckpoints(api, "/p#1");
    return review.view === "closed" ? [] : nodes(expand(panel.UndoPanel({ review, intent: "Undo", onOpenFile: (file) => opened.push(file.path) })));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const primary = () => render().find((node) => node.type === "PillButton");
  render();
  void review.open();
  await settle();
  let tree = render();
  assert.deepEqual(
    tree.filter((node) => node.props?.testID?.startsWith("undo-task-")).map((node) => node.props.testID),
    ["undo-task-task-2", "undo-task-task-1"],
  );
  assert.ok(strings(tree).includes("After login, open the account page"));
  tree.find((node) => node.props?.testID === "undo-task-task-2").props.onPress();
  await settle();
  tree = render();
  assert.equal(tree.filter((node) => node.props?.testID === "undo-file").length, 3);
  assert.ok(strings(tree).includes("Edited after this task"));
  assert.deepEqual(primary().props.title, "Undo 3 files");
  assert.equal(primary().props.disabled, true);
  tree.find((node) => node.props?.accessibilityLabel === "src/redirect.ts. Delete").props.onPress();
  assert.deepEqual(opened, ["src/redirect.ts"]);
  // Only the file edited after the task asks; the others are undone.
  render()
    .find((node) => node.type === "Segmented")
    .props.onChange("keep");
  assert.equal(primary().props.title, "Undo 2 files");
  assert.equal(primary().props.disabled, false);
  primary().props.onPress();
  await settle();
  tree = render();
  assert.ok(strings(tree).includes("Files changed. Review again."));
  const sent = calls.find(([method]) => method === "restore")[1];
  assert.equal(sent.approved, true);
  assert.equal(sent.chatId, "/p#1");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.decisions)), { "0:src/redirect.ts": "restore", "0:src/login.test.ts": "restore", "0:src/login.ts": "keep" });
  assert.equal(primary().props.disabled, true, "a fresh preview asks again");
  render()
    .find((node) => node.type === "Segmented")
    .props.onChange("keep");
  primary().props.onPress();
  await settle();
  render();
  assert.equal(review.error, "");
  assert.equal(review.view, "closed", JSON.stringify(calls));
  assert.equal(calls.filter(([method]) => method === "restore").length, 2);

  const divider = load("checkpoint-restore-divider.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "@milagre/shared/checkpoint-restore": await import("../packages/shared/src/checkpoint-restore.mjs"),
    "./icons": { Icon: "Icon" },
  });
  const previews = [];
  const line = nodes(
    divider.CheckpointRestoreDivider({
      context: { kind: "checkpoint-restore", checkpointId: "task-2", recoveryId: "recovery", restored: 2, kept: 1, redo: false },
      onPreview: (...args) => previews.push(args),
    }),
  );
  assert.ok(strings(line).includes("Undid 2 files"));
  const redo = line.find((node) => node.type === "Pressable");
  assert.ok(strings(redo).includes("Redo"));
  redo.props.onPress();
  assert.deepEqual(previews, [["recovery", "Redo"]]);
});

test("the header opens Settings over the sidebar and Routines as a page, and its ⋯ holds Add project, Link projects, Canvas and Triage", () => {
  const nav = navigationHost(deferred().promise);
  const tree = nav.render();
  find(tree, (node) => node.props?.label === "Settings").props.onPress();
  find(tree, (node) => node.props?.label === "Routines").props.onPress();
  assert.deepEqual(nav.routes, ["/settings", "/routines"]);
  assert.deepEqual(nav.secondaryRoutes, ["sheet", true], "Settings opens over the sidebar; Routines is a page, pushed after the sidebar closes");
  assert.equal(
    find(tree, (node) => node.props?.label === "Close navigation"),
    undefined,
    "no close button",
  );
  const menu = find(tree, (node) => node.type === "PullDown" && node.props.label === "More");
  same(
    menu.props.sections.flatMap((section) => section.items.map((item) => item.title)),
    ["Add project", "Link projects", "Canvas", "Triage an issue"],
  );
  menu.props.onSelect("canvas");
  menu.props.onSelect("link");
  assert.deepEqual(nav.routes.slice(2), ["/canvas", "/link-projects"]);
});

test("Triage an issue asks the computer New Chat picks for a triage session and opens a new Chat with its draft", async () => {
  const calls = [];
  const nav = navigationHost(deferred().promise, {
    session: {
      client: {
        url: "mac",
        call: async (...args) => {
          calls.push(args);
          return { prompt: "Read /p/PLAYBOOK.md and follow it. What went wrong: " };
        },
      },
    },
  });
  find(nav.render(), (node) => node.type === "PullDown" && node.props.label === "More").props.onSelect("triage");
  await new Promise((resolve) => setImmediate(resolve));
  same(
    calls.filter(([method]) => method === "triage:prepare"),
    [["triage:prepare", ["Milagre for iPhone 1.2.3"]]],
  );
  assert.equal(
    JSON.stringify(nav.routes),
    JSON.stringify([{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac", prefill: "Read /p/PLAYBOOK.md and follow it. What went wrong: " } }]),
  );
});

test("the header leaves Routines out when the Mac can't offer them (an older Mac, a confined phone)", () => {
  const nav = navigationHost(deferred().promise, { routinesAvailable: false });
  assert.equal(
    find(nav.render(), (node) => node.props?.label === "Routines"),
    undefined,
  );
  assert.ok(find(nav.render(), (node) => node.props?.label === "Settings"));
});

test("the floating controls hold the Filters menu and New Chat, which opens in the open Project", () => {
  const nav = navigationHost(deferred().promise);
  const controls = find(nav.render(), (node) => node.type === "ChatListControls");
  same(
    controls.props.filters.sections.map((section) => section.title ?? ""),
    ["", "Show", "On chats"],
  );
  same(
    controls.props.filters.sections[1].items.map((item) => [item.title, item.checked]),
    [
      ["All Chats", true],
      ["Needs me", false],
      ["Running", false],
      ["Archived", false],
    ],
  );
  assert.equal(controls.props.filters.active, false);
  controls.props.onNewChat();
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac" } }]));
});

test("a search that finds nothing offers a new Chat with the search as its draft", () => {
  const nav = navigationHost(deferred().promise);
  find(nav.render(), (node) => node.type === "ChatListControls").props.onQuery("dark canvas");
  same(
    nav.rows().props.data.map((item) => item.kind),
    ["start"],
  );
  find(nav.row("start"), (node) => node.props?.accessibilityLabel === "Start a new chat with your search").props.onPress();
  assert.equal(JSON.stringify(nav.routes), JSON.stringify([{ pathname: "/chat", params: { projectPath: "/last", hostId: "mac", prefill: "dark canvas" } }]));
});

const routineFixtures = () => [
  {
    id: "hb",
    name: "Babysit PR #473",
    prompt: "Check CI",
    trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId: "/p#4" },
    enabled: true,
    createdBy: { kind: "agent", chatId: "/p#4" },
    nextRunAt: Date.UTC(2026, 9, 17, 10, 45),
    maxRuns: 10,
    runCount: 7,
    createdAt: 1,
    updatedAt: 1,
    runs: [],
  },
  {
    id: "tr",
    name: "Issues labelled agent",
    prompt: "Work on {{issue.key}}",
    trigger: { kind: "linear", workspace: "w", event: "label-added", label: "agent" },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    enabled: false,
    pausedReason: "3 failed runs in a row: no worktree",
    createdBy: { kind: "user" },
    runCount: 3,
    createdAt: 1,
    updatedAt: 1,
    runs: [{ id: "r1", routineId: "tr", startedAt: 5, status: "failed", chatId: "/p#9" }],
  },
];

function routinesHost({
  routines = routineFixtures(),
  enabled = true,
  refuse = false,
  confined = false,
  slowUpdates = false,
  states = {},
  confirmed = [],
} = {}) {
  const react = hookHost();
  const effects = [];
  const focused = [];
  const calls = [];
  const routes = [];
  let list = routines;
  const sockets = [];
  const updates = [];
  const client = {
    url: "ws://mac",
    live: (path) => (sockets.push(path), { close() {} }),
    async call(method, args) {
      calls.push([method, args]);
      if (refuse && method.startsWith("routines:")) throw new Error(`${method} is not available from mobile`);
      if (confined && (method === "routines:enabled:read" || method === "routines:list")) return [];
      if (method === "routines:enabled:read") return { enabled };
      if (method === "routines:enabled:save") return { enabled: (enabled = args[0] === true) };
      if (method === "routines:list") return { routines: list };
      if (method === "routines:update" && slowUpdates) {
        const gate = deferred();
        updates.push(gate);
        await gate.promise;
      }
      if (method === "routines:update") {
        list = list.map((routine) => (routine.id === args[0] ? { ...routine, ...args[1] } : routine));
        return list.find((routine) => routine.id === args[0]);
      }
      return null;
    },
  };
  const reactModule = { ...react, useSyncExternalStore: (_subscribe, read) => read(), useEffect: (fn, deps) => effects.push([fn, deps]) };
  const useRoutines = load("use-routines.ts", {
    react: reactModule,
    "react-native": { AppState: { addEventListener: () => ({ remove() {} }) } },
    "expo-router": { useFocusEffect: (fn) => focused.push(fn) },
  });
  const { default: RoutinesScreen } = load("app/routines.tsx", {
    react: reactModule,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      ...Object.fromEntries(["Pressable", "Text", "View"].map((name) => [name, name])),
      Platform: { OS: "ios" },
      StyleSheet: { hairlineWidth: 1 },
    },
    "expo-router": {
      Stack: Object.assign(() => null, { Toolbar: Object.assign(() => null, { Button: "ToolbarButton", View: "ToolbarView" }) }),
      router: { push: (href) => routes.push(href) },
    },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/agent-runs": require("@milagre/shared/agent-runs"),
    "@milagre/shared/routines": require("@milagre/shared/routines"),
    "../session": { useSession: () => ({ client }) },
    "../use-routines": useRoutines,
    "../use-project-states": { useProjectStates: () => states },
    "../routine-rows": load("routine-rows.ts", {
      "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
      "@milagre/shared/routines": require("@milagre/shared/routines"),
      "@milagre/shared/routine-form": require("@milagre/shared/routine-form"),
    }),
    "../confirm-store": { confirm: async (...args) => (confirmed.push(args), true) },
    "../chat-row-store": { useActivityClock: () => Date.UTC(2026, 9, 17, 10, 30) },
    "../status-indicators": { ChatMarkIcon: "ChatMarkIcon" },
    "../icons": { Icon: "Icon" },
    "../ui": Object.fromEntries(["ErrorNotice", "HeaderButton", "PageScroll", "PillButton", "PullDown", "RowCheckbox"].map((name) => [name, name])),
  });
  const render = () => {
    react.begin();
    return RoutinesScreen();
  };
  const settle = async () => {
    for (const [fn] of effects.splice(0)) fn();
    for (const fn of focused.splice(0)) fn();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // The rows are components of their own; render each to read what it shows.
  const rows = (tree) => allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "RoutineRow").map((row) => row.type(row.props));
  const groups = (tree) => allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "Group").map((group) => group.props.title);
  return { render, settle, calls, routes, rows, groups, sockets, updates };
}

test("the phone Routines screen groups heartbeats and triggers, says why a trigger paused, and opens a row's actions", async () => {
  const host = routinesHost();
  host.render();
  await host.settle();
  const tree = host.render();
  assert.deepEqual(host.groups(tree), ["Heartbeats", "Triggers"]);
  assert.deepEqual(
    allNodes(tree, (node) => node.props?.accessibilityRole === "radio").map((node) => node.props.accessibilityLabel),
    ["All, 2", "Heartbeats, 1", "Triggers, 1", "Paused, 1"],
  );
  const [heartbeat, trigger] = host.rows(tree);
  assert.match(textOf(heartbeat), /Babysit PR #473/);
  assert.match(textOf(heartbeat), /Every 15 min · next \d\d:\d\d · 3 Runs left/);
  assert.match(textOf(trigger), /Paused: 3 failed runs in a row: no worktree/);
  assert.equal(find(trigger, (node) => node.type === "RowCheckbox").props.selected, false);
  const menu = find(trigger, (node) => node.type === "PullDown");
  // A Linear trigger only runs on its event, so it has no Run now; the heartbeat (a schedule) does.
  // Copy VM-owned arrays into this realm for deepStrictEqual.
  assert.deepEqual(Array.from(menu.props.sections.flatMap((section) => section.items.map((item) => item.title))), ["Edit", "Open last Chat", "Delete"]);
  const heartbeatMenu = find(heartbeat, (node) => node.type === "PullDown");
  assert.deepEqual(Array.from(heartbeatMenu.props.sections.flatMap((section) => section.items.map((item) => item.title))), [
    "Edit",
    "Run now",
    "Open Chat",
    "Delete",
  ]);
  // A tap opens the Routine's page; the actions stay on the long press.
  menu.props.onPress();
  menu.props.onSelect("open");
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes)), [
    { pathname: "/routine", params: { id: "tr" } },
    { pathname: "/chat", params: { projectPath: "/p", hostId: "ws://mac", id: "9" } },
  ]);
  assert.ok(
    allNodes(tree, (node) => node.type === "Text").some(
      (node) => textOf(node) === "Routines run while this Mac is awake. Closing the lid on battery pauses them.",
    ),
  );
  // The Paused chip keeps only the paused trigger.
  allNodes(tree, (node) => node.props?.accessibilityRole === "radio")[3].props.onPress();
  assert.deepEqual(host.groups(host.render()), ["Triggers"]);
});

test("a phone Routine row shows the unread dot while one of its hidden Run Chats is unread", async () => {
  const runChat = (id, routineId, extra) => ({ id, routine: { routineId, runId: `u${id}`, hidden: true }, ...extra });
  // Two of the trigger's Run Chats are unread: the row reads "unread Runs", as the dock's Routines button does.
  const host = routinesHost({
    states: { "/p": { sessions: { 9: runChat(9, "tr", { unread: true }), 10: runChat(10, "hb"), 11: runChat(11, "tr", { unread: true }) } } },
  });
  host.render();
  await host.settle();
  const [heartbeat, trigger] = host.rows(host.render());
  assert.ok(find(trigger, (node) => node.type === "ChatMarkIcon" && node.props.mark === "unread"));
  assert.match(find(trigger, (node) => node.type === "PullDown").props.label, /^Issues labelled agent, unread Runs\. /);
  assert.equal(
    find(heartbeat, (node) => node.type === "ChatMarkIcon"),
    undefined,
  );
});

test("deleting a Routine on the phone says a Heartbeat's Chat stays and a trigger's unkept Run Chats are archived", async () => {
  const confirmed = [];
  const host = routinesHost({ confirmed });
  host.render();
  await host.settle();
  const [heartbeat, trigger] = host.rows(host.render());
  find(heartbeat, (node) => node.type === "PullDown").props.onSelect("delete");
  find(trigger, (node) => node.type === "PullDown").props.onSelect("delete");
  await host.settle();
  assert.deepEqual(confirmed, [
    ["Delete Babysit PR #473?", "Its Chats stay.", "Delete"],
    ["Delete Issues labelled agent?", "Its Runs stop, and its Run Chats you haven't kept are archived.", "Delete"],
  ]);
  assert.deepEqual(
    host.calls.filter(([method]) => method === "routines:delete").map(([, args]) => args[0]),
    ["hb", "tr"],
  );
});

test("flipping a Routine's switch on the phone writes routines:update with the new value and reads the list again", async () => {
  const host = routinesHost();
  host.render();
  await host.settle();
  const [heartbeat] = host.rows(host.render());
  host.calls.length = 0;
  find(heartbeat, (node) => node.type === "RowCheckbox").props.onPress();
  assert.equal(find(host.rows(host.render())[0], (node) => node.type === "RowCheckbox").props.selected, false, "the switch moves at once");
  await host.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(host.calls[0])), ["routines:update", ["hb", { enabled: false }]]);
  assert.ok(host.calls.some(([method]) => method === "routines:list"));
  assert.equal(find(host.rows(host.render())[0], (node) => node.type === "RowCheckbox").props.selected, false);
});

test("an older Mac that says its Routines are off still lists them, with nothing to allow", async () => {
  const [heartbeat] = routineFixtures();
  const host = routinesHost({ routines: [heartbeat], enabled: false });
  host.render();
  await host.settle();
  const tree = host.render();
  assert.equal(host.rows(tree).length, 1, "its Routines are listed");
  assert.equal(
    find(tree, (node) => node.type === "PillButton" && node.props.title === "Allow"),
    undefined,
  );
});

// Local times, so "Today" holds in any time zone.
const routineNow = new Date(2026, 9, 17, 10, 30).getTime();
const at = (hour, minute = 0) => new Date(2026, 9, 17, hour, minute).getTime();

function routineHost({ id = "tr", routines = routineFixtures(), states = {}, enabled = true, loading = false, error = "", canGoBack = true } = {}) {
  const react = hookHost();
  const routes = [];
  const calls = [];
  const replaced = [];
  let current = routines;
  let backs = 0;
  const client = {
    url: "ws://mac",
    async call(method, args) {
      calls.push([method, args]);
      return null;
    },
  };
  const icons = new Proxy({}, { get: (_, key) => key });
  const shared = require("@milagre/shared/routines");
  const { RunList } = load("run-list.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": icons,
    "@milagre/shared/routines": shared,
    "./icons": { Icon: "Icon", SpinnerRing: "SpinnerRing" },
    "./status-indicators": { ChatMarkIcon: "ChatMarkIcon" },
    "./ui": { Button: "Button" },
  });
  const { default: RoutineScreen } = load("app/routine.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Platform: { OS: "ios" }, ScrollView: "ScrollView", Text: "Text", View: "View" },
    "expo-router": {
      Stack: Object.assign(() => null, { Screen: "StackScreen", Toolbar: Object.assign(() => null, { Button: "ToolbarButton", View: "ToolbarView" }) }),
      router: { push: (href) => routes.push(href), back: () => backs++, replace: (href) => replaced.push(href), canGoBack: () => canGoBack },
      // Runs when the screen comes into focus or its callback changes: queued here, and run by flush().
      useFocusEffect: (fn) => react.effect(fn, [fn]),
      useLocalSearchParams: () => ({ id }),
    },
    "@hugeicons/core-free-icons": icons,
    "@milagre/shared/agent-runs": require("@milagre/shared/agent-runs"),
    "@milagre/shared/routines": shared,
    "../session": { useSession: () => ({ client }) },
    "../use-routines": {
      useRoutines: () => ({ routines: current, enabled, unavailable: null, error, loading, refresh: async () => {}, update: async () => {} }),
    },
    "../use-project-states": { useProjectStates: () => states },
    "../use-rpc": { useRpc: (caller) => ({ data: caller ? { projects: [{ path: "/p", chats: [{ chatId: "/p#4", title: "Babysit" }] }] } : null }) },
    "../turn-options": { modelsFor: (provider) => (provider === "claude" ? [{ id: "claude-opus-5-5", name: "Opus 5.5", provider }] : []) },
    "../chat-row-store": { useActivityClock: () => routineNow },
    "../routine-rows": load("routine-rows.ts", {
      "@hugeicons/core-free-icons": icons,
      "@milagre/shared/routines": shared,
      "@milagre/shared/routine-form": require("@milagre/shared/routine-form"),
    }),
    "@milagre/shared/model-copy": require("../packages/shared/src/model-copy.ts"),
    "../run-list": { RunList },
    "../icons": { Icon: "Icon" },
    "../ui": Object.fromEntries(["ErrorNotice", "HeaderButton", "PageScroll", "RowCheckbox", "Segmented"].map((name) => [name, name])),
  });
  const render = () => {
    react.begin();
    return RoutineScreen();
  };
  // The Runs list is a component of its own; render it to read its rows.
  const runList = (tree) => {
    const node = find(tree, (child) => child.type === RunList);
    return node && node.type(node.props);
  };
  const rows = (list) => allNodes(list, (node) => node.type === "Pressable");
  return {
    render,
    runList,
    rows,
    routes,
    calls,
    replaced,
    backs: () => backs,
    flush: () => react.flush(),
    setRoutines: (next) => (current = next),
  };
}

const runsFixture = () => [
  { id: "r6", routineId: "tr", startedAt: at(10, 15), status: "running", chatId: "/p#16" },
  { id: "r5", routineId: "tr", startedAt: at(9), status: "acted", chatId: "/p#15", title: "Fixed the flaky login test" },
  { id: "r4", routineId: "tr", startedAt: at(8), status: "quiet", chatId: "/p#14", summary: "CI green" },
  { id: "r3", routineId: "tr", startedAt: at(7), status: "skipped-busy" },
  { id: "r2", routineId: "tr", startedAt: at(6), status: "failed", chatId: "/p#12", error: "No worktree\nat git" },
  { id: "r1", routineId: "tr", startedAt: at(5), status: "missed" },
];

test("the phone Routine screen lists its Runs by day: acted and failed rows, quiet stretches folded, and opens a Run's Chat while it is there", () => {
  const [, trigger] = routineFixtures();
  const host = routineHost({
    routines: [{ ...trigger, runs: runsFixture() }],
    states: {
      "/p": {
        sessions: { 15: { id: 15, unread: true, routine: { routineId: "tr", runId: "r5", hidden: true } }, 14: { id: 14, archived: true }, 16: { id: 16 } },
      },
    },
  });
  const tree = host.render();
  assert.equal(find(tree, (node) => node.type === "StackScreen").props.options.title, "Issues labelled agent");
  find(tree, (node) => node.type === "ToolbarButton" && node.props.accessibilityLabel === "Edit").props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes)), [{ pathname: "/routine-form", params: { id: "tr" } }]);
  host.routes.length = 0;
  // A Linear trigger has no Run now.
  assert.equal(
    find(tree, (node) => node.type === "ToolbarButton" && node.props.accessibilityLabel === "Run now"),
    undefined,
  );

  const list = host.runList(tree);
  assert.ok(allNodes(list, (node) => node.type === "Text").some((node) => textOf(node) === "Today"));
  assert.deepEqual(
    host.rows(list).map((row) => [row.props.accessibilityLabel, !row.props.disabled]),
    [
      ["Issues labelled agent. 10:15", true],
      ["Fixed the flaky login test. Unread. 09:00", true],
      ["1 quiet · 1 skipped, its Chat was busy. 07:00–08:00", true],
      ["Failed: No worktree. 06:00", false],
      ["1 missed. 05:00", true],
    ],
  );
  const [, acted, fold] = host.rows(list);
  assert.ok(find(acted, (node) => node.type === "ChatMarkIcon" && node.props.mark === "unread"));
  acted.props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes)), [{ pathname: "/chat", params: { projectPath: "/p", hostId: "ws://mac", id: "15" } }]);

  // A fold expands in place: a quiet Run whose Chat is left (archived) opens it; a skipped one says its Chat was busy.
  fold.props.onPress();
  const open = host.rows(host.runList(host.render()));
  assert.deepEqual(
    open.slice(2, 5).map((row) => [row.props.accessibilityLabel, !row.props.disabled]),
    [
      ["1 quiet · 1 skipped, its Chat was busy. 07:00–08:00", true],
      ["CI green. 08:00", true],
      ["Its Chat was busy. 07:00", false],
    ],
  );
  open[3].props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes.at(-1))), { pathname: "/chat", params: { projectPath: "/p", hostId: "ws://mac", id: "14" } });
});

test("the phone Routine screen shows On with its switch, its settings as chips, its times, and filters its Runs", () => {
  const [, trigger] = routineFixtures();
  const runs = runsFixture();
  const host = routineHost({
    routines: [{ ...trigger, enabled: true, pausedReason: undefined, model: "claude-opus-5-5", provider: "claude", permissionMode: "auto", runs }],
    states: { "/p": { sessions: { 15: { id: 15, unread: true, routine: { routineId: "tr", runId: "r5", hidden: true } }, 16: { id: 16 } } } },
  });
  const tree = host.render();
  assert.equal(find(tree, (node) => typeof node.type === "function" && node.type.name === "StatusPill").props.on, true);
  assert.equal(find(tree, (node) => node.type === "RowCheckbox").props.selected, true);
  const chips = find(tree, (node) => node.type === "ScrollView" && node.props.horizontal);
  assert.deepEqual(
    allNodes(chips, (node) => typeof node.type === "function" && node.type.name === "Chip").map((node) => node.props.text),
    ["Linear · label agent added", "New Worktree in p", "Opus 5.5", "Auto mode"],
  );
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Last Run 10:15"));
  const filter = find(tree, (node) => node.type === "Segmented");
  assert.deepEqual(Array.from(filter.props.options.map((option) => option.title)), ["All 6", "Acted 1", "Failed 1", "Unread 1"]);
  filter.props.onChange("failed");
  assert.deepEqual(
    host.rows(host.runList(host.render())).map((row) => row.props.accessibilityLabel),
    ["Failed: No worktree. 06:00"],
  );
  // No Delete on the screen: it is in Edit.
  assert.equal(
    find(host.render(), (node) => node.type === "Button"),
    undefined,
  );
});

// A babysit Heartbeat runs only on what changed on its PR and follows the Babysit PRs settings: no Run now, no Edit.
const babysitRoutine = (heartbeat) => ({
  ...heartbeat,
  id: "pr",
  name: "Babysit PR #7",
  trigger: { kind: "pull-request", url: "https://github.com/o/r/pull/7", repo: "github.com/o/r", number: 7, settings: {} },
  maxRuns: undefined,
  expiresAt: Date.UTC(2026, 9, 24),
  runs: [],
});

test("a phone babysit Heartbeat has no Run now or Edit, on its row or its screen, and its row still deletes it", async () => {
  const [heartbeat] = routineFixtures();
  const list = routinesHost({ routines: [babysitRoutine(heartbeat)] });
  list.render();
  await list.settle();
  const [row] = list.rows(list.render());
  const menu = find(row, (node) => node.type === "PullDown");
  assert.deepEqual(Array.from(menu.props.sections.flatMap((section) => section.items.map((item) => item.title))), ["Open Chat", "Delete"]);
  const screen = routineHost({ id: "pr", routines: [babysitRoutine(heartbeat)] });
  const toolbar = allNodes(screen.render(), (node) => node.type === "ToolbarButton").map((node) => node.props.accessibilityLabel);
  assert.deepEqual(toolbar, []);
  const other = routineHost({ id: "hb", routines: [{ ...heartbeat, runs: [] }] });
  assert.deepEqual(
    allNodes(other.render(), (node) => node.type === "ToolbarButton").map((node) => node.props.accessibilityLabel),
    ["Run now", "Edit"],
  );
});

test("a phone Run row gives its words all the room: flex 1 with no minimum, the dot's padding taken back, and the time never squeezed", () => {
  const [, trigger] = routineFixtures();
  const title = "Add exponential backoff retries to payments webhook";
  const host = routineHost({
    routines: [{ ...trigger, runs: [{ id: "r5", routineId: "tr", startedAt: at(9), status: "acted", chatId: "/p#15", title }] }],
    states: { "/p": { sessions: { 15: { id: 15, unread: true, routine: { routineId: "tr", runId: "r5", hidden: true } } } } },
  });
  const [row] = host.rows(host.runList(host.render()));
  const text = find(row, (node) => node.type === "Text" && textOf(node) === title);
  assert.equal(text.props.numberOfLines, 1);
  assert.ok([text.props.style].flat().some((entry) => entry && entry.flex === 1 && entry.minWidth === 0));
  // The unread mark is a 20 pt box round an 8 pt dot; its slack goes back to the words.
  const mark = find(row, (node) => node.type === "ChatMarkIcon");
  const slot = find(row, (node) => node.type === "View" && [node.props.children].flat(Infinity).includes(mark));
  assert.deepEqual([slot.props.style.marginHorizontal], [-6]);
  const time = find(row, (node) => node.type === "Text" && textOf(node) === "09:00");
  assert.equal(
    time.props.style.some((entry) => entry.flexShrink === 0),
    true,
  );
  // A fold's range ("13:29–13:30", 11 tabular characters at 13 pt) stays on one line.
  assert.equal(time.props.numberOfLines, 1);
  assert.ok(time.props.style.some((entry) => entry.width >= 92));
});

test("the phone Routine screen opens a Run's Chat in a Project it holds no state for, and the Chat screen loads it", () => {
  const [, trigger] = routineFixtures();
  const host = routineHost({ routines: [{ ...trigger, runs: [{ id: "r9", routineId: "tr", startedAt: at(9), status: "acted", chatId: "/q#3" }] }] });
  const [row] = host.rows(host.runList(host.render()));
  assert.equal(row.props.disabled, false);
  row.props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(host.routes)), [{ pathname: "/chat", params: { projectPath: "/q", hostId: "ws://mac", id: "3" } }]);
});

test("the phone Routine screen says No Runs yet with the next Run", async () => {
  const [heartbeat] = routineFixtures();
  const empty = routineHost({ id: "hb", routines: [{ ...heartbeat, nextRunAt: at(10, 45) }] });
  const texts = new Set(allNodes(empty.render(), (node) => node.type === "Text").map(textOf));
  assert.ok(texts.has("No Runs yet"));
  assert.ok(texts.has("Next Run 10:45"));
  // Run now is a play button in the toolbar, beside Edit.
  const play = find(empty.render(), (node) => node.type === "ToolbarButton" && node.props.accessibilityLabel === "Run now");
  assert.ok(play, "a Heartbeat runs now");
  assert.equal(play.props.icon, "play.fill");
  assert.equal(
    find(empty.render(), (node) => node.type === "Button" && node.props.title === "Run now"),
    undefined,
  );

  const gone = routineHost({ id: "nope" });
  assert.ok(allNodes(gone.render(), (node) => node.type === "Text").some((node) => textOf(node) === "This Routine is no longer on this Mac."));
});

test("the phone Routine screen goes back once the Mac's list has been read and no longer holds its Routine", () => {
  const host = routineHost({ id: "nope" });
  const tree = host.render();
  host.flush();
  assert.equal(host.backs(), 1);
  assert.deepEqual(host.replaced, []);
  // Still on screen while it leaves, with Edit unavailable.
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "This Routine is no longer on this Mac."));
  assert.equal(find(tree, (node) => node.type === "ToolbarButton" && node.props.accessibilityLabel === "Edit").props.disabled, true);
  // A later render, or a later focus, doesn't go back again.
  host.render();
  host.flush();
  host.render();
  host.flush();
  assert.equal(host.backs(), 1);
});

test("the phone Routine screen opened with nothing behind it goes to the Routines list instead", () => {
  const host = routineHost({ id: "nope", canGoBack: false });
  host.render();
  host.flush();
  assert.equal(host.backs(), 0);
  assert.deepEqual(host.replaced, ["/routines"]);
});

test("the phone Routine screen stays while its Routine is listed, the list is loading, or a read failed", () => {
  const cases = {
    "the Routine is listed": routineHost(),
    "the list is loading": routineHost({ id: "nope", loading: true }),
    "the Mac's switch is not read yet": routineHost({ id: "nope", enabled: null }),
    "the last read failed": routineHost({ id: "nope", error: "Could not read Routines." }),
  };
  for (const [name, host] of Object.entries(cases)) {
    host.render();
    host.flush();
    assert.deepEqual([host.backs(), host.replaced], [0, []], name);
  }
});

test("the phone Routine screen goes back once when its Routine is deleted from the Edit sheet or anywhere else", () => {
  const [, trigger] = routineFixtures();
  const host = routineHost({ routines: [trigger] });
  host.render();
  host.flush();
  assert.equal(host.backs(), 0);
  // The Mac's list drops the Routine: the page goes when it is back in view, once.
  host.setRoutines([]);
  host.render();
  host.flush();
  assert.equal(host.backs(), 1);
  host.render();
  host.flush();
  assert.equal(host.backs(), 1);
});

function routineFormHost({ params = {}, routines = [], answers = {}, created } = {}) {
  const react = hookHost();
  const calls = [];
  const routes = [];
  const responses = {
    "routines:targets": { projects: [{ path: "/p", name: "milagre-ade", chats: [{ chatId: "/p#4", title: "Babysit", lastAt: 1 }] }] },
    "routines:linear-options": {
      workspaces: [{ id: "w1", name: "Milagre" }],
      teams: [{ key: "MIL", name: "Milagre" }],
      labels: ["agent", "bug"],
      states: [{ name: "Todo", type: "unstarted" }],
    },
    ...answers,
  };
  const client = {
    url: "ws://mac",
    async call(method, args) {
      calls.push([method, JSON.parse(JSON.stringify(args))]);
      if (method === "routines:create") {
        const routine = { id: "new", enabled: true, runCount: 0, createdAt: 1, updatedAt: 1, runs: [], ...args[0], ...created?.routine };
        routines.push(routine);
        return { routine, ...(created?.hookUrl ? { hookUrl: created.hookUrl } : {}) };
      }
      if (method === "routines:rotate-hook") return { url: "https://relay.milagre.cloud/hook/rotated" };
      if (method === "routines:update") return { id: args[0] };
      return responses[method] ?? null;
    },
  };
  const icons = new Proxy({}, { get: (_, key) => key });
  // The discard guard: whether leaving is held back now, and the alert it shows when it is.
  const guard = { on: false, ask: null, alerts: [] };
  const { default: RoutineForm } = load("app/routine-form.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      ...Object.fromEntries(["Pressable", "Text", "View"].map((name) => [name, name])),
      Alert: { alert: (...args) => guard.alerts.push(args) },
      Platform: { OS: "ios" },
      StyleSheet: { hairlineWidth: 1 },
    },
    "expo-router/react-navigation": {
      usePreventRemove: (on, ask) => {
        guard.on = on;
        guard.ask = ask;
      },
    },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "expo-router": {
      Stack: { Screen: "StackScreen" },
      router: { back: () => routes.push("back"), push: (href) => routes.push(href) },
      useLocalSearchParams: () => params,
    },
    "expo-clipboard": { setStringAsync: async () => {} },
    "@hugeicons/core-free-icons": icons,
    "@milagre/shared/routine-form": require("@milagre/shared/routine-form"),
    "@milagre/shared/routine-prompt": require("@milagre/shared/routine-prompt"),
    "@milagre/shared/model-copy": require("../packages/shared/src/model-copy.ts"),
    "@milagre/shared/providers": require("@milagre/shared/providers"),
    "../session": { useSession: () => ({ client, models: null, cliStatus: null, snapshot: { project: { path: "/p" } } }) },
    "../use-routines": { useRoutines: () => ({ routines, enabled: true, error: "", loading: false, refresh: async () => {}, update: async () => {} }) },
    "../use-rpc": { useRpc: (caller, method) => ({ data: caller ? (responses[method] ?? null) : null, error: "", loading: false, refresh() {} }) },
    "../turn-options": { modelsFor: (provider) => (provider === "claude" ? [{ id: "claude-opus-5-5", name: "Opus 5.5", provider }] : []) },
    "../placeholder-field": { PlaceholderField: "PlaceholderField" },
    "../confirm-store": { confirm: async () => true },
    "../icons": { Icon: "Icon" },
    "../ui": Object.fromEntries(
      ["Button", "CircleButton", "ErrorNotice", "Field", "PageScroll", "PillButton", "PullDown", "RowCheckbox"].map((name) => [name, name]),
    ),
  });
  const render = () => {
    react.begin();
    return RoutineForm();
  };
  const rowLabels = (tree) => allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "FormRow").map((node) => node.props.label);
  const pick = (tree, label) => find(tree, (node) => node.type === "PullDown" && node.props.label === label);
  return { render, calls, routes, rowLabels, pick, guard };
}

test("the phone routine form in Linear mode shows the When, Label and Team rows and offers Linear placeholders", () => {
  const host = routineFormHost();
  let tree = host.render();
  assert.ok(find(tree, (node) => node.type === "CircleButton" && node.props.label === "Close"));
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "New Routine"));
  assert.ok(host.rowLabels(tree).includes("Repeats"), "a new Routine starts on a schedule");
  find(tree, (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  tree = host.render();
  const labels = host.rowLabels(tree);
  for (const label of ["When", "Label", "Team", "Project", "Works in", "Model", "Stop after"]) assert.ok(labels.includes(label), label);
  assert.equal(
    allNodes(tree, (node) => typeof node.type === "function" && node.type.name === "FormRow" && node.props.label === "Works in")[0].props.value,
    "New Worktree",
    "Worktree is a product noun",
  );
  const linear = find(tree, (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio");
  assert.equal(linear.props.accessibilityState.checked, true);
  const names = Array.from(find(tree, (node) => node.type === "PlaceholderField").props.placeholders.map((item) => item.name));
  assert.ok(names.includes("issue.key"));
  assert.equal(find(tree, (node) => node.type === "PillButton").props.title, "Create Routine");
});

test("a new phone Heartbeat can pick a Project, change it, and save its selected Chat", async () => {
  const host = routineFormHost({
    answers: {
      "routines:targets": {
        projects: [
          { path: "/p", name: "First", chats: [{ chatId: "/p#4", title: "Babysit", lastAt: 1 }] },
          { path: "/q", name: "Second", chats: [{ chatId: "/q#9", title: "Watch CI", lastAt: 2 }] },
        ],
      },
    },
  });
  host.pick(host.render(), "Works in").props.onSelect("chat");
  host.pick(host.render(), "Project").props.onSelect("/p");
  assert.deepEqual(
    host.pick(host.render(), "Chat").props.sections[0].items.map((item) => item.id),
    ["/p#4"],
  );
  host.pick(host.render(), "Chat").props.onSelect("/p#4");
  host.pick(host.render(), "Project").props.onSelect("/q");
  assert.deepEqual(
    host.pick(host.render(), "Chat").props.sections[0].items.map((item) => item.id),
    ["/q#9"],
  );
  host.pick(host.render(), "Chat").props.onSelect("/q#9");
  find(host.render(), (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Watch CI");
  find(host.render(), (node) => node.type === "PlaceholderField").props.onChangeText("Check this PR");
  find(host.render(), (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const create = host.calls.find(([method]) => method === "routines:create");
  assert.deepEqual(create?.[1][0].target, { kind: "chat", chatId: "/q#9" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(host.routes, ["back"]);
});

test("the phone offers comment placeholders only for a Linear comment Routine", () => {
  const host = routineFormHost();
  find(host.render(), (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  host.pick(host.render(), "When").props.onSelect("comment");
  const names = () => find(host.render(), (node) => node.type === "PlaceholderField").props.placeholders.map((item) => item.name);
  assert.ok(names().includes("comment.body"));
  assert.ok(names().includes("comment.author"));
  host.pick(host.render(), "When").props.onSelect("assigned");
  assert.ok(!names().includes("comment.body"));
  assert.ok(!names().includes("comment.author"));
});

test("the phone prompt field suggests {{issue.key}} while typing {{iss, and choosing it inserts the placeholder", () => {
  const react = hookHost();
  const changes = [];
  const { PlaceholderField } = load("placeholder-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "@milagre/shared/routine-prompt": require("@milagre/shared/routine-prompt"),
    "./ui": { Field: "Field", ListRow: "ListRow" },
  });
  const placeholders = require("@milagre/shared/routine-prompt").placeholdersFor({ kind: "linear", workspace: "w", event: "label-added" });
  let value = "Work on {{iss";
  const render = () => {
    react.begin();
    return PlaceholderField({ value, onChangeText: (next) => changes.push((value = next)), placeholders });
  };
  const field = find(render(), (node) => node.type === "Field");
  field.props.onFocus();
  field.props.onSelectionChange({ nativeEvent: { selection: { start: value.length, end: value.length } } });
  const suggestion = find(render(), (node) => node.type === "ListRow" && node.props.title === "{{issue.key}}");
  assert.ok(suggestion, "issue.key is suggested");
  suggestion.props.onPress();
  assert.deepEqual(changes, ["Work on {{issue.key}}"]);
  const after = find(render(), (node) => node.type === "Field");
  assert.deepEqual(JSON.parse(JSON.stringify(after.props.selection)), { start: 21, end: 21 }, "the caret goes after the }}");
});

test("Create on the phone routine form sends routines:create the formToInput output and closes", async () => {
  const host = routineFormHost();
  let tree = host.render();
  find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Take issues labelled agent");
  find(host.render(), (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  host.pick(host.render(), "Label").props.onSelect("agent");
  host.pick(host.render(), "Project").props.onSelect("/p");
  find(host.render(), (node) => node.type === "PlaceholderField").props.onChangeText("Work on {{issue.key}}");
  tree = host.render();
  find(tree, (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const create = host.calls.find(([method]) => method === "routines:create");
  assert.deepEqual(create[1], [
    {
      name: "Take issues labelled agent",
      prompt: "Work on {{issue.key}}",
      trigger: { kind: "linear", workspace: "w1", event: "label-added", label: "agent" },
      target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(host.routes, ["back"]);
});

test("the phone routine form shows a refused field's problem and sends nothing", async () => {
  const host = routineFormHost();
  find(host.render(), (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  find(host.render(), (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Labels");
  find(host.render(), (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    host.calls.find(([method]) => method === "routines:create"),
    undefined,
  );
  const problems = allNodes(host.render(), (node) => typeof node.type === "function" && node.type.name === "Problem").map((node) => node.props.text);
  assert.ok(problems.includes("Pick the label to watch"), "the problem shows under the Linear card");
});

test("opening the phone Routines screen reads once and opens one live socket", async () => {
  const host = routinesHost();
  host.render();
  await host.settle();
  assert.equal(host.calls.filter(([method]) => method === "routines:list").length, 1);
  assert.deepEqual(host.sockets, [""]);
});

test("on a Mac without Routines the phone screen asks to update Milagre there, with no raw error and no socket", async () => {
  const host = routinesHost({ refuse: true });
  host.render();
  await host.settle();
  const tree = host.render();
  const texts = new Set(allNodes(tree, (node) => node.type === "Text").map(textOf));
  assert.ok(texts.has("Update Milagre on this Mac to use Routines."));
  assert.ok(!texts.has("Routines are off on this Mac"));
  assert.equal(
    find(tree, (node) => node.type === "ErrorNotice"),
    undefined,
  );
  assert.deepEqual(host.sockets, []);
});

test("a confined phone is never told Routines are off, and opens no Project-less socket", async () => {
  const host = routinesHost({ confined: true });
  host.render();
  await host.settle();
  const texts = new Set(allNodes(host.render(), (node) => node.type === "Text").map(textOf));
  assert.ok(!texts.has("Routines are off on this Mac"));
  assert.ok(texts.has("Routines aren't available on this connection."));
  assert.deepEqual(host.sockets, []);
});

test("two quick flips of one Routine on the phone keep the second value until its own write settles", async () => {
  const host = routinesHost({ slowUpdates: true });
  host.render();
  await host.settle();
  const switchOf = () => find(host.rows(host.render())[0], (node) => node.type === "RowCheckbox");
  switchOf().props.onPress();
  assert.equal(switchOf().props.selected, false);
  switchOf().props.onPress();
  assert.equal(switchOf().props.selected, true);
  await host.settle();
  host.updates[0].resolve();
  await host.settle();
  assert.equal(switchOf().props.selected, true, "the first write's end doesn't drop the second flip");
  host.updates[1].resolve();
  await host.settle();
});

test("useRoutinesAvailable is true on a Mac with Routines, switched off or on, and false on an older Mac or a confined phone", async () => {
  const check = async (answer) => {
    const react = hookHost();
    const focused = [];
    const { useRoutinesAvailable } = load("use-routines.ts", {
      react,
      "react-native": { AppState: { addEventListener: () => ({ remove() {} }) } },
      "expo-router": { useFocusEffect: (fn) => focused.push(fn) },
    });
    const client = { call: async () => (answer instanceof Error ? Promise.reject(answer) : answer) };
    react.begin();
    useRoutinesAvailable(client);
    for (const fn of focused.splice(0)) fn();
    await new Promise((resolve) => setImmediate(resolve));
    react.begin();
    return useRoutinesAvailable(client);
  };
  assert.equal(await check({ enabled: false }), true);
  assert.equal(await check({ enabled: true }), true);
  assert.equal(await check(new Error("routines:enabled:read is not available from mobile")), false);
  assert.equal(await check([]), false);
});

const heartbeatFor = (chatId, extra = {}) => ({
  id: "hb1",
  name: "Babysit PR #473",
  prompt: "Check CI",
  trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
  target: { kind: "chat", chatId },
  enabled: true,
  createdBy: { kind: "agent", chatId },
  nextRunAt: new Date(2026, 9, 17, 10, 45).getTime(),
  // A year far ahead: the card reads "ends 09:00" instead of "ends Oct 24" on the day a Heartbeat ends, and the
  // runner's clock crossed that day (UTC) before the Mac's did.
  expiresAt: new Date(2036, 9, 24, 9, 0).getTime(),
  runCount: 2,
  createdAt: 1,
  updatedAt: 1,
  runs: [],
  ...extra,
});

test("a phone Chat with an enabled Heartbeat shows the Heartbeat header button and Next check; without one, neither", () => {
  const chat = chatHost({ routines: [heartbeatFor("/p#7"), heartbeatFor("/p#8", { id: "other" })] });
  chat.params.id = "7";
  chat.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1 };
  const tree = chat.render();
  const button = chatMenuEntry(tree, "Heartbeat");
  assert.ok(button, "the header shows the Heartbeat button");
  assert.equal(button.props.systemImage, "waveform.path.ecg");
  button.props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(chat.router.pushed)), [{ pathname: "/routine", params: { id: "hb1" } }], "it opens the Heartbeat's page");
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Next check 10:45"));

  const paused = chatHost({ routines: [heartbeatFor("/p#7", { enabled: false })] });
  paused.params.id = "7";
  paused.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1 };
  const off = paused.render();
  assert.equal(chatMenuEntry(off, "Heartbeat"), undefined);
  assert.ok(!allNodes(off, (node) => node.type === "Text").some((node) => textOf(node).startsWith("Next check")));
});

test("a phone Run Chat, hidden or kept, shows a Routine header button that opens its Routine's page", () => {
  const trigger = { ...routineFixtures()[1], enabled: false };
  for (const hidden of [true, false]) {
    const chat = chatHost({ routines: [trigger, heartbeatFor("/p#8")] });
    chat.params.id = "9";
    chat.session.snapshot.project.state.sessions[9] = { id: 9, worktree_id: 1, routine: { routineId: "tr", runId: "r1", hidden } };
    const button = chatMenuEntry(chat.render(), "Routine");
    assert.ok(button, "a paused Routine's Run Chat still names it");
    assert.equal(button.props.systemImage, "repeat");
    button.props.onPress();
    assert.deepEqual(JSON.parse(JSON.stringify(chat.router.pushed)), [{ pathname: "/routine", params: { id: "tr" } }]);
  }
  // A Run Chat whose Routine is gone has no button.
  const gone = chatHost({ routines: [heartbeatFor("/p#8")] });
  gone.params.id = "9";
  gone.session.snapshot.project.state.sessions[9] = { id: 9, worktree_id: 1, routine: { routineId: "tr", runId: "r1", hidden: true } };
  const tree = gone.render();
  assert.equal(
    chatMenuEntries(tree).find((node) => ["Routine", "Heartbeat"].includes(node.props.children)),
    undefined,
  );
});

test("the phone Chat header keeps its title on one line with an ellipsis, clear of the toolbar group, as Browser and PR shortcuts appear", () => {
  const title = "Rotate staging API key before Friday";
  const header = (screenWidth, { routines = [], routine, browserShortcut = null } = {}) => {
    const chat = chatHost({ routines, screenWidth, browserShortcut });
    chat.params.id = "9";
    chat.session.snapshot.project.state.sessions[9] = { id: 9, worktree_id: 1, title, ...(routine ? { routine } : {}) };
    const tree = chat.render();
    const screen = find(tree, (node) => node.type === "Screen");
    const element = screen.props.options.headerTitle();
    // The box reads whether the sidebar is pinned itself, so the Chat doesn't render again as it shows or hides.
    const titleBox = find(element, (node) => typeof node.type === "function" && "actionCount" in node.props);
    const box = titleBox.type(titleBox.props);
    const text = find(element, (node) => node.type === "Text" && textOf(node) === title);
    assert.ok(text, "the title is in the header");
    assert.equal(text.props.numberOfLines, 1);
    assert.equal(text.props.ellipsizeMode, "tail");
    assert.equal(text.props.style.flexShrink, 1, "the text gives way before the frame does");
    return box.props.style.maxWidth;
  };
  const runChat = { routines: [{ ...routineFixtures()[1], enabled: false }], routine: { routineId: "tr", runId: "r1", hidden: true } };
  const heartbeat = { routines: [heartbeatFor("/p#9")] };
  // Routine actions stay inside the menu and do not take title space.
  assert.equal(header(402, runChat), 230, "a Run Chat keeps Routine inside ⋯");
  assert.equal(header(402, heartbeat), 230, "a Heartbeat Chat also keeps its title room");
  assert.equal(header(402), 230, "a normal Chat keeps its room: only ⋯ on the right");
  // Narrower screens narrow the title; every case ends 12 pt clear of the pill.
  assert.equal(header(375, runChat), 230);
  assert.equal(header(375), 230);
  assert.equal(header(340), 196);
  const browserShortcut = { accessibilityLabel: "Browser, 1 page in this Chat", onPress() {} };
  assert.equal(header(402, { browserShortcut }), 214);
  globalThis.chatPullRequest = { number: 90, state: "OPEN", url: "https://github.com/o/r/pull/90" };
  try {
    assert.equal(header(402), 214, "PR alone reserves one extra button");
    assert.equal(header(402, { browserShortcut }), 170, "both shortcuts leave room for the title");
    assert.equal(header(320, { browserShortcut }), 88, "narrow phone title stays clear of all three controls");
  } finally {
    delete globalThis.chatPullRequest;
  }
  for (const width of [320, 375, 402, 430]) {
    for (const own of [runChat, heartbeat]) assert.ok(header(width, own) + 72 + 72 <= width, `${width} pt`);
  }
});

test("mobile ChatReply turns a heartbeat_create step into the Heartbeat set card, out of the activity rows", () => {
  const react = { memo: (fn) => fn, useCallback: (fn) => fn, useEffect() {}, useRef: () => ({}), useState: (value) => [value, () => {}] };
  const { ChatReply } = load("chat-reply.tsx", {
    "@milagre/shared/advisor-result": require("@milagre/shared/advisor-result"),
    "@milagre/shared/linked-message": require("@milagre/shared/linked-message"),
    react: { ...react, useMemo: (compute) => compute() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Image: "Image", Pressable: "Pressable", Text: "Text", View: "View", useColorScheme: () => "dark" },
    "react-native-svg": { default: "Svg", Path: "Path" },
    "expo-router": { router: {} },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
    "@milagre/shared/reply-parts": require("@milagre/shared/reply-parts"),
    "./file-chip": { FileChip: "FileChip" },
    "./markdown": { Markdown: "Markdown" },
    "./icons": { Icon: "Icon" },
    "./activity-item": { ActivityTitle: "ActivityTitle" },
    "./tool-row": { ToolRow: "ToolRow" },
    "./artifact": { ArtifactCards: "ArtifactCards", DesignFeedbackCard: "DesignFeedbackCard" },
    "@milagre/shared/page-comments": { parsePageComments: () => null },
    "./page-comments-card": { PageCommentsCard: "PageCommentsCard" },
    "./answer-card": { AnswerCard: "AnswerCard" },
    "./chat-display-setting": { useToolCallDisplay: () => ["full", () => {}] },
    "./pr-action-card": { PullRequestActionCard: "PullRequestActionCard" },
    "./linear-issue-card": { LinearIssueCard: "LinearIssueCard" },
    "./advisor-result-card": { AdvisorResultCard: "AdvisorResultCard" },
    "./heartbeat-card": { HeartbeatCard: "HeartbeatCard" },
    "./computer-use-card": { ComputerUseCard: "ComputerUseCard" },
    "./usage-limit-card": { UsageLimitCard: "UsageLimitCard" },
    "@milagre/shared/usage-limit": require("@milagre/shared/usage-limit"),
    "@milagre/shared/pr-action": require("@milagre/shared/pr-action"),
    "@milagre/shared/linear-issue": require("@milagre/shared/linear-issue"),
    "@milagre/shared/artifact": require("../packages/shared/src/artifact.ts"),
    "./theme": { hex: () => "#000" },
    "./viewer-store": { showImages() {} },
    "./ui": { colors: {}, styles: { card: {}, row: {}, muted: {} } },
  });
  const steps = [
    { id: "s1", kind: "shell", title: "Ran `gh pr view`", status: "done" },
    { id: "s2", kind: "other", title: 'Set Heartbeat "Babysit PR #473"', status: "done", routine: { id: "hb1", name: "Babysit PR #473" } },
  ];
  const message = { id: 9, session_id: 7, role: "assistant", body: "Opened #473. I'll check every 15 minutes.", steps };
  const tree = ChatReply({ message, media: () => null, onActivity() {}, chatId: "/p#7" });
  const card = find(tree, (node) => node.type === "HeartbeatCard");
  assert.ok(card, "the card shows");
  assert.equal(card.props.step.routine.id, "hb1");
  const rows = new Set(allNodes(tree, (node) => node.type === "ToolRow").map((node) => node.props.step.id));
  assert.ok(!rows.has("s2"), "the heartbeat step isn't an activity row too");
  const order = allNodes(tree, (node) => node.type === "HeartbeatCard" || node.type === "Markdown").map((node) => node.type);
  assert.deepEqual(order.slice(-2), ["Markdown", "HeartbeatCard"], "the reply text comes first, then the card");
  assert.ok(rows.has("s1"));
});

function heartbeatCardHost(routines, { fail, now } = {}) {
  const react = hookHost();
  const calls = [];
  let refreshed = 0;
  const client = {
    async call(method, args) {
      calls.push([method, JSON.parse(JSON.stringify(args))]);
      if (fail) throw new Error(fail);
      return { removed: true };
    },
  };
  const { HeartbeatCard } = load(
    "heartbeat-card.tsx",
    {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "react-native": { Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { hairlineWidth: 1 } },
      "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
      "./session": { useSession: () => ({ client }) },
      "./use-routines": {
        useRoutines: () => ({
          routines,
          enabled: true,
          unavailable: null,
          error: "",
          loading: false,
          refresh: async () => void refreshed++,
          update: async () => {},
        }),
      },
      "./routine-rows": load("routine-rows.ts", {
        "@hugeicons/core-free-icons": new Proxy({}, { get: (_, key) => key }),
        "@milagre/shared/routines": require("@milagre/shared/routines"),
        "@milagre/shared/routine-form": require("@milagre/shared/routine-form"),
      }),
      "@milagre/shared/routines": require("@milagre/shared/routines"),
      "./icons": { Icon: "Icon" },
      "./ui": { tap() {}, ErrorNotice: "ErrorNotice" },
    },
    now === undefined ? "" : `\nDate.now = () => ${now};`,
  );
  const step = { id: "s2", kind: "other", title: "Set Heartbeat", status: "done", routine: { id: "hb1", name: "Babysit PR #473" } };
  const render = () => {
    react.begin();
    return HeartbeatCard({ step });
  };
  return { render, calls, refreshed: () => refreshed };
}

test("the phone Heartbeat set card names the Heartbeat, its cadence and end, and Stop deletes it", async () => {
  const host = heartbeatCardHost([heartbeatFor("/p#7")], { now: new Date(2026, 9, 17, 10, 0).getTime() });
  const tree = host.render();
  const texts = allNodes(tree, (node) => node.type === "Text").map(textOf);
  assert.ok(texts.includes("Heartbeat set: Babysit PR #473"));
  assert.ok(texts.includes("Every 15 min · ends Oct 24"), texts.join(" | "));
  const stop = find(tree, (node) => node.props?.accessibilityLabel === "Stop Babysit PR #473");
  stop.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls, [["routines:delete", ["hb1"]]]);
  assert.equal(host.refreshed(), 1);
});

test("the phone Heartbeat set card says Stopped once its Heartbeat is gone, with no Stop button", () => {
  const host = heartbeatCardHost([]);
  const tree = host.render();
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Stopped"));
  assert.equal(
    find(tree, (node) => node.props?.accessibilityLabel === "Stop Babysit PR #473"),
    undefined,
  );
});

test("editing a Routine on the phone starts from it and saves the formToUpdate patch", async () => {
  const stored = {
    id: "tr",
    name: "Issues labelled agent",
    prompt: "Work on {{issue.key}}",
    trigger: { kind: "linear", workspace: "w1", event: "label-added", label: "agent" },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    createdAt: 1,
    updatedAt: 1,
    runs: [],
  };
  const host = routineFormHost({ params: { id: "tr" }, routines: [stored] });
  host.render();
  let tree = host.render();
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Edit Routine"));
  assert.equal(find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.value, "Issues labelled agent");
  assert.equal(find(tree, (node) => node.props?.accessibilityLabel === "On a schedule" && node.props.accessibilityRole === "radio").props.disabled, true);
  // Edit shows no Starts choice: a Routine's trigger kind can't change.
  assert.ok(!allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Starts"));
  assert.equal(host.pick(tree, "Label").props.nativeTrigger.title, "agent", "VoiceOver reads the row as Label: agent");
  find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Agent issues");
  tree = host.render();
  assert.equal(find(tree, (node) => node.type === "PillButton").props.title, "Save");
  find(tree, (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const update = host.calls.find(([method]) => method === "routines:update");
  const { formFromRoutine, formToUpdate } = require("@milagre/shared/routine-form");
  const expected = formToUpdate({ ...formFromRoutine(stored, "UTC"), name: "Agent issues" }, stored).patch;
  assert.deepEqual(update[1], ["tr", JSON.parse(JSON.stringify(expected))]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(host.routes, ["back"]);
});

test("the phone New Routine sheet uses desktop's copy, and Create waits for a name and a prompt", () => {
  const host = routineFormHost();
  let tree = host.render();
  const texts = () => allNodes(tree, (node) => node.type === "Text").map(textOf);
  assert.ok(texts().includes("Starts"));
  assert.deepEqual(
    allNodes(tree, (node) => node.props?.accessibilityRole === "radio").map((node) => node.props.accessibilityLabel),
    ["On a schedule", "Linear event", "Webhook"],
  );
  assert.equal(find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.placeholder, "Name this Routine");
  assert.equal(
    find(tree, (node) => node.type === "PlaceholderField").props.placeholder,
    "What should the agent do on each Run? End with (pass) when there's nothing to do.",
  );
  assert.ok(texts().includes("Type {{ for the Run's fields"));
  assert.ok(texts().includes("Stop after"));
  assert.equal(host.pick(tree, "Repeats") !== undefined, true);
  assert.equal(find(tree, (node) => node.type === "PillButton").props.disabled, true);
  assert.equal(
    find(tree, (node) => node.type === "Button" && node.props.title === "Delete Routine"),
    undefined,
    "a new Routine has nothing to delete",
  );
  find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Nightly triage");
  find(host.render(), (node) => node.type === "PlaceholderField").props.onChangeText("Triage new issues");
  tree = host.render();
  assert.equal(find(tree, (node) => node.type === "PillButton").props.disabled, false);
});

test("closing the phone Routine sheet with changes asks to discard them first; Linear says its issue text is data", () => {
  const host = routineFormHost();
  let tree = host.render();
  assert.equal(host.guard.on, false, "an untouched sheet closes at once");
  find(tree, (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  tree = host.render();
  assert.ok(
    allNodes(tree, (node) => node.type === "Text")
      .map(textOf)
      .includes("Type {{ for the Run's fields. Issue text is passed as data, not instructions."),
  );
  assert.equal(host.guard.on, true);
  let repeated = 0;
  host.guard.ask({ repeat: () => (repeated += 1) });
  const [title, , buttons] = host.guard.alerts[0];
  assert.equal(title, "Discard changes?");
  assert.deepEqual(JSON.parse(JSON.stringify(buttons.map((button) => button.text))), ["Keep editing", "Discard"]);
  buttons[1].onPress();
  assert.equal(repeated, 1);
  host.render();
  assert.equal(host.guard.on, false, "once discarded the sheet leaves without asking again");
});

test("Delete Routine sits at the bottom of the phone Edit sheet, says what deleting does, and asks first", async () => {
  const heartbeat = {
    id: "hb",
    name: "Babysit PR #473",
    prompt: "Check CI",
    trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId: "/p#4" },
    enabled: true,
    createdBy: { kind: "user" },
    runCount: 0,
    expiresAt: Date.now() + 864e5,
    createdAt: 1,
    updatedAt: 1,
    runs: [],
  };
  const host = routineFormHost({ params: { id: "hb" }, routines: [heartbeat] });
  host.render();
  const tree = host.render();
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Its Chats stay."));
  find(tree, (node) => node.type === "Button" && node.props.title === "Delete Routine").props.onPress();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    host.calls.filter(([method]) => method === "routines:delete"),
    [["routines:delete", ["hb"]]],
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(host.routes, ["back"]);
});

test("creating a webhook Routine on the phone keeps the sheet open on its URL, with Copy and Rotate", async () => {
  const host = routineFormHost({ created: { routine: { id: "wh" }, hookUrl: "https://relay.milagre.cloud/hook/abc" } });
  find(host.render(), (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Sentry crashes");
  find(host.render(), (node) => node.props?.accessibilityLabel === "Webhook" && node.props.accessibilityRole === "radio").props.onPress();
  let tree = host.render();
  assert.ok(host.rowLabels(tree).includes("URL"));
  assert.ok(host.rowLabels(tree).includes("Check signature"));
  assert.ok(!host.rowLabels(tree).includes("Signing secret"), "signing fields wait for the switch");
  host.pick(tree, "Project").props.onSelect("/p");
  find(host.render(), (node) => node.type === "PlaceholderField").props.onChangeText("Look at {{body}}");
  find(host.render(), (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const create = host.calls.find(([method]) => method === "routines:create");
  assert.deepEqual(create[1][0].trigger, { kind: "webhook", signed: false });
  assert.deepEqual(host.routes, [], "the sheet stays open");
  tree = host.render();
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "https://relay.milagre.cloud/hook/abc"));
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Webhook Routine"));
  const buttons = new Set(allNodes(tree, (node) => node.type === "PillButton").map((node) => node.props.title));
  assert.ok(buttons.has("Copy") && buttons.has("Rotate"));
  assert.equal(find(tree, (node) => node.type === "PillButton" && node.props.title === "Save").props.title, "Save");
  find(tree, (node) => node.type === "PillButton" && node.props.title === "Rotate").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    host.calls.find(([method]) => method === "routines:rotate-hook"),
    ["routines:rotate-hook", ["wh"]],
  );
  assert.ok(allNodes(host.render(), (node) => node.type === "Text").some((node) => textOf(node) === "https://relay.milagre.cloud/hook/rotated"));
});

test("a phone Chat shows no Heartbeat button or Next check while the Mac's Routines switch is off, a turn runs, or the check is past", () => {
  const setUp = (options, run) => {
    const chat = chatHost({ routines: [heartbeatFor("/p#7")], ...options });
    chat.params.id = "7";
    chat.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1 };
    if (run) chat.session.snapshot.runs.runs["/p#7"] = { startedAt: Date.now(), questions: [], approvals: [], steps: [] };
    return chat.render();
  };
  const button = (tree) => chatMenuEntry(tree, "Heartbeat");
  const nextCheck = (tree) => allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node).startsWith("Next check"));
  const off = setUp({ routinesOn: false });
  assert.equal(button(off), undefined, "switch off: no button");
  assert.equal(nextCheck(off), false, "switch off: no Next check");
  const running = setUp({}, true);
  assert.ok(button(running), "the button stays while a turn runs");
  assert.equal(nextCheck(running), false, "no Next check while a turn runs");
  const late = setUp({ now: new Date(2026, 9, 17, 10, 50).getTime() });
  assert.equal(nextCheck(late), false, "a check time already past isn't promised");
});

test("the phone Heartbeat set card shows a refused Stop as an error and keeps the button", async () => {
  const host = heartbeatCardHost([heartbeatFor("/p#7")], { fail: "This computer does not allow changing this setting from a phone." });
  find(host.render(), (node) => node.props?.accessibilityLabel === "Stop Babysit PR #473").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const tree = host.render();
  assert.match(find(tree, (node) => node.type === "ErrorNotice").props.message, /does not allow/);
  assert.ok(find(tree, (node) => node.props?.accessibilityLabel === "Stop Babysit PR #473"));
  assert.equal(host.refreshed(), 0);
});

test("the phone Heartbeat set card says Ended for a Heartbeat that ran out on its own", () => {
  const host = heartbeatCardHost([heartbeatFor("/p#7", { enabled: false, completedAt: 5 })]);
  const tree = host.render();
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Ended"));
  assert.equal(
    find(tree, (node) => node.props?.accessibilityLabel === "Stop Babysit PR #473"),
    undefined,
  );
});

test("a Linear comment Routine on the phone form drops the Each Run rows: comments go into the issue's linked Chat", async () => {
  const host = routineFormHost();
  find(host.render(), (node) => node.props?.accessibilityLabel === "Linear event" && node.props.accessibilityRole === "radio").props.onPress();
  host.pick(host.render(), "When").props.onSelect("comment");
  const tree = host.render();
  const labels = host.rowLabels(tree);
  assert.ok(!labels.includes("Project") && !labels.includes("Works in"), labels.join(", "));
  assert.ok(labels.includes("Model") && labels.includes("Stop after"), "the agent's settings stay");
  assert.ok(allNodes(tree, (node) => node.type === "Text").some((node) => textOf(node) === "Comments go into the Chat linked to the issue."));
  find(tree, (node) => node.type === "Field" && node.props.label === "Name").props.onChangeText("Answer comments");
  find(host.render(), (node) => node.type === "PlaceholderField").props.onChangeText("Reply to {{comment.body}}");
  find(host.render(), (node) => node.type === "PillButton").props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const create = host.calls.find(([method]) => method === "routines:create");
  assert.ok(create, "a comment Routine saves without the user picking a Project");
  assert.equal(create[1][0].trigger.event, "comment");
  assert.deepEqual(create[1][0].target, { kind: "new-chat", projectPath: "/p", workspace: "worktree" }, "it carries the Project open on the phone");
});

test("provider update cards on the phone install the advertised release on the connected computer", async () => {
  const react = hookHost();
  const calls = [];
  let transport;
  let refreshed = 0;
  const state = { current: { provider: "codex", version: "0.163.0", installedVersion: "0.160.0" }, working: false, error: "", dismiss() {}, install() {} };
  const { ProviderUpdateNotice } = load("provider-update-notice.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "expo-router": { router: { push: (path) => calls.push(path) } },
    "@hugeicons/core-free-icons": { Cancel01Icon: "close" },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) },
    "@milagre/shared/providers": require("@milagre/shared/providers"),
    "@milagre/shared/use-provider-updates": {
      useProviderUpdates: (value) => {
        transport = value;
        return state;
      },
    },
    "./hosts-native": {
      savedProviderUpdateDismissals: {
        load: async (hostId) => (calls.push(["load", hostId]), []),
        add: async (hostId, key) => void calls.push(["add", hostId, key]),
      },
    },
    "./session": {
      useSession: () => ({
        client: {
          url: "https://studio.local:7788",
          call: async (...args) => {
            calls.push(args);
            return { ok: true };
          },
        },
        hostName: "Studio Mac",
        refreshProviders: () => refreshed++,
      }),
    },
    "./icons": { ProviderLogo: "ProviderLogo" },
    "./ui": { IconButton: "IconButton", PillButton: "PillButton" },
  });
  react.begin();
  const tree = ProviderUpdateNotice();
  find(tree, (node) => node.type === "PillButton" && node.props.title === "Settings").props.onPress();
  assert.equal(calls[0], "/accounts");
  await transport.install(state.current);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ["agent:update-cli", ["codex", "0.163.0"]]);
  assert.equal(refreshed, 1);
  state.working = true;
  react.begin();
  const pending = ProviderUpdateNotice();
  assert.equal(find(pending, (node) => node.type === "PillButton" && node.props.title === "Updating…").props.disabled, true);
  assert.equal(find(pending, (node) => node.type === "IconButton").props.disabled, true);
  state.error = "Permission denied";
  state.working = false;
  react.begin();
  const failed = ProviderUpdateNotice();
  assert.equal(find(failed, (node) => node.props?.accessibilityRole === "alert").props.children, "Permission denied");
  assert.equal(find(failed, (node) => node.type === "PillButton" && node.props.title === "Retry").props.disabled, false);
  await transport.dismissals.add("codex:0.163.0");
  await transport.dismissals.load();
  assert.deepEqual(
    calls.slice(-2),
    [
      ["add", "https://studio.local:7788", "codex:0.163.0"],
      ["load", "https://studio.local:7788"],
    ],
    "dismissals are saved on the phone for the connected computer",
  );
});

test("a provider update dismissed on the phone stays dismissed when the connection is rebuilt", async () => {
  const react = hookHost({ effects: true });
  const source = fs.readFileSync(path.join(__dirname, "../packages/shared/src/use-provider-updates.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (id) => (id === "react" ? react : require(id)), setInterval, clearInterval });
  const saved = new Set();
  const transport = () => ({
    read: async () => [
      { provider: "codex", version: "0.165.0", installedVersion: "0.163.0" },
      { provider: "claude", version: "2.1.312", installedVersion: "2.1.300" },
    ],
    install: async () => ({ ok: true }),
    dismissals: { load: async () => [...saved], add: async (key) => void saved.add(key) },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let current = transport();
  const render = () => {
    react.begin();
    return exports.useProviderUpdates(current);
  };
  assert.equal(render().current, undefined, "nothing shows before the saved dismissals are read");
  await settle();
  const first = render();
  assert.equal(first.current.provider, "codex");
  first.dismiss();
  assert.equal(render().current.provider, "claude");
  assert.deepEqual([...saved], ["codex:0.165.0"]);
  current = transport(); // a reconnect builds a new client and so a new transport
  assert.equal(render().current, undefined);
  await settle();
  assert.equal(render().current.provider, "claude", "the dismissed Codex release does not come back");
  react.unmount();
});

test("provider logos preserve their shapes and use white or black in Simplified mode", () => {
  const react = hookHost();
  let scheme = "dark";
  let style = "simplified";
  const shapes = require("../packages/shared/src/provider-logos.ts");
  const svg = Object.fromEntries(
    ["default", "Circle", "Defs", "FeGaussianBlur", "Filter", "G", "LinearGradient", "Mask", "Path", "Stop"].map((name) => [
      name,
      name === "default" ? "Svg" : name,
    ]),
  );
  const { ProviderLogo } = load("icons.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {},
    "react-native-svg": { ...svg, __esModule: true },
    "@milagre/shared/provider-logos": shapes,
    "@hugeicons/react-native": {},
    "./theme": { useTheme: () => ({ scheme, settings: { providerIcons: style } }) },
  });
  const render = (provider, inverted = false) => {
    react.begin();
    return ProviderLogo({ provider, inverted });
  };
  for (const provider of ["claude", "codex", "antigravity"]) {
    let tree = render(provider);
    const path = find(tree, (node) => node.type === "Path");
    assert.equal(path.props.d, shapes.providerLogoPath(provider));
    assert.equal(path.props.fill, "#fff");
    assert.equal(
      find(tree, (node) => node.type === "Defs"),
      undefined,
    );
    scheme = "light";
    assert.equal(find(render(provider), (node) => node.type === "Path").props.fill, "#000");
    assert.equal(find(render(provider, true), (node) => node.type === "Path").props.fill, "#fff", "selected chips keep contrast in light mode");
    scheme = "dark";
    assert.equal(find(render(provider, true), (node) => node.type === "Path").props.fill, "#000", "selected chips keep contrast in dark mode");
  }
  style = "original";
  assert.equal(find(render("claude"), (node) => node.type === "Path").props.fill, shapes.CLAUDE_LOGO.fill);
  assert.ok(find(render("codex"), (node) => node.type === "LinearGradient"));
  assert.ok(find(render("antigravity"), (node) => node.type === "Mask"));
});

test("phone notification schedule controls save days, overnight hours, timezone and anytime", () => {
  const state = { schedule: null };
  const saved = [];
  const { NotificationScheduleSetting } = load("notification-schedule-setting.tsx", {
    "react-native": { Text: "Text", View: "View" },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/notification-schedule": require("@milagre/shared/notification-schedule"),
    "./push": {
      usePush: () => ({
        state,
        busy: false,
        preferences: (value) => {
          saved.push(value);
          Object.assign(state, value);
        },
      }),
    },
    "./ui": { ...uiHooks, PillButton: "PillButton", PullDown: "PullDown", Toggle: "Toggle" },
  });
  const render = () => NotificationScheduleSetting();
  const toggle = (title) => find(render(), (node) => node.type === "Toggle" && node.props.title === title);
  toggle("Notification schedule").props.onPress();
  assert.deepEqual([...state.schedule.days], [1, 2, 3, 4, 5]);
  toggle("Sat").props.onPress();
  assert.deepEqual([...state.schedule.days], [1, 2, 3, 4, 5, 6]);
  const pick = (label, value) => find(render(), (node) => node.type === "PullDown" && node.props.label === label).props.onSelect(value);
  pick("Start time", "22:00");
  pick("End time", "06:00");
  pick("Timezone", "UTC");
  assert.equal(state.schedule.start, "22:00");
  assert.equal(state.schedule.end, "06:00");
  assert.equal(state.schedule.timeZone, "UTC");
  assert.match(textOf(render()), /Ends the next day/);
  toggle("Notification schedule").props.onPress();
  assert.equal(saved.at(-1).schedule, null);
});

test("Git polling on the phone keeps the current list during reads and pauses off-screen", async () => {
  const react = hookHost({ effects: true });
  const timers = new Map();
  let next = 0,
    calls = 0,
    finish;
  const client = {
    call: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const { startRefreshLoop } = require("@milagre/shared/refresh-loop");
  const { useRpc } = load("use-rpc.ts", {
    react,
    "@milagre/shared/refresh-loop": {
      startRefreshLoop: (options) =>
        startRefreshLoop({
          ...options,
          schedule(fn) {
            timers.set(++next, fn);
            return next;
          },
          cancel(timer) {
            timers.delete(timer);
          },
        }),
    },
  });
  let active = true;
  const render = () => {
    react.begin();
    const result = useRpc(client, "git:diff-files", [{ cwd: "/project", mode: "uncommitted" }], active);
    react.flush();
    return result;
  };
  assert.equal(render().loading, true);
  finish({ files: ["edited.ts"] });
  await settle();
  assert.deepEqual(render().data.files, ["edited.ts"]);
  const [id, tick] = timers.entries().next().value;
  timers.delete(id);
  const reading = tick();
  assert.deepEqual(render().data.files, ["edited.ts"], "the list stays visible during a background read");
  finish({ files: [] });
  await reading;
  assert.deepEqual(render().data.files, [], "an external commit clears the list without a user action");
  active = false;
  render();
  assert.equal(timers.size, 0);
  const before = calls;
  active = true;
  render();
  assert.equal(calls, before + 1, "returning to the screen reads immediately");
  react.unmount();
  finish({ files: ["late.ts"] });
  await settle();
  assert.equal(timers.size, 0);
});

function splitShellHost() {
  const split = { pinned: true, dockable: true, available: true, hidden: false, widthClass: "wide", toggle() {} };
  const calls = [];
  const screen = { pathname: "/chat", pagePushed: false };
  const router = {
    canDismiss: () => screen.pagePushed,
    dismissAll: () => {
      calls.push("dismissAll");
      screen.pagePushed = false;
    },
    replace: (href) => calls.push(["replace", href]),
    push: (href) => calls.push(["push", href]),
  };
  // Effects on: the slide's end (withTiming's callback) is what wakes and sleeps the list.
  const shell = hookHost({ effects: true });
  const sidebar = hookHost();
  const { SplitShell } = load("split-layout.tsx", {
    react: shell,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    "expo-router": { router, usePathname: () => screen.pathname },
    "react-native-safe-area-context": {
      SafeAreaInsetsContext: { Provider: "InsetsProvider" },
      useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
    },
    "./project-navigation": { ProjectNavigation: "ProjectNavigation" },
    "./side-panels": { usePanelScreen: () => ({ attached: true, chatId: 4, open: null, show() {} }) },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      Easing: { bezier: () => (t) => t },
      ReduceMotion: { System: "system" },
      useSharedValue: (value) => ({ get: () => value, set() {} }),
      useAnimatedStyle: (style) => style(),
      withTiming: (value, _config, done) => {
        done?.(true);
        return value;
      },
    },
    "react-native-worklets": { scheduleOnRN: (fn, ...args) => fn(...args) },
    "./motion": { scaledTiming: (config) => config, useMotionScale: () => 1 },
    "./split-context": { useSplit: () => split, useCardTop: () => ({ top: 24, controls: 0, content: {} }) },
    "./session": { useSession: () => ({ client: { url: "http://mac" }, snapshot: { project: { path: "/p" } } }) },
    "./keybindings-store": { useHostKeybindings: () => ({ state: null, error: "", store: null }), rulesOf: () => [] },
  });
  const render = () => {
    shell.begin();
    return SplitShell({ children: "Screen" });
  };
  // The sidebar is drawn as an element; run it with its own hooks to reach the list inside.
  const sidebarOf = (tree) => {
    const element = find(tree, (node) => typeof node.type === "function" && "shown" in node.props);
    if (!element) return null;
    sidebar.begin();
    return { element, tree: element.type(element.props) };
  };
  return { split, calls, screen, render, sidebarOf };
}

test("the pinned sidebar stays mounted, hidden, when the window narrows, so a Chat it is opening still arrives", () => {
  const { split, render, sidebarOf } = splitShellHost();
  assert.equal(sidebarOf(render()).element.props.shown, true);
  // An iPad window dragged below the pinned width while the sidebar connects another computer.
  Object.assign(split, { pinned: false, dockable: false, widthClass: "regular" });
  const narrowed = sidebarOf(render());
  assert.ok(narrowed, "still mounted, so its open request isn't dropped");
  assert.equal(narrowed.element.props.shown, false);
  const visible = (sidebar) => find(sidebar.tree, (node) => node.type === "ProjectNavigation").props.visible;
  // It reads on until it has slid out, so the renders that follow never land on the slide's frames.
  assert.equal(visible(narrowed), true);
  assert.equal(visible(sidebarOf(render())), false, "reads nothing once it has slid out");
  // Leaving the computer (back to the Computers list) is what unmounts it.
  split.available = false;
  render();
  assert.equal(sidebarOf(render()), null);
});

test("the pinned sidebar reopens the Chat under a pushed page by closing the page, and opens other Chats", () => {
  const { calls, screen, render, sidebarOf } = splitShellHost();
  const navigate = (href) => find(sidebarOf(render()).tree, (node) => node.type === "ProjectNavigation").props.onNavigate(href);
  const chat = (id) => ({ pathname: "/chat", params: { hostId: "http://mac", projectPath: "/p", id } });
  // Routines pushed over Chat 4: the row isn't marked open, and picking Chat 4 pops back to it without remounting it.
  Object.assign(screen, { pathname: "/routines", pagePushed: true });
  assert.equal(find(sidebarOf(render()).tree, (node) => node.type === "ProjectNavigation").props.activeChatId, undefined);
  navigate(chat("4"));
  assert.deepEqual(calls, ["dismissAll"]);
  // On the Chat itself, picking it again does nothing; another Chat replaces it.
  calls.length = 0;
  screen.pathname = "/chat";
  navigate(chat("4"));
  navigate(chat("5"));
  assert.deepEqual(calls, [["replace", chat("5")]]);
});

test("mobile simulator relayed frames stay in two cache files and never enter injected JavaScript", async () => {
  const pixels = "aW1hZ2U=",
    injected = [];
  const client = {
    call: async (method, args) => {
      if (method === "simulator:open") return { viewerId: "relay-viewer", transport: "frames" };
      if (method === "simulator:frame")
        return {
          sequence: args[0].after + 1,
          data: pixels,
          mimeType: "image/jpeg",
          status: { width: 1, height: 1, generation: 1, ready: true, controlling: true, orientation: "portrait" },
        };
      return null;
    },
  };
  const h = simulatorHost(client);
  const props = { client, deviceId: "sim", chatId: "/p#7" };
  h.render("TestSimulatorWebView", props);
  await settle();
  const tree = h.render("TestSimulatorWebView", props);
  tree.props.ref.current = { injectJavaScript: (value) => injected.push(value) };
  const message = (id, method, args) => tree.props.onMessage({ nativeEvent: { data: JSON.stringify({ channel: "milagre-simulator", id, method, args }) } });
  message(1, "open", { deviceId: "sim" });
  await settle();
  for (let after = 0; after < 2; after++) {
    message(after + 2, "frame", { viewerId: "relay-viewer", after });
    await settle();
  }
  assert.equal([...h.files.keys()].filter((uri) => uri.endsWith(".jpg")).length, 2);
  assert.equal(
    injected.some((value) => value.includes(pixels)),
    false,
  );
  assert.ok(injected.some((value) => value.includes("file:///cache/simulator-")));
  message(4, "close", { viewerId: "relay-viewer" });
  await settle();
  message(5, "open", { deviceId: "sim" });
  await settle();
  message(6, "frame", { viewerId: "relay-viewer", after: 0 });
  await settle();
  assert.equal([...h.files.keys()].filter((uri) => uri.endsWith(".jpg")).length, 2, "reset frame sequences must not evict the newly written file");
  h.cleanup();
  assert.equal(h.files.size, 0);
});

test("phone Chat mentions work without a Worktree and never search or attach files", async () => {
  const react = hookHost();
  react.useEffect = react.effect;
  const calls = [];
  const client = {
    call: (...args) => {
      calls.push(args);
      return Promise.resolve([]);
    },
  };
  let draft = "@Plan";
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("@milagre/shared/prompt-skills"),
    "./use-rpc": { useRpc: () => ({ data: null }) },
    "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
    "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
  });
  const chats = [
    { id: 12, title: "Plan review", branch: "feature", at: 12, available: true },
    { id: 13, title: "Plan self", branch: "main", at: 13, available: true },
  ];
  const render = () => {
    react.begin();
    const tree = PromptField({
      client,
      projectPath: "/project",
      draft,
      chats,
      currentId: 13,
      onChangeText: (value) => {
        draft = value;
      },
    });
    react.flush();
    return tree;
  };
  try {
    let field = find(render(), (node) => node.type === "Field");
    field.props.onFocus();
    field.props.onSelectionChange({ nativeEvent: { selection: { start: draft.length, end: draft.length } } });
    const row = find(render(), (node) => node.type === "ListRow" && node.props.title === "Plan review");
    assert.ok(row);
    assert.equal(
      find(render(), (node) => node.type === "ListRow" && node.props.title === "Plan self"),
      undefined,
    );
    row.props.onPress();
    assert.equal(draft, "@chat:12 ");
    render();
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.deepEqual(calls, [], "no file callback means no file RPC, even with a Chat menu");
  } finally {
    react.cleanup();
  }
});

const chip = (tree) => find(tree, (node) => node.type === "Pressable" && node.props.accessibilityLabel === "Use suggested prompt: Add tests");

test("phone suggestion fills and focuses the draft without sending, and hides behind typing or menus", () => {
  const react = hookHost();
  let draft = "";
  let focus = 0;
  let accepted = 0;
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("../packages/shared/src/prompt-skills.mjs"),
    "./use-rpc": { useRpc: () => ({ data: { skills: [{ name: "tests", description: "Test" }] } }) },
    "./use-image-paste": { useImagePaste: () => ({ ref: { current: { focus: () => focus++ } }, onFocus() {} }) },
    "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
    "./theme": { useTheme: () => ({ colors: fakePalette, motionScale: 0, typeScale: 1 }) },
  });
  const render = () => {
    react.begin();
    return PromptField({
      client: {},
      projectPath: "/project",
      draft,
      suggestion: "Add tests",
      onChangeText: (value) => {
        draft = value;
      },
      onAcceptSuggestion: (value) => {
        accepted++;
        if (!draft) draft = value;
      },
    });
  };

  const tree = render();
  assert.ok(chip(tree));
  chip(tree).props.onPress();
  assert.equal(draft, "Add tests");
  assert.equal(focus, 1);
  assert.equal(accepted, 1);
  assert.equal(chip(render()), undefined);
  for (const value of [" ", "already typing", "/tests", "@file"]) {
    draft = value;
    assert.equal(chip(render()), undefined);
  }
  draft = "";
  const stale = chip(render());
  draft = "typed before the tap arrived";
  stale.props.onPress();
  assert.equal(draft, "typed before the tap arrived", "a delayed tap preserves new input");
});

test("the phone screen offers suggestions only for idle Claude Chats without attachments or a send in progress", () => {
  const screen = ongoingChatHost();
  const state = screen.session.snapshot.project.state;
  const chat = state.sessions[7];
  chat.provider = "claude";
  chat.suggestion = { text: "Add tests", turnId: "t" };
  for (const message of state.messages) message.model = "claude-opus-5-5";
  screen.session.drafts["/p#7"] = "";
  assert.equal(screen.field().suggestion, "Add tests");
  screen.session.attachments["/p#7"] = [{ id: "file", name: "notes.txt", uri: "file:///notes.txt" }];
  assert.equal(screen.field().suggestion, undefined);
  screen.session.attachments["/p#7"] = [];
  screen.session.snapshot.runs.runs["/p#7"] = { text: "", model: "claude-opus-5-5", steps: [], approvals: [], questions: [], answered: {} };
  assert.equal(screen.field().suggestion, undefined);
  delete screen.session.snapshot.runs.runs["/p#7"];
  chat.backgroundTasks = [{ id: "server", kind: "command", title: "Server", status: "running", startedAt: 1 }];
  assert.equal(screen.field().suggestion, undefined);
  delete chat.backgroundTasks;
  chat.provider = "codex";
  assert.equal(screen.field().suggestion, undefined);
});

test("attention pill uses live Chat titles, excludes visible panes, counts Chats and opens the selected Chat", async () => {
  const react = hookHost({ effects: true });
  let keys = ["/other#3", "/other#4"];
  const opened = [];
  const client = { url: "test-host", attention: async () => keys };
  const session = {
    client,
    recent: [{ path: "/other", name: "Project name" }],
    cachedProject: () => ({
      project: {
        state: {
          sessions: { 4: { id: 4, title: "Old cached title" }, 5: { id: 5, title: "Review changes" } },
          messages: [],
        },
      },
    }),
  };
  session.snapshot = {
    project: {
      path: "/other",
      state: {
        sessions: { 4: { id: 4, title: "Fix toolbar" }, 5: { id: 5, title: "Review changes" } },
        messages: [],
      },
    },
  };
  let visibleChat;
  const { AttentionPill } = load("attention.tsx", {
    // Subscribing starts the shared poller, as React does on mount; a new subscribe (another client) subscribes again.
    react: {
      ...react,
      useSyncExternalStore: (subscribe, snapshot) => {
        react.useEffect(() => subscribe(() => {}), [subscribe]);
        return snapshot();
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { AppState: { currentState: "active" }, Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { absoluteFill: {} } },
    "expo-router": { router: { replace: (route) => opened.push(route) } },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 59 }) },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/agent-runs": require("@milagre/shared/agent-runs"),
    "@milagre/shared/chats": require("@milagre/shared/chats"),
    "@milagre/shared/attention": require("@milagre/shared/attention"),
    "./hosts-native": { readAttentionButton: async () => true, saveAttentionButton: async () => {} },
    "./session": { useSession: () => session },
    "./icons": { Icon: "Icon" },
    "./ui": { PullDown: "PullDown" },
    "./theme": themeHooks,
    "./floating-inbox-setting": { useFloatingInbox: () => [false] },
    "./inbox": { FloatingInboxChip: "FloatingInboxChip" },
  });
  const render = () => {
    react.begin();
    return AttentionPill({ currentChat: "/other#3", visibleChat });
  };
  try {
    render();
    await new Promise((resolve) => setImmediate(resolve));
    let tree = render();
    assert.equal(tree.props.accessibilityLabel, "Fix toolbar needs attention. Open the Chat.");
    assert.equal(tree.props.style({ pressed: false })[0].top, 111, "the phone pill stays below header controls");
    tree.props.onPress();
    assert.deepEqual({ ...opened[0].params }, { projectPath: "/other", hostId: "test-host", id: "4" });
    // A different client forces a refresh without waiting for the poll timer.
    keys = ["/other#4", "/other#5"];
    session.client = { ...client };
    render();
    await new Promise((resolve) => setImmediate(resolve));
    tree = render();
    assert.equal(tree.props.label, "2 Chats need attention. Choose a Chat.");
    assert.deepEqual(
      Array.from(tree.props.sections[0].items, (item) => item.title),
      ["Fix toolbar", "Review changes"],
    );
    tree.props.onSelect("/other#5");
    assert.equal(opened[1].params.id, "5");
    session.snapshot = {
      project: {
        ...session.snapshot.project,
        state: {
          ...session.snapshot.project.state,
          sessions: { ...session.snapshot.project.state.sessions, 4: { id: 4, title: "Renamed toolbar Chat" } },
        },
      },
    };
    visibleChat = "/other#5";
    tree = render();
    assert.equal(
      tree.props.accessibilityLabel,
      "Renamed toolbar Chat needs attention. Open the Chat.",
      "a visible beside Chat is excluded and live renames render immediately",
    );
    visibleChat = "/other#4";
    tree = render();
    assert.equal(tree.props.accessibilityLabel, "Review changes needs attention. Open the Chat.");
  } finally {
    react.cleanup();
  }
});

test("Add computer can remove the public fallback before pairing a pasted invitation", async () => {
  const pairing = require("@milagre/shared/pairing-link");
  const identity = { hostId: "h".repeat(22), key: "k".repeat(43) };
  const direct = ["ws://192.168.1.20:8798", "ws://100.107.136.115:8798"];
  const invitation = `milagre://pair?relay=wss%3A%2F%2Frelay.milagre.cloud&host=${identity.hostId}&key=${identity.key}&token=${"a".repeat(64)}&direct=${encodeURIComponent(JSON.stringify(direct))}`;
  const host = hookHost();
  const connected = [];
  const { default: AddComputer } = load("app/add-computer.tsx", {
    react: host,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { absoluteFill: {} }, Linking: {} },
    "expo-router": { Stack: { Screen: "Screen" }, router: { dismissAll() {}, replace() {}, back() {} } },
    "expo-camera": { CameraView: "CameraView", useCameraPermissions: () => [{ granted: false }, () => {}] },
    "expo-clipboard": { getStringAsync: async () => invitation },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "@milagre/shared/site-links": require("@milagre/shared/site-links"),
    "@milagre/shared/pairing-link": pairing,
    "../pairing": pairing,
    "../session": {
      useSession: () => ({
        connect: async (value) => {
          connected.push(value);
          return false;
        },
      }),
    },
    "../icons": { Icon: "Icon" },
    "../settings-list": { Group: "Group", Row: "Row" },
    "../ui": {
      CircleButton: "CircleButton",
      ErrorNotice: "ErrorNotice",
      Field: "Field",
      PageScroll: "PageScroll",
      PillButton: "PillButton",
      RowCheckbox: "RowCheckbox",
      useStyles: () => ({}),
    },
  });
  const render = () => {
    host.begin();
    return AddComputer();
  };
  find(render(), (node) => node.props.title === "LAN or Tailscale only").props.onPress();
  find(render(), (node) => node.type === "Pressable" && texts(node).includes("Enter address and token")).props.onPress();
  assert.match(
    find(render(), (node) => node.type === "ErrorNotice").props.message,
    /For private pairing, scan or paste/,
    "manual HTTPS entry cannot bypass private mode",
  );
  find(render(), (node) => node.type === "Pressable" && texts(node).includes("Paste pairing link")).props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connected.length, 1);
  assert.equal(connected[0].relay.url, direct[0]);
  assert.deepEqual(Array.from(connected[0].relay.direct), direct);
  assert.equal(connected[0].relay.key, identity.key);
});

test("phone changes choose a comparison branch and keep its base when opening a diff; commit details expand", () => {
  const react = hookHost();
  const calls = [];
  const copied = [];
  let picker;
  let deleted = false;
  let unrelated = false;
  let phoneClient = {};
  const file = { path: "current.txt", status: "added", added: 2, removed: 0, binary: false };
  const commit = {
    sha: "a".repeat(40),
    author: "Maria",
    email: "maria@example.com",
    date: "2026-10-28T10:00:00Z",
    message: "Current work\n\nDetailed explanation",
    files: 1,
    added: 2,
    removed: 0,
  };
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-clipboard": {
      setStringAsync: async (sha) => {
        copied.push(sha);
        return true;
      },
    },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/git-diff": require("../packages/shared/src/git-diff.ts"),
    "@milagre/shared/diff-tree": { buildDiffTree: (files) => files },
    "./choice-store": { showChoiceSheet: (request) => (picker = request) },
    "./display-clock": { useScreenActive: () => true },
    "./use-rpc": {
      useRpc: (_client, method, [request]) => {
        calls.push({ method, request });
        const base = request.base === "refs/heads/parent" ? "parent" : "main";
        return {
          data:
            method === "git:history"
              ? {
                  isRepo: true,
                  branch: "current",
                  base,
                  total: 1,
                  suggested: "refs/heads/parent",
                  projectDefault: { name: "main", ref: "refs/heads/main" },
                  comparisonRef: request.base === "refs/heads/parent" ? "refs/heads/parent" : "refs/heads/main",
                  message: unrelated && request.base === "refs/heads/parent" ? "This branch shares no history with parent." : undefined,
                  automatic: { name: "main", ref: "refs/heads/main", reason: "the recorded base" },
                  branchesVersion: "v1",
                  baseMissing: deleted && request.base === "refs/heads/parent",
                  ...(request.branchesVersion === "v1"
                    ? {}
                    : {
                        branches: [
                          { ref: "refs/heads/parent", name: "parent" },
                          { ref: "refs/heads/current", name: "current" },
                          { ref: "refs/remotes/origin/main", name: "origin/main" },
                        ].filter((branch) => !deleted || branch.ref !== "refs/heads/parent"),
                      }),
                  commits: request.limit ? [commit] : [],
                  hasMore: false,
                }
              : { isRepo: true, base: request.mode === "committed" ? base : null, files: request.mode === "committed" ? [file] : [] },
          error: "",
          refresh() {},
        };
      },
    },
    "./icons": { Icon: "Icon" },
    "./diff-ui": { Counts: "Counts", StatusBox: "StatusBox" },
    "./ui": { ...uiHooks, ErrorNotice: "ErrorNotice" },
    "./theme": themeHooks,
  };
  const { ChangeSections, CommitCard } = load("change-tree.tsx", modules, "\nexport { CommitCard };");
  const opened = [];
  const render = () => {
    react.begin();
    return ChangeSections({ client: phoneClient, cwd: "/worktree", base: "main", onOpen: (...args) => opened.push(args) });
  };
  let tree = render();
  find(tree, (node) => node.props?.accessibilityLabel === "Comparison branch").props.onPress();
  assert.ok(picker.items.some((item) => item.id === "refs/heads/parent" && item.section === "Suggested"));
  assert.ok(picker.items.some((item) => item.id === "refs/heads/current" && item.disabled && item.subtitle === "current"));
  assert.ok(picker.items.some((item) => item.id === "refs/remotes/origin/main" && item.section === "Remote · origin"));
  assert.equal(picker.items[0].subtitle, "main, the recorded base");
  picker.onSelect("refs/heads/parent");
  tree = render();
  assert.equal(calls.findLast((call) => call.method === "git:diff-files" && call.request.mode === "committed").request.base, "refs/heads/parent");
  find(tree, (node) => node.type?.name === "ChangeTree").props.onOpen(file);
  assert.deepEqual(opened[0], [file, "committed", "refs/heads/parent"]);
  find(tree, (node) => node.props?.accessibilityLabel === "Commits").props.onPress();
  tree = render();
  assert.ok(find(tree, (node) => node.type === CommitCard));
  assert.equal(calls.findLast((call) => call.method === "git:history").request.limit, 30);
  const cardReact = hookHost();
  const card = load("change-tree.tsx", { ...modules, react: cardReact }, "\nexport { CommitCard };").CommitCard;
  cardReact.begin();
  let details = card({ commit });
  find(details, (node) => node.type === "Pressable").props.onPress();
  cardReact.begin();
  details = card({ commit });
  assert.ok(textOf(details).includes("maria@example.com"));
  assert.ok(textOf(details).includes("Detailed explanation"));
  find(details, (node) => node.props?.accessibilityLabel === "Copy SHA").props.onPress();
  assert.deepEqual(copied, [commit.sha]);
  assert.ok(find(details, (node) => node.type === "Counts" && node.props.added === 2));
  unrelated = true;
  tree = render();
  assert.ok(textOf(tree).includes("shares no history"));
  find(tree, (node) => node.type === "Pressable" && textOf(node) === "Compare with main instead").props.onPress();
  render();
  assert.equal(calls.findLast((call) => call.method === "git:history").request.base, "refs/heads/main");
  picker.onSelect("refs/heads/parent");
  deleted = true;
  render();
  tree = render();
  assert.equal(calls.findLast((call) => call.method === "git:history").request.base, "main");
  assert.ok(textOf(tree).includes("parent no longer exists. Showing changes since main."));
  find(tree, (node) => node.props?.accessibilityLabel === "Dismiss missing branch notice").props.onPress();
  assert.equal(textOf(render()).includes("no longer exists"), false);
  assert.equal(calls.findLast((call) => call.method === "git:history").request.branchesVersion, "v1");
  find(render(), (node) => node.props?.accessibilityLabel === "Comparison branch").props.onPress();
  assert.ok(
    picker.items.some((item) => item.id === "refs/heads/parent"),
    "omitted catalogues retain picker choices",
  );
  phoneClient = {};
  render();
  assert.equal(
    calls.findLast((call) => call.method === "git:history").request.branchesVersion,
    undefined,
    "another host never borrows the previous host's catalogue token",
  );
  for (const reason of ["timeout", "tooLarge"]) {
    const limited = { ...commit, files: null, added: null, removed: null, statsUnavailable: reason };
    const limitedReact = hookHost();
    const renderCard = load("change-tree.tsx", { ...modules, react: limitedReact }, "\nexport { CommitCard };\n").CommitCard;
    limitedReact.begin();
    let row = renderCard({ commit: limited });
    assert.ok(textOf(row).includes("Totals unavailable"));
    assert.equal(
      find(row, (node) => node.type === "Counts"),
      undefined,
      "unavailable totals never render as zero",
    );
    find(row, (node) => node.type === "Pressable").props.onPress();
    limitedReact.begin();
    row = renderCard({ commit: limited });
    assert.ok(textOf(row).includes("Detailed explanation") && textOf(row).includes("maria@example.com"));
    assert.ok(textOf(row).includes("Retrying automatically"));
  }
});

test("phone history retains metadata and commits during pagination, but never across repositories or clients", async () => {
  const react = hookHost({ effects: true });
  const pending = [];
  let client = {
    call: () => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  };
  const { useRpc } = load("use-rpc.ts", {
    react,
    "@milagre/shared/refresh-loop": {
      startRefreshLoop: (options) => {
        void options.refresh();
        return () => {};
      },
    },
  });
  let cwd = "/project",
    limit = 0;
  const render = () => {
    react.begin();
    const result = useRpc(client, "git:history", [{ cwd, base: "main", limit }], true, JSON.stringify([cwd, "main"]));
    react.flush();
    return result;
  };
  render();
  pending.shift().resolve({ branch: "feature", branches: ["main"], commits: [] });
  await settle();
  limit = 30;
  assert.equal(render().data.branch, "feature", "metadata stays while the initial commits load");
  pending.shift().resolve({ branch: "feature", branches: ["main"], commits: ["first"] });
  await settle();
  limit = 60;
  assert.deepEqual(render().data.commits, ["first"], "pagination retains the loaded list");
  pending.shift().reject(new Error("Connection dropped"));
  await settle();
  assert.deepEqual(render().data.commits, ["first"], "a failed page keeps the prior list for retry");
  assert.equal(render().error, "Connection dropped");
  limit = 90;
  render();
  const old = pending.shift();
  cwd = "/another-project";
  assert.equal(render().data, null, "a different repository never borrows the old result");
  old.resolve({ branch: "old", commits: ["wrong"] });
  await settle();
  assert.equal(render().data, null, "late answers for the prior repository are discarded");
  pending.shift().resolve({ branch: "new", commits: ["new"] });
  await settle();
  assert.equal(render().data.branch, "new");
  client = { call: () => new Promise(() => {}) };
  assert.equal(render().data, null, "another computer with the same path cannot reuse this computer's result");
  react.unmount();
});

test("older hosts without git history keep phone file diffs usable; network errors still offer retry", () => {
  const react = hookHost();
  let historyError = "Command is not available from mobile";
  const { ChangeSections } = load("change-tree.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-clipboard": {},
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": {},
    "@milagre/shared/git-diff": require("../packages/shared/src/git-diff.ts"),
    "@milagre/shared/diff-tree": { buildDiffTree: (files) => files },
    "./choice-store": { showChoiceSheet() {} },
    "./display-clock": { useScreenActive: () => true },
    "./use-rpc": {
      useRpc: (_client, method) =>
        method === "git:history"
          ? { data: null, error: historyError, refresh() {} }
          : { data: { isRepo: true, base: "main", files: [{ path: "changed.txt", added: 1, removed: 0 }] }, error: "", refresh() {} },
    },
    "./icons": { Icon: "Icon" },
    "./diff-ui": { Counts: "Counts", StatusBox: "StatusBox" },
    "./ui": { ...uiHooks, ErrorNotice: "ErrorNotice" },
    "./theme": themeHooks,
  });
  const opened = [];
  const render = () => {
    react.begin();
    return ChangeSections({ client: {}, cwd: "/project", onOpen: (...args) => opened.push(args) });
  };
  for (const message of ["Command is not available from mobile", "Unknown command: git:history"]) {
    historyError = message;
    const tree = render();
    assert.equal(
      find(tree, (node) => node.props?.accessibilityLabel === "Comparison branch"),
      undefined,
    );
    assert.equal(
      find(tree, (node) => node.type === "ErrorNotice"),
      undefined,
    );
    const files = find(tree, (node) => node.type?.name === "ChangeTree");
    assert.ok(files, "ordinary files remain visible on an older host");
    files.props.onOpen({ path: "changed.txt" });
  }
  assert.equal(opened.length, 2);
  historyError = "Connection dropped";
  const retry = find(render(), (node) => node.type === "ErrorNotice");
  assert.equal(retry.props.message, historyError);
  assert.equal(typeof retry.props.retry, "function");
});

test("Chat header promotes only Browser and PR, with working actions and no duplicate overflow entries", () => {
  let opened = 0;
  let shortcutOptions;
  const shortcut = { accessibilityLabel: "Browser, 1 page in this Chat", onPress: () => opened++ };
  const screen = chatHost({
    browserShortcut: (options) => {
      shortcutOptions = options;
      return shortcut;
    },
    routines: [heartbeatFor("/p#7")],
  });
  screen.panels.openInPanel = () => {};
  screen.params.id = "7";
  screen.session.snapshot.project.state.sessions[7] = { id: 7, worktree_id: 1 };
  globalThis.chatPullRequest = { number: 90, state: "OPEN", url: "https://github.com/o/r/pull/90" };
  globalThis.openedPullRequests = [];
  try {
    const tree = screen.render();
    assert.equal(shortcutOptions.openInPanel, screen.panels.openInPanel, "the header passes its own panel opener, outside the child context provider");
    const group = find(tree, (node) => node.type?.name === "HeaderActionGroup");
    assert.ok(group, "all promoted actions share one glass capsule");
    const buttons = allNodes(group, (node) => node.type?.name === "HeaderAction" && node.props.onPress);
    assert.deepEqual(
      buttons.map((node) => node.props.label),
      [shortcut.accessibilityLabel, "Pull request #90"],
    );
    buttons.find((node) => node.props.label === shortcut.accessibilityLabel).props.onPress();
    buttons.find((node) => node.props.label === "Pull request #90").props.onPress();
    assert.equal(opened, 1);
    assert.equal(globalThis.openedPullRequests.length, 1);
    const menu = new Set(chatMenuEntries(tree).map((node) => node.props.children));
    assert.ok(menu.has("Heartbeat"));
    assert.ok(menu.has("View changes"));
    assert.ok(!menu.has("Pull request #90"));
  } finally {
    delete globalThis.chatPullRequest;
    delete globalThis.openedPullRequests;
  }
});

test("an offline phone send saves text, destination and attachment bytes before clearing the composer", async () => {
  const { createOutbox } = require("@milagre/shared/outbox");
  let saved;
  const box = createOutbox({
    storage: {
      read: async () => null,
      write: async (data) => {
        saved = structuredClone(data);
      },
    },
    available: () => false,
    deliver: async () => assert.fail("offline delivery"),
  });
  const host = chatHost({ localOutbox: box });
  host.session.error = "Computer disconnected";
  host.session.attachments["/p#new:1"] = [
    { id: "photo", name: "Photo.jpg", uri: "temporary.jpg", image: { id: "photo", name: "Photo.jpg", dataUrl: "data:image/jpeg;base64,aW1n" } },
  ];
  host.render();
  host.send();
  await settle();
  await settle();
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].computerId, host.session.client.url);
  assert.equal(saved.items[0].owner, "/p");
  assert.equal(saved.items[0].request.body, "first message");
  assert.equal(saved.items[0].attachments[0].base64, "aW1n");
  assert.equal(host.field().value, "");
  assert.equal(host.session.attachments["/p#new:1"].length, 0);
  assert.equal(host.calls.filter((call) => call.method === "chat:send").length, 0);
  // The message waits in this Chat's composer tray, which says the computer is offline.
  assert.equal(find(host.render(), (node) => node.type === "OfflineTray")?.props.target.offline, true);
});

test("an offline queue storage failure keeps the phone draft and attachments", async () => {
  const box = {
    getSnapshot: () => ({ loaded: true }),
    enqueue: async () => {
      throw new Error("Disk full");
    },
    flush: async () => {},
  };
  const host = chatHost({ localOutbox: box });
  host.session.error = "Computer disconnected";
  host.session.attachments["/p#new:1"] = [{ id: "file", name: "notes.txt", uri: "temp", base64: "YWJj" }];
  host.render();
  host.send();
  await settle();
  assert.equal(host.field().value, "first message");
  assert.equal(host.session.attachments["/p#new:1"].length, 1);
  assert.match(JSON.stringify(host.render()), /Disk full/);
});

test("a send after restart waits for the saved queue before choosing direct delivery", async () => {
  const { createOutbox } = require("@milagre/shared/outbox");
  const disk = deferred();
  const box = createOutbox({ storage: { read: () => disk.promise, write: async () => {} }, available: () => false, deliver: async () => assert.fail() });
  const host = chatHost({ localOutbox: box });
  host.render();
  host.send();
  await settle();
  assert.equal(host.calls.filter((call) => call.method === "chat:send").length, 0);
  disk.resolve({
    version: 1,
    revision: 1,
    items: [
      {
        id: "older",
        computerId: host.session.client.url,
        computerName: "Computer",
        owner: "/p",
        conversation: "older",
        request: { projectPath: "/p", sessionId: null, worktreeId: 1, body: "older message", images: [], files: [] },
        attachments: [],
        status: "queued",
        phase: "ready",
        createdAt: 1,
        error: "",
      },
    ],
  });
  await settle();
  await settle();
  assert.deepEqual(
    box.getSnapshot().items.map((item) => item.request.body),
    ["older message", "first message"],
  );
  assert.equal(host.calls.filter((call) => call.method === "chat:send").length, 0);
});

test("browser preference defaults on, persists changes, ignores a late read and reports failed saves", async () => {
  let read;
  const saves = [];
  let fail = false;
  const { useInternalBrowser } = load("browser-setting.ts", {
    react: { useSyncExternalStore: (_subscribe, get) => get() },
    "./hosts-native": {
      readInternalBrowser: () =>
        new Promise((resolve) => {
          read = resolve;
        }),
      saveInternalBrowser: async (on) => {
        saves.push(on);
        if (fail) throw new Error("storage failed");
      },
    },
  });
  assert.equal(useInternalBrowser()[0], true);
  await useInternalBrowser()[1](false);
  read(true);
  await settle();
  assert.equal(useInternalBrowser()[0], false, "a slow initial read cannot undo the user's choice");
  fail = true;
  await assert.rejects(useInternalBrowser()[1](true), /storage failed/);
  assert.equal(useInternalBrowser()[0], false);
  fail = false;
  await useInternalBrowser()[1](true);
  assert.equal(useInternalBrowser()[0], true);
  assert.deepEqual(saves, [false, true, true]);
});

test("Chat web links use the iPad panel or phone sheet, and respect this device's external preference", () => {
  for (const docked of [false, true]) {
    const chat = chatHost({ screenWidth: docked ? 1194 : 402 });
    const tabs = [];
    chat.panels.openInPanel = docked ? (tab) => tabs.push(tab) : null;
    chat.params.id = "2";
    const link = () => find(chat.render(), (node) => node.type === "ChatLinkProvider").props.openLink;
    try {
      assert.equal(link()("http://localhost:5173"), true);
      if (docked) {
        assert.equal(tabs[0].kind, "browser");
        assert.equal(tabs[0].target.url, "http://localhost:5173");
        assert.equal((chat.router.pushed ?? []).length, 0);
      } else assert.equal(chat.router.pushed.at(-1).pathname, "/browser-sheet");
      globalThis.internalBrowser = false;
      const before = (chat.router.pushed ?? []).length + tabs.length;
      assert.equal(link()("https://example.com"), false, "Markdown delegates to Linking when the Chat declines the link");
      assert.equal((chat.router.pushed ?? []).length + tabs.length, before);
    } finally {
      delete globalThis.internalBrowser;
    }
  }
});

test("mobile Ports obey the external preference and explain a loopback-only server", async (t) => {
  const urls = [];
  const ports = [
    { port: 5173, pid: 22, command: "node", address: "*" },
    { port: 3000, pid: 23, command: "node", address: "127.0.0.1" },
  ];
  const h = simulatorHost({ url: "mac", call: async () => ({ chatId: "/p#7", ports }) }, "ports.tsx", {
    native: {
      Linking: {
        openURL: async (url) => {
          urls.push(url);
        },
      },
    },
    modules: {
      "./browser-setting": { useInternalBrowser: () => [false] },
      "./routes-native": { useReachableHost: () => "192.168.1.2" },
    },
  });
  t.after(() => h.cleanup());
  const render = () => h.render("PortsSheet", { hostId: "mac", chatId: "/p#7" });
  render();
  await settle();
  find(render(), (node) => node.props.accessibilityLabel === "Open http://localhost:5173").props.onPress();
  assert.deepEqual(urls, ["http://192.168.1.2:5173"]);
  find(render(), (node) => node.props.accessibilityLabel === "Open http://localhost:3000").props.onPress();
  assert.equal(urls.length, 1);
  assert.match(JSON.stringify(render()), /Enable Open links in Milagre in Settings > Browser/);
});

test("the mic is a 44 point target and the take's capsule can discard it or stop it", () => {
  const { VoiceMicButton, DictationCapsule, MIC_SIZE, CAPSULE_WIDTH, CAPSULE_INSET } = load("voice-mic-button.tsx", {
    react: { useEffect() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", View: "View" },
    "react-native-reanimated": {
      default: { View: "AnimatedView" },
      cancelAnimation() {},
      Easing: { linear() {} },
      ReduceMotion: { System: "system" },
      useAnimatedStyle: (callback) => callback(),
      useSharedValue: (initial) => ({ value: initial, get: () => initial, set() {} }),
      withRepeat: (value) => value,
      withTiming: (value) => value,
    },
    "@hugeicons/core-free-icons": { Cancel01Icon: "Cancel01Icon", Mic01Icon: "Mic01Icon" },
    "@milagre/shared/themes": { withAlpha: (color) => color },
    "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
    "./icons": { Icon: "Icon" },
    "./theme": { useTheme: () => ({ colors: fakePalette, motionScale: 1 }) },
  });
  assert.equal(MIC_SIZE, 44);
  let starts = 0;
  const idle = VoiceMicButton({ onPress: () => starts++ });
  const targetStyle = idle.props.style({ pressed: false });
  assert.equal(targetStyle.width, 44);
  assert.equal(targetStyle.height, 44);
  assert.equal(idle.props.accessibilityLabel, "Dictate");
  idle.props.onPress();
  assert.equal(starts, 1);

  let discards = 0;
  let stops = 0;
  const recording = DictationCapsule({ phase: "recording", level: { value: 1 }, onDiscard: () => discards++, onStop: () => stops++ });
  // The field is only 44 tall with one line of text, so the capsule has to fit inside it with room at both edges.
  const capsuleHeight = recording.props.style.height;
  const fieldHeight = 44;
  const top = fieldHeight - CAPSULE_INSET.bottom - capsuleHeight;
  assert.ok(top >= 4, `the capsule leaves ${top}px above it inside a one-line field, not overhanging its background`);
  assert.ok(capsuleHeight + CAPSULE_INSET.bottom <= fieldHeight, "and never reaches past the field's own height");
  const buttons = [];
  find(recording, (node) => {
    if (node.props?.accessibilityRole === "button") buttons.push(node);
    return false;
  });
  assert.deepEqual(
    buttons.map((node) => node.props.accessibilityLabel),
    ["Discard dictation", "Stop dictation"],
  );
  // Each visual is 28 points with hitSlop 8 on every side, so the target is 44.
  for (const button of buttons) {
    const style = button.props.style({ pressed: false });
    assert.equal(style.width + button.props.hitSlop * 2, 44);
    assert.equal(style.height + button.props.hitSlop * 2, 44);
  }
  buttons[0].props.onPress();
  buttons[1].props.onPress();
  assert.equal(discards, 1);
  assert.equal(stops, 1);

  // The halo swells with the voice; at full level it must still sit inside the capsule's own background.
  // The halo is the only layer with an animated style: its base size and the scale the shared level drives.
  const haloNode = find(recording, (node) => Array.isArray(node.props?.style) && node.props.style[0]?.position === "absolute");
  const haloBase = haloNode.props.style[0].height;
  const haloScale = haloNode.props.style[1].transform[0].scale;
  assert.ok(haloBase * haloScale <= capsuleHeight, `a full-voice halo is ${haloBase * haloScale}px inside a ${capsuleHeight}px capsule`);

  const preparing = DictationCapsule({ phase: "preparing", level: { value: 0 }, onDiscard() {}, onStop() {} });
  assert.equal(preparing.props.style.height, capsuleHeight, "the capsule is the same width and height in every phase");
  assert.ok(
    find(preparing, (node) => node.props?.accessibilityRole === "progressbar" && node.props.accessibilityLabel === "Preparing the microphone"),
    "no stop before there is anything to stop",
  );
  assert.ok(!find(preparing, (node) => node.props?.accessibilityLabel === "Stop dictation"));
  const finishing = DictationCapsule({ phase: "transcribing", level: { value: 0 }, onDiscard() {}, onStop() {} });
  assert.ok(find(finishing, (node) => node.props?.accessibilityLabel === "Finishing the last words"));
  assert.ok(
    find(finishing, (node) => node.props?.accessibilityLabel === "Discard dictation"),
    "a take can still be thrown away while it finishes",
  );
  assert.equal(CAPSULE_WIDTH, 72);
});

test("phone dictation writes into the field as it hears, tints only the revisable tail, and discards just the take", () => {
  const react = hookHost();
  react.useEffect = react.effect;
  let draft = "fix";
  let action = "paste";
  let deliver;
  let blocked = false;
  let partial = { text: "", settled: 0 };
  let phase = "idle";
  let cancels = 0;
  let starts = 0;
  let stops = 0;
  const sent = [];
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Linking: { openSettings() {} }, Pressable: "Pressable", Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("@milagre/shared/prompt-skills"),
    "./use-rpc": { useRpc: () => ({ data: null }) },
    "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
    "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
    "./chat-display-setting": { useDictationAction: () => [action] },
    "./voice-dictation-hook": {
      useVoiceDictation: (callback) => {
        deliver = callback;
        return {
          available: true,
          phase,
          error: null,
          partial,
          download: null,
          level: { value: 0 },
          start() {
            starts++;
          },
          stop() {
            stops++;
          },
          cancel() {
            cancels++;
          },
          dismiss() {},
        };
      },
    },
  });
  const render = () => {
    react.begin();
    const renderedDraft = draft;
    const tree = PromptField({
      client: { call: async () => [] },
      projectPath: "/project",
      draft,
      onChangeText: (value) => {
        draft = value;
      },
      onSubmit: () => {
        if (blocked) return;
        sent.push(renderedDraft);
        draft = "";
      },
    });
    react.flush();
    return tree;
  };
  const hear = (text) => deliver(text, { draft, selection: { start: draft.length, end: draft.length } });
  // The words in the field: every run of the attributed text, with whether it is the provisional tail.
  const runs = (tree) => {
    const field = find(tree, (node) => node.type === "Field");
    const out = [];
    find(field, (node) => {
      if (node.type === "Text" && typeof node.props.children === "string") out.push([node.props.children, node.props.style?.color === fakePalette.ink2]);
      return false;
    });
    return out;
  };
  render();
  // Tapping the mic opens the take; the draft is untouched until the first words arrive.
  find(render(), (node) => node.type === "VoiceMicButton").props.onPress();
  assert.equal(starts, 1);
  assert.equal(draft, "fix");
  phase = "preparing";
  const preparing = render();
  assert.ok(find(preparing, (node) => node.type === "Text" && node.props.children === "Preparing the microphone\u2026"));
  assert.ok(
    find(preparing, (node) => node.type === "DictationCapsule"),
    "the mic grew into the capsule, in its own place",
  );
  assert.ok(!find(preparing, (node) => node.type === "VoiceMicButton"));

  phase = "recording";
  partial = { text: "this bit", settled: 0 };
  render();
  assert.equal(draft, "fix this bit", "the words land in the field itself, not in a preview of their own");
  assert.deepEqual(
    runs(render()),
    [
      ["fix ", false],
      ["this bit", true],
    ],
    "nothing has settled, so the whole take is the tail",
  );

  partial = { text: "this bit here", settled: "this bit ".length };
  render();
  assert.equal(draft, "fix this bit here");
  assert.deepEqual(
    runs(render()),
    [
      ["fix this bit ", false],
      ["here", true],
    ],
    "settled words read like anything typed",
  );

  // Stop: the final transcript settles in place and the tint goes, with the words where they already were.
  phase = "transcribing";
  find(render(), (node) => node.type === "DictationCapsule").props.onStop();
  assert.equal(stops, 1);
  partial = { text: "", settled: 0 };
  phase = "idle";
  hear("this bit here");
  render();
  assert.equal(draft, "fix this bit here", "finishing changes nothing on screen");
  assert.deepEqual(runs(render()), [["fix this bit here", false]]);
  assert.deepEqual(sent, [], "paste is the default: the message waits for the user");

  // Discard takes out only the take, and puts back the draft and the caret it replaced.
  find(render(), (node) => node.type === "VoiceMicButton").props.onPress();
  phase = "recording";
  partial = { text: "throw this away", settled: 0 };
  render();
  assert.equal(draft, "fix this bit here throw this away");
  find(render(), (node) => node.type === "DictationCapsule").props.onDiscard();
  render();
  assert.equal(cancels, 1);
  assert.equal(draft, "fix this bit here", "the draft the user had is back, whole");
  phase = "idle";
  partial = { text: "", settled: 0 };
  render();

  // Send now: one message, once the parent has the final draft.
  action = "send";
  find(render(), (node) => node.type === "VoiceMicButton").props.onPress();
  phase = "recording";
  render();
  phase = "idle";
  hear("please");
  assert.deepEqual(sent, [], "wait for the updated parent render");
  render();
  render();
  assert.deepEqual(sent, ["fix this bit here please"]);
  assert.equal(draft, "");
  hear("  ");
  render();
  assert.equal(sent.length, 1);

  blocked = true;
  find(render(), (node) => node.type === "VoiceMicButton").props.onPress();
  phase = "recording";
  render();
  phase = "idle";
  hear("keep this");
  render();
  assert.equal(draft, "keep this");
  assert.equal(sent.length, 1);
  blocked = false;
  render();
  assert.equal(sent.length, 1, "unblocking does not send a stale transcript");
  react.cleanup();
});

test("a take's error is a bubble over the mic, not a line that moves the words", () => {
  const react = hookHost();
  react.useEffect = react.effect;
  let error = null;
  let dismissed = 0;
  const { PromptField } = load("prompt-field.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Linking: { openSettings() {} }, Pressable: "Pressable", Text: "Text", View: "View" },
    "react-native-reanimated": reanimatedStub,
    "@milagre/shared/prompt-skills": require("@milagre/shared/prompt-skills"),
    "./use-rpc": { useRpc: () => ({ data: null }) },
    "./use-image-paste": { useImagePaste: () => ({ onFocus() {} }) },
    "./ui": { Field: "Field", ListRow: "ListRow", PageScroll: "PageScroll" },
    "./chat-display-setting": { useDictationAction: () => ["paste"] },
    "./voice-dictation-hook": {
      useVoiceDictation: () => ({
        available: true,
        phase: "idle",
        error,
        partial: { text: "", settled: 0 },
        download: null,
        level: { value: 0 },
        start() {},
        stop() {},
        cancel() {},
        dismiss() {
          dismissed++;
        },
      }),
    },
  });
  const render = () => {
    react.begin();
    const tree = PromptField({ client: { call: async () => [] }, projectPath: "/project", draft: "keep this", onChangeText() {} });
    react.flush();
    return tree;
  };
  const quiet = render();
  assert.ok(!find(quiet, (node) => node.type === "DictationNotice"));

  error = { kind: "no-speech", message: "I didn't hear you. Try again." };
  const heard = render();
  const notice = find(heard, (node) => node.type === "DictationNotice");
  assert.ok(notice, "the message is the bubble the mic has always used");
  assert.equal(notice.props.error.message, "I didn't hear you. Try again.");
  assert.ok(notice.props.micSize > 0, "the bubble is told the mic's size so its arrow points at it");
  // The bubble floats out of the mic's own wrapper, so it can never become a row that pushes the draft.
  const wrapper = find(heard, (node) => {
    const children = [node.props?.children].flat(Infinity).filter(Boolean);
    return children.some((child) => child?.type === "DictationNotice") && children.some((child) => child?.type === "VoiceMicButton");
  });
  assert.ok(wrapper, "it sits in the mic's wrapper, beside the mic itself");
  assert.equal(wrapper.props.style.position, "absolute", "which is pinned over the field, not laid out in the column");
  notice.props.onDismiss();
  assert.equal(dismissed, 1);

  error = { kind: "permission", message: "Allow the microphone to dictate." };
  const refused = find(render(), (node) => node.type === "DictationNotice");
  assert.equal(typeof refused.props.onOpenSettings, "function", "a refused microphone keeps its way to Settings");
  react.cleanup();
});

test("phone checkboxes expose their state and let the entire labeled row toggle", () => {
  let toggles = 0;
  const { Checkbox } = load("primitives/checkbox.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@hugeicons/core-free-icons": { Tick02Icon: "tick" },
    "../icons": { Icon: "Icon" },
  });
  const tree = Checkbox({ label: "Keep awake", selected: true, onPress: () => toggles++ });
  assert.equal(tree.props.accessibilityRole, "checkbox");
  assert.equal(tree.props.accessibilityState.checked, true);
  assert.equal(tree.props.style({ pressed: false }).minHeight, 44);
  tree.props.onPress();
  assert.equal(toggles, 1);
  const disabled = Checkbox({ label: "Keep awake", selected: false, disabled: true, onPress() {} });
  assert.equal(disabled.props.disabled, true);
  assert.equal(disabled.props.accessibilityState.disabled, true);
});

test("phone dictation language opens a checked list and saves the chosen language", () => {
  let language = "auto";
  const { default: Screen } = load("app/(settings)/dictation-language.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: "ios" }, View: "View", Pressable: "Pressable", Text: "Text" },
    "expo-router": { Stack: { Screen: "Screen" } },
    "@milagre/shared/dictation": require("@milagre/shared/dictation"),
    "../chat-display-setting": {
      useDictationLanguage: () => [
        language,
        (next) => {
          language = next;
        },
      ],
    },
    "@hugeicons/core-free-icons": { Tick02Icon: "tick" },
    "../icons": { Icon: "Icon" },
    "../ui": { PageScroll: "PageScroll" },
  });
  const row = (name) => find(Screen(), (node) => node.props.title === name);
  assert.equal(row("Detect automatically (experimental)").props.selected, true);
  row("Portuguese").props.onPress();
  assert.equal(language, "pt");
  assert.equal(row("Portuguese").props.selected, true);
  assert.equal(row("Detect automatically (experimental)").props.selected, false);
  row("Detect automatically (experimental)").props.onPress();
  assert.equal(language, "auto");
  assert.equal(row("Detect automatically (experimental)").props.selected, true);
});

test("iPhone automatic detection routes to Whisper and individual languages still use Apple", async () => {
  const calls = [];
  const native = {
    isAvailable: () => true,
    prepare: async (language) => calls.push(["apple", language]),
  };
  const whisper = {
    prepare: async (language) => calls.push(["whisper", language]),
    transcribe: async (_audio, options) => {
      calls.push(["whisper-audio", options.language]);
      return "Olá, please review the code.";
    },
  };
  const { getTranscriber } = load("voice-transcription.ios.ts", {
    "react-native": { TurboModuleRegistry: { get: () => native } },
    "@react-native-ai/apple/src/NativeAppleTranscription": { default: native },
    "@milagre/shared/dictation": require("@milagre/shared/dictation"),
    "./voice-transcription-queue": { serializeTranscription: (work) => work() },
    "./voice-transcription-whisper": { getTranscriber: () => whisper },
  });
  const transcriber = getTranscriber();
  await transcriber.prepare("auto");
  assert.equal(await transcriber.transcribe(new ArrayBuffer(3200), { language: "auto", terms: [] }), "Olá, please review the code.");
  await transcriber.prepare("pt");
  await transcriber.prepare("en");
  assert.deepEqual(calls, [
    ["whisper", "auto"],
    ["whisper-audio", "auto"],
    ["apple", "pt-BR"],
    ["apple", "en-US"],
  ]);
});

test("older iPhones and iPads can use Whisper without an available Apple recognizer", async () => {
  const whisper = { prepare() {}, transcribe() {} };
  for (const apple of [
    null,
    { isAvailable: () => false },
    {
      isAvailable() {
        throw new Error("Unavailable");
      },
    },
  ]) {
    const { getTranscriber } = load("voice-transcription.ios.ts", {
      "react-native": { TurboModuleRegistry: { get: (name) => (name === "RNWhisper" ? {} : apple) } },
      "@react-native-ai/apple/src/NativeAppleTranscription": { default: apple },
      "@milagre/shared/dictation": require("@milagre/shared/dictation"),
      "./voice-transcription-queue": { serializeTranscription: (work) => work() },
      "./voice-transcription-whisper": { getTranscriber: () => whisper },
    });
    assert.equal(getTranscriber(), whisper);
  }
});

test("a build without Whisper still offers Apple languages and explains why auto detection is unavailable", async () => {
  const native = { isAvailable: () => true, prepare: async () => {} };
  const { getTranscriber } = load("voice-transcription.ios.ts", {
    "react-native": { TurboModuleRegistry: { get: (name) => (name === "RNWhisper" ? null : native) } },
    "@react-native-ai/apple/src/NativeAppleTranscription": { default: native },
    "@milagre/shared/dictation": require("@milagre/shared/dictation"),
    "./voice-transcription-queue": { serializeTranscription: (work) => work() },
    "./voice-transcription-whisper": {
      getTranscriber: () => {
        throw new Error("Must not load Whisper");
      },
    },
  });
  const transcriber = getTranscriber();
  await transcriber.prepare("pt");
  await assert.rejects(transcriber.prepare("auto"), /Choose a language or update Milagre/);
});

test("the phone awaits model installation and keeps the moved model for later dictation", async () => {
  const files = new Map();
  const shared = require("@milagre/shared/dictation");
  let directoryReady = false;
  let downloads = 0;
  let options;
  class Directory {
    uri = "file:///documents/whisper";
    get exists() {
      return directoryReady;
    }
    async create() {
      await Promise.resolve();
      directoryReady = true;
    }
  }
  class File {
    constructor(directory, name) {
      this.uri = `${directory.uri}/${name}`;
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return files.get(this.uri) ?? 0;
    }
    async delete() {
      await Promise.resolve();
      files.delete(this.uri);
    }
    async move(destination) {
      await Promise.resolve();
      assert.equal(this.exists, true, "cleanup must not race the async move");
      files.set(destination.uri, this.size);
      files.delete(this.uri);
      this.uri = destination.uri; // Expo updates the source object's URI after moving it.
    }
    static async downloadFileAsync(_url, destination) {
      assert.equal(directoryReady, true, "the destination directory must exist before downloading");
      downloads++;
      files.set(destination.uri, shared.WHISPER_MODELS.phone.size);
      return destination;
    }
  }
  const { getTranscriber } = load("voice-transcription-whisper.ts", {
    "expo-file-system": { Directory, File, Paths: { document: {} } },
    "@milagre/shared/dictation": shared,
    "./voice-transcription-queue": { serializeTranscription: (work) => work() },
    "whisper.rn/index": {
      initWhisper: async ({ filePath }) => {
        assert.equal(files.has(filePath), true, "the installed model survives cleanup");
        return {
          transcribeData: (_audio, opts) => {
            options = opts;
            return { promise: Promise.resolve({ result: "Olá, please review the code." }) };
          },
        };
      },
    },
  });
  const transcriber = getTranscriber();
  await transcriber.prepare("auto");
  await transcriber.prepare("auto");
  assert.equal(downloads, 1);
  const audio = new Int16Array(3200).fill(3000).buffer;
  assert.equal(await transcriber.transcribe(audio, { language: "auto", terms: ["Milagre"] }), "Olá, please review the code.");
  assert.equal(downloads, 1);
  assert.equal(options.language, "auto");
  assert.equal(options.translate, false);
  assert.match(options.prompt, /switch languages/);
});

test("secret form masks input, preserves bytes, clears drafts and declines without a summary", () => {
  const react = hookHost({ effects: true });
  let now = Date.now();
  const deadline = now + 300000;
  const { SecretQuestion } = load("secret-question.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable" },
    "./display-clock": { useDisplayNow: () => now, useScreenActive: () => true },
    "./design-tokens": require("../apps/mobile/src/design-tokens.ts"),
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_target, key) => key }),
    "./icons": { Icon: "Icon" },
    "./ui": { PillButton: "PillButton" },
  });
  const sent = [];
  const render = (busy = false) => {
    react.begin();
    return SecretQuestion({
      request: { requestId: "secret", questions: [{ question: "Token" }], secretRequest: { description: "For deployment", expiresAt: deadline } },
      busy,
      submit: (...args) => sent.push(args),
    });
  };
  let tree = render();
  let input = find(tree, (n) => n.type === "TextInput");
  assert.equal(input.props.secureTextEntry, true);
  assert.equal(find(tree, (n) => n.type === "Text" && String(n.props.children).includes("to enter")).props.children, "5:00 left to enter");
  find(tree, (n) => n.props?.accessibilityLabel === "Show secret").props.onPress();
  tree = render();
  assert.equal(find(tree, (n) => n.type === "TextInput").props.secureTextEntry, false);
  find(tree, (n) => n.props?.accessibilityLabel === "Hide secret").props.onPress();
  tree = render();
  assert.equal(input.props.autoCorrect, false);
  assert.equal(input.props.autoCapitalize, "none");
  assert.equal(find(tree, (n) => n.props?.title === "Save securely").props.disabled, true);
  input.props.onChangeText("  test-token  ");
  tree = render();
  find(tree, (n) => n.props?.title === "Save securely").props.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [[{ secret: ["  test-token  "] }, ""]]);
  tree = render(true);
  input = find(tree, (n) => n.type === "TextInput");
  assert.equal(input.props.value, "");
  assert.equal(input.props.editable, false);
  tree = render();
  find(tree, (n) => n.props?.title === "Decline").props.onPress();
  assert.deepEqual(sent.at(-1), [null, ""]);
  find(render(), (n) => n.type === "TextInput").props.onChangeText("unsent-draft");
  // The last minute switches the countdown to the attention tone.
  now = deadline - 30000;
  tree = render();
  assert.equal(find(tree, (n) => n.props?.accessibilityRole === "timer").props.children, "0:30 left to enter");
  assert.equal(find(tree, (n) => n.props?.accessibilityRole === "timer").props.style.color, fakePalette.orangeInk);
  now = deadline;
  tree = render();
  tree = render();
  assert.equal(find(tree, (n) => n.type === "TextInput").props.value, "");
  assert.equal(find(tree, (n) => n.type === "TextInput").props.editable, false);
  assert.equal(find(tree, (n) => n.props?.title === "Save securely").props.disabled, true);
  assert.ok(find(tree, (n) => n.type === "Text" && n.props.children === "Request expired"));
});

test("artifact feedback carries the comment and tab through phone and dock navigation", async () => {
  const page = { id: "page", title: "HTTP", format: "html", version: 1 };
  const comment = { id: "12345678", design: page, tab: { id: "headers", title: "Headers" }, text: "Explain caching", x: 0.2, y: 0.3 };
  for (const docked of [false, true]) {
    const pushes = [],
      tabs = [];
    const client = { url: `feedback-${docked}`, call: async (method) => (method === "artifact:list" ? [page] : []) };
    const h = artifactHost(client, pushes, undefined, designsOn, docked ? (tab) => tabs.push(tab) : null);
    const props = { chatId: "/p#7", feedback: { choice: null, comments: [comment] } };
    h.render("DesignFeedbackCard", props);
    await settle();
    const tree = h.render("DesignFeedbackCard", props);
    const action = find(tree, (node) => node.type === "Pressable" && node.props.accessibilityRole === "button");
    assert.ok(action, "a feedback comment opens its artifact");
    action.props.onPress();
    action.props.onPress();
    const targets = docked ? tabs.map((tab) => tab.target) : pushes.map((route) => route.params);
    assert.equal(targets.length, 2);
    assert.notEqual(targets[0].requestId, targets[1].requestId, "reopening the same comment makes a fresh request");
    assert.equal(targets[0].tab, "headers");
    assert.equal(targets[0].comment, "12345678");
    assert.equal(targets[0].id, "page");
    assert.equal(targets[0].hostId, client.url);
    assert.equal(targets[0].chatId, "/p#7");
    if (docked) assert.equal(targets[0].html, true);
    else assert.equal(pushes[0].pathname, "/artifact-sheet");
    h.cleanup();
  }
});

test("artifact feedback opens its tab and reveals after ready, including a repeated dock request", async () => {
  const page = {
    id: "page",
    title: "HTTP",
    format: "html",
    version: 1,
    latest: 1,
    html: "Overview",
    tabs: [
      { id: "overview", title: "Overview", html: "Overview" },
      { id: "headers", title: "Headers", html: "Headers" },
    ],
  };
  const comment = {
    id: "12345678",
    design: { id: page.id, title: page.title, version: 1 },
    tab: { id: "headers", title: "Headers" },
    text: "Explain caching",
    x: 0.2,
    y: 0.3,
  };
  const client = {
    url: "reveal-host",
    call: async (method) => (method === "artifact:comments" ? [comment] : method === "artifact:sharing-status" ? { available: false } : page),
  };
  const h = artifactHost(client);
  let props = { hostId: client.url, chatId: "/p#7", id: page.id, tab: "headers", comment: comment.id, requestId: "1" };
  let tree = await h.open(props);
  tree = h.render("ArtifactSheet", props);
  assert.ok(
    find(tree, (node) => node.props?.html === "Headers"),
    "the non-first tab opens",
  );
  assert.ok(
    h.commands().some((cmd) => cmd.t === "reveal" && cmd.k === "sent:12345678"),
    "the comment is revealed after readiness",
  );
  find(tree, (node) => node.props?.accessibilityLabel === "Close the comment").props.onPress();
  tree = h.render("ArtifactSheet", props);
  find(tree, (node) => node.type === "PullDown" && node.props.sections.some((section) => section.items.some((item) => item.id === "overview"))).props.onSelect(
    "overview",
  );
  tree = h.render("ArtifactSheet", props);
  assert.ok(find(tree, (node) => node.props?.html === "Overview"));
  const before = h.commands().filter((cmd) => cmd.t === "reveal").length;
  props = { ...props, requestId: "2" };
  h.render("ArtifactSheet", props);
  tree = h.render("ArtifactSheet", props);
  assert.ok(
    find(tree, (node) => node.props?.html === "Headers"),
    "the mounted dock turns back to the target tab",
  );
  assert.equal(h.commands().filter((cmd) => cmd.t === "reveal").length, before, "waits for the new tab's helper");
  h.say(tree, { t: "ready" });
  h.render("ArtifactSheet", props);
  tree = h.render("ArtifactSheet", props);
  assert.equal(h.commands().filter((cmd) => cmd.t === "reveal").length, before + 1);
  h.cleanup();
});

test("artifact route forwards a feedback target to the native viewer", () => {
  const params = { hostId: "mac", chatId: "/p#7", id: "page", kind: "html", tab: "headers", comment: "12345678", requestId: "2" };
  const { default: Screen } = load("app/artifact-sheet.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": { useLocalSearchParams: () => params },
    "../artifact": { ArtifactSheet: "ArtifactSheet" },
    "../designs-sheet": { DesignsSheet: "DesignsSheet" },
  });
  const tree = Screen();
  assert.equal(tree.type, "ArtifactSheet");
  for (const field of ["tab", "comment", "requestId", "hostId", "chatId", "id"]) assert.equal(tree.props[field], params[field]);
});

test("artifact feedback refreshes comments received after a dock was opened", async () => {
  const page = {
    id: "page",
    title: "HTTP",
    format: "html",
    version: 1,
    latest: 1,
    html: "Overview",
    tabs: [
      { id: "overview", title: "Overview", html: "Overview" },
      { id: "headers", title: "Headers", html: "Headers" },
    ],
  };
  let comments = [];
  const later = deferred();
  const client = {
    url: "later-feedback-host",
    call: async (method) => (method === "artifact:comments" ? comments : method === "artifact:sharing-status" ? { available: false } : page),
  };
  const h = artifactHost(client);
  let props = { hostId: client.url, chatId: "/p#7", id: page.id };
  await h.open(props);
  comments = later.promise;
  props = { ...props, tab: "headers", comment: "12345678", requestId: "2" };
  h.render("ArtifactSheet", props);
  let tree = h.render("ArtifactSheet", props);
  h.say(tree, { t: "ready" });
  h.render("ArtifactSheet", props);
  assert.equal(
    h.commands().some((command) => command.t === "reveal"),
    false,
    "no reveal before the comment loads",
  );
  later.resolve([
    { id: "12345678", design: { id: page.id, version: 1, title: page.title }, tab: { id: "headers", title: "Headers" }, x: 0.2, y: 0.3, text: "New feedback" },
  ]);
  await settle();
  h.render("ArtifactSheet", props);
  tree = h.render("ArtifactSheet", props);
  assert.ok(h.commands().some((command) => command.t === "reveal" && command.k === "sent:12345678"));
  h.cleanup();
});

function panelHandoffHost() {
  const react = hookHost();
  react.useEffect = react.effect;
  const painted = new Set();
  const routes = [];
  const session = { cancelNavigation() {} };
  const { SidePanelsProvider } = load("side-panels.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@milagre/shared/after-paint": {
      afterPaint: (work) => {
        painted.add(work);
        return () => painted.delete(work);
      },
    },
    "react-native": {
      useWindowDimensions: () => ({ width: 390 }),
      Keyboard: { dismiss() {} },
      BackHandler: { addEventListener: () => ({ remove() {} }) },
    },
    "expo-router": { router: { canDismiss: () => false, replace: (href) => routes.push(href), push: (href) => routes.push(href) } },
    "react-native-safe-area-context": {},
    "react-native-gesture-handler": {},
    "react-native-reanimated": {
      ReduceMotion: { System: "system" },
      Easing: { out: (value) => value, cubic: "cubic" },
      useSharedValue: (initial) =>
        react.useState(() => ({
          value: initial,
          set(value) {
            this.value = value;
          },
        }))[0],
      withTiming: (value, _options, complete) => {
        complete?.();
        return value;
      },
    },
    "react-native-worklets": { scheduleOnRN: (work) => work() },
    "@hugeicons/core-free-icons": {},
    "./session": { useSession: () => session },
    "./project-navigation": {},
    "./app/changes": {},
    "./change-tree": {},
    "./app/diff": {},
    "./ui": {},
    "./icons": {},
    "./pr-overview": {},
    "./pr-chat": {},
    "./motion": { springTo: (value) => value, scaledTiming: (value) => value },
    "./theme": { getMotionScale: () => 1 },
    "./panel-motion": {},
    "./chat-swipe-row": { ClosesLeftContext: { Provider: "ClosesLeftProvider" }, hideRevealed() {} },
    "./simulator": {},
    "./designs-sheet": {},
    "./artifact": {},
    "./browser": {},
  });
  const render = () => {
    react.begin();
    const value = SidePanelsProvider({ children: null }).props.value;
    react.flush();
    return value;
  };
  const old = { token: {}, chatId: 1 };
  render().attach(old);
  render().show("left");
  render();
  return {
    render,
    old,
    routes,
    painted,
    cleanup: () => react.cleanup(),
    paint: () => {
      for (const work of painted) {
        painted.delete(work);
        work();
      }
    },
  };
}

test("a Chat committed under the sidebar is revealed without a native transition event or the one-second watchdog", () => {
  const host = panelHandoffHost();
  try {
    host.render().navigate({ pathname: "/chat", params: { id: "2" } });
    assert.equal(host.routes.length, 1);
    host.render().detach(host.old.token);
    const next = { token: {}, chatId: 2 };
    host.render().attach(next);
    assert.equal(host.render().open, "left", "keep the old Chat covered until the destination paints");
    host.paint();
    assert.equal(host.render().open, null, "no transitionEnd is needed to reveal the committed destination");
    assert.equal(host.render().screen.chatId, 2);
  } finally {
    host.cleanup();
  }
});

test("a superseded sidebar handoff cannot close the navigation on the next Chat", () => {
  const host = panelHandoffHost();
  try {
    host.render().navigate({ pathname: "/chat", params: { id: "2" } });
    const second = { token: {}, chatId: 2 };
    host.render().attach(second);
    const stale = [...host.painted][0];
    host.render().navigate({ pathname: "/chat", params: { id: "3" } });
    const third = { token: {}, chatId: 3 };
    host.render().attach(third);
    stale();
    assert.equal(host.render().open, "left");
    host.paint();
    assert.equal(host.render().open, null);
    assert.equal(host.render().screen.chatId, 3);
  } finally {
    host.cleanup();
  }
});

test("a native transition ending first cancels the queued sidebar arrival", () => {
  const host = panelHandoffHost();
  try {
    host.render().navigate({ pathname: "/chat", params: { id: "2" } });
    const next = { token: {}, chatId: 2 };
    host.render().attach(next);
    host.render().arrived(next.token);
    assert.equal(host.render().open, null);
    assert.equal(host.painted.size, 0);
    host.render().show("left");
    host.paint();
    assert.equal(host.render().open, "left", "a completed arrival cannot dismiss a reopened sidebar");
  } finally {
    host.cleanup();
  }
});

test("the actual phone computer-use card receives the delayed first frame, opens the measured viewer and keeps the final image", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const react = hookHost({ effects: true });
  const frames = [];
  const routes = [];
  const calls = [];
  let answer = { seq: 0, live: false };
  const session = { client: { call: async (method, args) => (calls.push([method, args]), answer) } };
  const { ComputerUseCard } = load("computer-use-card.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", Image: "Image", ActivityIndicator: "ActivityIndicator" },
    "expo-router": { router: { push: (route) => routes.push(route) } },
    "@hugeicons/core-free-icons": new Proxy({}, { get: (_, name) => String(name) }),
    "@milagre/shared/desktop-steps": require("../packages/shared/src/desktop-steps.ts"),
    "@milagre/shared/computer-use": require("../packages/shared/src/computer-use.ts"),
    "./icons": { Icon: "Icon" },
    "./session": { useSession: () => session },
    "./viewer-store": { showImages: (images, index) => frames.push({ images, index }) },
  });
  t.after(() => react.unmount());
  const steps = [{ id: "first", kind: "other", status: "running", title: "Read TextEdit", startedAt: 1000, input: '{"app":"TextEdit"}' }];
  const render = () => {
    react.begin();
    return ComputerUseCard({ steps, chatId: "/p#1" });
  };
  assert.equal(find(render(), (node) => node.type === "Pressable").props.disabled, true);
  await new Promise(setImmediate);
  answer = { seq: 1, live: true, image: "FIRST", app: "TextEdit", at: 1100, width: 100, height: 80 };
  steps[0].status = "done";
  steps[0].endedAt = 1200;
  render();
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  let card = render();
  assert.equal(find(card, (node) => node.type === "Image").props.source.uri, "data:image/png;base64,FIRST");
  const button = find(card, (node) => node.type === "Pressable");
  button.props.ref.current = { measureInWindow: (done) => done(10, 20, 100, 80) };
  button.props.onPress();
  assert.deepEqual(routes, ["/viewer"]);
  assert.equal(frames[0].images[0].source.uri, "data:image/png;base64,FIRST");
  assert.equal(JSON.stringify(frames[0].images[0].from), JSON.stringify({ x: 10, y: 20, width: 100, height: 80 }));
  answer = { ...answer, live: false };
  t.mock.timers.tick(0);
  await new Promise(setImmediate);
  card = render();
  assert.ok(find(card, (node) => node.type === "Image"));
  assert.equal(
    find(card, (node) => node.type === "Text" && node.props.children === "Live"),
    undefined,
  );
  assert.equal(calls.length, 3, "one step, no remount, initial/live/final reads");
});

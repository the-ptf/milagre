// Real desktop App and mobile SessionProvider/ProjectNavigation, with delayed host responses.
// Mobile native controls are DOM adapters; this checks lifecycle and data flow, not native layout.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const data = `
const stateFor = (name) => ({ next_id: 4, projects: { 1: { id: 1, name } },
  worktrees: { 1: { id: 1, project_id: 1, name: 'main', path: '/' + name } },
  sessions: { 2: { id: 2, worktree_id: 1, agent_name: name, title: name + ' Chat', provider: 'claude', status: 'Idle' } },
  messages: [{ id: 3, session_id: 2, role: 'user', body: name + ' message', context: { kind: 'delegation', from: '/' + name + '#2', fromLabel: 'Linked source' } }], tasks: {} });
const projectFor = (path, title = path.slice(1)) => ({ path, name: path.slice(1), state: stateFor(title) });
window.requests = [];
window.hold = false;
window.request = (host, path) => window.hold ? new Promise((resolve, reject) => window.requests.push({ host, path, resolve, reject })) : Promise.resolve(projectFor(path));
window.finish = (path, title, host) => {
  const index = window.requests.findIndex(request => request.path === path && (!host || request.host === host));
  if (index < 0) throw new Error('No request for ' + path);
  window.requests.splice(index, 1)[0].resolve(projectFor(path, title));
};
window.fail = path => { const index = window.requests.findIndex(request => request.path === path); window.requests.splice(index, 1)[0].reject(new Error('Offline')); };
`;
const desktop = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { updateSettings } from '/src/lib/settings';
import '/src/styles.css';
${data}
updateSettings({ chatList: 'grouped' });
window.milagre = new Proxy({
  readContextSettings: async () => ({ buttonThreshold: 70, autoThreshold: 85, autoCompact: false }),
  simulators: { list: async ({ chatId }) => ({ chatId, supported: false, devices: [], attached: [], available: [] }) },
  getRuntimeConnection: async () => ({ connected: true }),
  getAgentPorts: async () => ({}),
  getRuns: async () => ({ seq: 0, runs: {} }),
  getLinkedWork: async () => ({ delegations: [], negotiations: [], receiveOnly: [] }),
  getCurrentProject: async () => projectFor('/alpha'),
  switchProject: path => window.request('desktop', path),
  listRecentProjects: async () => ['alpha', 'beta', 'gamma'].map(name => ({ path: '/' + name, name })),
  listNamedLinks: async () => [],
  listProjects: async () => [],
  // The sidebar lists every Project's chats from this read, which resolves at once; only switching is held.
  readProject: async path => ({ path, name: path.slice(1), state: stateFor(path.slice(1)) }),
  listBranches: async () => ['main'],
  listEditors: async () => [],
  getCachedUsage: async () => ({ providers: [] }),
  readUsage: async () => ({ providers: [] }),
  getUpdateState: async () => ({ status: 'idle' }),
}, { get(target, key) { return target[key] ?? (String(key).startsWith('on') ? () => () => {} : async () => null); } });
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;
const mobile = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider, useSession } from '/@fs/${path.resolve("apps/mobile/src/session.tsx")}';
import { ProjectNavigation } from '/@fs/${path.resolve("apps/mobile/src/project-navigation.tsx")}';
import { allComputers } from '/@fs/${path.resolve("apps/mobile/src/all-computers.tsx")}';
window.allComputers = allComputers;
${data}
window.makeClient = host => ({
  url: host.address,
  live: (_scope, { onStatus }) => { onStatus?.(true); return { close() {} }; },
  recentScopes: async () => [{ path: '/alpha', name: 'alpha' }, { path: '/beta', name: 'beta' }],
  open: async path => ({ project: await window.request(host.address, path), runs: { runs: {}, seq: 0 } }),
  call: async (method, args) => method === 'project:recent' ? [{ path: '/alpha', name: 'alpha' }, { path: '/beta', name: 'beta' }] : method === 'project:open' ? { path: args[0] } : null,
  snapshot: async path => ({ project: await window.request(host.address, path), runs: { runs: {}, seq: 0 } }),
  preview: async path => { const project = await window.request(host.address, path); return window.compactPreviews ? { previewOnly: true, project: { ...project, state: { ...project.state, messages: project.state.messages.map(message => ({ ...message, body: '' })) } }, runs: { runs: {}, seq: 0 } } : { project, runs: { runs: {}, seq: 0 } }; },
  runs: async () => ({ runs: {}, seq: 0 }),
});
function Screen() {
  window.session = useSession();
  const [shown, setShown] = useState(true);
  window.drawer = setShown;
  return shown ? <ProjectNavigation onNavigate={() => {}} /> : null;
}
createRoot(document.getElementById('root')).render(<SessionProvider><Screen /></SessionProvider>);
`;
const native = `
import React from 'react';
export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
export const Platform = { OS: 'ios' };
export const StyleSheet = { create: value => value, hairlineWidth: 1 };
export const View = ({ children }) => <div>{children}</div>;
export const KeyboardAvoidingView = View;
export const Text = ({ children }) => <span>{children}</span>;
export const Pressable = ({ children, onPress, accessibilityLabel, disabled }) => <button aria-label={accessibilityLabel} onClick={onPress} disabled={disabled}>{typeof children === "function" ? children({ pressed: false }) : children}</button>;
export const RefreshControl = () => null;
export const FlatList = ({ data, renderItem, ListEmptyComponent, keyExtractor }) => <div>{data.length ? data.map(item => <div key={keyExtractor(item)}>{renderItem({ item })}</div>) : ListEmptyComponent}</div>;
`;
const ui = `
import React from 'react';
export const colors = {}; export const styles = {};
export const useStyles = () => new Proxy({}, { get: () => ({}) });
export const ErrorNotice = ({message}) => <span>{message}</span>;
export const Field = ({value, onChangeText, label}) => <input aria-label={label} value={value} onChange={e => onChangeText(e.target.value)} />;
export const IconButton = ({label, onPress}) => <button aria-label={label} onClick={onPress} />;
export const PageScroll = ({children}) => <div>{children}</div>;
export const PullDown = ({children, label, onPress}) => <div role="button" aria-label={label} onClick={onPress}>{children}</div>;
`;
const stubs = {
  "react-native": native,
  "./client": "export const createClient = host => window.makeClient(host);",
  "./relay-native": "export const relayRuntime = {};",
  "./routes-native":
    'export const lanRoutes = { set() {}, forget() {}, checkAll() {}, subscribe: () => () => {}, kind: () => "remote", view: () => ({ current: () => null, subscribe: () => () => {} }) }; export const learnRoutes = async () => {};',
  "./hosts-native":
    "window.savedHostList = []; export const savedHosts = { list: async () => window.savedHostList.slice(), save: async host => { window.savedHostList = [...window.savedHostList.filter(saved => saved.id !== host.address), { id: host.address, lastUsed: 1, ...host }]; } }; export const savedNavigation = { read: async () => null }; export const readPermission = async () => null; export const savePermission = async () => {}; export const savedChatDefaults = { readModel: () => null, saveModel: async () => {}, readLastProject: () => null, saveLastProject: async () => {} }; export const savedProjectOrder = { apply: async (_host, projects) => projects, save: async () => {} }; const noFolds = new Set(); export const savedHiddenProjects = { hidden: () => noFolds, apply: async (_host, projects) => projects, setHidden: async () => {} }; export const savedFoldedProjects = { subscribe: () => () => {}, folded: () => noFolds, loaded: () => true, load: async () => {}, toggle: async () => {} };",
  "./live": "export const syncProject = () => () => {};",
  "./ui": ui,
  "./theme":
    "export const useTheme = () => ({ colors: new Proxy({}, { get: (_, key) => String(key) }), scheme: 'light', settings: {}, set() {} }); export const fonts = { mono: 'monospace' }; export const createStylesHook = () => () => new Proxy({}, { get: () => ({}) });",
  "./primitives/tap": "export const tap = () => {};",
  // The toast pill draws the phone's icons and theme, native-only: here it is its text and Undo.
  "./primitives/toast":
    'export const ToastPill = ({ text, onUndo }) => <div role="status">{text}{onUndo ? <button aria-label="Undo" onClick={onUndo} /> : null}</div>;',
  "@sbaiahmed1/react-native-blur": "export const LiquidGlassView = ({ children }) => <div>{children}</div>;",
  "expo-router": "import { useEffect } from 'react'; export const useFocusEffect = effect => useEffect(effect, [effect]);",
  "expo-linking": "export const openURL = async () => {};",
  "expo-clipboard": "export const setStringAsync = async () => {};",
  "react-native-safe-area-context": "export const useSafeAreaInsets = () => ({ top: 0, bottom: 0 });",
  "./chat-list-controls":
    "export const CONTROLS_HEIGHT = 48; export const useControlsBottomInset = () => 48 + 36; export const useControlsVisibility = () => ({ hidden: false, onScroll() {}, reveal() {} }); export const ChatListControls = () => null;",
  "./computer-actions": "export const isDesktopComputer = name => /studio|mini|imac/i.test(name);",
  "./chat-display-setting": "export const useChatList = () => ['grouped', () => {}];",
  "./status-indicators": "export const ChatMarkIcon = () => null;",
  "./icons": "export const Icon = () => null; export const SpinnerRing = () => null; export const LinearLogo = () => null;",
  "./loading-logo": "export const LoadingLogo = () => null;",
  "./app/settings": "export const SettingsView = () => null;",
  "./app/notifications": "export const NotificationsView = () => null;",
  "./usage-section": "export const UsageSection = () => null;",
  "./project-icon": "export const ProjectIcon = () => null; export const ChatsHomeIcon = () => null; export const ProjectIcons = () => null;",
  "./project-search": "export const ProjectSearch = () => null;",
  "./chat-actions": "export const chatMenu = () => []; export const runChatAction = async () => {};",
  // The swipe row is Reanimated and the gesture handler, native-only: a row here renders without it.
  "./chat-swipe-row":
    "export const ChatSwipeRow = ({ children }) => children; export const hideRevealed = () => {}; export const ClosesLeftContext = { Provider: ({ children }) => children };",
  "./offline-tray": "export const WaitingLabel = () => null;",
  "./split-context": "export const useSplit = () => ({ widthClass: 'compact' }); export const useSplitLayout = () => ({ widthClass: 'compact' });",
  "./confirm-store": "export const confirm = async () => true; export const confirmSheet = () => {};",
  "./attention": "export const AttentionDot = () => null; export const useAttention = () => [];",
  "./update-sheet": "export const UpdateSettingsBadge = () => null;",
  "./app-version": 'export const appVersionLine = () => "1.0";',
  "./chat-row-store":
    "export const useChatRowShow = () => ({ computer: true, pullRequests: true, linearIssue: true, branch: true, diff: false, lastActivity: false }); export const saveChatRowShow = () => {}; export const useActivityClock = () => Date.now();",
};

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-project-cache-")));
  setTimeout(() => {
    console.error("Project cache check timed out");
    app.exit(1);
  }, 90_000).unref();
  await app.whenReady();
  // App waits for the splash animation to finish; a shown window keeps its compositor painting under Xvfb.
  const window = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      errors.push(event.message);
      console.error(event.message);
    }
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 240; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  }
  async function click(label) {
    const selector = `[aria-label=${JSON.stringify(label)}]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  const contains = (text) => `document.body.textContent.includes(${JSON.stringify(text)})`;
  const sidebar = (text) => `document.querySelector('aside')?.textContent.includes(${JSON.stringify(text)})`;
  // "New chat in <name>" on another Project's sidebar group switches to that Project.
  async function switchTo(_current, next) {
    const target = `document.querySelector('[data-sidebar-scope="/${next}"] [data-scope-action]')`;
    await waitFor(`!!${target}`);
    await evaluate(`${target}.click()`);
  }
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await window.loadURL(process.argv[2] + "desktop");
    await waitFor(sidebar("alpha Chat"));
    await waitFor('!document.querySelector(".startup-splash-screen")');
    await switchTo("alpha", "beta");
    await waitFor(sidebar("beta Chat"));
    await evaluate("window.hold = true");
    await switchTo("beta", "alpha");
    await waitFor(sidebar("alpha Chat"));
    assert.equal(await evaluate("window.requests[0].path"), "/alpha", "cached chats show before refresh resolves");
    await screenshot("desktop-cached-refresh");
    await evaluate(`[...document.querySelectorAll('aside [data-row]')].find(row => row.textContent.includes('alpha Chat')).click()`);
    await waitFor(`!!document.querySelector('[data-linked-from="/alpha#2"]')`);
    await evaluate(`document.querySelector('[data-linked-from="/alpha#2"]').click()`);

    await click("New chat");
    await evaluate(
      `(() => { const input = document.querySelector('[data-prompt-editor]'); input.value = 'Draft during refresh'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await evaluate("window.finish('/alpha', 'Updated alpha')");
    await waitFor(sidebar("Updated alpha Chat"));
    assert.equal(await evaluate(`document.querySelector('[data-prompt-editor]').value`), "Draft during refresh");
    await screenshot("desktop-refreshed");
    await switchTo("alpha", "beta");
    await waitFor(sidebar("beta Chat"));
    await switchTo("beta", "alpha");
    await waitFor(sidebar("Updated alpha Chat"));
    await evaluate("window.finish('/beta', 'Late beta')");
    await delay(100);
    assert.equal(await evaluate(sidebar("Updated alpha Chat")), true, "late response cannot switch back");
    await evaluate("window.fail('/alpha')");
    await waitFor(contains("Offline"));
    assert.equal(await evaluate(sidebar("Updated alpha Chat")), true, "failure preserves cached chats");
    await switchTo("alpha", "gamma");
    assert.equal(await evaluate(sidebar("Updated alpha Chat")), true, "uncached switch waits for its first response");
    await evaluate("window.finish('/gamma', 'First gamma')");
    await waitFor(sidebar("First gamma Chat"));
    console.log("PASS desktop: immediate cached switch, background refresh, draft retention, failure retention, out-of-order navigation and cold open");

    await window.loadURL(process.argv[2] + "mobile");
    await waitFor("!!window.session?.booted");
    await evaluate("window.process = { env: {} }");
    await evaluate("window.session.connect({ address: 'host-one', token: '' }, false)");
    // Every Project's group starts open; only a group folded by hand stays folded.
    await waitFor(contains("alpha Chat"));
    await waitFor(contains("beta Chat"));
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Collapse beta"]')`), true, "another Project's group is open too");
    await evaluate("window.drawer(false)");
    await delay(50);
    await evaluate("window.hold = true; window.drawer(true)");
    await waitFor(contains("alpha Chat"));
    assert.equal(await evaluate(contains("Loading chats...")), false, "drawer remount renders cached list");
    await waitFor("['/alpha', '/beta'].every(path => window.requests.some(request => request.path === path))");
    await evaluate("window.drawer(false)");
    await delay(50);
    await evaluate("window.drawer(true)");
    await delay(100);
    assert.equal(await evaluate("window.requests.length"), 2, "remount joins the in-flight previews");
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Collapse beta"]')`), true, "beta stays open across remounts");
    await evaluate("window.finish('/alpha', 'Fresh alpha')");
    await waitFor(contains("Fresh alpha Chat"));
    assert.equal(await evaluate(contains("beta Chat")), true);
    await evaluate("window.fail('/beta')");
    await waitFor(contains("Could not refresh chats. Tap to retry."));
    assert.equal(await evaluate(contains("beta Chat")), true);
    await evaluate("[...document.querySelectorAll('button')].find(node => node.textContent.includes('Could not refresh chats')).click()");
    await waitFor("window.requests.some(request => request.path === '/beta')");
    await evaluate("window.finish('/beta', 'Retried beta')");
    await waitFor(contains("Retried beta Chat"));
    // Browsing the drawer (the all-computers store reading /beta) warmed the session's own cache.
    assert.equal(await evaluate("!!window.session.cachedProject('/beta')"), true, "the drawer's read of the current computer seeds the session cache");
    assert.equal(await evaluate("window.requests.some(request => request.path === '/beta')"), false, "no extra preview of beta is needed before opening it");
    await evaluate("window.session.open('/beta'); void 0");
    await waitFor("window.session.snapshot?.project.path === '/beta'");
    assert.equal(await evaluate("window.session.opening.cached"), true, "drawer previews warm foreground navigation");
    await waitFor("window.requests.some(request => request.path === '/beta')");
    await evaluate("window.finish('/beta', 'Opened beta')");
    await waitFor("window.session.opening === null");
    // Selecting beta refreshes alpha's preview on the current connection.
    await waitFor("window.requests.some(request => request.host === 'host-one' && request.path === '/alpha')");
    await evaluate("window.finish('/alpha', 'Fresh alpha', 'host-one')");
    // Both computers are saved, as paired phones have them: each keeps its own answers while the other is the open one.
    await evaluate("window.savedHostList = [{ id: 'host-one', name: 'One', address: 'host-one', token: '', lastUsed: 1 }]");
    await evaluate("window.session.connect({ address: 'host-two', token: '', name: 'Two' }, true)");
    await waitFor("window.requests.some(request => request.host === 'host-two')");
    const alphaOn = (host) => `window.allComputers.viewOf('${host}')?.copies.get('/alpha')?.project.state.sessions[2]?.title`;
    assert.equal(await evaluate(alphaOn("host-two")), undefined, "same path on another computer has no borrowed cache");
    assert.equal(await evaluate(alphaOn("host-one")), "Fresh alpha Chat", "the other computer keeps its answers");
    await evaluate("window.finish('/alpha', 'Other computer', 'host-two')");
    await waitFor(`${alphaOn("host-two")} === 'Other computer Chat'`);
    assert.equal(await evaluate(alphaOn("host-one")), "Fresh alpha Chat", "late response stays with its computer");
    await evaluate("window.session.connect({ address: 'host-one', token: '' }, false)");
    await waitFor(contains("Fresh alpha Chat"));
    await waitFor("window.requests.some(request => request.host === 'host-one' && request.path === '/alpha')");
    // The reconnect and the store each read it; answer whichever reads are open until the list shows the new answer.
    await waitFor(`(() => { try { window.finish('/alpha', 'Returned alpha', 'host-one'); } catch {} return ${contains("Returned alpha Chat")}; })()`);
    assert.equal(await evaluate(alphaOn("host-two")), "Other computer Chat", "returning leaves the other computer's answers alone");
    await evaluate("window.drawer(false)");
    await delay(50);
    // Answer every other open read, so only the empty alpha list below can still be loading.
    await evaluate(
      "window.requests.filter(request => request.path !== '/alpha').forEach(request => window.finish(request.path, request.path.slice(1) + ' settled', request.host))",
    );
    await evaluate("void window.allComputers.refreshProject('host-one', '/alpha')");
    await waitFor("window.requests.some(request => request.path === '/alpha')");
    await evaluate(`(() => {
      const index = window.requests.findIndex(request => request.path === '/alpha');
      const project = window.allComputers.viewOf('host-one').copies.get('/alpha').project;
      window.requests.splice(index, 1)[0].resolve({ ...project, state: { ...project.state, sessions: {}, messages: [] } });
    })()`);
    await delay(50);
    await evaluate("window.drawer(true)");
    await waitFor(contains("No chats yet. Start one with +."));
    assert.equal(await evaluate(contains("Loading chats...")), false, "an empty list fetched while unmounted is still a loaded cache entry");
    await evaluate("window.drawer(false)");
    await delay(50);
    await evaluate("window.finish('/alpha', 'Warm alpha'); window.hold = false; window.compactPreviews = true");
    await evaluate("window.session.open('/beta')");
    await evaluate("window.session.previewProject('/gamma')");
    assert.equal(await evaluate("window.session.cachedProject('/gamma').previewOnly"), true, "drawer uses the compact response");
    await evaluate("window.hold = true; void window.session.open('/gamma')");
    await waitFor("window.requests.some(request => request.path === '/gamma')");
    assert.equal(await evaluate("window.session.opening.cached"), false, "a list-only preview is never promoted to a transcript");
    assert.equal(await evaluate("window.session.snapshot.project.path"), "/beta");
    await evaluate("window.finish('/gamma', 'Opened gamma')");
    await waitFor("window.session.opening === null");
    await evaluate("window.hold = false; window.session.open('/beta')");
    await evaluate("window.session.previewProject('/gamma')");
    await evaluate("window.hold = true; void window.session.open('/gamma')");
    await waitFor("window.requests.some(request => request.path === '/gamma')");
    assert.equal(await evaluate("window.session.opening.cached"), true, "a compact refresh preserves the previously opened full transcript");
    assert.equal(await evaluate("window.session.snapshot.project.state.messages[0].body"), "Opened gamma message");
    await evaluate("window.finish('/gamma', 'Updated gamma')");
    await waitFor("window.session.opening === null");
    assert.deepEqual(errors, []);
    console.log(
      "PASS mobile: remount cache, request deduplication, background refresh, retry, warm foreground open, computer isolation, empty results and separate summary/transcript caches",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer, transformWithEsbuild } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve("apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "project-cache-fixtures",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "/__cache_desktop.tsx" || id === "/__cache_mobile.tsx") return id;
          if (importer?.includes("/apps/mobile/") && Object.hasOwn(stubs, id)) return "\0cache-stub:" + id + ".tsx";
        },
        async load(id) {
          if (id === "/__cache_desktop.tsx") return desktop;
          if (id === "/__cache_mobile.tsx") return mobile;
          if (id.startsWith("\0cache-stub:"))
            return transformWithEsbuild(stubs[id.slice("\0cache-stub:".length, -4)], id.slice(1), { loader: "tsx", jsx: "automatic" });
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            const match = /^\/__cache\/(desktop|mobile)$/.exec(request.url);
            if (!match) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__cache_' + match[1] + '.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), server.resolvedUrls.local[0] + "__cache/"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

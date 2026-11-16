const { createHash, randomBytes } = require("node:crypto");

const TARGET = /^([A-Za-z0-9-]{8,64}):([A-Fa-f0-9]{32})$/;
const BROWSER = /^[A-Za-z0-9-]{8,64}$/;
const BUTTONS = new Set(["left", "middle", "right", "none"]);
const COMMANDS = new Set(["selectAll", "copy", "cut", "paste", "undo", "redo"]);
const NAVIGATION = new Set(["back", "forward", "reload"]);
const MAX_ATTACHED = 16;
const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 4096;
const FRESH_MS = 2000;
const UNOWNED_MS = 30_000;

function identifier() {
  return randomBytes(24).toString("base64url");
}
const unit = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const modifiers = (value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 15);
function validEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  switch (event.kind) {
    case "mouse": {
      if (!["down", "move", "up"].includes(event.phase) || !unit(event.x) || !unit(event.y) || !modifiers(event.modifiers)) return false;
      const button = event.button ?? "none";
      if (!BUTTONS.has(button) || (event.phase !== "move" && button === "none")) return false;
      return event.clickCount === undefined || (Number.isInteger(event.clickCount) && event.clickCount >= 0 && event.clickCount <= 3);
    }
    case "wheel":
      return (
        unit(event.x) &&
        unit(event.y) &&
        modifiers(event.modifiers) &&
        [event.deltaX, event.deltaY].every((delta) => Number.isFinite(delta) && Math.abs(delta) <= 10000)
      );
    case "key":
      return (
        ["down", "up"].includes(event.phase) &&
        typeof event.key === "string" &&
        event.key.length >= 1 &&
        event.key.length <= 32 &&
        typeof event.code === "string" &&
        /^[A-Za-z0-9]{0,32}$/.test(event.code) &&
        Number.isInteger(event.keyCode) &&
        event.keyCode >= 0 &&
        event.keyCode <= 255 &&
        (event.text === undefined || (typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 8)) &&
        modifiers(event.modifiers) &&
        (event.commands === undefined ||
          (Array.isArray(event.commands) && event.commands.length <= 4 && event.commands.every((command) => COMMANDS.has(command))))
      );
    case "text":
      return typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 1024;
    case "navigate":
      return NAVIGATION.has(event.action);
    case "viewport":
      return [event.width, event.height].every((side) => Number.isInteger(side) && side >= MIN_VIEWPORT && side <= MAX_VIEWPORT);
    default:
      return false;
  }
}
function cleanEvent(event) {
  const extra = event.modifiers ? { modifiers: event.modifiers } : {};
  switch (event.kind) {
    case "mouse":
      return {
        kind: "mouse",
        phase: event.phase,
        x: event.x,
        y: event.y,
        button: event.button ?? "none",
        clickCount: event.clickCount ?? (event.phase === "move" ? 0 : 1),
        ...extra,
      };
    case "wheel":
      return { kind: "wheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, ...extra };
    case "key":
      return {
        kind: "key",
        phase: event.phase,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        ...(event.phase === "down" && event.text !== undefined ? { text: event.text } : {}),
        ...extra,
        ...(event.phase === "down" && event.commands?.length ? { commands: [...event.commands] } : {}),
      };
    case "text":
      return { kind: "text", text: event.text };
    case "viewport":
      return { kind: "viewport", width: event.width, height: event.height };
    default:
      return { kind: "navigate", action: event.action };
  }
}
function requireChat(request) {
  const chatId = request?.chatId;
  if (typeof chatId !== "string" || !chatId || chatId.length > 1024) throw new Error("A Chat is required to list its browsers.");
  return chatId;
}

function createBrowsers(options = {}) {
  const supported = options.supported ?? (process.platform === "darwin" || process.platform === "linux");
  const adapter = options.adapter ?? require("./browsers-cdp.cjs").createBrowserAdapter(options);
  const roots = options.roots ?? (() => new Map());

  const now = options.now ?? Date.now;
  const ttl = options.viewerTtlMs ?? 30000;
  const maxViewers = options.maxViewers ?? 8;
  const frameWaitMs = options.frameWaitMs ?? 2500;
  const owners = new Map(),
    viewers = new Map(),
    captures = new Map(),
    devtoolsSessions = new Map();
  const lineage = new Map();
  const attachments = new Map();
  const panels = new Map();
  let closed = false,
    queue = Promise.resolve(),
    pending = 0,
    cache = null,
    discovering = null;

  function dropSession(key, entry) {
    devtoolsSessions.delete(key);
    if (entry.session) entry.session.close();
    else
      entry.ready.then(
        (session) => session.close(),
        () => {},
      );
  }

  function dropGonePanelSessions() {
    const live = new Set(panelBrowsers().flatMap((browser) => browser.pages.map((page) => `${browser.id}:${page.id}`)));
    for (const [key, entry] of devtoolsSessions) if (entry.target.id.startsWith("panel-") && !live.has(entry.target.id)) dropSession(key, entry);
    return live;
  }

  function serial(fn, allowClosed = false) {
    if (closed && !allowClosed) return Promise.reject(new Error("Browser service is closed."));
    if (pending >= 128 && !allowClosed) return Promise.reject(new Error("Browser is busy. Retry after pending commands finish."));
    pending++;
    const result = queue.then(fn);
    queue = result
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return result;
  }
  function ownerState(owner) {
    if (typeof owner !== "string" || !owner || owner.length > 1024) throw new Error("A trusted browser owner is required.");
    let state = owners.get(owner);
    if (!state) {
      state = { dead: false, count: 0 };
      owners.set(owner, state);
    }
    return state;
  }
  function requireViewer(request, owner) {
    const v = viewers.get(request?.viewerId);
    if (!v || v.owner !== owner || v.ownerState.dead) throw new Error("Unknown browser viewer or owner. Reopen the viewer.");
    return v;
  }

  async function snapshot(maxAge = FRESH_MS) {
    if (cache && now() - cache.at < maxAge) return cache.world;
    discovering ??= (async () => {
      try {
        const world = await adapter.discover();
        const parents = new Map(world.processes.map((row) => [row.pid, row.ppid]));
        const agents = new Map([...roots()].flatMap(([chatId, root]) => [root.pid, ...(root.agents ?? [])].filter(Boolean).map((pid) => [pid, chatId])));
        const present = new Map(world.browsers.map((browser) => [browser.id, browser]));
        for (const [id, known] of lineage) if (present.get(id)?.pid !== known.pid) lineage.delete(id);
        for (const [chatId, set] of attachments) {
          for (const id of set) if (!present.has(id)) set.delete(id);
          if (!set.size) attachments.delete(chatId);
        }
        for (const browser of world.browsers) {
          let pid = parents.get(browser.pid);
          for (let depth = 0; pid && pid > 1 && depth < 64; depth++, pid = parents.get(pid)) {
            if (!agents.has(pid)) continue;
            lineage.set(browser.id, { chatId: agents.get(pid), pid: browser.pid });
            for (const [chatId, set] of attachments) if (chatId !== agents.get(pid) && set.delete(browser.id) && !set.size) attachments.delete(chatId);
            break;
          }
        }
        cache = { at: now(), world };
        return world;
      } finally {
        discovering = null;
      }
    })();
    return discovering;
  }
  function panelBrowsers() {
    const browsers = [];
    for (const [owner, panel] of panels) {
      const byChat = new Map();
      for (const page of panel.pages) byChat.set(page.chatId, [...(byChat.get(page.chatId) ?? []), page]);
      for (const [chatId, pages] of byChat)
        browsers.push({
          id: `panel-${createHash("sha256").update(`${owner}\0${chatId}`).digest("hex").slice(0, 24)}`,
          pid: 0,
          host: "127.0.0.1",
          port: panel.port,
          prefix: panel.prefix,
          product: "Browser panel",
          owner: chatId,
          panel: true,
          remote: !!panel.remote,
          pages: pages.map(({ id, title, url }) => ({ id, title, url })),
        });
    }
    return browsers;
  }
  const allBrowsers = (world) => [...world.browsers, ...panelBrowsers()];
  function mayOwn(chatId) {
    if (attachments.has(chatId) || roots().has(chatId)) return true;
    for (const panel of panels.values()) if (panel.pages.some((page) => page.chatId === chatId)) return true;
    for (const known of lineage.values()) if (known.chatId === chatId) return true;
    return false;
  }
  function view(world, chatId) {
    const targets = [],
      others = [];
    for (const browser of allBrowsers(world)) {
      const owner = browser.owner ?? lineage.get(browser.id)?.chatId;
      if (owner === chatId || attachments.get(chatId)?.has(browser.id)) {
        for (const page of browser.pages)
          targets.push({
            id: `${browser.id}:${page.id}`,
            title: String(page.title ?? "").slice(0, 300),
            url: String(page.url ?? "").slice(0, 2048),
            browser: browser.product,
            source: browser.panel ? "panel" : owner === chatId ? "agent" : "attached",
          });
      } else if (!owner)
        others.push({ id: browser.id, browser: browser.product, pages: browser.pages.length, title: String(browser.pages[0]?.title ?? "").slice(0, 300) });
    }
    return { supported: true, targets, others };
  }

  function releaseHeld(capture) {
    const mouse = capture.mouse;
    capture.mouse = null;
    if (mouse) {
      try {
        capture.channel.send({ kind: "mouse", phase: "up", ...mouse });
      } catch {}
    }
    for (const key of capture.keys.values()) {
      try {
        capture.channel.send({ kind: "key", phase: "up", ...key });
      } catch {}
    }
    capture.keys.clear();
  }
  function revoke(capture) {
    releaseHeld(capture);
    capture.controller = null;
    capture.generation++;
  }
  function metadata(capture) {
    const state = capture.channel.status();
    const signature = `${state.width}:${state.height}:${!!state.ready}:${state.error ?? ""}`;
    if (capture.signature !== signature) {
      if (capture.signature !== undefined) {
        releaseHeld(capture);
        capture.generation++;
      }
      capture.signature = signature;
    }
    return state;
  }
  function statusOf(v) {
    const capture = v.capture,
      state = metadata(capture);
    if (state.error) throw new Error(state.error);
    return {
      generation: capture.generation,
      controlling: capture.controller === v.id,
      ready: !!state.ready,
      title: state.title ?? "",
      url: state.url ?? "",
      canGoBack: !!state.canGoBack,
      canGoForward: !!state.canGoForward,
      supportsViewport: true,
    };
  }
  async function remove(v) {
    if (!viewers.delete(v.id)) return;
    v.removed = true;
    v.wake?.();
    const capture = v.capture;
    v.ownerState.count--;
    if (v.ownerState.count === 0 && owners.get(v.owner) === v.ownerState) owners.delete(v.owner);
    if (capture.controller === v.id) revoke(capture);
    capture.viewers.delete(v.id);
    if (capture.viewers.size === 0) {
      captures.delete(capture.key);
      await capture.channel.close().catch(() => {});
    }
  }
  async function expire() {
    for (const v of viewers.values()) if (now() - v.heartbeat >= ttl || v.ownerState.dead) await remove(v);
  }
  async function active(request, owner) {
    await expire();
    return requireViewer(request, owner);
  }
  const expiryTimer = setInterval(
    () => {
      if (!closed) void serial(expire).catch(() => {});
    },
    Math.min(5000, ttl),
  );
  expiryTimer.unref();
  function needsLineagePoll() {
    if (viewers.size || cache?.world.browsers.some((browser) => browser.pages.length)) return true;
    for (const panel of panels.values()) if (panel.pages.length) return true;
    for (const root of roots().values()) if (root.active) return true;
    return false;
  }
  const lineageTimer = setInterval(() => {
    if (!closed && supported && needsLineagePoll()) void snapshot().catch(() => {});
  }, options.lineagePollMs ?? 5000);
  lineageTimer.unref();

  return {
    async list(request) {
      if (closed) throw new Error("Browser service is closed.");
      const chatId = requireChat(request);
      if (!supported) return { supported: false, targets: [], others: [] };
      try {
        return view(await snapshot(mayOwn(chatId) ? FRESH_MS : UNOWNED_MS), chatId);
      } catch {
        return { supported: true, targets: [], others: [], error: "Could not list browsers on this computer." };
      }
    },
    async attach(request) {
      if (closed) throw new Error("Browser service is closed.");
      const chatId = requireChat(request);
      if (!supported) throw new Error("Browser viewing is not supported on this computer.");
      const world = await snapshot();
      const browser =
        typeof request.browserId === "string" && BROWSER.test(request.browserId) ? world.browsers.find((item) => item.id === request.browserId) : null;
      if (!browser || lineage.has(browser.id)) throw new Error("This browser is not available to attach. Refresh the list.");
      const set = attachments.get(chatId) ?? new Set();
      if (!set.has(browser.id) && set.size >= MAX_ATTACHED) throw new Error("Too many browsers are attached to this Chat.");
      if (!attachments.has(chatId) && attachments.size >= 512) throw new Error("Too many Chats have attached browsers.");
      set.add(browser.id);
      attachments.set(chatId, set);
      return view(world, chatId);
    },
    async detach(request) {
      if (closed) throw new Error("Browser service is closed.");
      const chatId = requireChat(request);
      if (!supported) throw new Error("Browser viewing is not supported on this computer.");
      const browserId = typeof request.browserId === "string" && BROWSER.test(request.browserId) ? request.browserId : null;
      const set = attachments.get(chatId);
      if (!browserId || !set?.has(browserId)) throw new Error("This browser is not attached to this Chat. Refresh the list.");
      set.delete(browserId);
      if (!set.size) attachments.delete(chatId);
      await serial(async () => {
        for (const v of Array.from(viewers.values())) if (v.chatId === chatId && v.capture.key.startsWith(`${browserId}:`)) await remove(v);
      });
      return view(await snapshot(), chatId);
    },
    async open(request, owner) {
      const ownership = ownerState(owner);
      return serial(async () => {
        await expire();
        const chatId = requireChat(request);
        if (!supported) throw new Error("Browser viewing is not supported on this computer.");
        if (ownership.dead || closed) throw new Error("Browser owner disconnected.");
        if (viewers.size >= maxViewers) throw new Error("Too many browser viewers. Close a viewer first.");
        const match = typeof request.targetId === "string" ? TARGET.exec(request.targetId) : null;
        if (!match) throw new Error("Unknown browser page. Choose another page.");
        const world = await snapshot();
        const target = view(world, chatId).targets.find((item) => item.id === request.targetId);
        const browser = allBrowsers(world).find((item) => item.id === match[1]);
        if (!target || !browser) throw new Error("This page is not available in this Chat. Choose another page.");
        let capture = captures.get(target.id);
        if (capture && metadata(capture).error) {
          for (const id of Array.from(capture.viewers)) await remove(viewers.get(id));
          capture = null;
        }
        if (!capture) {
          const channel = await adapter.connect(browser, match[2]);
          if (ownership.dead || closed) {
            await channel.close().catch(() => {});
            throw new Error("Browser owner disconnected.");
          }
          capture = { key: target.id, channel, viewers: new Set(), controller: null, generation: 1, mouse: null, keys: new Map() };
          captures.set(target.id, capture);
        }
        const id = identifier();
        ownership.count++;
        owners.set(owner, ownership);
        viewers.set(id, { id, owner, chatId, ownerState: ownership, capture, sequence: -1, heartbeat: now(), rateAt: now(), inputTokens: 240, waiting: false });
        capture.viewers.add(id);
        return { viewerId: id, target: { ...target } };
      });
    },
    async frame(request, owner) {
      const v = await serial(async () => {
        const v = await active(request, owner);
        if (!Number.isSafeInteger(request.after) || request.after < 0) throw new Error("Invalid browser frame request.");
        if (v.waiting) throw new Error("A frame request is already pending for this viewer.");
        statusOf(v);
        v.heartbeat = now();
        v.waiting = true;
        return v;
      });
      try {
        const newer = () => {
          const frame = v.capture.channel.frame();
          return frame && frame.sequence > request.after ? frame : null;
        };
        if (!newer() && !v.removed) {
          await new Promise((resolve) => {
            const timer = setTimeout(done, frameWaitMs);
            const unsubscribe = v.capture.channel.onFrame(() => {
              if (newer() || v.capture.channel.status().error) done();
            });
            v.wake = done;
            function done() {
              clearTimeout(timer);
              unsubscribe();
              v.wake = null;
              resolve();
            }
          });
        }
        if (v.removed) return null;
        const state = metadata(v.capture);
        if (state.error) throw new Error(state.error);
        const frame = newer();
        v.heartbeat = now();
        return frame ? { sequence: frame.sequence, data: frame.data, viewport: { ...frame.viewport }, generation: v.capture.generation } : null;
      } finally {
        v.waiting = false;
      }
    },
    status(request, owner) {
      return serial(async () => {
        const v = await active(request, owner);
        v.heartbeat = now();
        return statusOf(v);
      });
    },
    control(request, owner) {
      return serial(async () => {
        const v = await active(request, owner),
          capture = v.capture;
        if (typeof request.takeOver !== "boolean") throw new Error("Invalid browser control request.");
        if (capture.controller !== v.id && (!capture.controller || request.takeOver)) {
          revoke(capture);
          capture.controller = v.id;
        }
        v.heartbeat = now();
        return statusOf(v);
      });
    },
    input(request, owner) {
      return serial(async () => {
        const v = await active(request, owner),
          capture = v.capture;
        if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || !Number.isSafeInteger(request.generation) || !validEvent(request.event))
          throw new Error("Invalid browser input event.");
        const state = metadata(capture);
        if (capture.controller !== v.id || !state.ready || state.error || request.generation !== capture.generation || request.sequence <= v.sequence)
          return { accepted: false };
        v.sequence = request.sequence;
        v.inputTokens = Math.min(240, v.inputTokens + Math.max(0, now() - v.rateAt) * 0.24);
        v.rateAt = now();
        if (v.inputTokens < 1) {
          releaseHeld(capture);
          return { accepted: false };
        }
        v.inputTokens--;
        const event = cleanEvent(request.event);
        if (event.kind === "mouse" && (event.phase === "down" ? !!capture.mouse : event.phase === "up" && !capture.mouse)) return { accepted: false };
        try {
          capture.channel.send(event);
        } catch {
          revoke(capture);
          return { accepted: false };
        }
        if (event.kind === "mouse") {
          if (event.phase === "down") capture.mouse = { x: event.x, y: event.y, button: event.button, clickCount: event.clickCount };
          else if (event.phase === "up") capture.mouse = null;
          else if (capture.mouse) capture.mouse = { ...capture.mouse, x: event.x, y: event.y };
        }
        if (event.kind === "key") {
          if (event.phase === "down") capture.keys.set(event.code || event.key, { key: event.key, code: event.code, keyCode: event.keyCode });
          else capture.keys.delete(event.code || event.key);
        }
        v.heartbeat = now();
        return { accepted: true };
      });
    },
    closeViewer(request, owner) {
      return serial(async () => {
        await remove(await active(request, owner));
        return null;
      });
    },
    async devtools(request) {
      if (closed) throw new Error("Browser service is closed.");
      const chatId = requireChat(request);
      if (!supported) throw new Error("Browser pages are not supported on this computer.");
      const world = await snapshot();
      const { targets } = view(world, chatId);
      const panel = targets.filter((item) => item.source === "panel");
      const target = typeof request.page === "string" && request.page ? targets.find((item) => item.id === request.page) : (panel.at(-1) ?? targets[0]);
      if (!target)
        throw new Error(
          request.page
            ? "That page is not in this Chat. List the pages with browser_list."
            : "This Chat has no browser page. Open one with browser_open, or ask the user to open the Browser panel.",
        );
      for (const [key, entry] of devtoolsSessions)
        if (entry.session?.closed || (entry.chatId === chatId && !targets.some((item) => item.id === entry.target.id))) dropSession(key, entry);
      const key = `${chatId}\0${target.id}`;
      let entry = devtoolsSessions.get(key);
      if (!entry) {
        const match = TARGET.exec(target.id);
        const browser = match && allBrowsers(world).find((item) => item.id === match[1]);
        if (!browser || typeof adapter.session !== "function") throw new Error("This page can't be driven from here.");
        const made = { chatId, target, session: null, state: {}, ready: adapter.session(browser, match[2]) };
        entry = made;
        devtoolsSessions.set(key, made);
        made.ready.then(
          (session) => {
            made.session = session;
            if (devtoolsSessions.get(key) !== made) session.close();
          },
          () => devtoolsSessions.get(key) === made && devtoolsSessions.delete(key),
        );
      }
      const match = TARGET.exec(target.id);
      const browser = match && allBrowsers(world).find((item) => item.id === match[1]);
      const files = async (paths) => {
        if (!browser?.remote) return paths;
        if (typeof adapter.upload !== "function") throw new Error("Files can't reach the computer showing this page.");
        const placed = [];
        for (const file of paths) placed.push(await adapter.upload(browser, file));
        return placed;
      };
      return { target, session: await entry.ready, state: entry.state, files };
    },
    async setPanelPages(request, owner) {
      if (typeof owner !== "string" || !owner || owner.length > 1024) throw new Error("A trusted desktop connection is required.");
      const pages = Array.isArray(request?.pages) ? request.pages : [];
      if (pages.length > 128) throw new Error("Too many Browser panel pages.");
      if (!pages.length) panels.delete(owner);
      else {
        const port = request?.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof request.prefix !== "string" || !/^\/[a-f0-9]{48}$/.test(request.prefix))
          throw new Error("Invalid Browser panel endpoint.");
        panels.set(owner, {
          port,
          prefix: request.prefix,
          remote: request.remote === true,
          pages: pages.map((page) => {
            if (typeof page?.id !== "string" || !/^[A-F0-9]{32}$/.test(page.id)) throw new Error("Invalid Browser panel page.");
            if (typeof page.chatId !== "string" || !page.chatId || page.chatId.length > 1024) throw new Error("A Browser panel page names its Chat.");
            return { id: page.id, chatId: page.chatId, title: String(page.title ?? "").slice(0, 300), url: String(page.url ?? "").slice(0, 2048) };
          }),
        });
      }
      const live = dropGonePanelSessions();
      return serial(async () => {
        for (const v of Array.from(viewers.values())) if (v.capture.key.startsWith("panel-") && !live.has(v.capture.key)) await remove(v);
        return { pages: pages.length };
      });
    },
    disconnect(owner) {
      panels.delete(owner);
      dropGonePanelSessions();
      const state = owners.get(owner);
      if (state) {
        state.dead = true;
        owners.delete(owner);
      }
      return serial(async () => {
        for (const v of viewers.values()) if (v.owner === owner) await remove(v);
      }, true);
    },
    close() {
      if (closed) return queue;
      closed = true;
      clearInterval(expiryTimer);
      clearInterval(lineageTimer);
      for (const state of owners.values()) state.dead = true;
      for (const capture of captures.values()) releaseHeld(capture);
      for (const [key, entry] of devtoolsSessions) dropSession(key, entry);
      const stopping = Promise.resolve(adapter.stop());
      return serial(async () => {
        for (const v of viewers.values()) await remove(v);
        owners.clear();
        await stopping;
      }, true);
    },
  };
}
module.exports = { createBrowsers };

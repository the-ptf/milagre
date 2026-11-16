const { randomUUID } = require("node:crypto");
const { validToken, authenticationProof, authenticationNonce, validNonce } = require("./local-auth.cjs");
const { VERSION, MAX_PENDING, pageSize } = require("./protocol.cjs");
const { peerPolicy } = require("./peer-policy.cjs");
const { NO_REPLY } = require("./daemon-methods.cjs");

const PAGES_TTL_MS = 30000;
const PAGES_BUDGET_CHARS = 96 * 1024 * 1024;
const PAGE_METHODS = new Set(["daemon:result-page", "daemon:snapshot-page"]);

function createResultPages(maxFrameBytes, { ttlMs = PAGES_TTL_MS, budgetChars = PAGES_BUDGET_CHARS } = {}) {
  const captures = new Map();
  const waiting = [];
  const size = pageSize(maxFrameBytes);
  let slots = 0;
  let held = 0;
  let nextId = 0;
  let closed = false;
  const fits = (chars) => slots === 0 || (slots < MAX_PENDING && held + chars <= budgetChars);
  const reserve = (chars) => {
    slots++;
    held += chars;
  };
  function admit() {
    // oxlint-disable-next-line no-unmodified-loop-condition -- clear() sets closed from outside while this loop drains the queue
    while (waiting.length && (closed || fits(waiting[0].chars))) {
      const next = waiting.shift();
      if (!closed) reserve(next.chars);
      next.resolve();
    }
  }
  function release(id) {
    const capture = captures.get(id);
    if (!capture) return;
    clearTimeout(capture.timer);
    captures.delete(id);
    slots--;
    held -= capture.text.length;
    admit();
  }
  function arm(id, capture) {
    clearTimeout(capture.timer);
    capture.timer = setTimeout(() => release(id), ttlMs);
    capture.timer.unref();
  }
  return {
    mustWait: (chars) => waiting.length > 0 || !fits(chars),
    async capture(text) {
      if (waiting.length || !fits(text.length)) {
        if (waiting.length >= MAX_PENDING)
          throw Object.assign(new Error("Too many large responses are waiting on this connection. Try again."), { code: "PAGES_BUSY" });
        await new Promise((resolve) => waiting.push({ chars: text.length, resolve }));
      } else reserve(text.length);
      if (closed) return null;
      const pageId = ++nextId;
      const capture = { text, pageCount: Math.max(1, Math.ceil(text.length / size)), nextPage: 0, timer: null };
      captures.set(pageId, capture);
      arm(pageId, capture);
      return { pageId, pageCount: capture.pageCount };
    },
    page(pageId, index) {
      const capture = captures.get(pageId);
      if (!capture) throw new Error("This paged response expired. Send the request again.");
      if (!Number.isInteger(index) || index !== capture.nextPage || index >= capture.pageCount)
        throw new Error("This page is out of order. Read the pages from the first, or send the request again.");
      const text = capture.text.slice(index * size, (index + 1) * size);
      if (++capture.nextPage === capture.pageCount) release(pageId);
      else arm(pageId, capture);
      return text;
    },
    usage: () => ({ slots, chars: held }),
    clear() {
      closed = true;
      for (const id of captures.keys()) release(id);
      admit();
    },
  };
}
function acceptConnectionWith(deps, { send, end, destroy, isClosed, requireAuthentication: mustAuthenticate = false, policy = null, openStream = null }) {
  const {
    authenticationToken,
    authTimeoutMs,
    maxFrameBytes,
    pagesTtlMs,
    pagesBudgetChars,
    inlineLimit,
    clients,
    views,
    patchClients,
    methods,
    runtime,
    epoch,
    replyNumber,
    computers,
    windowFocused,
    desktopCommands,
    phone,
    onError,
    encode,
    leanResult,
    replyScope,
    SHOWN_PROJECT,
    close,
    isStopping,
    countUnauthenticated,
  } = deps;
  if (mustAuthenticate && !authenticationToken) throw new Error("requireAuthentication needs a daemon that has an authentication token");
  let authenticated = !mustAuthenticate;
  let challenge;
  let authenticationRejected = false;
  let closed = false;
  if (!authenticated) countUnauthenticated(1);
  const authenticationTimeout = authenticated ? null : setTimeout(destroy, authTimeoutMs);
  authenticationTimeout?.unref();
  const inflight = new Set();
  const noticeClaims = new Set();
  const awaitingPages = new Set();
  const resultPages = createResultPages(maxFrameBytes, { ttlMs: pagesTtlMs, budgetChars: pagesBudgetChars });
  const view = { focused: false, projectPath: null, chatId: null, peer: policy === peerPolicy };
  const context = Object.freeze({ clientId: randomUUID(), ...(openStream ? { openStream } : {}) });
  const key = Symbol("connection");
  const connection = { send, policy };
  if (authenticated) {
    clients.set(key, connection);
    views.set(key, view);
  }
  function authenticate(request, id, validId, fail) {
    const supplied = request?.args?.[0];
    const valid = request?.v === VERSION && validId && request.method === "daemon:authenticate" && Array.isArray(request.args) && request.args.length === 1;
    if (valid && !challenge && validNonce(supplied?.clientNonce)) {
      challenge = { clientNonce: supplied.clientNonce, serverNonce: authenticationNonce() };
      connection.send({
        v: VERSION,
        id,
        result: {
          serverNonce: challenge.serverNonce,
          proof: authenticationProof(authenticationToken, "server", challenge.clientNonce, challenge.serverNonce),
        },
      });
      return;
    }
    if (
      !valid ||
      !challenge ||
      !validToken(authenticationProof(authenticationToken, "client", challenge.clientNonce, challenge.serverNonce), supplied?.proof)
    ) {
      authenticationRejected = true;
      fail("UNAUTHORIZED", "Local daemon authentication is required");
      end();
      return;
    }
    if (closed) return;
    authenticated = true;
    countUnauthenticated(-1);
    clearTimeout(authenticationTimeout);
    clients.set(key, connection);
    views.set(key, view);
    connection.send({ v: VERSION, id, result: { authenticated: true } });
  }
  function refuses(request, id, validId, fail) {
    if (request?.v !== VERSION) {
      fail("VERSION_MISMATCH", `Local protocol version ${VERSION} is required`);
      return true;
    }
    if (!validId || typeof request.method !== "string" || request.method.length > 128 || !Array.isArray(request.args)) {
      fail("INVALID_REQUEST", "Expected id, method and an args array");
      return true;
    }
    if (isStopping()) {
      fail("CLOSING", "The daemon is closing");
      return true;
    }
    if (policy?.denies(request.method)) {
      fail("NOT_AVAILABLE_REMOTELY", "Not available on a remote computer");
      return true;
    }
    if (inflight.has(id) || inflight.size - awaitingPages.size >= MAX_PENDING) {
      fail("TOO_MANY_REQUESTS", "Request ID is in use or too many requests are pending");
      end();
      return true;
    }
    return false;
  }
  async function dispatch(request) {
    const validId = Number.isSafeInteger(request?.id) || (typeof request?.id === "string" && request.id.length <= 128);
    const id = validId ? request.id : null;
    function fail(code, message) {
      connection.send({ v: VERSION, id, error: { code, message } });
    }
    if (authenticationRejected) return;
    if (!authenticated) {
      authenticate(request, id, validId, fail);
      return;
    }
    if (refuses(request, id, validId, fail)) return;
    inflight.add(id);
    async function capturePages(text) {
      if (resultPages.mustWait(text.length)) awaitingPages.add(id);
      try {
        return await resultPages.capture(text);
      } finally {
        awaitingPages.delete(id);
      }
    }
    async function reply(result) {
      const resultJson = encode(leanResult(result, patchClients.get(key)));
      if (request.pages === true && !PAGE_METHODS.has(request.method) && resultJson.length > inlineLimit) {
        const pages = await capturePages(resultJson);
        if (pages) connection.send({ v: VERSION, id, pages });
        return;
      }
      connection.send(null, `{"v":${VERSION},"id":${JSON.stringify(id)},"result":${resultJson}}`);
    }
    try {
      let result = await methods.handle(request, {
        key,
        view,
        policy,
        context,
        connection,
        isClosed,
        connectionClosed: () => closed,
        noticeClaims,
        capturePages,
        resultPages,
      });
      if (result === NO_REPLY) return;
      if (isClosed() && /^(simulator|browser):/.test(request.method)) await runtime.disconnect?.(context.clientId);
      if (request.method === "link:open" && result?.link) {
        view.linkId = result.link.id;
        view.projectPath = null;
      }
      const opensProject = SHOWN_PROJECT.has(request.method) || (request.method === "project:read" && request.args[1] && typeof request.args[1] === "object");
      if (opensProject && result?.path) view.projectPath = result.path;
      const scope = replyScope(request.method, result);
      if (scope) {
        const number = replyNumber(scope, result.state);
        if (number !== null) result = { ...result, version: number, epoch };
      }
      await reply(result ?? null);
      if (request.method === "daemon:stop") void close().catch(onError);
    } catch (error) {
      fail(typeof error.code === "string" ? error.code : "COMMAND_FAILED", error.message);
    } finally {
      inflight.delete(id);
    }
  }
  return {
    receive(request) {
      if (closed) return;
      void dispatch(request).catch((error) => {
        onError(error);
        destroy();
      });
    },
    invalid(error) {
      connection.send({ v: VERSION, id: null, error: { code: error.code, message: error.message } });
      end();
    },
    close() {
      if (closed) return;
      closed = true;
      resultPages.clear();
      clearTimeout(authenticationTimeout);
      if (!authenticated) countUnauthenticated(-1);
      clients.delete(key);
      desktopCommands.disconnect(key);
      views.delete(key);
      computers.setFocused(windowFocused());
      patchClients.delete(key);
      for (const claim of noticeClaims) phone.releaseDeviceNotices(claim);
      noticeClaims.clear();
      Promise.resolve(runtime.disconnect?.(context.clientId)).catch(onError);
    },
  };
}

function createAcceptConnection(deps) {
  return (options) => acceptConnectionWith(deps, options);
}

module.exports = { createAcceptConnection, createResultPages };

const http = require("node:http");
const https = require("node:https");
const { randomBytes } = require("node:crypto");
const { startQuickTunnel } = require("./mobile-tunnel.cjs");

const COOKIE = "__Host-milagre-browser";
const AUTH = "/.milagre-browser-auth/";
const IDLE_MS = 10 * 60_000;

function pageUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Open an HTTP or HTTPS page without credentials in its address.");
  return url;
}

/** One authenticated, origin-preserving HTTP/WebSocket tunnel per page lease. No screenshots or HTML rewriting. */
function createBrowserPageProxy({ tunnel = startQuickTunnel, idleMs = IDLE_MS } = {}) {
  const leases = new Map();
  let closed = false;
  async function release(id) {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    clearTimeout(lease.timer);
    for (const socket of lease.sockets) socket.destroy();
    await Promise.all([lease.tunnel?.close(), new Promise((resolve) => lease.server.close(resolve))]);
  }
  return {
    async open(request) {
      const target = pageUrl(request?.url);
      if (closed) throw new Error("Browser proxy is closed.");
      if (leases.size >= 8) throw new Error("Close a Browser page before opening another proxy.");
      const id = randomBytes(24).toString("hex");
      const secret = randomBytes(32).toString("hex");
      const lease = { server: null, tunnel: null, sockets: new Set(), timer: null };
      const touch = () => {
        clearTimeout(lease.timer);
        lease.timer = setTimeout(() => void release(id), idleMs);
        lease.timer.unref();
      };
      lease.touch = touch;
      const authenticated = (req) => (req.headers.cookie ?? "").split(/;\s*/).includes(`${COOKIE}=${secret}`);
      const headers = (req) => {
        const result = { ...req.headers, host: target.host };
        result.cookie = (result.cookie ?? "")
          .split(/;\s*/)
          .filter((part) => !part.startsWith(`${COOKIE}=`))
          .join("; ");
        if (!result.cookie) delete result.cookie;
        // The upstream sees the origin it serves, including Vite's WebSocket origin check.
        if (result.origin === lease.tunnel?.url) result.origin = target.origin;
        if (result.referer?.startsWith(lease.tunnel?.url + "/")) result.referer = target.origin + result.referer.slice(lease.tunnel.url.length);
        for (const name of Object.keys(result)) if (/^(forwarded|x-forwarded-|cf-)/i.test(name)) delete result[name];
        return result;
      };
      const upstream = (req) =>
        (target.protocol === "https:" ? https : http).request({
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: req.url,
          headers: headers(req),
        });
      const server = http.createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        let address;
        try {
          address = new URL(req.url, "http://localhost");
        } catch {
          res.writeHead(400);
          return res.end("Invalid page address.");
        }
        if (req.method === "GET" && address.pathname === `${AUTH}${secret}`) {
          const requestedPath = address.searchParams.get("path");
          let destination;
          try {
            destination = requestedPath ? new URL(requestedPath, target.origin) : target;
          } catch {
            res.writeHead(400);
            return res.end("Invalid page address.");
          }
          if (destination.origin !== target.origin) {
            res.writeHead(400);
            return res.end("Invalid page address.");
          }
          touch();
          res.writeHead(303, {
            "Set-Cookie": `${COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=None`,
            Location: lease.tunnel.url + destination.pathname + destination.search + destination.hash,
          });
          return res.end();
        }
        if (!authenticated(req)) {
          res.writeHead(401);
          return res.end("Open this page from Milagre.");
        }
        touch();
        const outgoing = upstream(req);
        outgoing.on("response", (response) => {
          // An edge cache must never serve an authenticated response without checking the page cookie again.
          const output = { ...response.headers, "cache-control": "private, no-store" };
          for (const name of ["cdn-cache-control", "cloudflare-cdn-cache-control", "surrogate-control"]) delete output[name];
          if (output.location) {
            try {
              const redirect = new URL(output.location, target.origin + req.url);
              if (redirect.origin === target.origin) output.location = lease.tunnel.url + redirect.pathname + redirect.search + redirect.hash;
            } catch {
              delete output.location;
            }
          }
          if (output["set-cookie"])
            output["set-cookie"] = output["set-cookie"]
              .filter((cookie) => !cookie.startsWith(`${COOKIE}=`))
              .map((cookie) => cookie.replace(/;\s*Domain=[^;]*/gi, ""));
          res.writeHead(response.statusCode, output);
          response.pipe(res);
          response.on("error", () => res.destroy());
        });
        outgoing.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end("The computer could not reach this page. Check that its server is running.");
        });
        res.on("close", () => outgoing.destroy());
        req.pipe(outgoing);
      });
      server.on("connection", (socket) => {
        lease.sockets.add(socket);
        socket.on("close", () => lease.sockets.delete(socket));
      });
      server.on("upgrade", (req, socket, head) => {
        if (!authenticated(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        touch();
        const outgoing = upstream(req);
        outgoing.on("upgrade", (response, peer, peerHead) => {
          lease.sockets.add(peer);
          peer.on("close", () => {
            lease.sockets.delete(peer);
            socket.destroy();
          });
          socket.on("close", () => peer.destroy());
          peer.on("error", () => socket.destroy());
          socket.on("error", () => peer.destroy());
          socket.on("data", touch);
          peer.on("data", touch);
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, i, all) => (i % 2 ? lines : lines + `${value}: ${all[i + 1]}\r\n`), "")}\r\n`,
          );
          if (peerHead.length) socket.write(peerHead);
          if (head.length) peer.write(head);
          socket.pipe(peer).pipe(socket);
        });
        outgoing.on("response", () => socket.destroy());
        outgoing.on("error", () => socket.destroy());
        socket.on("close", () => outgoing.destroy());
        outgoing.end();
      });
      lease.server = server;
      leases.set(id, lease);
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        lease.tunnel = await tunnel({ port: server.address().port });
        if (!leases.has(id) || closed) {
          await lease.tunnel.close();
          throw new Error("Browser proxy was closed.");
        }
        touch();
        return { id, url: `${lease.tunnel.url}${AUTH}${secret}`, origin: lease.tunnel.url };
      } catch (error) {
        await release(id);
        throw error;
      }
    },
    keep(request) {
      const lease = leases.get(request?.id);
      lease?.touch();
      return !!lease;
    },
    release: async (request) => {
      await release(request?.id);
      return null;
    },
    async close() {
      closed = true;
      await Promise.all([...leases.keys()].map(release));
    },
  };
}

module.exports = { createBrowserPageProxy, pageUrl };

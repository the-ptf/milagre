// Lighthouse budget for the landing page: builds the site, serves it compressed the way Cloudflare does, and fails when
// any category's median of three runs drops below apps/site/lighthouse-budget.json, on mobile or on desktop.
// npm test -- --only lighthouse
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "apps/site/dist");
const budget = require("../apps/site/lighthouse-budget.json");
const RUNS = 3;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".json": "application/json",
};

// The built site, Brotli-compressed with the cache headers from public/_headers, as the Worker serves it in production.
function serve() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/api/stars") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ stars: 1234 }));
    }
    let file = path.join(dist, pathname);
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    const type = types[path.extname(file)] || "application/octet-stream";
    const cache = /^\/(_astro|demo|logos)\/|^\/icons\.svg$/.test(pathname) ? "public, max-age=2592000" : "public, max-age=0, must-revalidate";
    const body = fs.readFileSync(file);
    const compress = /text|javascript|svg|json|xml/.test(type) && /\bbr\b/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ...(compress ? { "Content-Encoding": "br" } : {}) });
    res.end(compress ? zlib.brotliCompressSync(body) : body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
  const built = spawnSync("npm", ["run", "build:site"], { cwd: root, stdio: "inherit" });
  assert.equal(built.status, 0, "the site builds");
  const { default: lighthouse } = await import("lighthouse");
  const chromeLauncher = await import("chrome-launcher");
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless=new", "--no-sandbox"] });
  const failures = [];
  try {
    for (const [formFactor, floors] of Object.entries(budget).filter(([key]) => key === "mobile" || key === "desktop")) {
      const config = formFactor === "desktop" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
      const scores = {};
      for (let run = 0; run < RUNS; run++) {
        const result = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error", skipAudits: budget.skipAudits }, config);
        for (const [id, category] of Object.entries(result.lhr.categories)) (scores[id] ??= []).push(Math.round(category.score * 100));
      }
      for (const [id, floor] of Object.entries(floors)) {
        const score = median(scores[id]);
        console.log(`${formFactor} ${id}: ${score} (runs ${scores[id].join(", ")}, budget ${floor})`);
        if (score < floor) failures.push(`${formFactor} ${id} ${score} < ${floor}`);
      }
    }
  } finally {
    await chrome.kill();
    server.close();
  }
  assert.deepEqual(failures, [], "every Lighthouse category meets apps/site/lighthouse-budget.json");
  console.log("PASS: Lighthouse scores meet the budget on mobile and desktop");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

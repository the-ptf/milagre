const https = require("node:https");
const dns = require("node:dns/promises");
const { isIP } = require("node:net");
const { isSnapshotRaster } = require("@milagre/shared/design-page");
const { resizeImagePng, imageSize } = require("./design-raster.cjs");

// A design's image src holds at most 500,000 characters. A larger download is redrawn at the size the design shows it.
const MAX_SRC = 500_000;
const MAX_DOWNLOAD = 20 * 1024 * 1024;

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Permit ordinary global-unicast IPv6 only. Reject mapped IPv4, NAT64, Teredo, 6to4 and documentation ranges.
  if (isIP(address) !== 6) return false;
  const [first, second] = address.split(":").map((part) => parseInt(part || "0", 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

// The design view loads images through Chromium, so downloads send the headers Chromium sends for an <img>:
// CDN bot rules (CloudFront, Cloudflare, Akamai) answer 403 to requests that don't look like a browser.
// The Accept list stays to the formats a shared page can embed, so content negotiation never picks AVIF.
const chrome = (process.versions.chrome ?? "152.0.0.0").split(".")[0];
const IMAGE_HEADERS = {
  accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
  "sec-fetch-dest": "image",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "cross-site",
};
const transient = (error) => error.retryable === true || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(error.code);

/** DNS answers are checked and pinned to the socket; every redirect goes through the same checks. */
async function fetchRaster(source, { lookup = dns.lookup, request = https.request, signal } = {}, redirects = 0) {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw Error("Shared images must use public HTTPS URLs.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  signal?.throwIfAborted();
  let abortLookup;
  let addresses;
  try {
    const resolution = lookup(hostname, { all: true });
    addresses = signal
      ? await Promise.race([
          resolution,
          new Promise((_resolve, reject) => {
            abortLookup = () => reject(signal.reason);
            signal.addEventListener("abort", abortLookup, { once: true });
          }),
        ])
      : await resolution;
  } finally {
    if (abortLookup) signal.removeEventListener("abort", abortLookup);
  }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw Error("A design image points to a private network address and cannot be shared.");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        headers: IMAGE_HEADERS,
        lookup: (_hostname, options, callback) => (options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          if (redirects >= 3 || !response.headers.location) return reject(Error("A design image redirected too many times."));
          let destination;
          try {
            destination = new URL(response.headers.location, url).href;
          } catch {
            return reject(Error("A design image returned an invalid redirect URL."));
          }
          return resolve(fetchRaster(destination, { lookup, request, signal }, redirects + 1));
        }
        if (response.statusCode !== 200) {
          response.destroy();
          return reject(
            Error(`A design image from ${url.hostname} could not be downloaded (HTTP ${response.statusCode}). Replace it before sharing this page.`),
          );
        }
        const type = String(response.headers["content-type"] ?? "")
          .split(";")[0]
          .toLowerCase();
        if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) {
          response.destroy();
          return reject(Error("Shared images must be PNG, JPEG, GIF or WebP files."));
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_DOWNLOAD) {
            response.destroy();
            reject(Error(`A design image from ${url.hostname} is larger than 20 MB. Replace it before sharing this page.`));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const data = `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
          if (!isSnapshotRaster(data)) return reject(Error("A design image did not contain the declared raster format."));
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(Object.assign(Error(`A design image from ${url.hostname} took too long to download.`), { retryable: true })));
    req.end();
  });
}

/** Fits an image under MAX_SRC: redrawn as a PNG that covers its largest drawn box at 2x, then 1x, never enlarged. */
async function fitImage(data, box, resize) {
  if (data.length <= MAX_SRC) return data;
  const size = imageSize(Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
  if (size) {
    for (const density of [2, 1]) {
      const scale = Math.min(1, Math.max((box.width * density) / size.width, (box.height * density) / size.height));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      const smaller = await resize(data, width, height).catch(() => null);
      if (smaller && smaller.length <= MAX_SRC && isSnapshotRaster(smaller)) return smaller;
    }
  }
  throw Error("A design image is too large to embed, even at the size the design shows it. Replace it before sharing this page.");
}

async function embedPageImages(snapshot, { fetchImage = fetchRaster, resize = resizeImagePng } = {}) {
  const result = structuredClone(snapshot);
  const images = new Map();
  const signal = AbortSignal.timeout(30_000);
  // The largest box each image is drawn in across the page, so one download serves every use.
  const boxes = new Map();
  for (const design of result.designs)
    for (const node of design.document.nodes) {
      if (node.type !== "image" || !/^https:/i.test(node.src ?? "")) continue;
      const box = boxes.get(node.src) ?? { width: 1, height: 1 };
      boxes.set(node.src, { width: Math.max(box.width, node.width ?? 1), height: Math.max(box.height, node.height ?? 1) });
    }
  for (const design of result.designs) {
    for (const node of design.document.nodes) {
      if (node.type !== "image" || !/^https:/i.test(node.src ?? "")) continue;
      if (!images.has(node.src)) {
        if (images.size >= 40) throw Error("A shared page can embed up to 40 distinct remote images.");
        // One retry covers a rate limit, a server hiccup or a dropped connection; the page deadline bounds both tries.
        const download = () => fetchImage(node.src, { signal });
        const data = await download().catch((error) => {
          if (!transient(error) || signal.aborted) throw error;
          return new Promise((resolve) => setTimeout(resolve, 1000)).then(download);
        });
        images.set(node.src, await fitImage(data, boxes.get(node.src), resize));
      }
      node.src = images.get(node.src);
    }
  }
  return result;
}
module.exports = { publicAddress, fetchRaster, embedPageImages, IMAGE_HEADERS };

const https = require("node:https");
const dns = require("node:dns/promises");
const { isIP } = require("node:net");
const { isSnapshotRaster } = require("@milagre/shared/design-page");

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
        // CDN bot rules (CloudFront, Cloudflare) answer 403 to requests without a User-Agent.
        headers: { accept: "image/png,image/jpeg,image/gif,image/webp", "user-agent": "Milagre (+https://milagre.cloud)" },
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
          if (size > 374_000) {
            response.destroy();
            reject(Error("A design image is too large to embed. Use an image smaller than 374 KB."));
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
    req.setTimeout(10_000, () => req.destroy(Error("A design image took too long to download.")));
    req.end();
  });
}

async function embedPageImages(snapshot, { fetchImage = fetchRaster } = {}) {
  const result = structuredClone(snapshot);
  const images = new Map();
  const signal = AbortSignal.timeout(30_000);
  for (const design of result.designs) {
    for (const node of design.document.nodes) {
      if (node.type !== "image" || !/^https:/i.test(node.src ?? "")) continue;
      if (!images.has(node.src)) {
        if (images.size >= 40) throw Error("A shared page can embed up to 40 distinct remote images.");
        images.set(node.src, await fetchImage(node.src, { signal }));
      }
      node.src = images.get(node.src);
    }
  }
  return result;
}
module.exports = { publicAddress, fetchRaster, embedPageImages };

// The renderer cannot fetch external URLs under the packaged app's CSP.
function createReleaseNotes({ fetch = globalThis.fetch } = {}) {
  const cache = new Map();
  return async (version) => {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error("Invalid release version");
    if (cache.has(version)) return cache.get(version);
    const response = await fetch(`https://api.github.com/repos/the-ptf/milagre-ade/releases/tags/v${version}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return "";
    if (!response.ok) throw new Error("Could not load release notes");
    const release = await response.json();
    const notes = typeof release.body === "string" ? release.body.trim() : "";
    cache.set(version, notes);
    return notes;
  };
}
module.exports = { createReleaseNotes };

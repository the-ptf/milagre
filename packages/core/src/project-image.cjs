const fs = require("node:fs/promises");
const { createGit } = require("./git/client.cjs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { scheduled } = require("./process-lanes.cjs");

const execFileAsync = scheduled(promisify(execFile));
const client = createGit().read;
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function git(projectPath, ...args) {
  const { stdout } = await client.checked(projectPath, args);
  return stdout.trim();
}

async function localImage(projectPath) {
  let config = {};
  try {
    const file = path.join(projectPath, "package.json");
    if ((await fs.stat(file)).size <= MAX_BYTES) config = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  const extensions = Object.keys(MIME_TYPES);
  const candidates = [
    ...extensions.map((extension) => `.milagre/icon${extension}`),
    config.build?.mac?.icon,
    config.build?.icon,
    config.expo?.icon,
    ...["logo", "icon", "public/logo", "public/icon", "app/public/logo", "app/public/app-icon", "assets/icon"].flatMap((base) =>
      extensions.map((extension) => `${base}${extension}`),
    ),
    ...["favicon", "public/favicon", "app/public/favicon", "app/favicon", "src/app/favicon", "static/favicon", "app/icon", "src/app/icon"].flatMap((base) =>
      extensions.map((extension) => `${base}${extension}`),
    ),
  ];
  const root = await fs.realpath(projectPath);
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const mime = MIME_TYPES[path.extname(candidate).toLowerCase()];
    if (!mime) continue;
    try {
      const file = await fs.realpath(path.resolve(root, candidate));
      const relative = path.relative(root, file);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) continue;
      return `data:${mime};base64,${(await fs.readFile(file)).toString("base64")}`;
    } catch {}
  }
  return null;
}

function githubOwner(remote) {
  // Only GitHub remotes; do not send arbitrary Git hosts to the GitHub API.
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([a-zA-Z0-9-]+)\/[^/\s]+\/?$/.exec(remote);
  return match?.[1] ?? null;
}

async function githubAccount(endpoint, projectPath) {
  try {
    const { stdout } = await execFileAsync("gh", ["api", "--hostname", "github.com", endpoint, "--jq", "{type,avatar_url}"], {
      cwd: projectPath,
      timeout: 4000,
      maxBuffer: 64 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    if (endpoint === "user") return null; // Authenticated profiles require gh credentials.
    try {
      const response = await fetch(`https://api.github.com/${endpoint}`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(3000),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }
}

function avatar(account) {
  if (typeof account?.avatar_url !== "string") return null;
  try {
    const url = new URL(account.avatar_url);
    if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com" || url.username || url.password) return null;
    url.searchParams.set("s", "80");
    return url.href;
  } catch {
    return null;
  }
}

async function resolveProjectImage(projectPath, { account = githubAccount, readGit = git } = {}) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw new Error("An absolute project path is required");
  const image = await localImage(projectPath);
  if (image) return image;

  let owner = null;
  try {
    owner = githubOwner(await readGit(projectPath, "remote", "get-url", "origin"));
  } catch {}
  const ownerAccount = owner ? await account(`users/${owner}`, projectPath) : null;
  if (ownerAccount?.type === "Organization" && avatar(ownerAccount)) return avatar(ownerAccount);
  const profile = avatar(await account("user", projectPath));
  if (profile) return profile;
  // Without a logged-in CLI, a personal repository still identifies a Git profile.
  return ownerAccount?.type === "User" ? avatar(ownerAccount) : null;
}

module.exports = { resolveProjectImage, githubOwner };

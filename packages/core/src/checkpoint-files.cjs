// A short-lived process pins its working directory before traversing a Worktree.
// Every mutating syscall uses a basename relative to that pinned directory, never
// an absolute path whose ancestors another process could replace with symlinks.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SECRET_NAME =
  /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(rsa|dsa|ecdsa|ed25519)(?:\..*)?|[^/]+\.(pem|key|p12|pfx|keystore))$/i;
const ARTIFACT =
  /(^|\/)(\.git|\.milagre|\.milagre-restore-[^/]+|node_modules|dist|build|coverage|\.next|\.expo|\.cache|\.ssh|\.aws|\.gnupg|\.kube|\.private_keys|secrets|credentials)(\/|$)/;
const secretContent = (bytes) =>
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})\b/.test(
    bytes.toString("utf8"),
  );
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
function partsFor(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.isAbsolute(name) ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid checkpoint path");
  return name.split("/");
}
const excluded = (name, patterns) => ARTIFACT.test(name) || SECRET_NAME.test(name) || patterns.some((p) => path.matchesGlob(name, p));
const sizeOf = (name) => {
  try {
    return fs.lstatSync(name).size;
  } catch {
    return 0;
  }
};
function execute(request) {
  const { root, identity, op } = request;
  const atRoot = () => {
    process.chdir(root);
    if (!sameInode(fs.statSync("."), identity)) throw new Error("Checkpoint Worktree identity changed");
  };
  const parent = (name, create = false) => {
    const parts = partsFor(name);
    atRoot();
    for (const part of parts.slice(0, -1)) {
      let stat;
      try {
        stat = fs.lstatSync(part);
      } catch (error) {
        if (error.code !== "ENOENT" || !create) throw error;
        fs.mkdirSync(part);
        stat = fs.lstatSync(part);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkpoint path is not a regular directory");
      process.chdir(part);
      if (!sameInode(fs.statSync("."), stat)) throw new Error("Checkpoint directory changed");
    }
    return parts.at(-1);
  };
  const bytesAt = (name, limit = MAX_FILE) => {
    let fd;
    try {
      const leaf = parent(name);
      const before = fs.lstatSync(leaf);
      if (!before.isFile() || before.nlink > 1) return { blocked: true };
      // O_NONBLOCK also covers a regular file swapped for a FIFO after lstat.
      fd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1 || !sameInode(before, stat)) return { blocked: true };
      // A file past 5 MiB stays out of checkpoints, like secrets and artifacts. Only the ignore file's own limit is an error.
      if (stat.size > limit) {
        if (limit === MAX_FILE) return { blocked: true };
        throw new Error(`Checkpoint file exceeds ignore-file limit: ${name}`);
      }
      // A bounded read prevents a concurrently growing file exhausting host memory.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!n) break;
        offset += n;
      }
      const end = fs.fstatSync(fd);
      if (offset > limit || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || offset !== stat.size)
        throw new Error(`File changed during checkpoint read: ${name}`);
      return { bytes: buffer.subarray(0, offset), mode: stat.mode & 0o777 };
    } catch (error) {
      if (error.code === "ENOENT") return { entry: null };
      if (["ENOTDIR", "ELOOP", "ENXIO"].includes(error.code) || /not a regular directory|directory changed/.test(error.message)) return { blocked: true };
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const readRules = () => {
    const found = bytesAt(".milagre/checkpoint-ignore", 64 * 1024);
    if (found.blocked) throw new Error("Checkpoint ignore file must be a regular file");
    return found.bytes
      ? found.bytes
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"))
      : [];
  };

  const read = (name, patterns) => {
    if (excluded(name, patterns)) return { blocked: true };
    const found = bytesAt(name);
    if (!found.bytes) return found;
    if (secretContent(found.bytes)) return { blocked: true };
    return { entry: { hash: hash(found.bytes), mode: found.mode }, bytes: found.bytes };
  };
  atRoot();
  const patterns = readRules();
  if (op === "scan" || op === "inspect") {
    const files = Object.create(null),
      blocked = [];
    // The Worktrees of a shared Chat split one budget (see checkpoints.cjs).
    const budget = Math.min(request.budget ?? MAX_TOTAL, MAX_TOTAL);
    let total = 0;
    if (op === "scan") fs.mkdirSync(request.blobDirectory, { recursive: true, mode: 0o700 });
    // Smallest first: past the budget the largest files stay out, so the source an agent edits stays covered.
    // A size read here only orders the files; each read below checks its file again.
    atRoot();
    const sizes = new Map(request.names.map((name) => [name, sizeOf(name)]));
    for (const name of request.names.toSorted((a, b) => sizes.get(a) - sizes.get(b))) {
      const found = read(name, patterns);
      if (found.blocked || (found.entry && total + found.bytes.length > budget)) {
        blocked.push(name);
        continue;
      }
      if (!found.entry) continue;
      total += found.bytes.length;
      files[name] = found.entry;
      if (op === "scan") {
        const dest = path.join(request.blobDirectory, found.entry.hash);
        if (!fs.existsSync(dest)) {
          const temp = dest + "." + randomUUID();
          try {
            fs.writeFileSync(temp, found.bytes, { flag: "wx", mode: 0o600 });
            fs.renameSync(temp, dest);
          } finally {
            fs.rmSync(temp, { force: true });
          }
        }
      }
    }
    atRoot();
    return { files, blocked, patterns, total };
  }
  if (op !== "apply") throw new Error("Invalid checkpoint file operation");
  let restored = 0;
  try {
    const verify = (file) => {
      const found = read(file.path, readRules());
      if (found.blocked || !same(found.entry, file.expected)) throw new Error("Files changed. Preview again before restoring");
    };
    // Preflight the entire group before writing, then recheck each file next to its write.
    for (const file of request.files) verify(file);
    for (const file of request.files) {
      verify(file);
      const leaf = parent(file.path, !!file.target);
      if (!file.target) {
        fs.unlinkSync(leaf);
        restored++;
        continue;
      }
      const bytes = fs.readFileSync(path.join(request.blobDirectory, file.target.hash));
      if (hash(bytes) !== file.target.hash || secretContent(bytes)) throw new Error("Checkpoint data failed verification");
      // Restore through the verified descriptor. No path-based chmod or
      // rename source can be redirected by swapping a temporary leaf.
      let fd, readOnlyFd, previousMode;
      let complete = false;
      const descriptor = (handle) => {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE) throw new Error("Checkpoint target is not a regular file");
        const current = Buffer.alloc(stat.size + 1);
        const length = fs.readSync(handle, current, 0, current.length, 0);
        if (length !== stat.size) throw new Error("File changed during checkpoint read");
        return { stat, entry: { hash: hash(current.subarray(0, length)), mode: stat.mode & 0o777 } };
      };
      try {
        let expected = file.expected;
        try {
          fd = fs.openSync(
            leaf,
            fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (expected ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
            0o600,
          );
        } catch (error) {
          if (error.code !== "EACCES" || !expected) throw error;
          readOnlyFd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          const before = descriptor(readOnlyFd);
          if (!same(before.entry, expected) || !sameInode(fs.lstatSync(leaf), before.stat)) throw new Error("Checkpoint target changed", { cause: error });
          previousMode = before.entry.mode;
          fs.fchmodSync(readOnlyFd, previousMode | 0o200);
          fd = fs.openSync(leaf, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          if (!sameInode(fs.fstatSync(fd), before.stat)) throw new Error("Checkpoint target changed", { cause: error });
          expected = { ...expected, mode: previousMode | 0o200 };
        }
        const { stat, entry } = descriptor(fd);
        if (expected && !same(entry, expected)) throw new Error("Files changed. Preview again before restoring");
        if (!sameInode(fs.lstatSync(leaf), stat)) throw new Error("Checkpoint target changed");
        fs.ftruncateSync(fd, 0);
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        fs.fchmodSync(fd, file.target.mode);
        fs.fsyncSync(fd);
        const final = fs.lstatSync(leaf);
        if (!final.isFile() || !sameInode(final, stat)) throw new Error("Checkpoint target changed during restore");
        complete = true;
        restored++;
      } finally {
        if (readOnlyFd !== undefined) {
          try {
            if (!complete && previousMode !== undefined) fs.fchmodSync(readOnlyFd, previousMode);
          } finally {
            fs.closeSync(readOnlyFd);
          }
        }
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    return { restored };
  } catch (error) {
    error.restored = restored;
    throw error;
  }
}
if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
      process.stdout.write(JSON.stringify({ result: execute(JSON.parse(input)) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message, restored: error.restored ?? 0 }));
      process.exitCode = 1;
    }
  });
}
module.exports = { execute };

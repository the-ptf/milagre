const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const git = require("./git/client.cjs").createGit({ analysisOnly: true }).read;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const includes = (rule, file) => file === rule || file.startsWith(rule + "/") || rule === ".";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LIMITS =
  "Only observed Worktree changes are checked. Shell commands, external files, ignored files outside protected paths, and changes reverted between checks may escape detection. Other writers can cause warnings. Existing permission rules still apply.";

function relativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:|^\\\\/.test(value))
    throw Error("Use a Worktree-relative file or directory path.");
  const name = value.trim().replaceAll("\\", "/").replace(/\/$/, "");
  if (name.split("/").includes("..") || name.split("/").includes(".git")) throw Error("Parent paths and .git are outside edit scope.");
  return path.posix.normalize(name);
}
function canonical(file, links = 0) {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // realpath returns ENOENT for dangling links too. Resolve their destination before
    // appending missing path components so an absent target cannot hide an escape.
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    if (stat?.isSymbolicLink()) {
      if (links >= 40) throw Error("Too many symbolic links", { cause: error });
      return canonical(path.resolve(path.dirname(file), fs.readlinkSync(file)), links + 1);
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent, links), path.basename(file));
  }
}
function policyFor(value, roots) {
  if (value === null) return null;
  if (!value || !Array.isArray(value.allowed) || !Array.isArray(value.protected) || value.allowed.length + value.protected.length > 128)
    throw Error("Choose allowed and protected paths (at most 128).");
  const rules = (list) =>
    list.map((item) => {
      if (!item || !roots.includes(item.root)) throw Error("Choose a Worktree owned by this Chat.");
      const name = relativePath(item.path);
      if (canonical(item.root) !== item.root || !within(item.root, canonical(path.resolve(item.root, name))))
        throw Error("A scope path resolves outside its Worktree.");
      return { root: item.root, path: name };
    });
  return { allowed: rules(value.allowed), protected: rules(value.protected) };
}
function violation(policy, roots, file, cwd) {
  if (!policy) return null;
  try {
    if (typeof file !== "string" || !file || file.includes("\0")) return "The edit has no valid file path.";
    const absolute = path.resolve(cwd, file),
      real = canonical(absolute);
    const root = roots.find((candidate) => within(candidate, absolute) && within(candidate, real) && canonical(candidate) === candidate);
    if (!root) return "The edit resolves outside the Chat's scoped Worktrees.";
    const names = [path.relative(root, absolute), path.relative(root, real)].map((name) => name.split(path.sep).join("/") || ".");
    if (names.some((name) => name.split("/").includes(".git"))) return "Git metadata is outside edit scope.";
    const matches = (rule, name, protectedPath = false) => {
      if (rule.root !== root) return false;
      const resolved =
        path
          .relative(root, canonical(path.resolve(root, rule.path)))
          .split(path.sep)
          .join("/") || ".";
      const fold = (text) => (process.platform === "win32" || (protectedPath && process.platform === "darwin") ? text.toLowerCase() : text);
      return [rule.path, resolved].some((candidate) => includes(fold(candidate), fold(name)));
    };
    if (policy.protected.some((rule) => names.some((name) => matches(rule, name, true)))) return "This path is protected by the active edit scope.";
    if (!names.every((name) => policy.allowed.some((rule) => matches(rule, name)))) return "This path is outside the active allowed paths.";
    return null;
  } catch {
    return "The edit path could not be checked safely.";
  }
}

/** Content fingerprints, never file contents. Git supplies tracked and nonignored names; explicit protected paths add ignored files. */
async function snapshot(roots, policy) {
  const files = {},
    errors = [],
    excluded = [];
  let bytes = 0,
    count = 0;
  for (const root of roots) {
    try {
      if ((await fsp.realpath(root)) !== root) throw Error("Worktree identity changed");
      const names = new Set((await git.text(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean));
      const addProtected = async (name) => {
        if (++count > 20000) throw Error("Observation file limit reached");
        const full = path.resolve(root, name);
        if (!within(root, full) || !within(root, canonical(path.dirname(full)))) throw Error("Protected directory changed");
        let stat;
        try {
          stat = await fsp.lstat(full);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        if (stat.isDirectory()) {
          for (const child of await fsp.readdir(full)) if (child !== ".git") await addProtected(path.join(name, child));
        } else names.add(name);
      };
      for (const entry of policy.protected.filter((rule) => rule.root === root)) await addProtected(entry.path);
      for (const name of names) {
        if (++count > 20000) throw Error("Observation file limit reached");
        const full = path.resolve(root, name),
          key = JSON.stringify([root, name]);
        // Allowed paths need no content read. Protected paths always win, including their canonical targets.
        if (!violation(policy, roots, full, root)) continue;
        if (!within(root, full) || !within(root, canonical(path.dirname(full)))) {
          errors.push("A changed or aliased directory could not be observed.");
          continue;
        }
        let handle;
        try {
          const stat = await fsp.lstat(full);
          if (stat.isSymbolicLink()) {
            files[key] = digest("symlink:" + (await fsp.readlink(full)));
            continue;
          }
          if (!stat.isFile()) {
            if (!stat.isDirectory()) errors.push("A nonregular file could not be observed.");
            continue;
          }
          bytes += stat.size;
          if (stat.size > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw Error("Observation byte limit reached");
          handle = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          const before = await handle.stat();
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || !within(root, canonical(path.dirname(full))))
            throw Error("File changed during observation");
          const hash = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
          const after = await handle.stat();
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            !within(root, canonical(path.dirname(full)))
          )
            throw Error("File changed during observation");
          files[key] = `${stat.mode}:${hash.digest("hex")}`;
        } catch (error) {
          if (error.code !== "ENOENT") {
            excluded.push(key);
            errors.push(error.message);
          }
        } finally {
          await handle?.close();
        }
      }
    } catch (error) {
      excluded.push(JSON.stringify([root]));
      errors.push(error.message);
    }
  }
  return { files, excluded, errors: [...new Set(errors)] };
}

class EditScopes {
  constructor({ file, roots, busy = () => false, pollMs = 3000, capture = snapshot }) {
    Object.assign(this, { file, roots, busy, pollMs, capture });
    this.items = {};
    this.active = new Map();
    this.queues = new Map();
    this.failures = new Map();
    try {
      this.items = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") this.loadError = "Saved edit scopes could not be read. Restore the host's edit-scopes.json before running scoped work.";
    }
    for (const item of Object.values(this.items))
      if (item.monitoring) {
        item.warnings = [
          ...(item.warnings ?? []),
          { kind: "incomplete", message: "Observation was interrupted by a host restart. Changes during downtime were not checked.", at: Date.now() },
        ];
        item.monitoring = false;
      }
  }
  serial(chatId, run) {
    const result = (this.queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(chatId, result);
    const clear = () => {
      if (this.queues.get(chatId) === result) this.queues.delete(chatId);
    };
    void result.then(clear, clear);
    return result;
  }
  item(chatId) {
    if (this.loadError) throw Error(this.loadError);
    return this.items[chatId] ?? { revision: 0, policy: null, warnings: [] };
  }
  put(chatId, value) {
    const next = { ...this.items, [chatId]: value },
      temporary = this.file + "." + randomUUID() + ".tmp";
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.items = next;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  async read(chatId) {
    const roots = await this.roots(chatId),
      item = this.item(chatId);
    return structuredClone({
      ...item,
      warnings: [...item.warnings, ...(this.failures.has(chatId) ? [this.failures.get(chatId)] : [])],
      roots,
      busy: this.busy(chatId) || this.active.has(chatId),
      limits: LIMITS,
      capability:
        "Claude file-edit hooks block out-of-scope edits. Codex and ACP block only edit approval requests that reach Milagre. All providers also use periodic host observation; commands are detection only.",
    });
  }
  save(chatId, revision, value) {
    return this.serial(chatId, async () => {
      const item = this.item(chatId);
      if (revision !== item.revision) throw Error("Edit scope changed. Reload before saving.");
      if (this.busy(chatId) || this.active.has(chatId)) throw Error("Stop this Chat and its background work before changing its edit scope.");
      const policy = policyFor(value, await this.roots(chatId));
      this.put(chatId, { ...item, revision: item.revision + 1, policy, pending: undefined, queuedPolicy: undefined });
      return this.read(chatId);
    });
  }
  request(chatId, value, reason) {
    return this.serial(chatId, async () => {
      const item = this.item(chatId);
      if (!item.policy) throw Error("This Chat has no active edit scope to expand.");
      if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) throw Error("Give a short reason for the requested scope.");
      const policy = policyFor(value, await this.roots(chatId));
      const pending = { id: randomUUID(), policy, reason, revision: item.revision };
      this.put(chatId, { ...item, pending });
      return {
        pending: true,
        id: pending.id,
        message: "The requested paths await the user's review in Edit scope. The active scope is unchanged. Stop and wait for approval, then start a new turn.",
      };
    });
  }
  resolve(chatId, id, approved) {
    return this.serial(chatId, async () => {
      const item = this.item(chatId);
      if (!item.pending || item.pending.id !== id || item.pending.revision !== item.revision) throw Error("This scope request is no longer current.");
      if (typeof approved !== "boolean") throw Error("Choose Approve or Decline.");
      const policy = approved ? policyFor(item.pending.policy, await this.roots(chatId)) : undefined;
      const busy = this.busy(chatId) || this.active.has(chatId);
      this.put(chatId, {
        ...item,
        pending: undefined,
        ...(approved ? (busy ? { queuedPolicy: policy } : { policy, revision: item.revision + 1, queuedPolicy: undefined }) : {}),
      });
      return this.read(chatId);
    });
  }
  begin(chatId, roots, continued = false) {
    return this.serial(chatId, async () => {
      if (this.active.has(chatId)) {
        if (continued) return this.context(chatId);
        await this.captureActive(chatId, true, true);
      }
      let item = this.item(chatId);
      if (item.queuedPolicy) {
        item = { ...item, policy: policyFor(item.queuedPolicy, roots), queuedPolicy: undefined, revision: item.revision + 1 };
      }
      if (!item.policy) return "";
      const policy = policyFor(item.policy, roots),
        before = await this.capture(roots, policy);
      const active = { policy, roots, before, timer: null };
      this.put(chatId, {
        ...item,
        monitoring: true,
        warnings: [...item.warnings, ...before.errors.map((message) => ({ kind: "incomplete", message, at: Date.now() }))].slice(-100),
      });
      this.active.set(chatId, active);
      this.schedule(chatId, active);
      return this.context(chatId);
    });
  }
  context(chatId) {
    const active = this.active.get(chatId);
    return active
      ? `Active edit scope (host policy): ${JSON.stringify(active.policy)}\n${LIMITS}\nRequest scope changes with edit_scope_request; a request never grants permission. User approval takes effect only on a new turn.`
      : "";
  }
  check(chatId, files, cwd) {
    const active = this.active.get(chatId);
    if (!active) return this.item(chatId).policy ? "The edit scope has no active observation. Start a new turn before editing." : null;
    if (!Array.isArray(files) || !files.length) return "The edit's paths could not be checked against its scope.";
    return files.map((file) => violation(active.policy, active.roots, file, cwd)).find(Boolean) ?? null;
  }
  schedule(chatId, active) {
    if (this.closed) return;
    active.timer = setTimeout(() => {
      void this.observe(chatId).catch(() => {});
    }, this.pollMs);
    active.timer.unref?.();
  }
  observe(chatId, ended = true) {
    return this.serial(chatId, async () => {
      try {
        await this.captureActive(chatId, ended);
        this.failures.delete(chatId);
      } catch (error) {
        this.failures.set(chatId, { kind: "incomplete", at: Date.now(), message: "Edit scope observation failed: " + error.message });
        const active = this.active.get(chatId);
        if (active) this.schedule(chatId, active);
        throw error;
      }
    });
  }
  async captureActive(chatId, ended, boundary = false) {
    const active = this.active.get(chatId);
    if (!active) return;
    clearTimeout(active.timer);
    const after = await this.capture(active.roots, active.policy),
      warnings = [];
    const excluded = new Set([...(active.before.excluded ?? []), ...(after.excluded ?? [])]);
    for (const key of new Set([...Object.keys(active.before.files), ...Object.keys(after.files)])) {
      const [scopeRoot] = JSON.parse(key);
      if (excluded.has(key) || excluded.has(JSON.stringify([scopeRoot])) || active.before.files[key] === after.files[key]) continue;
      const [root, name] = JSON.parse(key);
      warnings.push({
        kind: "outside",
        root,
        path: name,
        at: Date.now(),
        message: "An out-of-scope change was observed. It may have been made by this Chat or another writer.",
      });
    }
    for (const message of after.errors) warnings.push({ kind: "incomplete", message, at: Date.now() });
    const done = boundary || (ended && !this.busy(chatId)),
      item = this.item(chatId);
    this.put(chatId, { ...item, monitoring: !done, lastChecked: Date.now(), warnings: [...item.warnings, ...warnings].slice(-100) });
    active.before = after;
    if (done) this.active.delete(chatId);
    else this.schedule(chatId, active);
  }
  async close() {
    this.closed = true;
    for (const active of this.active.values()) clearTimeout(active.timer);
    await Promise.all([...this.active.keys()].map((id) => this.serial(id, () => this.captureActive(id, true, true))));
    for (const active of this.active.values()) clearTimeout(active.timer);
  }
}
function editScopeToolDefinitions(chatId, scopes) {
  const { z } = require("zod");
  const rule = z.object({ root: z.string().min(1).max(8192), path: z.string().min(1).max(4096) });
  return [
    {
      name: "edit_scope_request",
      description:
        "Request revised allowed and protected edit paths for this Chat. Only the user can approve them in Edit scope; the current turn never gains access. Stop and wait for a new turn. Use Worktree roots from edit_scope_read.",
      input: { allowed: z.array(rule).max(128), protected: z.array(rule).max(128), reason: z.string().min(1).max(2000) },
      readOnly: false,
      run: async ({ reason, ...policy }) => JSON.stringify(await scopes.request(chatId, policy, reason)),
    },
    {
      name: "edit_scope_read",
      description: "Read this Chat's active edit scope, owned Worktree roots, observation warnings and pending expansion.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify(await scopes.read(chatId)),
    },
  ];
}
module.exports = { EditScopes, policyFor, violation, snapshot, editScopeToolDefinitions };

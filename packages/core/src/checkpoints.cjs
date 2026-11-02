const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createGit } = require("./git/client.cjs");
const git = createGit({ analysisOnly: true }).read;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const entryAt = (files, name) => (files && Object.hasOwn(files, name) ? files[name] : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const summary = (item) => ({
  id: item.id,
  createdAt: item.createdAt,
  completedAt: item.completedAt,
  kind: item.kind,
  permissionMode: item.permissionMode,
  excluded: item.excluded,
  // The message that started the task, its text, and how many files the task changed (once it ended).
  ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
  ...(item.prompt ? { prompt: item.prompt } : {}),
  ...(item.changed !== undefined ? { changed: item.changed } : {}),
});
/** Files whose content differs between two captures of the same Worktrees, excluded files left out. */
function changedCount(before, after) {
  let count = 0;
  for (const [index, start] of before.entries()) {
    const end = after[index];
    for (const name of new Set([...Object.keys(start.files), ...Object.keys(end?.files ?? {})]))
      if (!start.blocked.includes(name) && !end?.blocked.includes(name) && !same(entryAt(start.files, name), entryAt(end?.files, name))) count++;
  }
  return count;
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID();
  try {
    await fs.writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function identity(root) {
  // Git for Windows uses forward slashes and can spell the drive differently from Node.
  if ((await fs.realpath(root)) !== root || (await fs.realpath((await git.text(root, ["rev-parse", "--show-toplevel"])).trim())) !== root)
    throw new Error("Checkpoint Worktree identity changed");
  const stat = await fs.stat(root);
  return { root, dev: stat.dev, ino: stat.ino, gitDir: (await git.text(root, ["rev-parse", "--absolute-git-dir"])).trim() };
}
function fileOperation(request) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(__dirname, "checkpoint-files.cjs")],
      { cwd: request.root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(new Error("Checkpoint file operation failed or timed out", { cause: error }));
          return;
        }
        if (result.error || error) {
          const failure = new Error(result.error || error.message);
          failure.restored = result.restored ?? 0;
          reject(failure);
        } else resolve(result.result);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
async function namesFor(root) {
  return (await git.text(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
}
/** `budget` caps the bytes one capture saves across a Chat's Worktrees; past it the largest files stay out. */
function createCheckpoints({ directory, budget = 100 * 1024 * 1024, assertIdle = async () => {}, validateRoots = async () => {} }) {
  const running = new Map(),
    previews = new Map(),
    // Each Worktree's file stamps from its last full scan, so the next one reads only the files that changed. Kept
    // for the Worktrees captured most recently; a restart starts them over.
    stamps = new Map();
  const stampsKey = (id) => JSON.stringify([id.root, id.dev, id.ino, id.gitDir]);
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const manifestPath = (id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid checkpoint");
    return path.join(directory, id, "manifest.json");
  };
  const save = (item) => atomic(manifestPath(item.id), JSON.stringify(item));
  async function load(chatId, id) {
    const item = JSON.parse(await fs.readFile(manifestPath(id), "utf8"));
    if (item.chatId !== chatId || item.version !== 1) throw new Error("Checkpoint does not belong to this Chat");
    return item;
  }

  /** `only[index]`, when given, limits root `index` to those files: a restore saves just the files it writes. */
  async function snapshot(roots, only) {
    const snapshots = [];
    let excluded = 0,
      total = 0;
    for (const [index, root] of roots.entries()) {
      const id = await identity(root);
      const key = stampsKey(id);
      const captured = await fileOperation({
        op: "scan",
        root,
        identity: id,
        names: [...new Set(only ? only[index] : await namesFor(root))].toSorted(),
        blobDirectory: path.join(directory, "blobs"),
        // A shared Chat's Worktrees take what the earlier ones left of the budget.
        budget: budget - total,
        known: stamps.get(key),
      });
      if (!same(id, await identity(root))) throw new Error("Worktree changed during checkpoint capture");
      // A restore's scan covers only the files it writes; the full scans keep the stamps.
      if (!only) {
        stamps.delete(key);
        stamps.set(key, captured.stamps ?? {});
        if (stamps.size > 32) stamps.delete(stamps.keys().next().value);
      }
      total += captured.total;
      excluded += captured.blocked.length;
      snapshots.push({ identity: id, files: captured.files, blocked: captured.blocked });
    }
    return { roots: snapshots, excluded };
  }
  async function idle(item) {
    const roots = item.before.map((s) => s.identity.root);
    await validateRoots(item.chatId, roots);
    if ([...running.values()].some((task) => task.roots.some((root) => roots.includes(root))))
      throw new Error("Wait for running tasks to finish before restoring");
    await assertIdle(roots);
  }
  async function impact(item) {
    await idle(item);
    const files = [],
      states = [];
    let excluded = item.excluded;
    for (const [index, before] of item.before.entries()) {
      const root = before.identity.root;
      if (!same(before.identity, await identity(root))) throw new Error("Checkpoint Worktree identity changed");
      const after = item.after?.[index];
      const names = [...new Set([...Object.keys(before.files), ...Object.keys(after?.files ?? {}), ...(!after ? await namesFor(root) : [])])].toSorted();
      const candidates = names.filter(
        (name) =>
          !before.blocked.includes(name) && !after?.blocked.includes(name) && (!after || !same(entryAt(before.files, name), entryAt(after.files, name))),
      );
      const current = await fileOperation({ op: "inspect", root, identity: before.identity, names: candidates, budget });
      states.push({ identity: before.identity, patterns: current.patterns });
      for (const name of candidates) {
        if (current.blocked.includes(name)) {
          excluded++;
          states.push({ index, name, blocked: true });
          continue;
        }
        const original = entryAt(before.files, name),
          now = entryAt(current.files, name);
        if (same(original, now)) continue;
        const key = `${index}:${name}`;
        files.push({
          key,
          path: name,
          worktree: root,
          action: original ? (now ? "replace" : "create") : "delete",
          conflict: !after || !same(now, entryAt(after.files, name)),
        });
        states.push({ key, entry: now });
      }
    }
    return { files, excluded, digest: hash(JSON.stringify(states)) };
  }
  return {
    begin: (request) =>
      serial(async () => {
        if (running.has(request.chatId)) return summary(await load(request.chatId, running.get(request.chatId).id));
        const roots = [...new Set(request.roots)],
          captured = await snapshot(roots);
        const item = {
          version: 1,
          id: randomUUID(),
          chatId: request.chatId,
          permissionMode: request.permissionMode ?? "ask",
          kind: "task",
          createdAt: Date.now(),
          before: captured.roots,
          excluded: captured.excluded,
          ...(Number.isSafeInteger(request.messageId) ? { messageId: request.messageId } : {}),
          ...(typeof request.prompt === "string" && request.prompt.trim() ? { prompt: request.prompt.trim().slice(0, 300) } : {}),
        };
        await save(item);
        running.set(request.chatId, { id: item.id, roots });
        return summary(item);
      }),
    discard: (chatId, messageId) =>
      serial(async () => {
        const names = await fs.readdir(directory).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const id of names.filter((name) => /^[0-9a-f-]{36}$/.test(name))) {
          const item = JSON.parse(await fs.readFile(manifestPath(id), "utf8"));
          if (item.chatId !== chatId || item.messageId !== messageId) continue;
          await fs.rm(path.dirname(manifestPath(id)), { recursive: true, force: true });
          if (running.get(chatId)?.id === id) running.delete(chatId);
          return true;
        }
        return false;
      }),
    finish: (chatId) =>
      serial(async () => {
        const task = running.get(chatId);
        if (!task) return;
        try {
          const item = await load(chatId, task.id),
            captured = await snapshot(task.roots);
          item.after = captured.roots;
          item.completedAt = Date.now();
          item.excluded = Math.max(item.excluded, captured.excluded);
          item.changed = changedCount(item.before, item.after);
          await save(item);
        } finally {
          running.delete(chatId);
        }
      }),
    list: (chatId) =>
      serial(async () => {
        const names = await fs.readdir(directory).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const items = [];
        for (const id of names.filter((name) => /^[0-9a-f-]{36}$/.test(name))) {
          const item = JSON.parse(await fs.readFile(manifestPath(id), "utf8"));
          if (item.chatId === chatId) items.push(summary(item));
        }
        return items.toSorted((a, b) => b.createdAt - a.createdAt);
      }),
    preview: (chatId, id) =>
      serial(async () => {
        const item = await load(chatId, id),
          result = await impact(item);
        for (const [token, p] of previews) if (Date.now() - p.at > 10 * 60 * 1000 || p.chatId === chatId) previews.delete(token);
        if (previews.size >= 100) previews.delete(previews.keys().next().value);
        const token = randomUUID();
        previews.set(token, { id, chatId, digest: result.digest, at: Date.now() });
        return { ...summary(item), token, files: result.files, excluded: result.excluded };
      }),
    restore: (chatId, request = {}) =>
      serial(async () => {
        if (request.approved !== true) throw new Error("Confirm the restore after reviewing its preview");
        const preview = previews.get(request.token);
        if (!preview || preview.chatId !== chatId || Date.now() - preview.at > 10 * 60 * 1000) throw new Error("Preview again before restoring");
        const item = await load(chatId, preview.id),
          current = await impact(item);
        if (current.digest !== preview.digest) {
          previews.delete(request.token);
          throw new Error("Files changed. Preview again before restoring");
        }
        const choices = request.decisions;
        if (
          !choices ||
          current.files.some((file) => !Object.hasOwn(choices, file.key) || !["keep", "restore"].includes(choices[file.key])) ||
          Object.keys(choices).some((key) => !current.files.some((file) => file.key === key))
        )
          throw new Error("Resolve every file with a keep or restore decision");
        previews.delete(request.token);
        const selected = current.files.filter((file) => choices[file.key] === "restore");
        // `redo` marks restoring a recovery checkpoint: putting back the files an earlier restore replaced.
        const outcome = { checkpointId: item.id, kept: current.files.length - selected.length, redo: item.kind === "recovery" };
        if (!selected.length) return { ...outcome, restored: 0, recoveryId: null };
        // Only the files about to change: the rest of the Worktree can't crowd them out of the budget.
        const captured = await snapshot(
          item.before.map((s) => s.identity.root),
          item.before.map((_, index) => selected.filter((file) => file.key.startsWith(`${index}:`)).map((file) => file.path)),
        );
        const recovery = {
          version: 1,
          id: randomUUID(),
          chatId,
          createdAt: Date.now(),
          completedAt: Date.now(),
          kind: "recovery",
          permissionMode: item.permissionMode,
          excluded: captured.excluded,
          before: captured.roots,
          after: structuredClone(captured.roots),
          changed: selected.length,
          ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
          ...(item.prompt ? { prompt: item.prompt } : {}),
        };
        for (const file of selected) {
          const index = Number(file.key.slice(0, file.key.indexOf(":"))),
            original = entryAt(item.before[index].files, file.path);
          if (original)
            Object.defineProperty(recovery.after[index].files, file.path, { value: original, enumerable: true, configurable: true, writable: true });
          else delete recovery.after[index].files[file.path];
        }
        await save(recovery);
        if ((await impact(item)).digest !== preview.digest) throw new Error("Files changed. Preview again before restoring");
        let restored = 0;
        try {
          for (const [index, before] of item.before.entries()) {
            const group = selected.filter((file) => file.key.startsWith(`${index}:`));
            if (!group.length) continue;
            // A helper pins its cwd and uses basename-only syscalls. Directory swaps cannot redirect a write outside the Worktree.
            const result = await fileOperation({
              op: "apply",
              root: before.identity.root,
              identity: before.identity,
              blobDirectory: path.join(directory, "blobs"),
              files: group.map((file) => ({
                path: file.path,
                expected: entryAt(captured.roots[index].files, file.path),
                target: entryAt(before.files, file.path),
              })),
            });
            restored += result.restored;
          }
        } catch (error) {
          throw new Error(
            `${error.message}. Recovery checkpoint saved (${recovery.id}); ${restored + (error.restored ?? 0)} files restored. A failed file may be partially written; use the recovery checkpoint.`,
            {
              cause: error,
            },
          );
        }
        return { ...outcome, restored, recoveryId: recovery.id };
      }),
  };
}
module.exports = { createCheckpoints };

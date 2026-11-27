const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createGit } = require("./git/client.cjs");
const git = createGit({ analysisOnly: true }).read;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const entryAt = (files, name) => (files && Object.hasOwn(files, name) ? files[name] : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameRoots = (item, roots) => JSON.stringify(item.before.map((s) => s.identity.root)) === JSON.stringify([...new Set(roots)]);
const summary = (item) => ({
  id: item.id,
  createdAt: item.createdAt,
  completedAt: item.completedAt,
  kind: item.kind,
  permissionMode: item.permissionMode,
  excluded: item.excluded,
  ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
  ...(item.prompt ? { prompt: item.prompt } : {}),
  ...(item.changed !== undefined ? { changed: item.changed } : {}),
});
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
async function readManifests(directory, chatId) {
  const names = await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const items = [];
  for (const id of names.filter((name) => /^[0-9a-f-]{36}$/.test(name))) {
    const item = JSON.parse(await fs.readFile(path.join(directory, id, "manifest.json"), "utf8"));
    if (item.chatId === chatId) items.push(item);
  }
  return items.toSorted((a, b) => b.createdAt - a.createdAt);
}
// Which of the tasks changed each file in one of their Worktrees.
function changersOf(items, index, names) {
  const changers = new Map();
  for (const name of names) {
    const touched = items.filter((item) => {
      const start = item.before[index],
        end = item.after?.[index];
      return !start.blocked.includes(name) && !end?.blocked.includes(name) && (!end || !same(entryAt(start.files, name), entryAt(end.files, name)));
    });
    if (touched.length) changers.set(name, touched);
  }
  return changers;
}
function rememberPreview(previews, chatId, ids, digest) {
  for (const [token, p] of previews) if (Date.now() - p.at > 10 * 60 * 1000 || p.chatId === chatId) previews.delete(token);
  if (previews.size >= 100) previews.delete(previews.keys().next().value);
  const token = randomUUID();
  previews.set(token, { ids, chatId, digest, at: Date.now() });
  return token;
}
function rewindPreview(items, ids, result, token) {
  return {
    ...summary(items[0]),
    tasks: items.length,
    revision: hash(JSON.stringify([ids, result.digest])),
    token,
    files: result.files,
    excluded: result.excluded,
  };
}
function createCheckpoints({
  directory,
  budget = 100 * 1024 * 1024,
  assertIdle = async () => {},
  validateRoots = async () => {},
  assertWritable = async () => {},
}) {
  const running = new Map(),
    previews = new Map(),
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
        budget: budget - total,
        known: stamps.get(key),
      });
      if (!same(id, await identity(root))) throw new Error("Worktree changed during checkpoint capture");
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
  // Several tasks undone together (editing an earlier message) restore each file to before the first task that changed it,
  // and treat it as edited afterwards when it no longer matches the end of the last task that changed it.
  async function impact(items) {
    await idle(items[0]);
    const files = [],
      states = [],
      targets = new Map();
    let excluded = Math.max(...items.map((item) => item.excluded));
    for (const [index, before] of items[0].before.entries()) {
      const root = before.identity.root;
      if (!same(before.identity, await identity(root))) throw new Error("Checkpoint Worktree identity changed");
      const open = items.some((item) => !item.after?.[index]);
      const names = [
        ...new Set([
          ...items.flatMap((item) => [...Object.keys(item.before[index].files), ...Object.keys(item.after?.[index]?.files ?? {})]),
          ...(open ? await namesFor(root) : []),
        ]),
      ].toSorted();
      const changers = changersOf(items, index, names);
      const candidates = [...changers.keys()];
      const current = await fileOperation({ op: "inspect", root, identity: before.identity, names: candidates, budget });
      states.push({ identity: before.identity, patterns: current.patterns });
      for (const name of candidates) {
        if (current.blocked.includes(name)) {
          excluded++;
          states.push({ index, name, blocked: true });
          continue;
        }
        const touched = changers.get(name),
          last = touched.at(-1).after?.[index];
        const original = entryAt(touched[0].before[index].files, name),
          now = entryAt(current.files, name);
        if (same(original, now)) continue;
        const key = `${index}:${name}`;
        files.push({
          key,
          path: name,
          worktree: root,
          action: original ? (now ? "replace" : "create") : "delete",
          conflict: !last || !same(now, entryAt(last.files, name)),
        });
        targets.set(key, original);
        states.push({ key, entry: now });
      }
    }
    return { files, excluded, targets, digest: hash(JSON.stringify(states)) };
  }
  const listItems = (chatId) => readManifests(directory, chatId);
  const remember = (chatId, ids, digest) => rememberPreview(previews, chatId, ids, digest);
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
        const item = (await listItems(chatId)).find((candidate) => candidate.messageId === messageId);
        if (!item) return false;
        await fs.rm(path.dirname(manifestPath(item.id)), { recursive: true, force: true });
        if (running.get(chatId)?.id === item.id) running.delete(chatId);
        return true;
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
    list: (chatId) => serial(async () => (await listItems(chatId)).map(summary)),
    preview: (chatId, id) =>
      serial(async () => {
        const item = await load(chatId, id),
          result = await impact([item]);
        return { ...summary(item), token: remember(chatId, [id], result.digest), files: result.files, excluded: result.excluded };
      }),
    // Every task started at or after a message, undone together: what editing that message would also undo.
    rewind: (chatId, messageId, roots) =>
      serial(async () => {
        const items = (await listItems(chatId)).filter((item) => item.kind === "task" && item.messageId >= messageId && sameRoots(item, roots)).toReversed();
        if (!items.length) return null;
        const ids = items.map((item) => item.id),
          result = await impact(items);
        return rewindPreview(items, ids, result, remember(chatId, ids, result.digest));
      }),
    running: (chatId) => running.has(chatId),
    restore: (chatId, request = {}) =>
      serial(async () => {
        await assertWritable(chatId);
        if (request.approved !== true) throw new Error("Confirm the restore after reviewing its preview");
        const preview = previews.get(request.token);
        if (!preview || preview.chatId !== chatId || Date.now() - preview.at > 10 * 60 * 1000) throw new Error("Preview again before restoring");
        const items = await Promise.all(preview.ids.map((id) => load(chatId, id))),
          item = items[0],
          current = await impact(items);
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
        const outcome = { checkpointId: item.id, kept: current.files.length - selected.length, redo: item.kind === "recovery" };
        if (!selected.length) return { ...outcome, restored: 0, recoveryId: null };
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
          const index = Number(file.key.slice(0, file.key.indexOf(":")));
          const original = current.targets.get(file.key);
          if (original)
            Object.defineProperty(recovery.after[index].files, file.path, { value: original, enumerable: true, configurable: true, writable: true });
          else delete recovery.after[index].files[file.path];
        }
        await save(recovery);
        if ((await impact(items)).digest !== preview.digest) throw new Error("Files changed. Preview again before restoring");
        let restored = 0;
        try {
          for (const [index, before] of item.before.entries()) {
            const group = selected.filter((file) => file.key.startsWith(`${index}:`));
            if (!group.length) continue;
            await assertWritable(chatId);
            const result = await fileOperation({
              op: "apply",
              root: before.identity.root,
              identity: before.identity,
              blobDirectory: path.join(directory, "blobs"),
              files: group.map((file) => ({
                path: file.path,
                expected: entryAt(captured.roots[index].files, file.path),
                target: current.targets.get(file.key) ?? null,
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

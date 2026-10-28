import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFileEntry, DiffFileResult, DiffFilesResult, MilagreBridge } from "../../electron";
import type { ChangesMode, PrRange } from "../../lib/pull-request-view";
import { useGitRefresh } from "./useGitRefresh";
import { parsePatch, type DiffHunk } from "../../lib/diff-parse";

// Patches load as files scroll into view; a few at a time keeps git from competing with the agent.
const MAX_IN_FLIGHT = 4;
// Past this many changed lines a file waits for "Show diff" instead of loading and highlighting on scroll.
const LARGE_DIFF_LINES = 3000;

export type PatchState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & DiffFileResult);

export type DiffList =
  | { state: "idle" | "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; isRepo: false; message: string }
  | { state: "ready"; isRepo: true; base: string | null; files: DiffFileEntry[]; message?: string };

const parsed = new WeakMap<object, DiffHunk[]>();

/** A loaded patch's hunks, parsed once however many places read them (a file's rows, the comments' outdated check). */
export function hunksOf(patch: PatchState | undefined): DiffHunk[] {
  if (patch?.status !== "ready") return [];
  let hunks = parsed.get(patch);
  if (!hunks) parsed.set(patch, (hunks = parsePatch(patch.patch)));
  return hunks;
}

export function isLarge(file: DiffFileEntry) {
  return file.added + file.removed > LARGE_DIFF_LINES;
}

function patchKey(cwd: string, mode: ChangesMode, file: DiffFileEntry, range?: PrRange) {
  return [cwd, mode, mode === "pr" ? range?.head : "", file.path, file.added, file.removed].join("\0");
}

type Failure = { ok: false; message: string };
const failed = (result: object): result is Failure => "ok" in result && result.ok === false;

/** The file list for a mode: git's for the Chat's own changes, the PR's commits for "pr" (nothing until its commits are known). */
async function readList(bridge: MilagreBridge, cwd: string, base: string | undefined, mode: ChangesMode, range?: PrRange): Promise<DiffFilesResult> {
  if (mode !== "pr") return bridge.git.diffFiles({ cwd, base, mode });
  if (!range) return { isRepo: true, base: null, files: [] };
  const result = await bridge.pr.diffFiles({ cwd, ...range });
  if (failed(result)) throw new Error(result.message);
  return result;
}

async function readPatch(
  bridge: MilagreBridge,
  cwd: string,
  base: string | undefined,
  mode: ChangesMode,
  file: DiffFileEntry,
  range?: PrRange,
): Promise<DiffFileResult> {
  if (mode !== "pr") return bridge.git.diffFile({ cwd, base, mode, path: file.path, oldPath: file.oldPath, untracked: file.untracked });
  if (!range) return { patch: "", binary: false, tooLarge: false };
  const result = await bridge.pr.diffFile({ cwd, ...range, path: file.path, oldPath: file.oldPath });
  if (failed(result)) throw new Error(result.message);
  return result;
}

/**
 * The changed files of a chat's folder and their patches. `refresh` re-reads the list and revalidates loaded
 * patches, since an edit can keep a file's line counts. Previous patches stay visible during reads. Large files
 * the user opened with "Show diff" stay opened until the folder or mode changes.
 */
export function useDiffFiles({
  cwd,
  base,
  mode,
  range,
  active,
  patches = true,
  bridge,
}: {
  cwd: string;
  base?: string;
  mode: ChangesMode;
  /** The PR's commits, for mode "pr". */
  range?: PrRange;
  active: boolean;
  /** Whether the diff shows this mode: only then does a refresh re-read the loaded patches; otherwise it drops them. */
  patches?: boolean;
  bridge: MilagreBridge;
}) {
  const scope = JSON.stringify([cwd, base, mode, mode === "pr" ? range : null]);
  const [snapshot, setSnapshot] = useState<{ scope: string; list: DiffList }>({ scope, list: { state: "idle" } });
  const list: DiffList = snapshot.scope === scope ? snapshot.list : { state: "idle" };
  const [, setVersion] = useState(0);
  const cache = useRef(new Map<string, PatchState>());
  const queue = useRef<(() => void)[]>([]);
  const inFlight = useRef(0);
  const generation = useRef(0);
  // Bumped whenever the cache is dropped, so a patch read that started before it doesn't land in the new one.
  const epoch = useRef(0);
  const forced = useRef(new Set<string>());
  const reload = useRef<(file: DiffFileEntry) => void>(() => {});
  const request = useRef({ cwd, base, mode, bridge, range, patches });
  request.current = { cwd, base, mode, bridge, range, patches };
  const bump = useCallback(() => setVersion((version) => version + 1), []);

  const dropPatches = useCallback(() => {
    epoch.current++;
    queue.current = [];
    cache.current.clear();
  }, []);

  const refresh = useCallback(
    async (background = false) => {
      // Let slow patches finish before a periodic read invalidates their cache generation.
      if (background && (inFlight.current > 0 || queue.current.length > 0)) return;
      const { cwd, base, mode, bridge, range, patches } = request.current;
      const scope = JSON.stringify([cwd, base, mode, mode === "pr" ? range : null]);
      const current = ++generation.current;
      setSnapshot((previous) => ({ scope, list: previous.scope === scope && previous.list.state === "ready" ? previous.list : { state: "loading" } }));
      try {
        const result = await readList(bridge, cwd, base, mode, range);
        if (current === generation.current) {
          // Keep loaded patches visible while polling revalidates them, including edits with unchanged line counts.
          const previous = new Map(cache.current);
          dropPatches();
          if (result.isRepo && patches) {
            for (const file of result.files) {
              const key = patchKey(cwd, mode, file, range);
              const patch = previous.get(key);
              if (patch?.status !== "ready") continue;
              cache.current.set(key, patch);
              reload.current(file);
            }
          }
          setSnapshot({ scope, list: { state: "ready", ...result } });
        }
      } catch (error) {
        if (current === generation.current)
          setSnapshot({ scope, list: { state: "error", message: error instanceof Error ? error.message : "Couldn't read the changes" } });
      }
    },
    [dropPatches],
  );

  useEffect(() => {
    dropPatches();
    forced.current.clear();
    setSnapshot({ scope, list: { state: "idle" } });
    // Invalidates a read still running for the old folder or mode.
    return () => {
      generation.current++;
    };
    // `scope` stands for cwd, base, mode and the PR's commits.
  }, [active, scope, bridge, refresh, dropPatches]);

  useGitRefresh(active && !!cwd, scope, refresh);

  const pump = useCallback(() => {
    while (inFlight.current < MAX_IN_FLIGHT && queue.current.length) queue.current.shift()!();
  }, []);

  /** Starts loading a file's patch unless it is cached or already loading. `force` is "Show diff" on a large file. */
  const load = useCallback(
    (file: DiffFileEntry, force = false, revalidate = false) => {
      const { cwd, base, mode, bridge, range } = request.current;
      const key = patchKey(cwd, mode, file, range);
      if (force) forced.current.add(file.path);
      if ((!revalidate && cache.current.has(key)) || file.binary || (isLarge(file) && !forced.current.has(file.path))) return;
      const loadEpoch = epoch.current;
      if (!revalidate) cache.current.set(key, { status: "loading" });
      bump();
      queue.current.push(() => {
        inFlight.current++;
        readPatch(bridge, cwd, base, mode, file, range)
          .then<PatchState, PatchState>(
            (result) => ({ status: "ready", ...result }),
            (error) => ({ status: "error", message: error instanceof Error ? error.message : "Couldn't read this file" }),
          )
          .then((next) => {
            if (loadEpoch === epoch.current) {
              const previous = cache.current.get(key);
              if (
                previous?.status !== "ready" ||
                next.status !== "ready" ||
                previous.patch !== next.patch ||
                previous.binary !== next.binary ||
                previous.tooLarge !== next.tooLarge
              )
                cache.current.set(key, next);
            }
            inFlight.current--;
            bump();
            pump();
          });
      });
      pump();
    },
    [pump, bump],
  );

  reload.current = (file) => load(file, false, true);

  const patchFor = (file: DiffFileEntry) => cache.current.get(patchKey(cwd, mode, file, range));

  return { list, refresh, load, patchFor };
}

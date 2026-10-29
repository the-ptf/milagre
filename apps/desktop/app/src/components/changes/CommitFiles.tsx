import { lazy, Suspense, useEffect, useState } from "react";
import { commitComparisonLabel, diffFileCountLabel } from "@milagre/shared/git-diff";
import type { DiffFilesResult, DiffFileResult, MilagreBridge } from "../../electron";
import { buildDiffTree } from "../../lib/diff-tree";
import { Tree } from "./DiffTree";
import { isLarge, type PatchState } from "./useDiffFiles";

const CommitDiffFile = lazy(() => import("./DiffFile").then(({ DiffFile }) => ({ default: DiffFile })));
const selectedFileIsVisible = () => {};

/** Immutable commit inspection, independent of the current branch and working tree. */
export function CommitFiles({ cwd, sha, bridge }: { cwd: string; sha: string; bridge: MilagreBridge }) {
  const [retry, setRetry] = useState(0);
  const [path, setPath] = useState("");
  const [patchRetry, setPatchRetry] = useState(0);
  const [forcedPath, setForcedPath] = useState("");
  const [collapsedPath, setCollapsedPath] = useState("");
  const scope = JSON.stringify([cwd, sha, retry]);
  const [loaded, setLoaded] = useState<{ scope: string; bridge: MilagreBridge; result?: DiffFilesResult; error?: string }>();
  const current = loaded?.scope === scope && loaded.bridge === bridge ? loaded : undefined;
  const result = current?.result;
  const error = current?.error;
  useEffect(() => {
    let live = true;
    bridge.git.diffFiles({ cwd, mode: "committed", commit: sha }).then(
      (data) => {
        if (live)
          setLoaded(
            data.isRepo && data.commit !== sha
              ? { scope, bridge, error: "This computer needs an update to show files in a commit" }
              : { scope, bridge, result: data },
          );
        return undefined;
      },
      (failure) => {
        if (live) setLoaded({ scope, bridge, error: String(failure.message ?? failure) });
      },
    );
    return () => {
      live = false;
    };
  }, [cwd, sha, bridge, scope]);
  const file = result?.isRepo ? result.files.find((entry) => entry.path === path) : undefined;
  const patchScope = JSON.stringify([scope, patchRetry, forcedPath === path]);
  const [readPatch, setReadPatch] = useState<{ scope: string; bridge: MilagreBridge; file: typeof file; result?: DiffFileResult; error?: string }>();
  const currentPatch = readPatch?.scope === patchScope && readPatch.bridge === bridge && readPatch.file === file ? readPatch : undefined;
  const patch = currentPatch?.result;
  const patchError = currentPatch?.error;
  useEffect(() => {
    let live = true;
    if (file && !file.binary && (!isLarge(file) || forcedPath === file.path))
      bridge.git.diffFile({ cwd, mode: "committed", commit: sha, path: file.path, oldPath: file.oldPath }).then(
        (data) => {
          if (live) setReadPatch({ scope: patchScope, bridge, file, result: data });
          return undefined;
        },
        (failure) => {
          if (live) setReadPatch({ scope: patchScope, bridge, file, error: String(failure.message ?? failure) });
        },
      );
    return () => {
      live = false;
    };
  }, [cwd, sha, bridge, file, patchScope, forcedPath]);
  const patchState: PatchState | undefined = patchError ? { status: "error", message: patchError } : patch ? { status: "ready", ...patch } : undefined;
  return (
    <div data-commit-files={sha} className="mt-2 min-w-0">
      {error ? (
        <button type="button" onClick={() => setRetry((value) => value + 1)} className="min-h-6 text-12 text-red-ink">
          {error}. Retry
        </button>
      ) : !result ? (
        <p className="text-12 text-ink-3">Reading changes…</p>
      ) : !result.isRepo ? (
        <p className="text-12 text-ink-3">{result.message}</p>
      ) : (
        <>
          <p className="mb-2 text-11 text-ink-3">
            {diffFileCountLabel(result)} · {commitComparisonLabel(result.commitParent)}
          </p>
          {!result.files.length && <p className="text-12 text-ink-3">No changes in this commit.</p>}
          <Tree nodes={buildDiffTree(result.files)} depth={0} onSelectFile={setPath} activePath={path} />
          {file && (
            <div className="mt-2" aria-label={`Commit diff: ${path}`}>
              {patchError && (
                <button
                  type="button"
                  aria-label="Retry commit patch"
                  data-commit-patch-retry
                  onClick={() => setPatchRetry((value) => value + 1)}
                  className="mb-2 min-h-6 text-12 text-red-ink"
                >
                  Retry patch
                </button>
              )}
              <Suspense fallback={<p className="text-12 text-ink-3">Loading diff…</p>}>
                <CommitDiffFile
                  readOnly
                  file={file}
                  patch={patchState}
                  layout="unified"
                  wrap
                  collapsed={collapsedPath === path}
                  onToggle={() => setCollapsedPath((value) => (value === path ? "" : path))}
                  onVisible={selectedFileIsVisible}
                  onShowLarge={() => setForcedPath(path)}
                />
              </Suspense>
            </div>
          )}
        </>
      )}
    </div>
  );
}

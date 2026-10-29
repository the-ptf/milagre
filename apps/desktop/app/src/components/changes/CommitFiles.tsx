import { useEffect, useState } from "react";
import type { DiffFilesResult, DiffFileResult, MilagreBridge } from "../../electron";
import { buildDiffTree } from "../../lib/diff-tree";
import { Tree } from "./ChangesPanel";

/** Immutable commit inspection, independent of the current branch and working tree. */
export function CommitFiles({ cwd, sha, bridge }: { cwd: string; sha: string; bridge: MilagreBridge }) {
  const [retry, setRetry] = useState(0);
  const [path, setPath] = useState("");
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
  const [readPatch, setReadPatch] = useState<{ scope: string; bridge: MilagreBridge; file: typeof file; result?: DiffFileResult; error?: string }>();
  const currentPatch = readPatch?.scope === scope && readPatch.bridge === bridge && readPatch.file === file ? readPatch : undefined;
  const patch = currentPatch?.result;
  const patchError = currentPatch?.error;
  useEffect(() => {
    let live = true;
    if (file && !file.binary)
      bridge.git.diffFile({ cwd, mode: "committed", commit: sha, path: file.path, oldPath: file.oldPath }).then(
        (data) => {
          if (live) setReadPatch({ scope, bridge, file, result: data });
          return undefined;
        },
        (failure) => {
          if (live) setReadPatch({ scope, bridge, file, error: String(failure.message ?? failure) });
        },
      );
    return () => {
      live = false;
    };
  }, [cwd, sha, bridge, file, scope]);
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
          <p className="mb-2 text-11 text-ink-3">{result.files.length} files · Compared with first parent</p>
          {!result.files.length && <p className="text-12 text-ink-3">No changes in this commit.</p>}
          <Tree nodes={buildDiffTree(result.files)} depth={0} onSelectFile={setPath} activePath={path} />
          {file && (
            <div className="mt-2 rounded-control border border-line p-2" aria-label={`Commit diff: ${path}`}>
              <p className="mb-2 break-words text-11 text-ink-2">{file.oldPath ? `${file.oldPath} → ${path}` : path}</p>
              {patchError ? (
                <button type="button" onClick={() => setRetry((value) => value + 1)} className="min-h-6 text-12 text-red-ink">
                  {patchError}. Retry
                </button>
              ) : file.binary || patch?.binary ? (
                <p className="text-12 text-ink-3">Binary file</p>
              ) : patch?.tooLarge ? (
                <p className="text-12 text-ink-3">This diff is over 1 MB. Review it in your editor.</p>
              ) : !patch ? (
                <p className="text-12 text-ink-3">Reading diff…</p>
              ) : (
                <pre className="max-h-96 overflow-auto font-mono text-11" tabIndex={0}>
                  {patch.patch.split("\n").map((line, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- fixed lines of an immutable commit patch
                    <span key={index} className={`block ${line.startsWith("+") ? "text-diff-add" : line.startsWith("-") ? "text-diff-remove" : "text-ink-2"}`}>
                      {line || " "}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

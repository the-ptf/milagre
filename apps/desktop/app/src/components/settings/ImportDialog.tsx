import { useEffect, useState } from "react";
import {
  IMPORT_INTRO,
  IMPORT_NONE,
  IMPORT_TITLE,
  defaultSelection,
  foundSources,
  importLabel,
  importSummary,
  importable,
  projectDetail,
  projectState,
  threadDetail,
  toggleProject,
  toggleThread,
  type ImportRequest,
  type ImportScan,
} from "@milagre/shared/ade-import";
import { rowDate } from "@milagre/shared/storage";
import { ipcErrorMessage } from "@milagre/shared/result";
import { showToast } from "../../lib/toast";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { InlineError } from "../primitives/InlineError";
import { ScrollArea } from "../primitives/ScrollArea";
import type { MilagreBridge } from "../../electron";

export type ImportBridge = Pick<MilagreBridge, "scanImports" | "runImport">;

export function ImportDialog({
  bridge,
  onClose,
  onImported,
}: {
  bridge: ImportBridge;
  onClose: () => void;
  onImported?: (projectPath: string | null) => void;
}) {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<ImportRequest>({ projects: [], threads: [] });
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    bridge.scanImports().then(
      (answer) => {
        if (!live) return;
        setScan(answer);
        setSelection(defaultSelection(answer));
      },
      (failure) => live && setError(ipcErrorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.runImport(selection);
      showToast(importSummary(result));
      onImported?.(result.projects[0]?.path ?? null);
      onClose();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
      setBusy(false);
    }
  }

  const sources = foundSources(scan);
  const nothing = !selection.projects.length && !selection.threads.length;
  return (
    <Dialog
      data-import-dialog
      title={IMPORT_TITLE}
      description={IMPORT_INTRO}
      width={620}
      footer="bar"
      onClose={busy ? undefined : onClose}
      dismissOnScrim={!busy}
      actions={
        <>
          <Button variant="ghost" autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button data-import-run disabled={busy || nothing || !sources.length} onClick={() => void run()}>
            {busy ? "Importing…" : importLabel(selection)}
          </Button>
        </>
      }
    >
      <div className="mt-4 grid gap-3">
        {error && (
          <InlineError size={12}>
            {/unknown|no handler|not allowed/i.test(error) ? "This computer's Milagre can't import yet. Update it first." : error}
          </InlineError>
        )}
        {scan === null && !error ? (
          <span className="py-6 text-center text-13 text-ink-3">Looking for T3 Code, Paseo and Orca…</span>
        ) : scan && !sources.length ? (
          <span data-import-empty className="py-6 text-center text-13 text-ink-3">
            {IMPORT_NONE}
          </span>
        ) : (
          <ScrollArea chainScroll className="max-h-[420px] rounded-control border border-line">
            {sources.map((source) => (
              <section key={source.id} data-import-source={source.id} className="border-b border-line last:border-b-0">
                <h3 className="px-3 pt-3 pb-1 text-12 font-medium text-ink-3">
                  {source.label}
                  {source.error ? <span className="ml-2 text-orange-ink">Couldn't read all of it: {source.error}</span> : null}
                </h3>
                <ul>
                  {source.projects.map((project) => (
                    <li key={project.path} data-import-project={project.name}>
                      <label className={`flex items-center gap-3 px-3 py-2 ${project.exists ? "cursor-pointer hover:bg-hover/50" : "opacity-60"}`}>
                        <Checkbox
                          checked={projectState(selection, source.id, project)}
                          disabled={busy || !project.exists}
                          onCheckedChange={(on) => setSelection((current) => toggleProject(current, source.id, project, on))}
                        />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-13 font-medium text-ink">{project.name}</span>
                          <span className="truncate text-12 text-ink-3">{projectDetail(project)}</span>
                        </span>
                      </label>
                      {project.exists && project.threads.length > 0 && (
                        <ul className="pb-1">
                          {project.threads.map((thread) => (
                            <li key={thread.id} data-import-thread={thread.title}>
                              <label
                                className={`flex items-center gap-3 py-1.5 pr-3 pl-10 ${importable(thread) ? "cursor-pointer hover:bg-hover/50" : "opacity-60"}`}
                              >
                                <Checkbox
                                  checked={selection.threads.includes(thread.id)}
                                  disabled={busy || !importable(thread)}
                                  onCheckedChange={(on) => setSelection((current) => toggleThread(current, source.id, project, thread, on))}
                                />
                                <span className="grid min-w-0 flex-1">
                                  <span className="truncate text-13 text-ink">{thread.title}</span>
                                  <span className="truncate text-12 text-ink-3">{threadDetail(thread)}</span>
                                </span>
                                {thread.updatedAt ? <span className="shrink-0 text-12 tabular-nums text-ink-3">{rowDate(thread.updatedAt, now)}</span> : null}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </ScrollArea>
        )}
      </div>
    </Dialog>
  );
}

import { useMemo, useState } from "react";
import { scopePaths, scopePolicy, scopeSummary, useEditScope, type EditScopeView } from "@milagre/shared/edit-scope";
import { bridgeForKey } from "../lib/computer-bridge";
import { Button } from "./primitives/Button";
import { Dialog } from "./primitives/Dialog";
import { FIELD_AREA } from "./primitives/Field";
import { InlineError } from "./primitives/InlineError";

export function EditScopeControl({ chatId, visible }: { chatId: string; visible: boolean }) {
  const api = useMemo(() => bridgeForKey(chatId).editScope, [chatId]);
  const scope = useEditScope(api, chatId, visible);
  const [open, setOpen] = useState(false);
  const view = scope.view;
  return (
    <div className="mb-1 flex items-center gap-2 px-1" data-edit-scope>
      <Button variant="ghost" size={24} onClick={() => setOpen(true)} aria-label={scopeSummary(view)}>
        {scopeSummary(view)}
      </Button>
      {view?.queuedPolicy && <span className="text-12 text-ink-3">Approved for next turn</span>}
      {open && (
        <Dialog title="Edit scope" onClose={() => setOpen(false)} width={560}>
          <div className="mt-4 flex flex-col gap-4 pb-2">
            <InlineError>{scope.error}</InlineError>
            {!view && !scope.error && <p className="text-13 text-ink-3">Loading edit scope...</p>}
            {view && (
              <>
                <p className="text-13 text-ink-2">{view.capability}</p>
                <p className="text-12 text-ink-3">{view.limits}</p>
                {view.pending && (
                  <section className="rounded-card border border-line bg-inset p-3 text-13">
                    <h3 className="font-medium">Requested scope</h3>
                    <p className="mt-1 whitespace-pre-wrap break-words">{view.pending.reason}</p>
                    <p className="mt-2 text-12 text-ink-3">Review all proposed paths. Approval applies to a new turn; this turn keeps its active scope.</p>
                    {view.pending.policy.allowed.map((rule) => (
                      <p key={`a${rule.root}/${rule.path}`} className="mt-1 break-all text-12">
                        Allow: {rule.root}/{rule.path}
                      </p>
                    ))}
                    {view.pending.policy.protected.map((rule) => (
                      <p key={`p${rule.root}/${rule.path}`} className="mt-1 break-all text-12">
                        Protect: {rule.root}/{rule.path}
                      </p>
                    ))}
                    {!view.pending.policy.allowed.length && <p className="mt-1 text-12">No allowed paths.</p>}
                    {!view.pending.policy.protected.length && <p className="mt-1 text-12">No protected paths.</p>}
                    <div className="mt-3 flex gap-2">
                      <Button disabled={scope.pending} onClick={() => void scope.resolve(true)}>
                        Approve for next turn
                      </Button>
                      <Button variant="secondary" disabled={scope.pending} onClick={() => void scope.resolve(false)}>
                        Decline
                      </Button>
                    </div>
                  </section>
                )}
                {view.queuedPolicy && <p className="text-13 text-ink-2">Your approved scope will apply when a new turn starts.</p>}
                <ScopeEditor key={view.revision} view={view} pending={scope.pending} save={scope.save} />
                {!!view.warnings.length && (
                  <section className="flex flex-col gap-2 text-13" aria-label="Scope observations">
                    <h3 className="font-medium">Scope observations</h3>
                    {view.warnings.toReversed().map((warning) => (
                      <div key={JSON.stringify([warning.at, warning.root, warning.path, warning.message])} className="rounded-card bg-inset p-3">
                        <p>{warning.message}</p>
                        {warning.path && (
                          <p className="mt-1 break-all font-mono text-12">
                            {warning.root}/{warning.path}
                          </p>
                        )}
                        <p className="mt-1 text-12 text-ink-3">{new Date(warning.at).toLocaleString()}</p>
                      </div>
                    ))}
                  </section>
                )}
                {view.lastChecked && <p className="text-12 text-ink-3">Last observed: {new Date(view.lastChecked).toLocaleString()}</p>}
              </>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
function ScopeEditor({ view, pending, save }: { view: EditScopeView; pending: boolean; save: ReturnType<typeof useEditScope>["save"] }) {
  const [fields, setFields] = useState(() =>
    Object.fromEntries(
      view.roots.map((root) => [root, { allowed: scopePaths(view.policy, root, "allowed"), protected: scopePaths(view.policy, root, "protected") }]),
    ),
  );
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-13 font-medium">{view.policy ? "Active paths" : "Choose paths"}</h3>
      <p className="text-12 text-ink-3">
        One file or directory per line, relative to its Worktree. A directory includes its descendants. Use . for the whole Worktree. Protected paths always
        win. Empty allowed paths permit no edits.
      </p>
      {view.busy && <p className="text-13 text-ink-2">Stop this Chat and its background work to edit paths. Requests can be approved for the next turn.</p>}
      {view.roots.map((root) => (
        <div key={root} className="flex flex-col gap-2">
          <p className="break-all font-mono text-12 text-ink-3">{root}</p>
          {(["allowed", "protected"] as const).map((kind) => (
            <label key={kind} className="flex flex-col gap-1 text-13">
              {kind === "allowed" ? "Allowed paths" : "Protected paths"}
              <textarea
                className={FIELD_AREA}
                rows={3}
                disabled={pending || view.busy}
                value={fields[root]?.[kind] ?? ""}
                onChange={(event) => setFields((all) => ({ ...all, [root]: { ...all[root]!, [kind]: event.target.value } }))}
                spellCheck={false}
              />
            </label>
          ))}
        </div>
      ))}
      <div className="flex gap-2">
        <Button disabled={pending || view.busy || !view.roots.length} onClick={() => void save(scopePolicy(view.roots, fields))}>
          Save scope
        </Button>
        {view.policy && (
          <Button variant="secondary" disabled={pending || view.busy} onClick={() => void save(null)}>
            Remove scope
          </Button>
        )}
      </div>
    </section>
  );
}

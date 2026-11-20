import { useState } from "react";
import { designScope, type DesignLibraryEntry, type DesignLibraryPage } from "@milagre/shared/artifact";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { FIELD_LABEL, Input } from "../primitives/Field";
import { InlineError } from "../primitives/InlineError";
import { DESIGN_DELETED, type DesignDeleted } from "../agents/design-events";
import { LibraryPagePicker, useLibraryPageChoice } from "./LibraryPagePicker";

/** A change asked for on the Design library page, each with its own dialog. */
export type LibraryAction =
  | { kind: "rename"; design: DesignLibraryEntry }
  | { kind: "move"; design: DesignLibraryEntry }
  | { kind: "delete"; design: DesignLibraryEntry }
  | { kind: "rename-page"; page: DesignLibraryPage };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      onDone();
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The dialog for `action` on the library of the Project `projectKey` names; closes when the host has made the change. */
export function LibraryActionDialog({
  projectKey,
  pages,
  action,
  onClose,
}: {
  projectKey: string;
  pages: DesignLibraryPage[];
  action: LibraryAction;
  onClose: () => void;
}) {
  const api = bridgeForKey(projectKey).artifacts;
  const scope = designScope(projectKey);
  const { busy, error, run } = useRun(onClose);
  if (action.kind === "delete") {
    const { design } = action;
    return (
      <Dialog
        role="alertdialog"
        data-slot="library-delete"
        title={`Delete ${design.title}?`}
        description="It leaves the Project library for every Chat in this Project, with every version. Chats' own designs stay."
        onClose={busy ? undefined : onClose}
        width={400}
        actions={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-slot="library-delete-confirm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.delete({ ...scope, id: design.id });
                  window.dispatchEvent(new CustomEvent<DesignDeleted>(DESIGN_DELETED, { detail: { chatId: projectKey, id: design.id } }));
                })
              }
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <InlineError size={12} className="mt-3">
          {error}
        </InlineError>
      </Dialog>
    );
  }
  if (action.kind === "move")
    return (
      <MoveDialog
        pages={pages}
        design={action.design}
        busy={busy}
        error={error}
        onClose={onClose}
        onMove={(page) => void run(() => api.updateLibraryDesign({ ...scope, id: action.design.id, page }))}
      />
    );
  if (action.kind === "rename-page") {
    const { page } = action;
    return (
      <NameDialog
        title="Rename page"
        label="Page name"
        initial={page.name}
        max={60}
        busy={busy}
        error={error}
        onClose={onClose}
        onSave={(name) => void run(() => api.renameLibraryPage({ ...scope, page: page.id, name }))}
      />
    );
  }
  const { design } = action;
  return (
    <NameDialog
      title="Rename design"
      label="Design name"
      initial={design.title}
      max={120}
      busy={busy}
      error={error}
      onClose={onClose}
      onSave={(name) => void run(() => api.updateLibraryDesign({ ...scope, id: design.id, title: name }))}
    />
  );
}

function NameDialog({
  title,
  label,
  initial,
  max,
  busy,
  error,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  initial: string;
  max: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <Dialog
      as="form"
      data-slot="library-rename"
      title={title}
      onClose={busy ? undefined : onClose}
      onSubmit={() => trimmed && trimmed !== initial && onSave(trimmed)}
      width={400}
      actions={
        <>
          <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" data-slot="library-rename-save" disabled={!trimmed || trimmed === initial || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <label className="mt-4 flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>{label}</span>
        <Input data-slot="library-name" autoFocus maxLength={max} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
      </label>
      <InlineError size={12} className="mt-3">
        {error}
      </InlineError>
    </Dialog>
  );
}

function MoveDialog({
  pages,
  design,
  busy,
  error,
  onClose,
  onMove,
}: {
  pages: DesignLibraryPage[];
  design: DesignLibraryEntry;
  busy: boolean;
  error: string;
  onClose: () => void;
  onMove: (page: string) => void;
}) {
  const choice = useLibraryPageChoice(pages, design.page);
  const current = pages.find((item) => item.id === design.page);
  const unchanged = choice.choice === design.page;
  return (
    <Dialog
      as="form"
      data-slot="library-move"
      title={`Move ${design.title}`}
      description="Pick a page of the Project library, or name a new one. A page with no designs left goes away."
      onClose={busy ? undefined : onClose}
      onSubmit={() => choice.page && !unchanged && onMove(choice.page)}
      width={400}
      actions={
        <>
          <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" data-slot="library-move-save" disabled={!choice.page || unchanged || busy}>
            {busy ? "Moving…" : "Move"}
          </Button>
        </>
      }
    >
      <LibraryPagePicker pages={pages} state={choice} disabled={busy} current={current?.id} />
      <InlineError size={12} className="mt-3">
        {error}
      </InlineError>
    </Dialog>
  );
}

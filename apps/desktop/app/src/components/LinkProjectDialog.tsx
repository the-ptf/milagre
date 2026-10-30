import { LINK_CHAT_WORKTREES_TEXT, LINK_UPDATE_WORKTREES_TEXT } from "@milagre/shared/worktree-link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NamedProjectLink } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button } from "./primitives/Button";
import { FIELD } from "./primitives/Field";
import { InlineError } from "./primitives/InlineError";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { bridgeForKey } from "../lib/computer-bridge";
type Project = { id: string; name: string; path: string };
/** Creates a Link, or edits `link`'s name and member Projects. Chats already started keep their Worktrees. */
export function LinkProjectDialog({ link, onClose, onCreated }: { link?: NamedProjectLink; onClose: () => void; onCreated: (link: NamedProjectLink) => void }) {
  const bridge = bridgeForKey(link ? `milagre-link:${link.id}` : null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>(() => link?.projectIds ?? []);
  const [name, setName] = useState(link?.name ?? "");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    void bridge
      .listProjects()
      .then((rows) => {
        if (live) setProjects(rows);
      })
      .catch((error) => {
        if (live) setError(ipcErrorMessage(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      dialog.current?.close();
    };
  }, []);
  // A member whose folder is gone is still listed, so it can be removed.
  const missing = (link?.projectIds ?? [])
    .filter((id) => !projects.some((project) => project.id === id))
    .map((id) => ({ id, name: id.split("/").at(-2) ?? "Project", path: "Unavailable" }));
  const filtered = [...projects, ...(loading ? [] : missing)].filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function create() {
    if (saving || selected.length < 2 || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const request = { name: name.trim(), projectIds: selected };
      onCreated(await (link ? bridge.updateNamedLink({ id: link.id, ...request }) : bridge.createNamedLink(request)));
    } catch (error) {
      setError(ipcErrorMessage(error));
      setSaving(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="link-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !saving) onClose();
      }}
      className="link-project-dialog m-auto w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex max-h-[calc(100vh-64px)] flex-col p-5"
      >
        <h2 id="link-dialog-title" className="text-17 font-semibold">
          {link ? "Edit Link" : "Link projects"}
        </h2>
        <p className="mt-1 text-13 text-ink-2">{link ? LINK_UPDATE_WORKTREES_TEXT : LINK_CHAT_WORKTREES_TEXT}</p>
        <label className="mt-5 text-12 font-medium text-ink-2" htmlFor="link-name">
          Link name
        </label>
        <input
          id="link-name"
          autoFocus
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. RDFood"
          className={`${FIELD} mt-1`}
        />
        <input
          aria-label="Search projects"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects"
          className={`${FIELD} mt-4`}
        />
        <ScrollArea aria-label="Projects" aria-busy={loading} className="mt-2 max-h-[218px] min-h-0 rounded-control border border-line p-1">
          {loading && (
            <div role="status">
              <span className="sr-only">Loading projects</span>
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} aria-hidden="true" className="flex h-[52px] items-center gap-2 px-2 py-2 motion-safe:animate-pulse">
                  <span className="size-4 shrink-0 rounded-inline bg-ink/10" />
                  <span className="size-6 shrink-0 rounded-chip bg-ink/10" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="h-3 w-32 rounded-inline bg-ink/10" />
                    <span className="h-2.5 w-4/5 rounded-inline bg-ink/5" />
                  </span>
                </div>
              ))}
            </div>
          )}
          {!loading &&
            filtered.map((project) => (
              <label
                key={project.id}
                className="flex h-[52px] cursor-pointer items-center gap-2 rounded-control px-2 py-2 transition-colors duration-fast hover:bg-hover"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(project.id)}
                  disabled={saving}
                  onChange={(event) => setSelected((current) => (event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id)))}
                  className="accent-ink"
                />
                <ProjectAvatarStack projects={[project]} />
                <span className="min-w-0">
                  <span className="block truncate text-13 font-medium" title={project.name}>
                    {project.name}
                  </span>
                  <span className="block truncate text-11 text-ink-3" title={project.path}>
                    {project.path}
                  </span>
                </span>
              </label>
            ))}
          {!loading && !error && !filtered.length && <p className="p-3 text-13 text-ink-3">No projects found.</p>}
        </ScrollArea>
        <p className="mt-2 text-12 text-ink-3">{selected.length} selected. Choose at least two Projects.</p>
        <InlineError className="mt-3 whitespace-pre-wrap">{error}</InlineError>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim() || selected.length < 2}>
            {link ? (saving ? "Saving…" : "Save") : saving ? "Creating…" : "Create Link"}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

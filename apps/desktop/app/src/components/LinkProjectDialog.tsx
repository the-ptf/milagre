import { LINK_CHAT_WORKTREES_TEXT, LINK_UPDATE_WORKTREES_TEXT } from "@milagre/shared/worktree-link";
import { useEffect, useState } from "react";
import type { NamedProjectLink } from "@milagre/shared/model";
import { UI_COPY } from "@milagre/shared/model-copy";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "./primitives/ScrollArea";
import { Button } from "./primitives/Button";
import { Checkbox } from "./primitives/Checkbox";
import { Dialog } from "./primitives/Dialog";
import { EmptyState } from "./primitives/EmptyState";
import { FIELD, FIELD_LABEL } from "./primitives/Field";
import { InlineError } from "./primitives/InlineError";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { bridgeForKey } from "../lib/computer-bridge";
type Project = { id: string; name: string; path: string };
/** Creates a Link, or edits `link`'s name and member Projects. Chats already started keep their Worktrees. */
export function LinkProjectDialog({ link, onClose, onCreated }: { link?: NamedProjectLink; onClose: () => void; onCreated: (link: NamedProjectLink) => void }) {
  const bridge = bridgeForKey(link ? `milagre-link:${link.id}` : null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>(() => link?.projectIds ?? []);
  const [name, setName] = useState(link?.name ?? "");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
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
  // While saving, nothing closes it: no ×, and Esc and the scrim do nothing.
  return (
    <Dialog
      as="form"
      onSubmit={() => void create()}
      title={<span id="link-dialog-title">{link ? "Edit Link" : "Link Projects"}</span>}
      description={link ? LINK_UPDATE_WORKTREES_TEXT : LINK_CHAT_WORKTREES_TEXT}
      onClose={saving ? undefined : onClose}
      className="flex flex-col"
      actions={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim() || selected.length < 2}>
            {link ? (saving ? UI_COPY.saving : "Save") : saving ? "Creating…" : "Create Link"}
          </Button>
        </>
      }
    >
      <label className={`mt-4 ${FIELD_LABEL}`} htmlFor="link-name">
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
      {/* Lower-case "projects" stays: it's the field's name in test-project-links. */}
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
            <span className="sr-only">Loading Projects</span>
            {/* Skeleton's look (hover-2 main bar, hover under it), drawn inline: test-link-project-dialog counts these rows as the only aria-hidden nodes. */}
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} aria-hidden="true" className="flex h-[52px] items-center gap-2 p-2 motion-safe:animate-pulse">
                <span className="size-4 shrink-0 rounded-inline bg-hover-2" />
                <span className="size-6 shrink-0 rounded-chip bg-hover-2" />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="h-3 w-32 rounded-inline bg-hover-2" />
                  <span className="h-2.5 w-4/5 rounded-inline bg-hover" />
                </span>
              </div>
            ))}
          </div>
        )}
        {!loading &&
          filtered.map((project) => (
            <label key={project.id} className="flex h-[52px] items-center gap-2 rounded-control p-2 transition-colors hover:bg-hover">
              <Checkbox
                checked={selected.includes(project.id)}
                disabled={saving}
                onCheckedChange={(checked) => setSelected((current) => (checked ? [...current, project.id] : current.filter((id) => id !== project.id)))}
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
        {!loading && !error && !filtered.length && <EmptyState size="compact" title={UI_COPY.noProjects} />}
      </ScrollArea>
      <p className="mt-2 text-12 text-ink-3">{selected.length} selected. Choose at least two Projects.</p>
      <InlineError size={12} className="mt-3 whitespace-pre-wrap">
        {error}
      </InlineError>
    </Dialog>
  );
}

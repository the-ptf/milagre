import { useEffect, useState } from "react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import type { OrchestratorProject, OrchestratorSettings as Settings } from "@milagre/shared/orchestrator";
import { readOrchestratorProjects } from "../../lib/orchestrator-names";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { FIELD_AREA, FieldGroup } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { ScrollArea } from "../primitives/ScrollArea";
import { ProjectIcon } from "../orchestrator/TaskCards";
import { Group } from "./SettingsGroup";

type Save = (patch: Partial<Settings>) => void;

function HintDialog({ project, onSave, onClose }: { project: OrchestratorProject; onSave: (hints: string | null) => void; onClose: () => void }) {
  const [hints, setHints] = useState(project.hints ?? "");
  return (
    <Dialog
      data-orchestrator-hint-dialog
      title={project.name}
      description="What this Project is, so the router can tell it apart."
      onClose={onClose}
      as="form"
      onSubmit={() => onSave(hints.trim() || null)}
      footer="bar"
      footerStart={
        <Button variant="quiet" size={28} disabled={!project.hints && !hints} onClick={() => onSave(null)}>
          Use the Project's own files
        </Button>
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save
          </Button>
        </>
      }
    >
      <textarea
        aria-label={`Hints for ${project.name}`}
        rows={5}
        maxLength={600}
        autoFocus
        value={hints}
        placeholder={project.defaultHints ?? "What this Project is, so the router can tell it apart"}
        onChange={(event) => setHints(event.target.value)}
        className={`${FIELD_AREA} mt-3 w-full resize-y outline-none`}
      />
    </Dialog>
  );
}

function ProjectRow({ project, onInclude, onOpen }: { project: OrchestratorProject; onInclude: (on: boolean) => void; onOpen: () => void }) {
  const hint = project.hints ?? project.defaultHints;
  return (
    <div data-orchestrator-project={project.path} className={`flex min-h-12 items-center gap-3 px-4 py-2 ${project.included ? "" : "opacity-60"}`}>
      <Checkbox aria-label={`Route to ${project.name}`} checked={project.included} onCheckedChange={onInclude} />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <ProjectIcon path={project.path} name={project.name} size={24} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-13 font-medium text-ink">{project.name}</span>
          {hint && <span className="truncate text-12 text-ink-3">{hint}</span>}
        </span>
      </button>
    </div>
  );
}

export function OrchestratorProjectsSettings({ settings, save }: { settings: Settings; save: Save }) {
  const [projects, setProjects] = useState<OrchestratorProject[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<OrchestratorProject | null>(null);
  useEffect(() => {
    void window.milagre
      .readOrchestratorProjects()
      .then((list) => {
        setProjects(list);
        return list;
      })
      .catch(() => setProjects([]));
  }, [settings.projects]);
  const store = (project: OrchestratorProject, included: boolean, hints: string | null) => {
    save({ projects: { ...settings.projects, [project.path]: { included, hints } } });
    window.setTimeout(readOrchestratorProjects, 300);
  };
  const needle = query.trim().toLowerCase();
  const shown = projects?.filter((project) => project.name.toLowerCase().includes(needle)) ?? null;
  return (
    <Group title="Projects it can route to" footer="Hints tell the router what each Project is. Empty, it reads the Project's AGENTS.md, CLAUDE.md or README.">
      {projects && projects.length > 0 && (
        <div className="px-4 py-2">
          <FieldGroup
            size={28}
            aria-label="Search Projects"
            leading={<Icon icon={Search01Icon} size={14} className="shrink-0 text-ink-3" />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Projects…"
          />
        </div>
      )}
      {shown === null && <p className="px-4 py-3 text-12 text-ink-3">Loading Projects…</p>}
      {shown && shown.length > 0 && (
        <ScrollArea data-orchestrator-projects className="max-h-[360px] divide-y divide-line">
          {shown.map((project) => (
            <ProjectRow key={project.path} project={project} onInclude={(on) => store(project, on, project.hints)} onOpen={() => setEditing(project)} />
          ))}
        </ScrollArea>
      )}
      {projects?.length === 0 && <p className="px-4 py-3 text-12 text-ink-3">No Projects yet.</p>}
      {projects && projects.length > 0 && shown?.length === 0 && <p className="px-4 py-3 text-12 text-ink-3">No Projects match "{query.trim()}".</p>}
      {editing && (
        <HintDialog
          project={editing}
          onClose={() => setEditing(null)}
          onSave={(hints) => {
            store(editing, editing.included, hints);
            setEditing(null);
          }}
        />
      )}
    </Group>
  );
}

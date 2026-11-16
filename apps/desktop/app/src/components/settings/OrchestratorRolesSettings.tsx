import { useEffect, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { MEMORY_GROUPS, type OrchestratorProject, type OrchestratorRole, type OrchestratorSettings as Settings } from "@milagre/shared/orchestrator";
import { effortCopy } from "@milagre/shared/model-copy";
import { capabilityFor, type EffortLevel, type ModelOption } from "../../model";
import { GROUP_TITLES, readOrchestratorProjects } from "../../lib/orchestrator-names";
import { forgetMemory, importMemory, saveMemoryNotes, useOrchestrator } from "../../lib/orchestrator-store";
import { Button, IconButton } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { FIELD_AREA } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ProjectAvatar } from "../primitives/ProjectAvatar";
import { Segmented } from "../primitives/Segmented";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { MODEL_SEPARATOR, modelOptions, splitModel } from "./orchestrator-models";
import { Group, Row } from "./SettingsGroup";

type Save = (patch: Partial<Settings>) => void;
const NONE = "none";

export function OrchestratorMemorySettings() {
  const { memory } = useOrchestrator();
  const [busy, setBusy] = useState<"read" | "forget" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (kind: "read" | "forget", work: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    void work()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(null));
  };
  const setNotes = (notes: typeof memory.notes) => void saveMemoryNotes(notes).catch((cause: Error) => setError(cause.message));
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return (
    <Group title="Memory">
      <Row
        label="What it knows about you"
        description={
          memory.importedAt
            ? `${memory.notes.length} ${memory.notes.length === 1 ? "note" : "notes"}${found.length ? `, read from ${found.join(", ")}` : ""}. Untick a note to stop using it.`
            : "Nothing read yet. It reads your agents' instructions and memories on this computer."
        }
      >
        <Button variant="secondary" size={28} disabled={busy !== null} onClick={() => run("read", importMemory)}>
          {busy === "read" && <SpinnerRing size={12} />}
          Read again
        </Button>
      </Row>
      {MEMORY_GROUPS.map((group) => {
        const notes = memory.notes.filter((note) => note.group === group);
        if (!notes.length) return null;
        return (
          <div key={group} className="px-4 py-3">
            <p className="pb-1.5 text-12 font-medium text-ink-3">{GROUP_TITLES[group]}</p>
            {notes.map((note) => (
              <div key={note.id} className="group flex min-h-8 items-center gap-2.5">
                <Checkbox
                  aria-label={note.text}
                  checked={note.enabled}
                  onCheckedChange={(enabled) => setNotes(memory.notes.map((entry) => (entry.id === note.id ? { ...entry, enabled } : entry)))}
                />
                <span className={`min-w-0 flex-1 text-13 ${note.enabled ? "text-ink" : "text-ink-3"}`}>{note.text}</span>
                <span className="shrink-0 text-11 text-ink-3">{note.source}</span>
                <IconButton
                  size={24}
                  variant="danger-ghost"
                  label="Delete note"
                  icon={Delete02Icon}
                  className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => setNotes(memory.notes.filter((entry) => entry.id !== note.id))}
                />
              </div>
            ))}
          </div>
        );
      })}
      <Row label="Forget everything" description="Drops every note and what it learned from your corrections">
        {confirm ? (
          <span className="flex gap-1.5">
            <Button variant="ghost" size={28} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size={28}
              disabled={busy !== null}
              onClick={() => {
                setConfirm(false);
                run("forget", forgetMemory);
              }}
            >
              Forget
            </Button>
          </span>
        ) : (
          <Button variant="danger-ghost" size={28} onClick={() => setConfirm(true)}>
            Forget
          </Button>
        )}
      </Row>
      {error && (
        <InlineError size={12} className="px-4 py-3">
          {error}
        </InlineError>
      )}
    </Group>
  );
}

function ProjectRow({ project, onSave }: { project: OrchestratorProject; onSave: (included: boolean, hints: string | null) => void }) {
  const [hints, setHints] = useState(project.hints ?? "");
  useEffect(() => setHints(project.hints ?? ""), [project.hints]);
  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${project.included ? "" : "opacity-60"}`}>
      <Checkbox aria-label={`Route to ${project.name}`} className="mt-2" checked={project.included} onCheckedChange={(on) => onSave(on, project.hints)} />
      <ProjectAvatar name={project.name} size={24} className="mt-1" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <span className="text-13 font-medium text-ink">{project.name}</span>
        <textarea
          aria-label={`Hints for ${project.name}`}
          rows={2}
          maxLength={600}
          value={hints}
          placeholder={project.defaultHints ?? "What this Project is, so the router can tell it apart"}
          disabled={!project.included}
          onChange={(event) => setHints(event.target.value)}
          onBlur={() => hints !== (project.hints ?? "") && onSave(project.included, hints.trim() || null)}
          className={`${FIELD_AREA} resize-y outline-none`}
        />
      </div>
    </div>
  );
}

export function OrchestratorProjectsSettings({ settings, save }: { settings: Settings; save: Save }) {
  const [projects, setProjects] = useState<OrchestratorProject[] | null>(null);
  useEffect(() => {
    void window.milagre
      .readOrchestratorProjects()
      .then((list) => {
        setProjects(list);
        return list;
      })
      .catch(() => setProjects([]));
  }, [settings.projects]);
  return (
    <Group title="Projects it can route to" footer="Hints tell the router what each Project is. Empty, it reads the Project's AGENTS.md, CLAUDE.md or README.">
      {projects === null && <p className="px-4 py-3 text-12 text-ink-3">Loading Projects…</p>}
      {projects?.map((project) => (
        <ProjectRow
          key={project.path}
          project={project}
          onSave={(included, hints) => {
            save({ projects: { ...settings.projects, [project.path]: { included, hints } } });
            window.setTimeout(readOrchestratorProjects, 300);
          }}
        />
      ))}
      {projects?.length === 0 && <p className="px-4 py-3 text-12 text-ink-3">No Projects yet.</p>}
    </Group>
  );
}

function RoleRow({ role, models, onChange }: { role: OrchestratorRole; models: ModelOption[]; onChange: (patch: Partial<OrchestratorRole>) => void }) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState(role.instructions ?? "");
  const model =
    models.find((entry) => entry.provider === role.provider && entry.id === role.model) ??
    (role.provider && role.model ? { id: role.model, name: role.model, provider: role.provider, description: "" } : undefined);
  const efforts = model ? capabilityFor(model, null).efforts : [];
  const inactive = !role.model;
  return (
    <div data-orchestrator-role={role.id} className="grid gap-2.5 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-15 font-semibold text-ink">{role.name}</span>
          <span className="text-13 text-ink-2">{role.description}</span>
          <span className="text-12 text-ink-3">{inactive ? "No model set · role inactive" : "Active"}</span>
        </div>
        <Select
          label={`Model for ${role.name}`}
          width={260}
          searchable
          value={role.provider && role.model ? `${role.provider}${MODEL_SEPARATOR}${role.model}` : NONE}
          options={[...modelOptions(models, role), { value: NONE, label: "Not set" }]}
          onChange={(value) => {
            if (value === NONE) return onChange({ provider: null, model: null, effort: null });
            const next = splitModel(value);
            const picked = models.find((entry) => entry.provider === next.provider && entry.id === next.model);
            const levels = picked ? capabilityFor(picked, null).efforts : [];
            onChange({ ...next, effort: role.effort && levels.includes(role.effort as EffortLevel) ? role.effort : (levels.at(-2) ?? null) });
          }}
        />
        {efforts.length > 0 && (
          <Select
            label={`Effort for ${role.name}`}
            width={160}
            value={role.effort ?? efforts[0]!}
            options={efforts.map((level) => ({ value: level, label: effortCopy(level).name }))}
            onChange={(effort) => onChange({ effort })}
          />
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <span className="text-12 font-medium text-ink-2">Delegation</span>
        <Segmented<OrchestratorRole["delegation"]>
          label={`Delegation for ${role.name}`}
          value={inactive ? null : role.delegation}
          options={[
            { value: "prefer", label: "Prefer", disabled: inactive },
            { value: "always", label: "Always", disabled: inactive },
          ]}
          onChange={(delegation) => onChange({ delegation })}
        />
        <span className="flex-1" />
        <span className="text-12 text-ink-3">
          {inactive
            ? "Pick a model to turn this role on."
            : role.delegation === "always"
              ? "Every matching task goes to this role."
              : "Used when the router is confident."}
        </span>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 justify-self-start text-12 text-ink-2 transition-colors hover:text-ink"
      >
        <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
        Instructions
        <span className="text-ink-3">{role.instructions ? "Your own" : "Built-in"}</span>
      </button>
      {open && (
        <textarea
          aria-label={`Instructions for ${role.name}`}
          rows={3}
          maxLength={4000}
          value={instructions}
          placeholder={`You are the ${role.name} agent. ${role.description}`}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => instructions !== (role.instructions ?? "") && onChange({ instructions: instructions.trim() || null })}
          className={`${FIELD_AREA} resize-y outline-none`}
        />
      )}
    </div>
  );
}

export function OrchestratorRolesSettings({ settings, models, save }: { settings: Settings; models: ModelOption[]; save: Save }) {
  return (
    <Group title="Roles and models" footer="A role with no model is off: the router never picks it.">
      {settings.roles.map((role) => (
        <RoleRow
          key={role.id}
          role={role}
          models={models}
          onChange={(patch) => save({ roles: settings.roles.map((entry) => (entry.id === role.id ? { ...entry, ...patch } : entry)) })}
        />
      ))}
    </Group>
  );
}

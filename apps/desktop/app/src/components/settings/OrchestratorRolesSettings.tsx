import { useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { OrchestratorRole, OrchestratorSettings as Settings } from "@milagre/shared/orchestrator";
import type { ModelOption } from "../../model";
import { FIELD_AREA } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { RoleModelPicker } from "./OrchestratorRoleModel";
import { Group } from "./SettingsGroup";

type Save = (patch: Partial<Settings>) => void;

function RoleRow({ role, models, onChange }: { role: OrchestratorRole; models: ModelOption[]; onChange: (patch: Partial<OrchestratorRole>) => void }) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState(role.instructions ?? "");
  return (
    <div data-orchestrator-role={role.id} className="grid gap-2.5 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-15 font-semibold text-ink">{role.name}</span>
          {!role.model && <span className="text-12 text-ink-3">No model set · role inactive</span>}
        </div>
        <RoleModelPicker role={role} models={models} onChange={onChange} />
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

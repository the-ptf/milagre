import { useState } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { useComputers } from "../lib/computers";
import { AccountsSettings } from "./AccountsSettings";
import { ProjectAccountsSettings } from "./ProjectAccountsSettings";
import { LimitAutoSwitchSetting } from "./settings/LimitAutoSwitchSetting";
import { ChoiceGroup } from "./settings/settings-parts";
import { Select } from "./primitives/Select";

export function AccountsPage({ title, projectPath }: { title: string; projectPath?: string }) {
  const { thisMac, computers } = useComputers();
  const [chosen, setChosen] = useState<string>(LOCAL_COMPUTER);
  const remote = computers.find((computer) => computer.id === chosen) ?? null;
  const computerId = remote ? remote.id : LOCAL_COMPUTER;
  return (
    <div data-accounts-page>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {computers.length > 0 && (
          <Select
            label="Computer"
            value={computerId}
            width={200}
            compact
            options={[
              { value: LOCAL_COMPUTER, label: thisMac || "This computer" },
              ...computers.map((computer) => ({ value: computer.id, label: computer.state === "online" ? computer.name : `${computer.name} · Offline` })),
            ]}
            onChange={setChosen}
          />
        )}
      </div>
      <AccountsSettings key={computerId} computerId={computerId} computerName={remote?.name ?? null} online={remote ? remote.state === "online" : true} />
      <LimitAutoSwitchSetting key={`limits-${computerId}`} computerId={computerId} />
      <ChoiceGroup title="Per Project">
        <ProjectAccountsSettings projectPath={projectPath} />
      </ChoiceGroup>
    </div>
  );
}

import { useState } from "react";
import type { ModelOption } from "../../model";
import { OrchestratorRow, OrchestratorSettingsPage } from "./OrchestratorSettings";
import { useRemoteDelegationEnabled } from "../../lib/remote-delegation";
import { useDeviceNotesEnabled } from "../../lib/device-notes";
import { DEVICE_NOTES_DESCRIPTION, DEVICE_NOTES_LABEL, DEVICE_NOTES_WARNING } from "@milagre/shared/device-notes";
import { SettingCheckbox } from "../primitives/Checkbox";
import { updateSettings, useSettings } from "../../lib/settings";
import { Group, Row } from "./SettingsGroup";
import { NEW_CHAT_STATS_HINT, NEW_CHAT_STATS_LABEL } from "@milagre/shared/new-chat-glance";
import { WORKSPACE_TABS_DESCRIPTION, WORKSPACE_TABS_LABEL } from "@milagre/shared/workspace-tabs";
import { computerNoun } from "../../lib/shortcut-hints";

function RemoteDelegationSettings() {
  const setting = useRemoteDelegationEnabled();
  return (
    <div data-slot="remote-delegation-setting">
      <Row
        label="Delegate to other computers"
        description={`A Chat's agent can hand work to a Project on another paired computer. That computer runs the turn, and this Chat shows it as it runs. Needs Drive other computers on in Settings › This ${computerNoun}.`}
      >
        <SettingCheckbox
          label="Delegate to other computers"
          checked={setting.enabled}
          disabled={!setting.ready || setting.saving}
          onChange={(enabled) => void setting.save(enabled)}
        />
      </Row>
      {setting.error && (
        <p role="alert" className="px-4 pb-3 text-12 text-red-ink">
          {setting.error}
        </p>
      )}
    </div>
  );
}

function DeviceNotesSettings() {
  const setting = useDeviceNotesEnabled();
  if (!setting.available) return null;
  return (
    <div data-slot="device-notes-setting">
      <Row label={DEVICE_NOTES_LABEL} description={DEVICE_NOTES_DESCRIPTION}>
        <SettingCheckbox
          label={DEVICE_NOTES_LABEL}
          checked={setting.enabled}
          disabled={!setting.ready || setting.saving}
          onChange={(enabled) => void setting.save(enabled)}
        />
      </Row>
      <p className="px-4 pb-3 text-12 text-orange-ink">{DEVICE_NOTES_WARNING}</p>
      {setting.error && (
        <p role="alert" className="px-4 pb-3 text-12 text-red-ink">
          {setting.error}
        </p>
      )}
    </div>
  );
}

export function ExperimentalSettings({ title, models, onOpenKeybindings }: { title?: string; models: ModelOption[]; onOpenKeybindings?: () => void }) {
  const settings = useSettings();
  const [page, setPage] = useState<"church" | "orchestrator">("church");
  if (page === "orchestrator") return <OrchestratorSettingsPage models={models} onBack={() => setPage("church")} onOpenKeybindings={onOpenKeybindings} />;
  return (
    <>
      <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1 text-13 text-ink-2">Features still taking shape. They may change or go away.</p>
      <Group title="Beta">
        <OrchestratorRow onOpen={() => setPage("orchestrator")} />
        <Row
          label="Floating inbox"
          description="A thin bar attached to the screen edge. Drag its grip to show docking targets over a dimmed desktop. Drop left, right, or bottom; release elsewhere to return. The bottom bar is horizontal. Hover a dot to preview its Chat."
        >
          <SettingCheckbox label="Floating inbox" checked={settings.floatingInbox} onChange={(floatingInbox) => updateSettings({ floatingInbox })} />
        </Row>
        {settings.floatingInbox && (
          <div className="ml-4 border-l border-line pl-4">
            <Row
              label="Show Chat activity"
              description="Include working chats with a progress summary and finished updates. Off: only questions and permission requests."
            >
              <SettingCheckbox
                label="Show Chat activity"
                checked={settings.floatingInboxActivity}
                onChange={(floatingInboxActivity) => updateSettings({ floatingInboxActivity })}
              />
            </Row>
          </div>
        )}
        <Row
          label="Ultracode Fatality"
          description="Turning Ultracode on darkens the window, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud."
        >
          <SettingCheckbox
            label="Ultracode Fatality"
            checked={settings.ultracodeFatality}
            onChange={(ultracodeFatality) => updateSettings({ ultracodeFatality })}
          />
        </Row>
        <Row label={NEW_CHAT_STATS_LABEL} description={NEW_CHAT_STATS_HINT}>
          <SettingCheckbox label={NEW_CHAT_STATS_LABEL} checked={settings.newChatGlance} onChange={(newChatGlance) => updateSettings({ newChatGlance })} />
        </Row>
        <Row label={WORKSPACE_TABS_LABEL} description={WORKSPACE_TABS_DESCRIPTION}>
          <SettingCheckbox label={WORKSPACE_TABS_LABEL} checked={settings.workspaceTabs} onChange={(workspaceTabs) => updateSettings({ workspaceTabs })} />
        </Row>
        <RemoteDelegationSettings />
        <DeviceNotesSettings />
      </Group>
    </>
  );
}

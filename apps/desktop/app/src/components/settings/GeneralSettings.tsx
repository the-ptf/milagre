import { SettingCheckbox } from "../primitives/Checkbox";
import { updateSettings, useSettings } from "../../lib/settings";
import type { UsageDisplay } from "../../lib/settings";
import { SIDEBAR_USAGE_PICKS, sidebarUsagePick, sidebarUsagePickSettings, type SidebarUsagePick } from "@milagre/shared/usage";
import type { ChatOrder } from "../../lib/chat-list";
import { useEditors } from "../../lib/editors";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { ChatListChoice } from "./ChatDisplayChoices";
import { computerNoun } from "../../lib/shortcut-hints";
import { ChoiceGroup } from "./settings-parts";
import { DoneRetentionSetting, SnoozeSetting } from "./ChatSettings";

export function GeneralSettings() {
  const settings = useSettings();
  const usagePick = sidebarUsagePick(settings.usageInSidebar, settings.appearance.sidebarUsage);
  const { editors, editor } = useEditors();
  return (
    <>
      <Group title="Editor">
        <Row
          label="Open files in"
          description={
            editors && editors.length === 0
              ? "Install Cursor, VS Code, Zed or another editor to open files and folders"
              : "Used by file links in replies and tool rows, and by Open in <editor> in the chat menu"
          }
        >
          {editors && editors.length === 0 ? (
            <span className="text-ink-3">No editor found</span>
          ) : (
            <Select
              label="Open files in"
              value={editor?.id ?? ""}
              onChange={(editorId) => updateSettings({ editorId })}
              options={(editors ?? []).map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            />
          )}
        </Row>
      </Group>
      <Group title="Sidebar">
        <Row label="Chat order" description="Newest Chat first keeps Chats in place as replies arrive">
          <Select<ChatOrder>
            label="Chat order"
            value={settings.chatOrder}
            onChange={(chatOrder) => updateSettings({ chatOrder })}
            options={[
              { value: "created", label: "Newest Chat first" },
              { value: "recent", label: "Latest message first" },
            ]}
          />
        </Row>
      </Group>
      <ChoiceGroup title="Chat list">
        <ChatListChoice
          value={settings.chatList === "list" && settings.appearance.sidebarRows === "edge" ? "title-first" : settings.chatList}
          onChange={(pick) =>
            pick === "title-first" || pick === "list"
              ? updateSettings({ chatList: "list", appearance: { ...settings.appearance, sidebarRows: pick === "title-first" ? "edge" : "classic" } })
              : updateSettings({ chatList: pick })
          }
        />
      </ChoiceGroup>
      <DoneRetentionSetting />
      <SnoozeSetting />
      <Group title="Plan usage">
        <Row label="Show" description="Claude, Codex and Antigravity plan limits">
          <Select<UsageDisplay>
            label="Show usage as"
            value={settings.usageDisplay}
            onChange={(usageDisplay) => updateSettings({ usageDisplay })}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
          />
        </Row>
        <Row label="Show in sidebar" description={SIDEBAR_USAGE_PICKS.find((choice) => choice.id === usagePick)?.hint}>
          <Select<SidebarUsagePick>
            label="Show usage in sidebar"
            value={usagePick}
            onChange={(pick) => {
              const { usageInSidebar, sidebarUsage } = sidebarUsagePickSettings(pick);
              updateSettings(sidebarUsage ? { usageInSidebar, appearance: { ...settings.appearance, sidebarUsage } } : { usageInSidebar });
            }}
            options={SIDEBAR_USAGE_PICKS.map((choice) => ({ value: choice.id, label: choice.label }))}
          />
        </Row>
      </Group>
      <Group title="System">
        <Row
          label={`Keep the ${computerNoun} awake`}
          description="While Milagre runs, so your phone and other computers can reach it. The screen can still turn off. Plugged in, it stays awake with the lid closed; on battery, closing the lid sleeps it."
        >
          <SettingCheckbox label={`Keep the ${computerNoun} awake`} checked={settings.keepAwake} onChange={(keepAwake) => updateSettings({ keepAwake })} />
        </Row>
      </Group>
    </>
  );
}

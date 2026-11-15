import { permissionPresentation } from "@milagre/shared/model-copy";
import { ContextSettings } from "../ContextSettings";
import { SettingCheckbox } from "../primitives/Checkbox";
import { PROVIDERS, providerName } from "@milagre/shared/providers";
import { SecurityCheckIcon, Shield01Icon, ShieldAlertIcon } from "@hugeicons/core-free-icons";
import { PERMISSION_MODES } from "../../model";
import type { ModelOption, PermissionMode } from "../../model";
import { providerForId, resolveModel } from "../../lib/models";
import { updateSettings, useSettings } from "../../lib/settings";
import type { ClaudeReplies } from "../../lib/settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { ProviderLogo } from "../ProviderLogo";
import { Icon, ChoiceGroup } from "./settings-parts";

/** What new Chats start with and how agents write and compact: defaults, context, replies. */
export function ModelsSettings({ models }: { models: ModelOption[] }) {
  const settings = useSettings();
  return (
    <>
      <Group title="New chats">
        <Row label="Default model" description="Used for new chats; remembers your last selection">
          <Select
            label="Default model"
            width={280}
            value={resolveModel(models, settings.defaultModelId, providerForId(settings.defaultModelId)).id}
            onChange={(defaultModelId) => updateSettings({ defaultModelId })}
            options={PROVIDERS.flatMap((provider) =>
              models
                .filter((model) => model.provider === provider)
                .map((model) => ({
                  value: model.id,
                  label: model.name,
                  icon: <ProviderLogo provider={provider} size={14} />,
                  group: providerName(provider),
                })),
            )}
          />
        </Row>
        <Row label="Default permission" description="Used for new chats; remembers your last selection">
          <Select<PermissionMode>
            label="Default permission"
            width={340}
            value={settings.defaultPermissionMode}
            onChange={(defaultPermissionMode) => updateSettings({ defaultPermissionMode })}
            options={PERMISSION_MODES.map((mode) => ({
              value: mode.id,
              label: mode.name,
              description: mode.description,
              icon: (
                <span className={`flex shrink-0 ${mode.id === "full" ? "text-orange-ink" : "text-ink-2"}`}>
                  <Icon
                    icon={{ shield: Shield01Icon, "security-check": SecurityCheckIcon, "shield-alert": ShieldAlertIcon }[permissionPresentation(mode.id).icon]}
                    size={14}
                  />
                </span>
              ),
            }))}
          />
        </Row>
      </Group>
      <ChoiceGroup title="Context">
        <ContextSettings />
      </ChoiceGroup>
      <Group title="Replies">
        <Row
          label="TLDR writing"
          description="Shape Claude, Codex and Antigravity updates and replies with /tldr. Applies on the next turn after the current reply finishes."
        >
          <SettingCheckbox label="TLDR writing" checked={settings.tldrEnabled} onChange={(tldrEnabled) => updateSettings({ tldrEnabled })} />
        </Row>
        <Row label="Claude replies">
          <Select<ClaudeReplies>
            label="Claude replies"
            value={settings.claudeReplies}
            onChange={(claudeReplies) => updateSettings({ claudeReplies })}
            options={[
              { value: "concise", label: "Concise" },
              { value: "normal", label: "Normal" },
            ]}
          />
        </Row>
      </Group>
    </>
  );
}

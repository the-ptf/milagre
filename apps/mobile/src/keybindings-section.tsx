import { Alert, Text, View } from "react-native";
import { KeyboardIcon } from "@hugeicons/core-free-icons";
import {
  KEYBINDING_COMMANDS,
  canonicalKey,
  conflictsFor,
  defaultRulesFor,
  hasCommandModifier,
  isDefault,
  keyLabelFor,
  keybindingCommand,
  parseKey,
  type KeybindingCommand,
  type KeybindingCommandId,
  type KeybindingRule,
} from "@milagre/shared/keybindings";
import { confirmSheet } from "./confirm-store";
import { rulesOf, useHostKeybindings } from "./keybindings-store";
import { Group, Row } from "./settings-list";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { ErrorNotice, showActions } from "./ui";

// Settings › Keybindings on an iPad: the connected Mac's keybindings.json, which the Mac and this iPad's keyboard both
// run (desktop's Settings › Keybindings edits the same file). A key is typed as text, `cmd+shift+k`, as in the file.

const label = (key: string) => keyLabelFor(key, true) ?? key;
const title = (command: KeybindingCommandId) => keybindingCommand(command)?.title ?? command;
const own = (rules: readonly KeybindingRule[], command: KeybindingCommandId) =>
  rules.filter((rule) => rule.command === command).map(({ key, when }) => (when ? { key, when } : { key }));

const fail = (failure: unknown) => Alert.alert("Couldn't save", failure instanceof Error ? failure.message : String(failure));

export function KeybindingsSection() {
  const { colors } = useTheme();
  const session = useSession();
  const host = useHostKeybindings(session.client);
  const rules = rulesOf(host);
  const store = host.store;
  const editable = Boolean(store && host.state);

  async function addKey(command: KeybindingCommandId, typed: string) {
    const shortcut = parseKey(typed);
    if (!store || !shortcut) {
      Alert.alert("That isn't a key", "Type it as cmd+shift+k, alt+left or f5.");
      return;
    }
    const key = typed.trim().toLowerCase();
    if (!hasCommandModifier(key)) {
      Alert.alert(`${label(key)} would run while you type`, "Add cmd, ctrl or alt.");
      return;
    }
    const mine = own(rules, command);
    const conflicts = conflictsFor(rules, { key, command }, true);
    const save = async (take: KeybindingCommandId[]) => {
      try {
        for (const other of take) {
          await store.setCommand(
            other,
            own(rules, other).filter((rule) => rule.when || canonicalKey(rule.key, true) !== canonicalKey(key, true)),
          );
        }
        await store.setCommand(command, [...mine, { key }]);
      } catch (failure) {
        fail(failure);
      }
    };
    if (!conflicts.length) return void save([]);
    confirmSheet(
      `${label(key)} already runs ${conflicts.map((other) => `“${title(other)}”`).join(", ")}`,
      `Replace takes it from ${conflicts.length > 1 ? "them" : "it"}.`,
      [
        { text: "Replace", style: "default", onPress: () => void save(conflicts) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  function edit(command: KeybindingCommand) {
    if (!store) return;
    const mine = own(rules, command.id);
    showActions({
      title: command.title,
      actions: [
        { id: "add", title: mine.length ? "Add another key" : "Add a key" },
        ...mine.map((rule, index) => ({ id: `remove:${index}`, title: `Remove ${label(rule.key)}`, destructive: true })),
        { id: "reset", title: "Back to default", disabled: isDefault(rules, command.id) },
      ],
      onSelect: (id) => {
        if (id === "add") {
          Alert.prompt(
            `A key for ${command.title}`,
            "Type it as cmd+shift+k, alt+left or f5.",
            (typed) => void addKey(command.id, typed ?? ""),
            "plain-text",
            "",
            "default",
          );
        } else if (id === "reset") {
          void store
            .setCommand(
              command.id,
              defaultRulesFor(command.id).map(({ key }) => ({ key })),
            )
            .catch(fail);
        } else if (id.startsWith("remove:")) {
          const index = Number(id.slice("remove:".length));
          void store
            .setCommand(
              command.id,
              mine.filter((_, at) => at !== index),
            )
            .catch(fail);
        }
      },
    });
  }

  const row = (command: KeybindingCommand) => {
    const keys = own(rules, command.id).map((rule) => label(rule.key) + (rule.when ? "*" : ""));
    return (
      <Row
        key={command.id}
        title={command.title}
        icon={KeyboardIcon}
        value={keys.length ? keys.join("  ") : "None"}
        chevron={editable}
        disabled={!editable}
        onPress={editable ? () => edit(command) : undefined}
      />
    );
  };

  return (
    <View style={{ gap: 28 }}>
      <Text style={{ color: colors.ink2, fontSize: 15, lineHeight: 21, paddingHorizontal: 16 }}>
        {host.state
          ? "The connected Mac's keybindings.json. The Mac and this iPad's keyboard both use it; a key marked * runs only under a condition."
          : session.client
            ? "This Mac's Milagre keeps no keybindings yet, so the iPad uses the defaults. Update Milagre on the Mac to change them."
            : "Connect a computer to change its keybindings."}
      </Text>
      {host.error ? <ErrorNotice message={host.error} retry={() => void store?.read()} retryTitle="Try again" /> : null}
      {host.state?.issues.length ? <ErrorNotice message={`keybindings.json has problems: ${host.state.issues.join(" ")}`} /> : null}
      <Group title="On this iPad">{KEYBINDING_COMMANDS.filter((command) => command.mobile).map(row)}</Group>
      <Group title="On the Mac" footer={host.state ? host.state.path : undefined}>
        {KEYBINDING_COMMANDS.filter((command) => !command.mobile).map(row)}
      </Group>
      {editable ? (
        <Group>
          {[
            <Row
              key="reset"
              title="Reset all to defaults"
              destructive
              chevron={false}
              onPress={() =>
                confirmSheet("Reset all keybindings?", "Every key goes back to its default, on the Mac too.", [
                  { text: "Reset all", style: "destructive", onPress: () => void store?.resetAll().catch(fail) },
                  { text: "Cancel", style: "cancel" },
                ])
              }
            />,
          ]}
        </Group>
      ) : null}
    </View>
  );
}

import { Text, View } from "react-native";
import { Cancel01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { MessageEditFlow } from "@milagre/shared/use-message-edit";
import { Icon } from "./icons";
import { FileRow } from "./undo-panel";
import { IconButton, InlineError, Toggle, useStyles } from "./ui";
import { lineHeight, radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** Above the composer while a sent message is edited, styled like the Queued card: what goes, and the file undo. */
export function MessageEditCard({
  flow,
  running,
  sending,
  error,
  onCancel,
}: {
  flow: MessageEditFlow;
  running: boolean;
  sending: boolean;
  error: string;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const edit = flow.edit;
  if (!edit) return null;
  const removed = edit.removed;
  return (
    <View
      accessibilityLabel="Editing a message"
      testID="message-edit-card"
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.sheet,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.lineStrong,
        paddingHorizontal: space.xl,
        paddingTop: space.md,
        paddingBottom: space.md,
        gap: space.xs,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon icon={PencilEdit02Icon} tone="ink3" size={18} />
        <Text style={{ flex: 1, color: colors.ink2, fontWeight: "600", fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>Editing message</Text>
        <IconButton label="Cancel editing" icon={Cancel01Icon} size={32} disabled={sending} onPress={onCancel} />
      </View>
      <Text style={styles.caption}>
        {removed ? `The ${removed} ${removed === 1 ? "message" : "messages"} after it will be removed.` : "Nothing after it is removed."}
        {running ? " The running turn stops first." : ""}
      </Text>
      {(flow.files.length > 0 || running) && (
        <Toggle
          title={flow.files.length ? `Also undo the changes to ${files(flow.files.length)}` : "Also undo the files the removed turns change"}
          selected={edit.undo}
          disabled={sending}
          onPress={() => flow.setUndo(!edit.undo)}
        />
      )}
      {edit.undo &&
        flow.files
          .filter((file) => file.conflict)
          .map((file, index) => (
            <FileRow
              key={file.key}
              file={file}
              intent="Undo"
              first={index === 0}
              decision={edit.decisions[file.key]}
              onChoose={(decision) => flow.choose(file.key, decision)}
            />
          ))}
      <InlineError message={error} />
    </View>
  );
}

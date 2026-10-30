import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FileAddIcon,
  FileEditIcon,
  FileRemoveIcon,
  Redo02Icon,
  Undo02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { checkpointEffect, checkpointMeta, checkpointTask, checkpointTime, splitCheckpointPath, type CheckpointFile } from "@milagre/shared/checkpoints";
import type { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { Icon } from "./icons";
import { ErrorNotice, IconButton, PageScroll, PillButton, Segmented, pressStyle } from "./ui";
import { lineHeight, radius, type } from "./design-tokens";
import { useTheme } from "./theme";

export type CheckpointReview = ReturnType<typeof useCheckpoints>;
/** Undo previews a task's checkpoint; Redo previews the recovery checkpoint an undo saved. */
export type UndoIntent = "Undo" | "Redo";

const FILE_ICONS = { replace: FileEditIcon, delete: FileAddIcon, create: FileRemoveIcon } as const;

/**
 * Undo changes in the composer's place, as on desktop: the Chat's tasks (from ⋯ or /undo), then one task's files with what
 * undoing does to each. Only a file edited after the task asks Keep current or Undo; the button waits for that answer.
 */
export function UndoPanel({
  review,
  intent,
  onOpenFile,
}: {
  review: CheckpointReview;
  intent: UndoIntent;
  /** Opens a file's diff; absent where the phone can't show it (a shared Link Chat). */
  onOpenFile?: (file: CheckpointFile) => void;
}) {
  const { colors } = useTheme();
  const preview = review.view === "preview" ? review.preview : null;
  const title = review.view === "list" ? "Undo changes" : `${intent} changes`;
  const count = review.resolved ? review.restoreCount : (preview?.files.length ?? 0);
  const label =
    review.pending && preview
      ? "Working…"
      : review.resolved && count === 0
        ? `Nothing to ${intent.toLowerCase()}`
        : `${intent} ${count} ${count === 1 ? "file" : "files"}`;
  return (
    <View
      testID="undo-panel"
      accessibilityLabel={title}
      style={{
        borderRadius: 24,
        borderCurve: "continuous",
        overflow: "hidden",
        padding: 16,
        paddingTop: 12,
        gap: 12,
        boxShadow: colors.shadowRaised,
      }}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 24, borderCurve: "continuous", backgroundColor: colors.surface }]} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon icon={intent === "Redo" && review.view === "preview" ? Redo02Icon : Undo02Icon} tone="ink2" size={18} />
        <Text accessibilityRole="header" style={{ flex: 1, color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600" }}>
          {title}
        </Text>
        <IconButton label="Close" icon={Cancel01Icon} size={34} disabled={review.pending} onPress={review.close} />
      </View>
      {review.view === "list" ? (
        <PageScroll
          style={{ maxHeight: 260, flexGrow: 0 }}
          contentContainerStyle={{ padding: 0, paddingBottom: 0, gap: 2 }}
          contentInsetAdjustmentBehavior="never"
        >
          {!review.tasks.length && (
            <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, paddingVertical: 8 }}>
              {review.pending ? "Loading…" : "No task has changed files yet."}
            </Text>
          )}
          {review.tasks.map((item, index) => (
            <Pressable
              key={item.id}
              testID={`undo-task-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${checkpointTask(item)}. ${checkpointMeta(item)}`}
              accessibilityState={{ disabled: review.pending }}
              disabled={review.pending}
              onPress={() => void review.inspect(item.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: radius.card,
                borderCurve: "continuous",
                backgroundColor: index === 0 || pressed ? colors.field : "transparent",
              })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
                  {checkpointTask(item)}
                </Text>
                <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{checkpointMeta(item)}</Text>
              </View>
              <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
            </Pressable>
          ))}
        </PageScroll>
      ) : (
        <>
          {preview && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`From ${checkpointTask(preview)}, ${checkpointTime(preview.createdAt)}. Choose another task`}
              accessibilityState={{ disabled: review.pending || !review.tasks.length || intent !== "Undo" }}
              disabled={review.pending || !review.tasks.length || intent !== "Undo"}
              onPress={review.back}
              style={({ pressed }) => [
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  minHeight: 44,
                  paddingHorizontal: 12,
                  borderRadius: radius.control,
                  borderCurve: "continuous",
                  backgroundColor: colors.field,
                },
                pressStyle({ pressed }),
              ]}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "500" }}>
                {checkpointTask(preview)}
              </Text>
              <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{checkpointTime(preview.createdAt)}</Text>
              {review.tasks.length > 0 && intent === "Undo" && <Icon icon={UnfoldMoreIcon} tone="ink3" size={16} />}
            </Pressable>
          )}
          {!!review.notice && (
            <Text accessibilityRole="alert" style={{ color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
              {review.notice}
            </Text>
          )}
          {!preview ? (
            !review.error && <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>Checking files…</Text>
          ) : !preview.files.length ? (
            <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
              These files are already as they were before the task.
            </Text>
          ) : (
            <PageScroll
              style={{ maxHeight: 280, flexGrow: 0 }}
              contentContainerStyle={{ padding: 0, paddingBottom: 0, gap: 0 }}
              contentInsetAdjustmentBehavior="never"
            >
              {preview.files.map((file, index) => (
                <FileRow
                  key={file.key}
                  file={file}
                  intent={intent}
                  first={index === 0}
                  decision={review.decisions[file.key]}
                  onChoose={(decision) => review.choose(file.key, decision)}
                  onOpen={onOpenFile ? () => onOpenFile(file) : undefined}
                />
              ))}
            </PageScroll>
          )}
          {!!review.error && <ErrorNotice message={review.error} />}
          {review.conflicts > 0 && !review.error && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon icon={Alert02Icon} tone="orange" size={16} />
              <Text style={{ color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                {review.conflicts === 1 ? "1 file needs a choice" : `${review.conflicts} files need a choice`}
              </Text>
            </View>
          )}
          <PillButton
            title={label}
            disabled={review.pending || !review.resolved || review.restoreCount === 0}
            loading={review.pending && !!preview}
            onPress={() => void review.restore()}
          />
          {!!preview?.files.length && (
            <Text
              style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, textAlign: "center" }}
            >{`You can ${intent === "Undo" ? "redo" : "undo"} this.`}</Text>
          )}
        </>
      )}
    </View>
  );
}

function FileRow({
  file,
  intent,
  first,
  decision,
  onChoose,
  onOpen,
}: {
  file: CheckpointFile;
  intent: UndoIntent;
  first: boolean;
  decision: "keep" | "restore" | undefined;
  onChoose: (decision: "keep" | "restore") => void;
  onOpen?: () => void;
}) {
  const { colors } = useTheme();
  const { name, dir } = splitCheckpointPath(file.path);
  const effect = intent === "Redo" && file.action === "replace" ? "Reapply" : checkpointEffect(file);
  return (
    <View testID="undo-file" style={{ gap: 8, paddingVertical: 12, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
      <Pressable
        accessibilityRole={onOpen ? "button" : undefined}
        accessibilityLabel={`${file.path}. ${file.conflict ? "Edited after this task" : effect}`}
        disabled={!onOpen}
        onPress={onOpen}
        style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12 }, pressStyle({ pressed })]}
      >
        <Icon icon={FILE_ICONS[file.action]} tone="ink3" size={18} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>
            <Text style={{ fontWeight: "500" }}>{name}</Text>
            {dir ? <Text style={{ color: colors.ink3, fontSize: type.footnote }}>{`  ${dir}`}</Text> : null}
          </Text>
          {file.conflict && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.orange }} />
              <Text style={{ color: colors.orangeInk, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>Edited after this task</Text>
            </View>
          )}
        </View>
        {!file.conflict && <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{effect}</Text>}
        {onOpen && <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />}
      </Pressable>
      {file.conflict && (
        <Segmented
          label={`${name}: keep it or ${intent.toLowerCase()} it`}
          value={decision ?? ""}
          options={[
            { value: "keep", title: "Keep current" },
            { value: "restore", title: intent },
          ]}
          onChange={(value) => onChoose(value as "keep" | "restore")}
        />
      )}
    </View>
  );
}

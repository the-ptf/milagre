import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { VALIDATION_COPY, VALIDATION_LIMITS, type ValidationCommand, type ValidationSettings } from "@milagre/shared/validation";
import type { Client } from "./client";
import { fonts } from "./theme";
import { Field, Group, InlineError, ListRow, PillButton, useStyles } from "./ui";

const BLOCK = { paddingVertical: 12, gap: 8 } as const;
const EMPTY: ValidationCommand = { name: "", command: "", cwd: "" };

/** Settings › Project › Validation, as on desktop: the commands Milagre runs to prove a task's code, saved as you type. */
export function ProjectValidationSettings({ client, path }: { client: Client; path: string }) {
  const styles = useStyles();
  const [draft, setDraft] = useState<ValidationSettings | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<ValidationSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    void client.call<ValidationSettings>("project-validation:save", [path, next]).then(
      () => setError(""),
      (failure: unknown) => setError(failure instanceof Error ? `Couldn't save: ${failure.message}` : "Couldn't save validation commands."),
    );
  }

  useEffect(() => {
    let live = true;
    client.call<ValidationSettings>("project-validation:read", [path]).then(
      (value) => live && setDraft({ ...value, commands: value.commands.length ? value.commands : [EMPTY] }),
      (failure: unknown) => live && setError(failure instanceof Error ? failure.message : "Couldn't read validation commands."),
    );
    return () => {
      live = false;
      flush();
    };
  }, [client, path]);

  if (!draft)
    return (
      <Group title={VALIDATION_COPY.title} inset={0}>
        <View style={BLOCK}>{error ? <InlineError message={error} /> : <Text style={styles.caption}>Loading…</Text>}</View>
      </Group>
    );

  function change(next: ValidationSettings, now = false) {
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(flush, 600);
  }
  const edit = (index: number, patch: Partial<ValidationCommand>) =>
    change({ ...draft, commands: draft.commands.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  const remove = (index: number) => {
    const commands = draft.commands.filter((_, at) => at !== index);
    change({ ...draft, commands: commands.length ? commands : [EMPTY] }, true);
  };

  return (
    <View style={{ gap: 12 }}>
      <Group title={VALIDATION_COPY.title} footer={VALIDATION_COPY.commands.description} inset={0}>
        {draft.commands.map((item, index) => (
          <View key={index} style={BLOCK} testID="validation-command">
            <Field
              label={VALIDATION_COPY.name.label}
              value={item.name}
              placeholder={VALIDATION_COPY.name.placeholder}
              maxLength={VALIDATION_LIMITS.name}
              onChangeText={(name) => edit(index, { name })}
            />
            <Field
              label={VALIDATION_COPY.command.label}
              value={item.command}
              placeholder={VALIDATION_COPY.command.placeholder}
              maxLength={VALIDATION_LIMITS.command}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ fontFamily: fonts.mono }}
              onChangeText={(command) => edit(index, { command })}
            />
            <Field
              label={VALIDATION_COPY.cwd.label}
              value={item.cwd}
              placeholder={VALIDATION_COPY.cwd.placeholder}
              maxLength={VALIDATION_LIMITS.cwd}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ fontFamily: fonts.mono }}
              onChangeText={(cwd) => edit(index, { cwd })}
            />
            <View style={{ flexDirection: "row" }}>
              <PillButton size="small" variant="plain" destructive title="Remove command" onPress={() => remove(index)} />
            </View>
          </View>
        ))}
        {draft.commands.length < VALIDATION_LIMITS.commands && (
          <View style={{ paddingVertical: 12, flexDirection: "row" }}>
            <PillButton
              size="small"
              variant="secondary"
              title={VALIDATION_COPY.add}
              onPress={() => change({ ...draft, commands: [...draft.commands, EMPTY] }, true)}
            />
          </View>
        )}
        {error ? (
          <View style={{ paddingBottom: 12 }}>
            <InlineError message={error} />
          </View>
        ) : null}
      </Group>
      <Group footer={VALIDATION_COPY.afterTask.description} inset={0}>
        <ListRow
          title={VALIDATION_COPY.afterTask.label}
          subtitleLines={2}
          toggle={{ value: draft.afterTask, onChange: () => change({ ...draft, afterTask: !draft.afterTask }, true) }}
        />
      </Group>
    </View>
  );
}

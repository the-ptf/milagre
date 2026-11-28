import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Alert02Icon, ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { SECRETS_COPY, loginHost, secretFlags, secretScopeText, type SecretDelivery, type SecretKind, type SecretSummary } from "@milagre/shared/secrets";
import { ago } from "@milagre/shared/main-sync";
import { CheckRow, Field, Group, InlineError, pressStyle, useStyles } from "./ui";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { lineHeight, space, type } from "./design-tokens";
import { useProjectOrigins } from "./use-secrets";

export type SecretOptIns = { delivery: SecretDelivery; askEachUse: boolean; unattended: boolean };

/** A write-only value: masked until the eye is pressed, hidden again when the field loses focus. */
export function SecretValueField({
  label,
  value,
  onChangeText,
  disabled = false,
  onSubmitEditing,
  placeholder = SECRETS_COPY.valuePlaceholder,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChangeText: (value: string) => void;
  disabled?: boolean;
  onSubmitEditing?: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Field
      label={label}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      secureTextEntry={!revealed}
      autoComplete="off"
      textContentType="none"
      editable={!disabled}
      onBlur={() => setRevealed(false)}
      onSubmitEditing={onSubmitEditing}
      returnKeyType="done"
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? "Hide value" : "Show value"}
          disabled={disabled || !value}
          onPress={() => setRevealed((current) => !current)}
          style={({ pressed }) => [
            { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", marginRight: -space.md },
            pressStyle({ pressed, disabled: disabled || !value }),
          ]}
        >
          <Icon icon={revealed ? ViewOffIcon : ViewIcon} size={20} tone="ink2" />
        </Pressable>
      }
    />
  );
}

/** All Projects, or a checklist of the computer's Projects by origin. Chosen with none checked is shown, not saved. */
export function SecretScopeFields({
  projects,
  onChange,
  disabled = false,
}: {
  projects: "all" | string[];
  onChange: (projects: "all" | string[]) => void;
  disabled?: boolean;
}) {
  const origins = useProjectOrigins(projects);
  const chosen = Array.isArray(projects) ? projects : null;
  const toggle = (origin: string) => {
    const current = chosen ?? [];
    onChange(current.includes(origin) ? current.filter((item) => item !== origin) : [...current, origin]);
  };
  return (
    <View style={{ gap: 8 }}>
      <Group title={SECRETS_COPY.projects} role="radiogroup" inset={0}>
        <CheckRow title={SECRETS_COPY.allProjects} checked={!chosen} disabled={disabled} onPress={() => onChange("all")} />
        <CheckRow title={SECRETS_COPY.chosenProjects} checked={!!chosen} disabled={disabled} onPress={() => chosen || onChange([])} />
      </Group>
      {chosen ? (
        origins.length ? (
          <Group inset={32}>
            {origins.map(({ origin, name }) => (
              <CheckRow
                key={origin}
                kind="checkbox"
                title={name}
                subtitle={origin}
                subtitleLines={1}
                checked={chosen.includes(origin)}
                disabled={disabled}
                onPress={() => toggle(origin)}
              />
            ))}
          </Group>
        ) : null
      ) : null}
      {chosen && !chosen.length ? <InlineError message={SECRETS_COPY.noProjects} style={{ paddingHorizontal: 4 }} /> : null}
    </View>
  );
}

/** The three opt-ins, each with its help. Keeping a secret in the environment is only for text secrets. */
export function SecretOptInFields({
  kind,
  value,
  onChange,
  disabled = false,
}: {
  kind: SecretKind;
  value: SecretOptIns;
  onChange: (patch: Partial<SecretOptIns>) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Group inset={32}>
      {kind === "text" ? (
        <CheckRow
          kind="checkbox"
          title={SECRETS_COPY.ambient.label}
          subtitle={SECRETS_COPY.ambient.help}
          checked={value.delivery === "ambient"}
          disabled={disabled}
          onPress={() => onChange(value.delivery === "ambient" ? { delivery: "on-demand" } : { delivery: "ambient", askEachUse: false })}
        />
      ) : null}
      {kind === "login" ? null : (
        <CheckRow
          kind="checkbox"
          title={SECRETS_COPY.askEachUse.label}
          subtitle={SECRETS_COPY.askEachUse.help}
          checked={value.askEachUse}
          disabled={disabled}
          onPress={() => onChange(value.askEachUse ? { askEachUse: false } : { askEachUse: true, delivery: "on-demand" })}
        />
      )}
      <View style={{ paddingBottom: space.md }}>
        <CheckRow
          kind="checkbox"
          title={SECRETS_COPY.unattended.label}
          checked={value.unattended}
          disabled={disabled}
          onPress={() => onChange({ unattended: !value.unattended })}
        />
        <View style={{ flexDirection: "row", gap: 6, marginTop: -4, paddingLeft: 32 }}>
          <Icon icon={Alert02Icon} size={16} tone="orangeInk" />
          <Text style={{ flex: 1, color: colors.orangeInk, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>{SECRETS_COPY.unattended.help}</Text>
        </View>
      </View>
    </Group>
  );
}

function codeParts(text: string) {
  const parts: { part: string; at: number; code: boolean }[] = [];
  let offset = 0;
  for (const [position, part] of text.split("`").entries()) {
    parts.push({ part, at: offset, code: position % 2 === 1 });
    offset += part.length + 1;
  }
  return parts;
}

/** Copy with `code` spans, as SECRETS_COPY writes commands. */
export function CodeText({ text, style }: { text: string; style?: object }) {
  const styles = useStyles();
  const parts = codeParts(text);
  return (
    <Text style={[styles.caption, style]}>
      {parts.map(({ part, at, code }) =>
        code ? (
          <Text key={at} style={{ fontFamily: styles.code.fontFamily }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/** A login's name in a list and a header: its site. */
export function loginTitle(secret: SecretSummary) {
  return secret.login ? loginHost(secret.login.origin) : secret.name;
}

/** The facts a login row shows under its site: the username, where it reaches, the unattended opt-in and when it was last used. */
export function loginRowLine(secret: SecretSummary, now: number) {
  return [
    secret.login?.username || SECRETS_COPY.logins.nobody,
    secretScopeText(secret.projects),
    ...secretFlags(secret),
    secret.lastUsedAt ? SECRETS_COPY.lastUsed(ago(secret.lastUsedAt, now)) : SECRETS_COPY.neverUsed,
  ].join(" · ");
}

/** The facts a row shows under its name: the hint or file, where it reaches, its opt-ins, when it was last used and, when not `here`, the computer that changed it. */
export function secretRowLine(secret: SecretSummary, now: number, here: string) {
  return [
    secret.kind === "file" ? [SECRETS_COPY.file, secret.fileName].filter(Boolean).join(" ") : secret.hint ? `…${secret.hint}` : null,
    secretScopeText(secret.projects),
    ...secretFlags(secret),
    secret.lastUsedAt ? SECRETS_COPY.lastUsed(ago(secret.lastUsedAt, now)) : SECRETS_COPY.neverUsed,
    here && secret.changedOn !== here ? SECRETS_COPY.changedOn(secret.changedOn) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

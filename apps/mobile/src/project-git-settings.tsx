import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  BRANCH_COPY,
  BRANCH_TOKENS,
  branchPolicyCheck,
  branchPolicyOverrides,
  type BranchPolicy,
  type BranchPolicySettings,
} from "@milagre/shared/branch-policy";
import type { Client } from "./client";
import { fonts } from "./theme";
import { Chip, Field, Group, InlineError, ListRow, PillButton, useStyles } from "./ui";

const BLOCK = { paddingVertical: 12, gap: 8 } as const;

/** Adds `{token}` at the caret, with a dash before it when it would run into the previous part. */
function insertToken(value: string, token: string, at: number) {
  const before = value.slice(0, at);
  const glue = before && !/[-/_]$/.test(before) ? "-" : "";
  return `${before}${glue}{${token}}${value.slice(at)}`;
}

/** Project settings › Branches, as on desktop: saves as you type; a field set in .milagre/worktree.json is read-only. */
export function ProjectGitSettings({ client, path }: { client: Client; path: string }) {
  const styles = useStyles();
  const [saved, setSaved] = useState<BranchPolicySettings | null>(null);
  const [draft, setDraft] = useState<BranchPolicy | null>(null);
  const [error, setError] = useState("");
  const caret = useRef<number | null>(null);
  const pending = useRef<BranchPolicy | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef<BranchPolicySettings | null>(null);

  function persist(local: Partial<BranchPolicy>, adopt: boolean) {
    return client.call<BranchPolicySettings>("project-git:save", [path, local]).then(
      (value) => {
        savedRef.current = value;
        setSaved(value);
        if (adopt) setDraft(value.effective);
        setError("");
      },
      (failure: unknown) => setError(failure instanceof Error ? `Couldn't save: ${failure.message}` : "Couldn't save branch settings."),
    );
  }
  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next && savedRef.current) void persist(branchPolicyOverrides(savedRef.current, next), false);
  }

  useEffect(() => {
    let live = true;
    client.call<BranchPolicySettings>("project-git:read", [path]).then(
      (value) => {
        if (!live) return;
        savedRef.current = value;
        setSaved(value);
        setDraft(value.effective);
      },
      (failure: unknown) => live && setError(failure instanceof Error ? failure.message : "Couldn't read branch settings."),
    );
    // Leaving the screen saves what was typed last.
    return () => {
      live = false;
      flush();
    };
  }, [client, path]);

  if (!draft || !saved)
    return (
      <Group title={BRANCH_COPY.title} inset={0}>
        <View style={BLOCK}>{error ? <InlineError message={error} /> : <Text style={styles.caption}>Loading…</Text>}</View>
      </Group>
    );

  const check = branchPolicyCheck(draft);
  const fromRepo = (field: keyof BranchPolicy) => Object.hasOwn(saved.repository, field);
  const describe = (field: keyof BranchPolicy) => (fromRepo(field) ? BRANCH_COPY.repository : BRANCH_COPY[field].description);
  function edit(patch: Partial<BranchPolicy>, now = false) {
    const next = { ...draft!, ...patch };
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    // An invalid template or base branch waits until it's fixed.
    const problems = branchPolicyCheck(next);
    if (problems.template || problems.baseBranch) {
      pending.current = null;
      return;
    }
    pending.current = next;
    if (now) flush();
    else timer.current = setTimeout(flush, 600);
  }
  // Values are code; placeholders like "Current branch" are prose.
  const mono = (value: string) => (value ? { fontFamily: fonts.mono } : null);
  const textField = (field: "username" | "baseBranch") => (
    <View style={BLOCK}>
      <Field
        label={BRANCH_COPY[field].label}
        value={draft[field]}
        placeholder={BRANCH_COPY[field].placeholder}
        editable={!fromRepo(field)}
        invalid={field === "baseBranch" && !!check.baseBranch}
        style={mono(draft[field])}
        onChangeText={(value) => edit({ [field]: value })}
      />
      <Text style={styles.caption}>{describe(field)}</Text>
      {field === "baseBranch" ? <InlineError message={check.baseBranch} /> : null}
    </View>
  );
  const checkbox = (field: "dashesOnly" | "trackBase") => (
    <ListRow
      title={BRANCH_COPY[field].label}
      subtitle={describe(field)}
      subtitleLines={2}
      disabled={fromRepo(field)}
      toggle={{ value: draft[field], onChange: () => edit({ [field]: !draft[field] }, true) }}
    />
  );

  return (
    <View style={{ gap: 12 }}>
      <Group title={BRANCH_COPY.title} footer={BRANCH_COPY.footer} inset={0}>
        <View style={BLOCK}>
          <Field
            label={BRANCH_COPY.template.label}
            value={draft.template}
            placeholder={BRANCH_COPY.template.placeholder}
            editable={!fromRepo("template")}
            invalid={!!check.template}
            style={mono(draft.template)}
            onSelectionChange={(event) => {
              caret.current = event.nativeEvent.selection.start;
            }}
            onChangeText={(template) => edit({ template })}
          />
          <Text style={styles.caption}>{describe("template")}</Text>
          {!fromRepo("template") && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {BRANCH_TOKENS.map((token) => (
                <Chip
                  key={token}
                  label={`{${token}}`}
                  accessibilityLabel={`Add ${token}`}
                  onPress={() => edit({ template: insertToken(draft.template, token, caret.current ?? draft.template.length) })}
                />
              ))}
            </View>
          )}
          {check.template ? (
            <InlineError message={check.template} />
          ) : (
            <Text style={styles.caption} selectable>
              {BRANCH_COPY.example} <Text style={[styles.code, { fontSize: styles.caption.fontSize }]}>{check.preview}</Text>
            </Text>
          )}
        </View>
        {textField("username")}
        {checkbox("dashesOnly")}
        {textField("baseBranch")}
        {checkbox("trackBase")}
        <View style={BLOCK}>
          <Field
            label={BRANCH_COPY.instructions.label}
            value={draft.instructions}
            placeholder={BRANCH_COPY.instructions.placeholder}
            editable={!fromRepo("instructions")}
            multiline
            style={{ minHeight: 88, textAlignVertical: "top" }}
            onChangeText={(instructions) => edit({ instructions })}
          />
          <Text style={styles.caption}>{describe("instructions")}</Text>
        </View>
      </Group>
      <InlineError message={error} />
      {Object.keys(saved.local).length > 0 && (
        <PillButton
          title={BRANCH_COPY.reset}
          variant="plain"
          size="small"
          style={{ alignSelf: "flex-start" }}
          onPress={() => {
            pending.current = null;
            void persist({}, true);
          }}
        />
      )}
    </View>
  );
}

import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Text, TextInput, View } from "react-native";
import type { CoordinatorState } from "@milagre/shared/model";
import type { GitHubIssue, GitHubIssueList, GitHubImportRequest, GitHubImportResult } from "@milagre/shared/github-issue";
import { githubImportTargets, useGitHubIssue } from "@milagre/shared/use-github-issue";
import { randomUUID } from "expo-crypto";
import { radius, type } from "./design-tokens";
import { useTheme } from "./theme";
import { PageScroll, PillButton, PullDown, SheetHeader } from "./ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function GitHubIssueImport({
  client,
  project,
  computer,
  baseBranch,
  sessionId,
  options,
  note,
  onClose,
  onImported,
}: {
  client: { call: <T>(method: string, args: unknown[]) => Promise<T> };
  project: { path: string; name: string; state: CoordinatorState };
  computer: string;
  baseBranch: string;
  sessionId?: number;
  options: GitHubImportRequest["options"];
  note: string;
  onClose: () => void;
  onImported: (result: GitHubImportResult) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const api = useMemo(
    () => ({
      list: () => client.call<GitHubIssueList>("github:issues", [project.path]),
      read: (url: string) => client.call<GitHubIssue>("github:issue", [project.path, url]),
    }),
    [client, project.path],
  );
  const form = useGitHubIssue(api);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState(sessionId ? `existing:${sessionId}` : "worktree");
  const [base, setBase] = useState(baseBranch);
  const [messageId] = useState(randomUUID);
  const [busy, setBusy] = useState(false);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const life = mounted;
    return () => {
      life.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const targets = githubImportTargets(project.state);
  const choices = [{ value: "worktree", label: "New Chat in a new Worktree" }, ...targets];
  const text = { color: colors.ink, fontSize: type.subheadline };
  const field = { ...text, borderWidth: 1, borderColor: colors.line, borderRadius: radius.control, padding: 12, minHeight: 44 };
  async function confirm(issue: GitHubIssue) {
    if (importing.current) return;
    importing.current = true;
    setBusy(true);
    setError("");
    try {
      const selected = target === "worktree" ? { kind: "worktree" as const, baseBranch: base } : targets.find((item) => item.value === target)?.target;
      if (!selected) throw new Error("Choose an available target.");
      const result = await client.call<GitHubImportResult>("github:import", [
        { projectPath: project.path, url: issue.url, account: issue.account, target: selected, options: { ...options, clientMessageId: messageId }, note },
      ]);
      if (mounted.current) onImported(result);
    } catch (failure) {
      if (mounted.current) setError(ipcErrorMessage(failure));
    } finally {
      importing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
        <SheetHeader title="Import GitHub issue" subtitle={`${project.name} on ${computer}`} />
        <PageScroll keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
          <Text selectable style={{ ...text, color: colors.ink3 }}>
            Project: {project.path}
          </Text>
          <TextInput
            accessibilityLabel="GitHub issue URL"
            placeholder="https://github.com/owner/repository/issues/123"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            value={url}
            editable={!busy}
            onChangeText={(value) => {
              setUrl(value);
              form.invalidate();
              setError("");
            }}
            style={field}
          />
          <PillButton title="Preview URL" variant="secondary" disabled={busy || form.loading || !url.trim()} onPress={() => void form.preview(url)} />
          <PullDown
            label="Select an open GitHub issue"
            sections={[
              {
                items: (form.list?.issues ?? []).map((issue) => ({
                  id: issue.url,
                  title: `${issue.repository}#${issue.number}: ${issue.title}`,
                  disabled: busy || form.loading,
                })),
              },
            ]}
            onSelect={(selectedUrl) => {
              if (!busy) {
                setUrl(selectedUrl);
                void form.preview(selectedUrl);
              }
            }}
          >
            <Text style={{ ...field, textAlign: "center" }}>Select an open GitHub issue</Text>
          </PullDown>
          {form.loading && (
            <Text accessibilityRole="text" style={text}>
              Reading GitHub...
            </Text>
          )}
          {!form.loading && form.list && !form.list.issues.length && <Text style={text}>No open issues in this Project. You can paste an issue URL.</Text>}
          {form.issue && (
            <View style={{ gap: 10, padding: 16, borderWidth: 1, borderColor: colors.line, borderRadius: radius.control }}>
              <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>
                {form.issue.title}
              </Text>
              <Text selectable style={text}>
                {form.issue.url}
              </Text>
              <Text style={{ ...text, color: colors.ink3 }}>
                Account: {form.issue.account}. Imported: {new Date(form.issue.importedAt).toLocaleString()}
              </Text>
              <Text selectable style={text}>
                {form.issue.body || "No description."}
              </Text>
            </View>
          )}
          <PullDown
            label="Chat and Worktree target"
            sections={[{ items: choices.map((item) => ({ id: item.value, title: item.label, checked: item.value === target, disabled: busy })) }]}
            onSelect={(selectedTarget) => {
              if (!busy) setTarget(selectedTarget);
            }}
          >
            <Text style={field}>{choices.find((item) => item.value === target)?.label ?? "Choose target"}</Text>
          </PullDown>
          {target === "worktree" && (
            <>
              <Text style={text}>Base branch</Text>
              <TextInput
                accessibilityLabel="Base branch"
                autoCapitalize="none"
                autoCorrect={false}
                value={base}
                editable={!busy}
                onChangeText={setBase}
                style={field}
              />
            </>
          )}
          {!!note.trim() && (
            <Text selectable style={text}>
              Your message: {note}
            </Text>
          )}
          {!!(error || form.error) && (
            <Text accessibilityRole="alert" style={text}>
              {error || form.error}
            </Text>
          )}
          <PillButton
            title={busy ? "Importing..." : "Import and start Chat"}
            loading={busy}
            disabled={!form.issue || busy || form.loading || (target === "worktree" && !base.trim())}
            onPress={() => {
              if (form.issue) void confirm(form.issue);
            }}
          />
          <PillButton title="Cancel" variant="plain" disabled={busy} onPress={onClose} />
        </PageScroll>
      </View>
    </Modal>
  );
}

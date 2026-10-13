import { Fragment, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import {
  emptyLocalMcpDraft,
  localMcpClientConfig,
  localMcpClientDetail,
  localMcpConfiguration,
  localMcpDescription,
  localMcpDraftFor,
  localMcpReadOnly,
  type LocalMcpApi,
  type LocalMcpClient,
  type LocalMcpDraft,
  type LocalMcpStatus,
} from "@milagre/shared/local-mcp";
import { useLocalMcp } from "@milagre/shared/use-local-mcp";
import { useSession } from "./session";
import { Button, Field, Toggle, useStyles } from "./ui";
import { Icon } from "./icons";
import { useTheme } from "./theme";

export function LocalMcpSection() {
  const client = useSession().client;
  const api = useMemo<LocalMcpApi | undefined>(
    () =>
      client
        ? {
            status: () => client.call("local-mcp:status", []),
            create: (input) => client.call("local-mcp:create", [input]),
            update: (id, input) => client.call("local-mcp:update", [id, input]),
            rotate: (id) => client.call("local-mcp:rotate", [id]),
            revoke: (id) => client.call("local-mcp:revoke", [id]),
            enableClient: (id, input) => client.call("local-mcp:enableClient", [id, input]),
            disableClient: (id) => client.call("local-mcp:disableClient", [id]),
          }
        : undefined,
    [client],
  );
  const local = useLocalMcp(api);
  const styles = useStyles();
  const [setup, setSetup] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyLocalMcpDraft);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const custom = local.status?.connections.filter((c) => !c.clientId) ?? [];
  const open = (item?: LocalMcpClient) => {
    local.dismiss();
    setCopied(false);
    setCopyError(false);
    setSetup(item?.id ?? "custom");
    setDraft(item?.connection ? localMcpDraftFor(item.connection) : { ...emptyLocalMcpDraft(), label: item?.label ?? "" });
  };
  const submit = async (item?: LocalMcpClient) => {
    const config = { ...localMcpConfiguration(draft), ...(item?.connection?.expiresAt ? { expiresAt: item.connection.expiresAt } : {}) };
    if (item ? await local.enableClient(item.id, config) : await local.create(config)) setSetup(null);
  };
  const editor = (item?: LocalMcpClient) =>
    local.status && (
      <View style={{ gap: 16, paddingVertical: 16 }}>
        <Text accessibilityRole="header" style={styles.text}>
          {item ? `Access for ${item.label}` : "Custom connection"}
        </Text>
        {!item && <Field label="Connection name" value={draft.label} onChangeText={(label) => setDraft({ ...draft, label })} />}
        <ScopeFields draft={draft} onChange={setDraft} status={local.status} />
        <Button
          title={local.busy ? "Saving..." : item ? (item.enabled ? "Save access" : `Enable ${item.label}`) : "Create configuration"}
          disabled={local.busy || !draft.label.trim() || !(draft.kind === "designs" ? draft.chatId.trim() : draft.projectPaths.length)}
          onPress={() => void submit(item)}
        />
        <Button title="Cancel" secondary disabled={local.busy} onPress={() => setSetup(null)} />
      </View>
    );
  return (
    <View style={{ gap: 24 }}>
      <Text style={styles.muted}>Connect your local tools to Milagre. Choose which Projects or Designs each app can access when you enable it.</Text>
      {local.error ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {local.error}
        </Text>
      ) : null}
      {!local.status && !local.error ? <Text style={styles.muted}>Loading client settings...</Text> : null}
      <View>
        {(local.status?.clients ?? []).map((item) => (
          <Fragment key={item.id}>
            <View style={{ paddingVertical: 8, gap: 4 }}>
              <Toggle
                title={item.label}
                selected={item.enabled}
                disabled={local.busy || item.state === "unavailable"}
                onPress={() => {
                  if (item.enabled) {
                    setSetup(null);
                    void local.disableClient(item.id);
                  } else if (setup === item.id) setSetup(null);
                  else open(item);
                }}
              />
              {localMcpClientDetail(item) ? <Text style={styles.muted}>{localMcpClientDetail(item)}</Text> : null}
              {item.enabled || item.state === "error" ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Set up ${item.label}`}
                  disabled={local.busy}
                  onPress={() => open(item)}
                  style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
                >
                  <Text style={styles.text}>Set up</Text>
                </Pressable>
              ) : null}
            </View>
            {setup === item.id ? editor(item) : null}
            <View style={styles.separator} />
          </Fragment>
        ))}
      </View>
      <View style={{ gap: 12 }}>
        <Text style={styles.muted}>
          Enabled clients are set up when Milagre starts. Restart the client after setup. Access stays on the computer running Milagre.
        </Text>
        <Button title="Refresh" secondary disabled={local.busy} onPress={() => void local.refresh()} />
      </View>
      <View style={styles.separator} />
      <View style={{ gap: 12 }}>
        <Toggle
          title="Custom MCP"
          selected={customOpen}
          disabled={local.busy || !local.status}
          onPress={() => {
            setCustomOpen(!customOpen);
            if (customOpen) {
              if (setup === "custom") setSetup(null);
              local.dismiss();
              setShowConnections(false);
            } else if (!custom.length) open();
          }}
        />
        {customOpen ? (
          <View style={{ gap: 12 }}>
            <Text style={styles.muted}>For another app, create a scoped connection and copy its configuration.</Text>
            {setup !== "custom" && !local.credential ? (
              <Button title="Create MCP config" secondary disabled={local.busy || !local.status} onPress={() => open()} />
            ) : null}
            {setup === "custom" ? editor() : null}
            {local.credential ? (
              <View style={{ gap: 12 }}>
                <Text style={styles.muted}>Copy this configuration now. The credential is available only once.</Text>
                <Button
                  title={copied ? "Copied" : "Copy MCP config"}
                  onPress={() =>
                    void Clipboard.setStringAsync(localMcpClientConfig(local.credential!)).then(
                      () => {
                        setCopied(true);
                        setCopyError(false);
                      },
                      () => setCopyError(true),
                    )
                  }
                />
                <Button title="Done" secondary onPress={local.dismiss} />
                {copyError ? (
                  <Text accessibilityRole="alert" style={styles.text}>
                    Could not copy. Try again before closing this configuration.
                  </Text>
                ) : null}
              </View>
            ) : null}
            {custom.length > 0 ? (
              <Button title={`Manage custom connections (${custom.length})`} secondary onPress={() => setShowConnections(!showConnections)} />
            ) : null}
            {showConnections
              ? custom.map((connection) => {
                  const active = !connection.revokedAt && !(connection.expiresAt && Date.parse(connection.expiresAt) <= local.checkedAt);
                  const writable = Object.values(connection.grants).some((scope) => scope.capabilities.some((cap) => cap !== "read"));
                  return (
                    <View key={connection.id} style={{ gap: 8, paddingVertical: 8 }}>
                      <Text style={styles.text}>
                        {connection.label}
                        {connection.revokedAt ? " (Revoked)" : !active ? " (Expired)" : ""}
                      </Text>
                      <Text selectable style={styles.muted}>
                        {localMcpDescription(connection)}
                      </Text>
                      {active ? (
                        <>
                          <Button
                            title="Replace credential"
                            secondary
                            disabled={local.busy}
                            onPress={() => {
                              setCopied(false);
                              setCopyError(false);
                              void local.rotate(connection.id);
                            }}
                          />
                          {writable ? (
                            <Button
                              title="Restrict to read"
                              secondary
                              disabled={local.busy}
                              onPress={() => void local.update(connection.id, localMcpReadOnly(connection))}
                            />
                          ) : null}
                          <Button title="Revoke" secondary disabled={local.busy} onPress={() => void local.revoke(connection.id)} />
                        </>
                      ) : null}
                    </View>
                  );
                })
              : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
function ScopeFields({ draft, onChange, status }: { draft: LocalMcpDraft; onChange: (draft: LocalMcpDraft) => void; status: LocalMcpStatus }) {
  const styles = useStyles();
  return (
    <>
      <Text style={styles.muted}>Allow access to</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Allow access to">
        {(["projects", "designs"] as const).map((kind) => (
          <ScopeChoice
            key={kind}
            radio
            title={kind === "projects" ? "Projects" : "Designs only"}
            selected={draft.kind === kind}
            onPress={() => onChange({ ...draft, kind })}
          />
        ))}
      </View>
      {draft.kind === "projects" ? (
        <>
          {!status.projects.length ? <Text style={styles.muted}>Open a Project in Milagre to grant access to it.</Text> : null}
          {status.projects.map((project) => (
            <ScopeChoice
              key={project.path}
              title={`${project.name} (${project.path})`}
              selected={draft.projectPaths.includes(project.path)}
              onPress={() =>
                onChange({
                  ...draft,
                  projectPaths: draft.projectPaths.includes(project.path)
                    ? draft.projectPaths.filter((p) => p !== project.path)
                    : [...draft.projectPaths, project.path],
                })
              }
            />
          ))}
        </>
      ) : (
        <>
          <Field label="Chat reference" placeholder="/path/to/project#123" value={draft.chatId} onChangeText={(chatId) => onChange({ ...draft, chatId })} />
          <Field label="Design IDs" value={draft.designIds} onChangeText={(designIds) => onChange({ ...draft, designIds })} />
          <Text style={styles.muted}>Use * for all designs in this Chat, or separate IDs with commas. Public sharing is separate.</Text>
          {!status.groups.some((g) => g.id === "designs" && g.enabled) ? (
            <Text style={styles.muted}>Design tools are unavailable while Designs is off.</Text>
          ) : null}
        </>
      )}
      <ScopeChoice
        title={draft.kind === "designs" ? "Allow design edits" : "Allow creating Worktrees and Chats and starting tasks"}
        selected={draft.write}
        onPress={() => onChange({ ...draft, write: !draft.write })}
      />
    </>
  );
}

function ScopeChoice({ title, selected, onPress, radio = false }: { title: string; selected: boolean; onPress: () => void; radio?: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole={radio ? "radio" : "checkbox"}
      accessibilityLabel={title}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, opacity: pressed ? 0.6 : 1 })}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderWidth: 1,
          borderRadius: radio ? 10 : 4,
          borderColor: selected ? colors.ink : colors.ink3,
          backgroundColor: selected && !radio ? colors.ink : colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? (
          radio ? (
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.ink }} />
          ) : (
            <Icon icon={Tick02Icon} tone="onInk" size={16} />
          )
        ) : null}
      </View>
      <Text style={[styles.text, { flex: 1 }]}>{title}</Text>
    </Pressable>
  );
}

import { Fragment, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  emptyLocalMcpDraft,
  localMcpClientConfig,
  localMcpClientDetail,
  localMcpConfiguration,
  localMcpDescription,
  localMcpDraftFor,
  localMcpDraftValid,
  localMcpReadOnly,
  localMcpWritable,
  setLocalMcpDraftKind,
  toggleLocalMcpDraftConnector,
  toggleLocalMcpDraftProject,
  type LocalMcpApi,
  type LocalMcpClient,
  type LocalMcpDraft,
  type LocalMcpStatus,
} from "@milagre/shared/local-mcp";
import { useLocalMcp } from "@milagre/shared/use-local-mcp";
import type { ConnectorSummary } from "@milagre/shared/connectors";
import { useSession } from "./session";
import { CheckRow, ErrorNotice, Field, InlineError, PillButton, pressStyle, Toggle, useStyles } from "./ui";

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
            onChanged: client.live
              ? (callback) => {
                  let down = false;
                  const live = client.live("", {
                    onSignal: (signal) => {
                      if (signal === "mcp") callback({});
                    },
                    onStatus: (up) => {
                      if (up && down) callback({});
                      down = !up;
                    },
                  });
                  return () => live.close();
                }
              : undefined,
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
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  useEffect(() => {
    if (!client || !setup) return;
    let live = true;
    client.call<ConnectorSummary[]>("connectors:list", []).then(
      (items) => live && setConnectors(items),
      () => live && setConnectors([]),
    );
    return () => {
      live = false;
    };
  }, [client, setup]);
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
        <ConnectorFields draft={draft} onChange={setDraft} connectors={connectors} />
        <PillButton
          title={local.busy ? "Saving…" : item ? (item.enabled ? "Save access" : `Enable ${item.label}`) : "Create configuration"}
          disabled={local.busy || !localMcpDraftValid(draft)}
          onPress={() => void submit(item)}
        />
        <PillButton title="Cancel" secondary disabled={local.busy} onPress={() => setSetup(null)} />
      </View>
    );
  return (
    <View style={{ gap: 24 }}>
      <Text style={styles.muted}>Connect your local tools to Milagre. Choose which Projects, Designs and Connectors each app can use when you enable it.</Text>
      {local.error ? <ErrorNotice message={local.error} /> : null}
      {!local.status && !local.error ? <Text style={styles.muted}>Loading client settings…</Text> : null}
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
                  accessibilityState={{ disabled: local.busy }}
                  disabled={local.busy}
                  onPress={() => open(item)}
                  style={({ pressed }) => [{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }, pressStyle({ pressed, disabled: local.busy })]}
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
          Enabled clients are set up when Milagre starts. Restart a client after enabling it; scope changes apply at once. Access stays on the computer running
          Milagre.
        </Text>
        <PillButton title="Refresh" secondary disabled={local.busy} onPress={() => void local.refresh()} />
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
              <PillButton title="Create MCP config" secondary disabled={local.busy || !local.status} onPress={() => open()} />
            ) : null}
            {setup === "custom" ? editor() : null}
            {local.credential ? (
              <View style={{ gap: 12 }}>
                <Text style={styles.muted}>Copy this configuration now. The credential is available only once.</Text>
                <PillButton
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
                <PillButton title="Done" secondary onPress={local.dismiss} />
                <InlineError message={copyError ? "Could not copy. Try again before closing this configuration." : ""} />
              </View>
            ) : null}
            {custom.length > 0 ? (
              <PillButton title={`Manage custom connections (${custom.length})`} secondary onPress={() => setShowConnections(!showConnections)} />
            ) : null}
            {showConnections
              ? custom.map((connection) => {
                  const active = !connection.revokedAt && !(connection.expiresAt && Date.parse(connection.expiresAt) <= local.checkedAt);
                  const writable = localMcpWritable(connection);
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
                          <PillButton
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
                            <PillButton
                              title="Restrict to read"
                              secondary
                              disabled={local.busy}
                              onPress={() => void local.update(connection.id, localMcpReadOnly(connection))}
                            />
                          ) : null}
                          <PillButton title="Revoke" secondary destructive disabled={local.busy} onPress={() => void local.revoke(connection.id)} />
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
const scopeKindLabel = (kind: LocalMcpDraft["kind"]) => (kind === "projects" ? "Projects" : kind === "all-projects" ? "All Projects" : "Designs only");
function ScopeFields({ draft, onChange, status }: { draft: LocalMcpDraft; onChange: (draft: LocalMcpDraft) => void; status: LocalMcpStatus }) {
  const styles = useStyles();
  return (
    <>
      <Text style={styles.muted}>Allow access to</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Allow access to">
        {(["projects", "all-projects", "designs"] as const).map((kind) => (
          <CheckRow key={kind} title={scopeKindLabel(kind)} checked={draft.kind === kind} onPress={() => onChange(setLocalMcpDraftKind(draft, kind))} />
        ))}
      </View>
      {draft.kind === "projects" ? (
        <>
          {!status.projects.length ? <Text style={styles.muted}>Open a Project in Milagre to grant access to it.</Text> : null}
          {status.projects.map((project) => (
            <CheckRow
              key={project.path}
              kind="checkbox"
              title={project.name}
              subtitle={project.path}
              subtitleLines={1}
              checked={draft.projectPaths.includes(project.path)}
              onPress={() => onChange(toggleLocalMcpDraftProject(draft, project.path))}
            />
          ))}
        </>
      ) : draft.kind === "all-projects" ? (
        <Text style={styles.muted}>Includes every Project open in Milagre now and any Project added later.</Text>
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
      <CheckRow
        kind="checkbox"
        title={draft.kind === "designs" ? "Allow design edits" : "Allow creating Worktrees and Chats and starting tasks"}
        checked={draft.write}
        onPress={() => onChange({ ...draft, write: !draft.write })}
      />
    </>
  );
}
const connectorChoices = [
  ["none", "No connectors"],
  ["all", "All connectors"],
  ["some", "Choose connectors"],
] as const;
function ConnectorFields({
  draft,
  onChange,
  connectors,
}: {
  draft: LocalMcpDraft;
  onChange: (draft: LocalMcpDraft) => void;
  connectors: ConnectorSummary[] | null;
}) {
  const styles = useStyles();
  return (
    <>
      <Text style={styles.muted}>Connectors</Text>
      <Text style={styles.muted}>Lets this app use the tools of the Connectors on your computer, through Milagre.</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Connectors">
        {connectorChoices.map(([value, title]) => (
          <CheckRow key={value} title={title} checked={draft.connectors === value} onPress={() => onChange({ ...draft, connectors: value })} />
        ))}
      </View>
      {draft.connectors === "some" ? (
        <>
          {connectors && !connectors.length ? <Text style={styles.muted}>Add a Connector on your computer first.</Text> : null}
          {(connectors ?? []).map((connector) => (
            <CheckRow
              key={connector.id}
              kind="checkbox"
              title={connector.name}
              checked={draft.connectorIds.includes(connector.id)}
              onPress={() => onChange(toggleLocalMcpDraftConnector(draft, connector.id))}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

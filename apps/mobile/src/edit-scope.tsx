import { useMemo, useState } from "react";
import { Modal, Text, View } from "react-native";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { scopePaths, scopePolicy, scopeSummary, useEditScope, type EditScopeApi, type EditScopeView } from "@milagre/shared/edit-scope";
import { useSession } from "./session";
import { CircleButton, Field, InlineError, PageScroll, PillButton, SheetHeader, useStyles } from "./ui";

export function EditScopeControl({ chatId, visible = true }: { chatId: string; visible?: boolean }) {
  const { client } = useSession();
  const api = useMemo<EditScopeApi>(
    () => ({
      read: (request) => (client ? client.call("chat:edit-scope:read", [request]) : Promise.reject(Error("Connect to the Computer to read edit scope."))),
      save: (request) => (client ? client.call("chat:edit-scope:save", [request]) : Promise.reject(Error("Connect to the Computer to save edit scope."))),
      resolve: (request) =>
        client ? client.call("chat:edit-scope:resolve", [request]) : Promise.reject(Error("Connect to the Computer to review edit scope.")),
    }),
    [client],
  );
  const scope = useEditScope(api, chatId, visible),
    [open, setOpen] = useState(false),
    styles = useStyles();
  const view = scope.view;
  return (
    <>
      <PillButton title={scopeSummary(view)} variant="plain" size="small" onPress={() => setOpen(true)} />
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={styles.screen}>
          <SheetHeader title="Edit scope" leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => setOpen(false)} />} />
          <PageScroll contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}>
            <InlineError message={scope.error || (!visible ? "Connect to the Computer to read edit scope." : "")} />
            {visible && !view && !scope.error && <Text style={styles.caption}>Loading edit scope...</Text>}
            {view && (
              <>
                <Text style={styles.text}>{view.capability}</Text>
                <Text style={styles.caption}>{view.limits}</Text>
                {view.pending && (
                  <View style={{ gap: 8 }}>
                    <Text style={styles.label}>Requested scope</Text>
                    <Text selectable style={styles.text}>
                      {view.pending.reason}
                    </Text>
                    <Text style={styles.caption}>Review all proposed paths. Approval applies to a new turn; this turn keeps its active scope.</Text>
                    {view.pending.policy.allowed.map((rule) => (
                      <Text selectable key={`a${rule.root}/${rule.path}`} style={styles.caption}>
                        Allow: {rule.root}/{rule.path}
                      </Text>
                    ))}
                    {view.pending.policy.protected.map((rule) => (
                      <Text selectable key={`p${rule.root}/${rule.path}`} style={styles.caption}>
                        Protect: {rule.root}/{rule.path}
                      </Text>
                    ))}
                    {!view.pending.policy.allowed.length && <Text style={styles.caption}>No allowed paths.</Text>}
                    {!view.pending.policy.protected.length && <Text style={styles.caption}>No protected paths.</Text>}
                    <PillButton title="Approve for next turn" disabled={scope.pending} onPress={() => void scope.resolve(true)} />
                    <PillButton title="Decline" secondary disabled={scope.pending} onPress={() => void scope.resolve(false)} />
                  </View>
                )}
                {view.queuedPolicy && <Text style={styles.text}>Your approved scope will apply when a new turn starts.</Text>}
                <ScopeEditor key={view.revision} view={view} pending={scope.pending} save={scope.save} />
                {!!view.warnings.length && (
                  <View style={{ gap: 12 }}>
                    <Text style={styles.label}>Scope observations</Text>
                    {view.warnings.toReversed().map((warning) => (
                      <View key={JSON.stringify([warning.at, warning.root, warning.path, warning.message])} style={{ gap: 4 }}>
                        <Text style={styles.text}>{warning.message}</Text>
                        {warning.path && (
                          <Text selectable style={styles.caption}>
                            {warning.root}/{warning.path}
                          </Text>
                        )}
                        <Text style={styles.caption}>{new Date(warning.at).toLocaleString()}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {view.lastChecked && <Text style={styles.caption}>Last observed: {new Date(view.lastChecked).toLocaleString()}</Text>}
              </>
            )}
          </PageScroll>
        </View>
      </Modal>
    </>
  );
}
function ScopeEditor({ view, pending, save }: { view: EditScopeView; pending: boolean; save: ReturnType<typeof useEditScope>["save"] }) {
  const styles = useStyles();
  const [fields, setFields] = useState(() =>
    Object.fromEntries(
      view.roots.map((root) => [root, { allowed: scopePaths(view.policy, root, "allowed"), protected: scopePaths(view.policy, root, "protected") }]),
    ),
  );
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.label}>{view.policy ? "Active paths" : "Choose paths"}</Text>
      <Text style={styles.caption}>
        One file or directory per line, relative to its Worktree. A directory includes its descendants. Use . for the whole Worktree. Protected paths always
        win. Empty allowed paths permit no edits.
      </Text>
      {view.busy && <Text style={styles.text}>Stop this Chat and its background work to edit paths. Requests can be approved for the next turn.</Text>}
      {view.roots.map((root) => (
        <View key={root} style={{ gap: 8 }}>
          <Text selectable style={styles.caption}>
            {root}
          </Text>
          {(["allowed", "protected"] as const).map((kind) => (
            <Field
              key={kind}
              label={kind === "allowed" ? "Allowed paths" : "Protected paths"}
              multiline
              style={{ minHeight: 96 }}
              editable={!pending && !view.busy}
              value={fields[root]?.[kind] ?? ""}
              onChangeText={(value) => setFields((all) => ({ ...all, [root]: { ...all[root]!, [kind]: value } }))}
            />
          ))}
        </View>
      ))}
      <PillButton title="Save scope" disabled={pending || view.busy || !view.roots.length} onPress={() => void save(scopePolicy(view.roots, fields))} />
      {view.policy && <PillButton title="Remove scope" secondary disabled={pending || view.busy} onPress={() => void save(null)} />}
    </View>
  );
}

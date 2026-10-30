import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Add01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { mcpHeadersPayload, renameHeader, type McpHeaderRow } from "../mcp-headers";
import { useMcp } from "../use-mcp";
import { CheckRow, CircleButton, ErrorNotice, Field, Group, IconButton, PageScroll, PillButton, SheetHeader, useStyles } from "../ui";
import { useTheme } from "../theme";

const TARGETS: { value: McpTarget; title: string }[] = [
  { value: "everywhere", title: "Everywhere" },
  { value: "claude", title: "Claude only" },
  { value: "codex", title: "Codex only" },
];
const asTarget = (value: string | undefined): McpTarget => (value === "claude" || value === "codex" ? value : "everywhere");

/** Settings › MCP › add or edit a URL server. With `name` and `target` it edits that server; stored header values arrive masked. */
export default function McpAddSheet() {
  const params = useLocalSearchParams<{ name?: string; target?: string }>();
  const editing = !!params.name;
  const mcp = useMcp();
  const styles = useStyles();
  const { colors } = useTheme();
  const [name, setName] = useState(params.name ?? "");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [headers, setHeaders] = useState<McpHeaderRow[]>([]);
  const [target, setTarget] = useState<McpTarget>(asTarget(params.target));
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nextId = useRef(1);
  const loaded = useRef(false);

  useEffect(() => {
    if (!params.name || loaded.current) return;
    loaded.current = true;
    const server = params.name;
    void (async () => {
      try {
        const def = await mcp.definition(server, asTarget(params.target));
        if (!def) setError("Couldn’t read this server’s settings. Edit it in its CLI config.");
        else if (def.type === "stdio") setError("This server runs a command. Edit it on the Mac.");
        else {
          setName(def.name);
          setUrl(def.url);
          setTransport(def.type);
          setHeaders(Object.entries(def.headers).map(([key, value]) => ({ id: nextId.current++, key, value, masked: value === MCP_SECRET_MASK })));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load this server.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once for the opened server
  }, []);

  const change = (id: number, patch: Partial<McpHeaderRow>) => setHeaders((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  async function save() {
    if (saving || loading) return;
    const payload = mcpHeadersPayload(headers);
    if ("error" in payload) return setError(payload.error);
    const def: McpServerDefinition = { name: name.trim(), type: transport, url: url.trim(), headers: payload.headers };
    const problem = validateMcpServer(def);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    try {
      await mcp.saveUrl(def, target, params.name ? { name: params.name, target: asTarget(params.target) } : undefined);
      // A renamed server leaves the detail screen under this sheet pointing at a name that no longer exists.
      if (params.name && def.name !== params.name) router.dismissTo("/mcp");
      else router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const canSave = !saving && !loading && !(editing && !url);
  // A form sheet sizes its first scroll view to the sheet, so the header lives inside it, pinned as its sticky first
  // child: the keyboard rises from the bottom of the sheet, so Save stays reachable however the scroll view's keyboard
  // inset works out inside the sheet. A sticky header's own style moves to the wrapper RN draws around it, so the row
  // sits in a plain outer View (as in model-sheet.tsx).
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} stickyHeaderIndices={[0]} automaticallyAdjustKeyboardInsets>
      <View style={{ backgroundColor: colors.page }}>
        <SheetHeader
          title={editing ? "Edit MCP server" : "Add MCP server"}
          leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />}
          trailing={<CircleButton label={saving ? "Saving…" : "Save"} icon={Tick02Icon} filled disabled={!canSave} onPress={() => void save()} />}
        />
      </View>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ padding: 16, paddingTop: 8, gap: 16 }}>
        {/* Next to Save, so a refused save is seen without scrolling. */}
        {error ? <ErrorNotice message={error} /> : null}
        {loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <>
            <Field label="Name" value={name} onChangeText={setName} placeholder="linear" autoFocus={!editing} />
            <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://mcp.example.com/mcp" keyboardType="url" />
            <View style={{ gap: 8 }}>
              <Text style={styles.label}>Headers</Text>
              {headers.map((row) => (
                <View key={row.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Header name"
                      hideLabel
                      placeholder="Authorization"
                      value={row.key}
                      onChangeText={(key) => setHeaders((rows) => rows.map((item) => (item.id === row.id ? renameHeader(item, key) : item)))}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Header value"
                      hideLabel
                      placeholder="Value"
                      value={row.value}
                      secureTextEntry={row.masked}
                      onChangeText={(value) => change(row.id, { value, masked: false })}
                      onFocus={() => row.masked && change(row.id, { value: "" })}
                      onBlur={() => row.masked && !row.value && change(row.id, { value: MCP_SECRET_MASK })}
                    />
                  </View>
                  <IconButton
                    label="Remove header"
                    icon={Cancel01Icon}
                    size={32}
                    tone="ink3"
                    onPress={() => setHeaders((rows) => rows.filter((item) => item.id !== row.id))}
                  />
                </View>
              ))}
              <PillButton
                title="Add header"
                icon={Add01Icon}
                variant="tinted"
                size="small"
                style={{ alignSelf: "flex-start" }}
                onPress={() => setHeaders((rows) => [...rows, { id: nextId.current++, key: "", value: "", masked: false }])}
              />
            </View>
            <Group title="Load it in" role="radiogroup" inset={0}>
              {TARGETS.map((item) => (
                <CheckRow key={item.value} title={item.title} checked={target === item.value} onPress={() => setTarget(item.value)} />
              ))}
            </Group>
          </>
        )}
      </View>
    </PageScroll>
  );
}

import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { Icon } from "../icons";
import { mcpHeadersPayload, renameHeader, type McpHeaderRow } from "../mcp-headers";
import { useMcp } from "../use-mcp";
import { CircleButton, Field, PageScroll, useStyles } from "../ui";
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
  const [type, setType] = useState<"http" | "sse">("http");
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
          setType(def.type);
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
    const def: McpServerDefinition = { name: name.trim(), type, url: url.trim(), headers: payload.headers };
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
  // A form sheet sizes its first scroll view to the sheet, so the header lives inside it. It sticks to the top and holds
  // Save (the iOS form place, as in the model sheet): the keyboard rises from the bottom of the sheet, so Save stays
  // reachable however the scroll view's keyboard inset works out inside the sheet.
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} stickyHeaderIndices={[0]} automaticallyAdjustKeyboardInsets>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 6,
          backgroundColor: colors.page,
        }}
      >
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
          {editing ? "Edit MCP server" : "Add MCP server"}
        </Text>
        <View style={{ opacity: canSave ? 1 : 0.4 }}>
          <CircleButton label={saving ? "Saving" : "Save"} icon={Tick02Icon} filled onPress={canSave ? () => void save() : undefined} />
        </View>
      </View>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ padding: 20, paddingTop: 8, gap: 18 }}>
        {/* Next to Save, so a refused save is seen without scrolling. */}
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
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
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Remove header"
                    hitSlop={8}
                    onPress={() => setHeaders((rows) => rows.filter((item) => item.id !== row.id))}
                  >
                    <Icon icon={Cancel01Icon} tone="ink3" size={18} />
                  </Pressable>
                </View>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => setHeaders((rows) => [...rows, { id: nextId.current++, key: "", value: "", masked: false }])}
                style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: 36, justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
              >
                <Text style={{ color: colors.ink, fontSize: 15, fontWeight: "600" }}>Add header</Text>
              </Pressable>
            </View>
            <View style={{ gap: 8 }}>
              <Text style={styles.label}>Load it in</Text>
              <View
                accessibilityRole="radiogroup"
                style={{ backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 16 }}
              >
                {TARGETS.map((item, index) => (
                  <View key={item.value}>
                    {index > 0 && <View style={styles.separator} />}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: target === item.value }}
                      onPress={() => setTarget(item.value)}
                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", minHeight: 48, opacity: pressed ? 0.5 : 1 })}
                    >
                      <Text style={[styles.text, { flex: 1 }]}>{item.title}</Text>
                      {target === item.value ? <Icon icon={Tick02Icon} tone="ink" size={20} /> : null}
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}
      </View>
    </PageScroll>
  );
}

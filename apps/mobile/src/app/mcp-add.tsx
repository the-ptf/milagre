import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { Icon } from "../icons";
import { useMcp } from "../use-mcp";
import { Button, CircleButton, Field, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

type HeaderRow = { id: number; key: string; value: string; masked: boolean };
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
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
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
        if (!def) setError("This server is no longer there.");
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

  const change = (id: number, patch: Partial<HeaderRow>) => setHeaders((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  async function save() {
    if (saving || loading) return;
    const record: Record<string, string> = {};
    for (const row of headers) if (row.key.trim() || row.value) record[row.key.trim()] = row.value;
    const def: McpServerDefinition = { name: name.trim(), type, url: url.trim(), headers: record };
    const problem = validateMcpServer(def);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    try {
      await mcp.saveUrl(def, target, params.name ? { name: params.name, target: asTarget(params.target) } : undefined);
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  // A form sheet sizes its first scroll view to the sheet, so the header scrolls with the content.
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
          {editing ? "Edit MCP server" : "Add MCP server"}
        </Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ padding: 20, paddingTop: 8, gap: 18 }}>
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
                    <Field label="Header name" hideLabel placeholder="Authorization" value={row.key} onChangeText={(key) => change(row.id, { key })} />
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
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        <Button title="Save" loading={saving} disabled={loading || (editing && !url)} onPress={() => void save()} />
      </View>
    </PageScroll>
  );
}

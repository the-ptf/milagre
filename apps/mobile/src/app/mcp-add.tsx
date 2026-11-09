import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  MCP_SECRET_MASK,
  searchMcpCatalog,
  mcpCatalogDefinition,
  mcpCatalogAuthHint,
  type McpCatalogEntry,
  validateMcpServer,
  type McpServerDefinition,
  type McpTarget,
} from "@milagre/shared/mcp";
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
  const [choosing, setChoosing] = useState(!editing);
  const [service, setService] = useState<McpCatalogEntry | null>(null);
  const [search, setSearch] = useState("");
  const [token, setToken] = useState("");
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

  const choose = (entry: McpCatalogEntry | null) => {
    setService(entry);
    setChoosing(false);
    setName(entry?.id ?? "");
    setUrl(entry?.url ?? "");
    setType("http");
    setHeaders([]);
    setToken("");
    setError("");
  };
  const openLink = (href: string) => void Linking.openURL(href).catch(() => setError("Could not open this link."));

  async function save() {
    if (choosing || saving || loading) return;
    const payload = mcpHeadersPayload(headers);
    if ("error" in payload) return setError(payload.error);
    let def: McpServerDefinition;
    try {
      def = service ? mcpCatalogDefinition(service, token) : { name: name.trim(), type, url: url.trim(), headers: payload.headers };
    } catch (cause) {
      return setError(cause instanceof Error ? cause.message : "Could not configure this service.");
    }
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

  const canSave = !choosing && !saving && !loading && !(editing && !url);
  // A form sheet sizes its first scroll view to the sheet, so the header lives inside it, pinned as its sticky first
  // child: the keyboard rises from the bottom of the sheet, so Save stays reachable however the scroll view's keyboard
  // inset works out inside the sheet. A sticky header's own style moves to the wrapper RN draws around it, so the row
  // sits in a plain outer View (as in model-sheet.tsx).
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} stickyHeaderIndices={[0]} automaticallyAdjustKeyboardInsets>
      <View style={{ backgroundColor: colors.page }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 60,
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 8,
          }}
        >
          <Text
            accessibilityRole="header"
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 72,
              right: 72,
              top: 16,
              bottom: 8,
              textAlign: "center",
              textAlignVertical: "center",
              lineHeight: 40,
              color: colors.ink,
              fontSize: 17,
              fontWeight: "600",
            }}
            numberOfLines={1}
          >
            {editing ? "Edit MCP server" : service ? `Add ${service.name}` : choosing ? "Add MCP" : "Custom MCP"}
          </Text>
          {saving ? <View style={{ width: 44 }} /> : <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />}
          {!choosing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={editing ? "Save" : "Add"}
              accessibilityState={{ disabled: !canSave, busy: saving }}
              disabled={!canSave}
              hitSlop={8}
              onPress={() => void save()}
              style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}
            >
              {saving ? (
                <ActivityIndicator color={colors.ink3} />
              ) : (
                <Text style={{ color: canSave ? colors.ink : colors.ink3, fontSize: 17, fontWeight: "600" }}>{editing ? "Save" : "Add"}</Text>
              )}
            </Pressable>
          ) : (
            <View style={{ width: 44 }} />
          )}
        </View>
      </View>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ padding: 16, paddingTop: 8, gap: 24 }}>
        {/* Next to Save, so a refused save is seen without scrolling. */}
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        {choosing ? (
          <View style={{ gap: 16 }}>
            <Text style={styles.muted}>Choose a service. Its connection settings are ready to use.</Text>
            <Field label="Search services" hideLabel placeholder="Search services" value={search} onChangeText={setSearch} />
            <View style={{ backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 16 }}>
              {searchMcpCatalog(search).map((entry, index) => (
                <View key={entry.id}>
                  {index > 0 && <View style={styles.separator} />}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={entry.name}
                    onPress={() => choose(entry)}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16, opacity: pressed ? 0.5 : 1 })}
                  >
                    <View
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                      style={{ width: 32, height: 32, alignSelf: "flex-start", alignItems: "center", justifyContent: "flex-start" }}
                    >
                      <Svg width={22} height={22} viewBox="0 0 24 24">
                        <Path d={entry.iconPath} fill={colors.ink} />
                      </Svg>
                    </View>
                    <View style={{ flex: 1, gap: 4, alignSelf: "flex-start", marginTop: -2 }}>
                      <Text style={[styles.text, { fontWeight: "600", lineHeight: 20, includeFontPadding: false }]}>{entry.name}</Text>
                      <Text style={styles.muted}>{entry.description}</Text>
                    </View>
                    <Text style={styles.muted}>{entry.auth === "token" ? "Token" : "Sign in"}</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {searchMcpCatalog(search).length === 0 && <Text style={styles.muted}>No matching services. You can add a custom MCP with its URL.</Text>}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Custom MCP"
              onPress={() => choose(null)}
              style={({ pressed }) => ({
                backgroundColor: colors.surface,
                borderRadius: 14,
                borderCurve: "continuous",
                padding: 16,
                gap: 4,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Text style={[styles.text, { fontWeight: "600" }]}>Custom MCP</Text>
              <Text style={styles.muted}>Connect another service with a URL.</Text>
            </Pressable>
          </View>
        ) : loading ? (
          <Text style={styles.muted}>Loading…</Text>
        ) : (
          <>
            {!editing && (
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => {
                  setChoosing(true);
                  setService(null);
                  setToken("");
                  setError("");
                }}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={styles.text}>All services</Text>
              </Pressable>
            )}
            {service ? (
              <View style={{ gap: 16 }}>
                <Text style={styles.muted}>{service.description}</Text>
                <Text style={styles.muted}>{mcpCatalogAuthHint(service, true)}</Text>
                {service.auth === "token" && (
                  <>
                    <Field
                      label="Personal access token"
                      value={token}
                      onChangeText={(value) => {
                        setToken(value);
                        setError("");
                      }}
                      secureTextEntry
                      editable={!saving}
                    />
                    {service.tokenUrl && (
                      <Pressable accessibilityRole="link" onPress={() => openLink(service.tokenUrl!)} style={{ minHeight: 44, justifyContent: "center" }}>
                        <Text style={styles.text}>Create a token on {service.name}</Text>
                      </Pressable>
                    )}
                  </>
                )}
                <Pressable accessibilityRole="link" onPress={() => openLink(service.docsUrl)} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={styles.text}>{service.name} setup guide</Text>
                </Pressable>
              </View>
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
              </>
            )}
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
                      accessibilityState={{ checked: target === item.value, disabled: saving }}
                      disabled={saving}
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

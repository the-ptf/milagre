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
import { mcpHeadersPayload, renameHeader, type McpHeaderRow } from "../mcp-headers";
import { useMcp } from "../use-mcp";
import { CheckRow, CircleButton, Field, Group, IconButton, ListRow, PageScroll, SheetHeader, pressStyle, tap, useStyles } from "../ui";
import { useTheme } from "../theme";
import { hitSlopFor, lineHeight, space, type as typeScale } from "../design-tokens";

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
        else if (def.type === "stdio") setError("This server runs a command. Edit it on your computer.");
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
        <SheetHeader
          title={editing ? "Edit MCP server" : service ? `Add ${service.name}` : choosing ? "Add MCP" : "Custom MCP"}
          leading={saving ? null : <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />}
          trailing={
            choosing ? null : saving ? (
              <View accessibilityLabel={editing ? "Saving" : "Adding"} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={colors.ink3} />
              </View>
            ) : (
              <CircleButton label={editing ? "Save" : "Add"} icon={Tick02Icon} filled disabled={!canSave} onPress={() => void save()} />
            )
          }
        />
      </View>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ padding: space.gutter, paddingTop: space.md, gap: space.section }}>
        {/* Next to Save, so a refused save is seen without scrolling. */}
        {error ? (
          <Text accessibilityRole="alert" selectable style={[styles.text, { color: colors.error }]}>
            {error}
          </Text>
        ) : null}
        {choosing ? (
          <View style={{ gap: space.xl }}>
            <Text style={styles.muted}>Choose a service. Its connection settings are ready to use.</Text>
            <Field label="Search services" hideLabel placeholder="Search services" value={search} onChangeText={setSearch} />
            {searchMcpCatalog(search).length > 0 ? (
              <Group>
                {searchMcpCatalog(search).map((entry) => (
                  <ListRow
                    key={entry.id}
                    title={entry.name}
                    subtitle={entry.description}
                    subtitleLines={3}
                    value={entry.auth === "token" ? "Token" : "Sign in"}
                    leading={
                      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Svg width={20} height={20} viewBox="0 0 24 24">
                          <Path d={entry.iconPath} fill={colors.ink} />
                        </Svg>
                      </View>
                    }
                    onPress={() => choose(entry)}
                  />
                ))}
              </Group>
            ) : (
              <Text style={styles.muted}>No matching services. You can add a custom MCP with its URL.</Text>
            )}
            <Group inset={0}>
              <ListRow title="Custom MCP" subtitle="Connect another service with a URL." onPress={() => choose(null)} />
            </Group>
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
                      <IconButton
                        label="Remove header"
                        icon={Cancel01Icon}
                        size={32}
                        tone="ink3"
                        onPress={() => setHeaders((rows) => rows.filter((item) => item.id !== row.id))}
                      />
                    </View>
                  ))}
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={hitSlopFor(36)}
                    onPress={() => {
                      tap();
                      setHeaders((rows) => [...rows, { id: nextId.current++, key: "", value: "", masked: false }]);
                    }}
                    style={({ pressed }) => [{ alignSelf: "flex-start", minHeight: 36, justifyContent: "center" }, pressStyle({ pressed })]}
                  >
                    <Text style={{ color: colors.ink, fontSize: typeScale.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
                      Add header
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
            <Group title="Load it in" role="radiogroup" inset={0}>
              {TARGETS.map((item) => (
                <CheckRow key={item.value} title={item.title} checked={target === item.value} disabled={saving} compact onPress={() => setTarget(item.value)} />
              ))}
            </Group>
          </>
        )}
      </View>
    </PageScroll>
  );
}

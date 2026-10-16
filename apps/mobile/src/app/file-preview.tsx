import { useEffect, useState } from "react";
import { isMarkdownFile } from "@milagre/shared/file-link";
import { File, FileMode } from "expo-file-system";
import { Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSession } from "../session";
import { useRpc } from "../use-rpc";
import { FileCode } from "../file-code";
import { Markdown } from "../markdown";
import { ErrorNotice, PageScroll, useStyles } from "../ui";

export default function FilePreview() {
  const styles = useStyles();
  const { path, uri, name: localName } = useLocalSearchParams<{ path?: string; uri?: string; name?: string }>();
  const { client } = useSession();
  const remote = useRpc<{ text: string; binary: boolean; truncated: boolean }>(path ? client : null, "attachment:preview", [path]);
  const [local, setLocal] = useState<{ data?: { text: string; binary: boolean; truncated: boolean }; error?: string }>({});
  useEffect(() => {
    if (!uri) return;
    let current = true;
    readPickedFile(uri).then(
      (data) => {
        if (current) setLocal({ data });
      },
      (reason) => {
        if (current) setLocal({ error: reason instanceof Error ? reason.message : "Could not read this file." });
      },
    );
    return () => {
      current = false;
    };
  }, [uri]);
  const { data, error } = uri ? local : remote;
  const name = localName || path?.split(/[\\/]/).pop() || "File preview";
  // Markdown opens formatted, with the source a tap away. Relative links in it resolve against its own folder.
  const markdown = isMarkdownFile(name) && !!data?.text;
  const [formatted, setFormatted] = useState(true);
  const folder = path ? path.slice(0, path.lastIndexOf("/")) || "/" : undefined;
  return (
    <>
      <Stack.Screen options={{ title: name }} />
      {markdown && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button icon={formatted ? "chevron.left.forwardslash.chevron.right" : "doc.richtext"} onPress={() => setFormatted(!formatted)}>
            {formatted ? "Source" : "Formatted"}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <PageScroll contentContainerStyle={{ padding: 20, gap: 12 }}>
        {error ? (
          <ErrorNotice message={error} retry={uri ? undefined : remote.refresh} />
        ) : !data ? (
          <Text accessibilityRole="text" style={styles.muted}>
            {client ? "Reading file…" : "Connect to the computer to preview this file."}
          </Text>
        ) : data.binary ? (
          <Text style={styles.muted}>This file does not have a text preview.</Text>
        ) : markdown && formatted ? (
          <Markdown text={data.text} basePath={folder} />
        ) : data.text ? (
          <FileCode text={data.text} name={name} />
        ) : (
          <Text style={styles.muted}>This file is empty.</Text>
        )}
        {data?.truncated && (
          <View>
            <Text style={styles.caption}>Showing the first 256 KB.</Text>
          </View>
        )}
      </PageScroll>
    </>
  );
}

async function readPickedFile(uri: string) {
  const file = new File(uri);
  const handle = file.open(FileMode.ReadOnly);
  let bytes: Uint8Array;
  try {
    bytes = handle.readBytesSync(Math.min(file.size, 256 * 1024));
  } finally {
    handle.close();
  }
  let text = "";
  let binary = bytes.includes(0);
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: file.size > bytes.length });
  } catch {
    binary = true;
  }
  return binary ? { text: "", binary: true, truncated: false } : { text, binary: false, truncated: file.size > bytes.length };
}

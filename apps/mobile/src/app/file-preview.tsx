import { useEffect, useMemo, useState } from "react";
import { isMarkdownFile } from "@milagre/shared/file-link";
import { File, FileMode } from "expo-file-system";
import { Platform, Text, View } from "react-native";
import { Download04Icon, SourceCodeIcon, TextIcon } from "@hugeicons/core-free-icons";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSession } from "../session";
import { useRpc } from "../use-rpc";
import { FileCode } from "../file-code";
import { saveAttachment } from "../save-attachment";
import { Toast } from "../primitives/toast";
import { Markdown } from "../markdown";
import { ErrorNotice, HeaderButton, PageScroll, PillButton, useStyles } from "../ui";
import { fileLinkFolder } from "@milagre/shared/file-link";

/** The path to read, then `fallbacks` (a JSON list): files the Chat worked on that end with a path a reply named. */
function previewPaths(path: string | undefined, fallbacks: string | undefined): string[] {
  if (!path) return [];
  try {
    const parsed: unknown = fallbacks ? JSON.parse(fallbacks) : [];
    return [path, ...(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && !!item && item !== path) : [])];
  } catch {
    return [path];
  }
}

export default function FilePreview() {
  const styles = useStyles();
  const { path: named, uri, name: localName, fallbacks } = useLocalSearchParams<{ path?: string; uri?: string; name?: string; fallbacks?: string }>();
  const { client } = useSession();
  // A path a reply named from the agent's subfolder misses under the Chat's folder: each file the Chat worked on that
  // ends with it is read next. When none reads, the named path's own error shows.
  const paths = useMemo(() => previewPaths(named, fallbacks), [named, fallbacks]);
  // Which of `paths` is read, and the named path's error once it missed; other paths start over.
  const [tried, setTried] = useState({ paths, attempt: 0, namedError: "" });
  const { attempt, namedError } = tried.paths === paths ? tried : { attempt: 0, namedError: "" };
  const path = paths[Math.min(attempt, Math.max(paths.length - 1, 0))];
  const read = useRpc<{ text: string; binary: boolean; truncated: boolean }>(path ? client : null, "attachment:preview", [path]);
  const tryNext = !!read.error && attempt < paths.length - 1;
  // Adjusted while rendering, as React does for state that follows a value: the next read starts at once, and the miss
  // that moved it on is no longer this path's.
  if (tryNext) setTried({ paths, attempt: attempt + 1, namedError: attempt === 0 ? read.error : namedError });
  const remote = {
    data: read.data,
    error: tryNext || !read.error ? "" : namedError || read.error,
    refresh: () => {
      if (attempt) setTried({ paths, attempt: 0, namedError: "" });
      else read.refresh();
    },
  };
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
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const [saved, setSaved] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadError("");
    setSaved(false);
    try {
      setSaved(
        await saveAttachment({
          name,
          uri,
          read: (offset, version) => {
            if (!client || !path) throw new Error("Connect to the computer to download this file.");
            return client.call("attachment:read", version === undefined ? [path, offset] : [path, offset, version]);
          },
          progress: (received, total) => setDownloadProgress(total ? Math.round((received / total) * 100) : 100),
        }),
      );
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : "Could not download this file. Try again.");
    } finally {
      setDownloading(false);
    }
  };
  const folder = path ? fileLinkFolder(path) : undefined;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: name }} />
      {markdown && (
        <Stack.Toolbar placement="right">
          {Platform.OS === "ios" ? (
            <Stack.Toolbar.Button icon={formatted ? "chevron.left.forwardslash.chevron.right" : "doc.richtext"} onPress={() => setFormatted(!formatted)}>
              {formatted ? "Source" : "Formatted"}
            </Stack.Toolbar.Button>
          ) : (
            <Stack.Toolbar.View>
              <HeaderButton label={formatted ? "Source" : "Formatted"} icon={formatted ? SourceCodeIcon : TextIcon} onPress={() => setFormatted(!formatted)} />
            </Stack.Toolbar.View>
          )}
        </Stack.Toolbar>
      )}
      <PageScroll contentContainerStyle={{ padding: 16, gap: 12 }}>
        {!error && data?.binary && <Text style={styles.muted}>This file does not have a text preview.</Text>}
        {/* With an icon the ring takes its place, so the percentage stays readable. */}
        <PillButton
          icon={Download04Icon}
          title={downloading ? `Downloading… ${downloadProgress}%` : "Download"}
          loading={downloading}
          disabled={!uri && !client}
          onPress={() => void download()}
        />
        {!!downloadError && <ErrorNotice message={downloadError} />}
        {error ? (
          <ErrorNotice message={error} retry={uri ? undefined : remote.refresh} />
        ) : !data ? (
          <Text accessibilityRole="text" style={styles.muted}>
            {client ? "Reading file…" : "Connect to the computer to preview this file."}
          </Text>
        ) : data.binary ? null : markdown && formatted ? (
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
      {saved && <Toast text="File saved." />}
    </View>
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

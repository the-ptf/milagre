import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, type ViewInstance } from "react-native";
import type { ChatStep } from "@milagre/shared/model";
import { viewedImageName } from "@milagre/shared/reply-parts";
import type { MediaSource } from "./chat-reply";
import { useMediaState } from "./media-source";
import { PageScroll } from "./ui";
import { useTheme } from "./theme";
import { radius, type } from "./design-tokens";
import type { ViewerImage } from "./viewer-store";

type Entry = ViewerImage & { id: string; status: ChatStep["status"] };

function Tile({
  entry,
  thumb,
  onReady,
  onPress,
}: {
  entry: Entry;
  thumb: (view: ViewInstance | null) => void;
  onReady: (entry: Entry, ready: boolean) => void;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { source, failed } = useMediaState(entry.source);
  const sourceKey = JSON.stringify(source);
  const [load, setLoad] = useState<{ sourceKey: string; ready: boolean } | null>(null);
  const ready = load?.sourceKey === sourceKey && load.ready;
  const unavailable = entry.status === "failed" || failed || (load?.sourceKey === sourceKey && !load.ready);
  useEffect(() => onReady(entry, !!ready && !unavailable), [entry, ready, unavailable, onReady]);
  return (
    <Pressable
      ref={thumb}
      accessibilityRole="imagebutton"
      accessibilityLabel={`${entry.name}. ${unavailable ? "Image unavailable" : ready ? "Open full screen" : "Loading image"}`}
      accessibilityState={{ disabled: !ready, busy: !ready && !unavailable }}
      disabled={!ready || unavailable}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 80,
        height: 80,
        borderRadius: radius.control,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.canvas,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {source && !unavailable ? (
        <Image
          source={source}
          resizeMode="cover"
          style={{ position: "absolute", width: 80, height: 80, opacity: ready ? 1 : 0 }}
          onLoad={() => setLoad({ sourceKey, ready: true })}
          onError={() => setLoad({ sourceKey, ready: false })}
        />
      ) : null}
      {unavailable || !ready ? (
        <Text style={{ fontSize: type.caption1, color: colors.ink2, textAlign: "center", paddingHorizontal: 4 }}>
          {unavailable ? "Image unavailable" : "Loading image…"}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Native horizontal scrolling and the Chat's existing grouped viewer. Only decoded tiles enter it. */
export function ViewedImages({
  steps,
  media,
  open,
}: {
  steps: ChatStep[];
  media: MediaSource;
  open: (images: ViewerImage[], index: number, thumbs: (ViewInstance | null)[]) => void;
}) {
  const thumbs = useRef(new Map<string, ViewInstance>());
  const [loaded, setLoaded] = useState<Record<string, Entry>>({});
  const entries = useMemo(
    () => steps.map((step) => ({ id: step.id, name: viewedImageName(step), source: step.file ? media(step.file) : { uri: "" }, status: step.status })),
    [steps, media],
  );
  const ready = useCallback((entry: Entry, isReady: boolean) => {
    setLoaded((previous) => {
      const next = { ...previous };
      if (isReady) next[entry.id] = entry;
      else delete next[entry.id];
      return next;
    });
  }, []);
  if (!steps.length) return null;
  return (
    <PageScroll
      horizontal
      accessibilityLabel="Viewed images"
      style={{ flexGrow: 0, maxHeight: 88 }}
      contentContainerStyle={{ padding: 0, paddingBottom: 0, gap: 8 }}
    >
      {entries.map((entry) => (
        <Tile
          key={entry.id + ":" + (steps.find((step) => step.id === entry.id)?.file ?? "")}
          entry={entry}
          onReady={ready}
          thumb={(view) => {
            if (view) thumbs.current.set(entry.id, view);
            else thumbs.current.delete(entry.id);
          }}
          onPress={() => {
            const available = entries.filter((item) => loaded[item.id]?.source === item.source && item.status === "done");
            const index = available.findIndex((item) => item.id === entry.id);
            if (index >= 0)
              open(
                available,
                index,
                available.map((item) => thumbs.current.get(item.id) ?? null),
              );
          }}
        />
      ))}
    </PageScroll>
  );
}

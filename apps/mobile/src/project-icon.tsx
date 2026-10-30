import { useEffect, useState, useSyncExternalStore } from "react";
import { Image, Text, View } from "react-native";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { PROJECT_AVATAR, projectAvatarRadius, projectInitial } from "@milagre/shared/project-list";
import type { Client } from "./client";
import { lineHeight, type } from "./design-tokens";
import { Icon } from "./icons";
import { useTheme } from "./theme";

// Desktop's project avatars: the repository's own icon or favicon, else its GitHub owner's avatar. Read once per
// computer and Project for the app's life; a Mac without project:image, or a Project without one, keeps its initial.
const images = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Shows the icon the computer now returns, after one is chosen or reset in Settings. */
export function setProjectImage(client: Client, path: string, uri: string | null) {
  images.set(`${client.url}|${path}`, Promise.resolve(uri));
  version++;
  for (const listener of listeners) listener();
}

function projectImage(client: Client, path: string) {
  const key = `${client.url}|${path}`;
  let image = images.get(key);
  if (!image) {
    image = client.call<string | null>("project:image", [path]).then(
      (value) => (typeof value === "string" && /^(data:image\/|https:\/\/)/.test(value) ? value : null),
      () => null,
    );
    images.set(key, image);
  }
  return image;
}

/** A tile's frame and its glyph sizes (projectAvatarRadius): caption2 initials up to 24, footnote to 40, title1 above. */
function tile(size: number) {
  const frame = { width: size, height: size, borderRadius: projectAvatarRadius(size), borderCurve: "continuous" } as const;
  const text = size <= 24 ? "caption2" : size <= 40 ? "footnote" : "title1";
  const glyph = size <= 24 ? 12 : size <= 40 ? 16 : 24;
  return { frame, text, glyph } as const;
}

/** A Project's tile: its image, else desktop's ink square with its on-ink initial (`name`, or the folder's). */
export function ProjectIcon({ client, path, name, size = 28 }: { client: Client | null; path: string; name?: string; size?: number }) {
  const { colors } = useTheme();
  const [source, setSource] = useState<{ key: string; uri: string | null } | null>(null);
  const changed = useSyncExternalStore(subscribe, () => version);
  const key = client ? `${client.url}|${path}` : "";
  useEffect(() => {
    if (!client) return;
    let live = true;
    void projectImage(client, path).then((uri) => {
      if (live) setSource({ key: `${client.url}|${path}`, uri });
    });
    return () => {
      live = false;
    };
  }, [client, path, changed]);
  const uri = source?.key === key ? source.uri : null;
  const { frame, text } = tile(size);
  return uri ? (
    <Image source={{ uri }} accessibilityIgnoresInvertColors style={[frame, { backgroundColor: colors.field }]} />
  ) : (
    <View style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: colors[PROJECT_AVATAR.fill] }]}>
      <Text allowFontScaling={false} style={{ color: colors[PROJECT_AVATAR.ink], fontSize: type[text], lineHeight: lineHeight[text], fontWeight: "600" }}>
        {projectInitial(name ?? path.split("/").findLast(Boolean) ?? "")}
      </Text>
    </View>
  );
}

/** The mark of Chats without a Project, in a Project icon's place: the same ink tile with a bubble, since there is no
 * repository to show. */
export function ChatsHomeIcon({ size = 28 }: { size?: number }) {
  const { colors } = useTheme();
  const { frame, glyph } = tile(size);
  return (
    <View style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: colors[PROJECT_AVATAR.fill] }]}>
      <Icon icon={BubbleChatIcon} tone={PROJECT_AVATAR.ink} size={glyph} />
    </View>
  );
}

export function ProjectIcons({ client, projects }: { client: Client | null; projects: { id: string; path: string }[] }) {
  const visible = projects.slice(0, 3);
  return (
    <View accessibilityLabel={`${projects.length} linked Projects`} style={{ width: 28 + Math.max(0, visible.length - 1) * 10, height: 28 }}>
      {visible.map((project, index) => (
        <View key={project.id} style={{ position: "absolute", left: index * 10, top: 0 }}>
          <ProjectIcon client={client} path={project.path} />
        </View>
      ))}
    </View>
  );
}

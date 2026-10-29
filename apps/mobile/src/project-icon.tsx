import { useEffect, useState, useSyncExternalStore } from "react";
import { Image, View } from "react-native";
import { BubbleChatIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import type { Client } from "./client";
import { Icon } from "./icons";
import { useTheme } from "./theme";

// Desktop's project avatars: the repository's own icon or favicon, else its GitHub owner's avatar. Read once per
// computer and Project for the app's life; a Mac without project:image, or a Project without one, keeps the folder.
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

export function ProjectIcon({ client, path, size = 28 }: { client: Client | null; path: string; size?: number }) {
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
  const frame = { width: size, height: size, borderRadius: size / 4, borderCurve: "continuous" } as const;
  return uri ? (
    <Image source={{ uri }} accessibilityIgnoresInvertColors style={[frame, { backgroundColor: colors.field }]} />
  ) : (
    <View style={[frame, { alignItems: "center", justifyContent: "center", backgroundColor: colors.field }]}>
      <Icon icon={Folder01Icon} tone="ink2" size={size * 0.57} />
    </View>
  );
}

/** The mark of Chats without a Project, in a Project icon's place: a chat bubble, since there is no repository to show. */
export function ChatsHomeIcon({ size = 28 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.field,
      }}
    >
      <Icon icon={BubbleChatIcon} tone="ink2" size={size * 0.57} />
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

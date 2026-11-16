import { useRef, useState } from "react";
import { Image, View } from "react-native";
import { Cancel01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { ORCHESTRATOR_MAX_IMAGES } from "@milagre/shared/orchestrator";
import { pickAttachments } from "./attachment-picker";
import type { Attachment } from "./attachments";
import { radius, space } from "./design-tokens";
import { Icon } from "./icons";
import { DISABLED_OPACITY } from "./primitives/press-style";
import { useTheme } from "./theme";
import { IconButton, PullDown } from "./ui";

export type OrchestratorImage = { id: string; name: string; dataUrl: string };
type Picked = Attachment & { image: OrchestratorImage };

const SEND_CHARS = 900 * 1024;
const TOO_BIG = "These photos are too big to send together. Remove one and try again.";

export function useOrchestratorImages() {
  const [items, setItems] = useState<Picked[]>([]);
  const [error, setError] = useState("");
  const picking = useRef(false);
  async function attach(kind: "photos" | "camera" | "paste") {
    if (picking.current) return;
    picking.current = true;
    setError("");
    try {
      const added = await pickAttachments(kind);
      const photos = added.filter((item): item is Picked => !!item.image?.dataUrl);
      if (photos.length < added.length) setError("Only photos can go to the Orchestrator.");
      if (!photos.length) return;
      const next = [...items, ...photos];
      if (next.length > ORCHESTRATOR_MAX_IMAGES) return setError(`Attach at most ${ORCHESTRATOR_MAX_IMAGES} photos.`);
      if (next.reduce((total, item) => total + item.image.dataUrl.length, 0) > SEND_CHARS) return setError(TOO_BIG);
      setItems(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      picking.current = false;
    }
  }
  return {
    items,
    error,
    attach,
    images: () => items.map((item) => item.image),
    remove: (id: string) => {
      setItems((current) => current.filter((item) => item.id !== id));
      setError("");
    },
    clear: () => {
      setItems([]);
      setError("");
    },
    restore: (kept: Picked[]) => setItems(kept),
  };
}

export function OrchestratorAttachButton({ disabled, onAttach }: { disabled: boolean; onAttach: (kind: "photos" | "camera" | "paste") => void }) {
  return (
    <PullDown
      label="Attach photos"
      nativeTrigger={{ systemImage: "photo", disabled }}
      sections={[
        {
          items: [
            { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled },
            { id: "camera", title: "Take Photo", systemImage: "camera", disabled },
            { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled },
          ],
        },
      ]}
      onSelect={(kind) => onAttach(kind as "photos" | "camera" | "paste")}
    >
      <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", opacity: disabled ? DISABLED_OPACITY.control : 1 }}>
        <Icon icon={Image01Icon} tone="ink2" size={18} />
      </View>
    </PullDown>
  );
}

export function OrchestratorImageStrip({ items, disabled, onRemove }: { items: Attachment[]; disabled: boolean; onRemove: (id: string) => void }) {
  const { colors } = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, paddingTop: space.sm }}>
      {items.map((item) => (
        <View key={item.id} style={{ width: 64, height: 64 }}>
          <Image
            source={{ uri: item.uri }}
            accessibilityLabel={item.name}
            style={{ width: 64, height: 64, borderRadius: radius.control, backgroundColor: colors.field }}
          />
          <View style={{ position: "absolute", top: -10, right: -10 }}>
            <IconButton label={`Remove ${item.name}`} icon={Cancel01Icon} filled size={32} disabled={disabled} onPress={() => onRemove(item.id)} />
          </View>
        </View>
      ))}
    </View>
  );
}

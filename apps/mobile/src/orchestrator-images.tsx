import { useRef, useState } from "react";
import { Image, View } from "react-native";
import { Attachment01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { ORCHESTRATOR_MAX_IMAGES } from "@milagre/shared/orchestrator";
import { discardPastedImage, pickAttachments, preparePastedImage, type PastedImage } from "./attachment-picker";
import type { Attachment } from "./attachments";
import { radius, space } from "./design-tokens";
import { Icon } from "./icons";
import { DISABLED_OPACITY } from "./primitives/press-style";
import { useTheme } from "./theme";
import { IconButton, PullDown } from "./ui";

export type OrchestratorImage = { id: string; name: string; dataUrl: string };
type Picked = Attachment & { image: OrchestratorImage };
type ImageSource = "photos" | "camera" | "paste";

const SEND_CHARS = 900 * 1024;
const TOO_BIG = "These photos are too big to send together. Remove one and try again.";

export function useOrchestratorImages() {
  const [{ items, error }, setDraft] = useState<{ items: Picked[]; error: string }>({ items: [], error: "" });
  const [picking, setPicking] = useState(false);
  const preparing = useRef(false);
  async function attach(source: ImageSource | PastedImage) {
    if (preparing.current) {
      if (typeof source !== "string") discardPastedImage(source);
      return;
    }
    preparing.current = true;
    setPicking(true);
    setDraft((draft) => ({ ...draft, error: "" }));
    try {
      const added = typeof source === "string" ? await pickAttachments(source) : [await preparePastedImage(source)];
      const photos = added.filter((item): item is Picked => Boolean(item.image?.dataUrl));
      setDraft((draft) => {
        const next = [...draft.items, ...photos];
        if (next.length > ORCHESTRATOR_MAX_IMAGES) return { ...draft, error: `Attach at most ${ORCHESTRATOR_MAX_IMAGES} photos.` };
        if (next.reduce((total, item) => total + item.image.dataUrl.length, 0) > SEND_CHARS) return { ...draft, error: TOO_BIG };
        return { items: next, error: photos.length < added.length ? "Only photos can go to the Orchestrator." : "" };
      });
    } catch (failure) {
      setDraft((draft) => ({ ...draft, error: (failure as Error).message }));
    } finally {
      preparing.current = false;
      setPicking(false);
    }
  }
  return {
    items,
    error,
    picking,
    attach,
    images: () => items.map((item) => item.image),
    remove: (id: string) => setDraft((draft) => ({ items: draft.items.filter((item) => item.id !== id), error: "" })),
    clear: () => setDraft({ items: [], error: "" }),
    restore: (kept: Picked[]) => setDraft((draft) => ({ ...draft, items: kept })),
  };
}

export function OrchestratorAttachButton({ disabled, onAttach }: { disabled: boolean; onAttach: (kind: ImageSource) => void }) {
  return (
    <PullDown
      label="Attach photos"
      nativeTrigger={{ systemImage: "paperclip", iconSize: 16, disabled }}
      sections={[
        {
          items: [
            { id: "photos", title: "Photo Library", systemImage: "photo.on.rectangle", disabled },
            { id: "camera", title: "Take Photo", systemImage: "camera", disabled },
            { id: "paste", title: "Paste image", systemImage: "doc.on.clipboard", disabled },
          ],
        },
      ]}
      onSelect={(kind) => onAttach(kind as ImageSource)}
    >
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? DISABLED_OPACITY.control : 1 }}>
        <Icon icon={Attachment01Icon} tone="ink2" size={18} />
      </View>
    </PullDown>
  );
}

export function OrchestratorImageStrip({ items, disabled, onRemove }: { items: Attachment[]; disabled: boolean; onRemove: (id: string) => void }) {
  const { colors } = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingHorizontal: space.md, paddingVertical: space.xs }}>
      {items.map((item) => (
        <View key={item.id} style={{ width: 64, height: 64 }}>
          <Image
            source={{ uri: item.uri }}
            accessibilityLabel={item.name}
            style={{ width: 64, height: 64, borderRadius: radius.control, backgroundColor: colors.field }}
          />
          <View style={{ position: "absolute", top: -space.xs, right: -space.xs }}>
            <IconButton label={`Remove ${item.name}`} icon={Cancel01Icon} filled size={32} disabled={disabled} onPress={() => onRemove(item.id)} />
          </View>
        </View>
      ))}
    </View>
  );
}

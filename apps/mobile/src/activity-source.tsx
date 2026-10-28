import { View } from "react-native";
import { AiBrainIcon, CommandLineIcon, File01Icon, FileEditIcon, Image01Icon, Search01Icon, Wrench01Icon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import { activitySources, type ActivitySource as Source } from "@milagre/shared/tool-activity";
import type { ChatStep, StepKind } from "@milagre/shared/model";
import { Icon, LinearLogo, type IconData } from "./icons";
import { useTheme } from "./theme";

const icons: Record<StepKind, IconData> = {
  shell: CommandLineIcon,
  setup: CommandLineIcon,
  read: File01Icon,
  edit: FileEditIcon,
  search: Search01Icon,
  thinking: AiBrainIcon,
  image: Image01Icon,
  artifact: PaintBoardIcon,
  other: Wrench01Icon,
};

export function ActivityIcon({ source, size = 16 }: { source: Source; size?: number }) {
  return source.linear ? <LinearLogo size={size} /> : <Icon icon={icons[source.kind] ?? Wrench01Icon} size={size} />;
}

export function ActivitySources({ steps }: { steps: ChatStep[] }) {
  const { colors } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", paddingLeft: 6 }}>
      {activitySources(steps).map((source) => (
        <View
          key={source.id}
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 2,
            borderColor: colors.page,
            backgroundColor: colors.field,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: -6,
          }}
        >
          <ActivityIcon source={source} size={13} />
        </View>
      ))}
    </View>
  );
}

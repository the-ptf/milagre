import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import {
  ArrowRight01Icon,
  BubbleChatIcon,
  Cursor01Icon,
  Layers01Icon,
  LayoutBottomIcon,
  LeftToRightListBulletIcon,
  PaintBoardIcon,
  RulerIcon,
  SmartPhone01Icon,
  Tag01Icon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import { SettingsScroll } from "../../settings-find";
import { Group, Row } from "../../settings-list";
import { Icon, type IconData } from "../../icons";
import { useTheme } from "../../theme";
import { radius, space } from "../../design-tokens";
import { PillButton, Segmented, useStyles } from "../../ui";
import {
  COLOR_PREVIEW,
  DESIGN_SYSTEM_GROUPS,
  DESIGN_SYSTEM_INTRO,
  PLATFORM_NAMES,
  PLATFORM_RULES,
  designPlatform,
  type DesignPlatform,
  type DesignSection,
  type DesignSectionId,
} from "../../design-system-catalogue";

const ICONS: Record<DesignSectionId, IconData> = {
  colors: PaintBoardIcon,
  type: TextFontIcon,
  spacing: RulerIcon,
  surfaces: Layers01Icon,
  buttons: Cursor01Icon,
  rows: LeftToRightListBulletIcon,
  chips: Tag01Icon,
  menus: LayoutBottomIcon,
  composer: BubbleChatIcon,
  platforms: SmartPhone01Icon,
};

const noop = () => {};

export default function DesignSystemScreen() {
  const styles = useStyles();
  const [platform, setPlatform] = useState<DesignPlatform>(() => designPlatform(undefined, Platform.OS));
  const open = (section: DesignSection) => router.push({ pathname: "/design-system-page", params: { section: section.id, platform } });
  return (
    <>
      <Stack.Screen options={{ title: "Design system" }} />
      <SettingsScroll>
        <View style={{ gap: space.lg }}>
          <Text style={styles.muted}>{DESIGN_SYSTEM_INTRO}</Text>
          <Segmented
            label="Platform"
            value={platform}
            options={(["ios", "android"] as const).map((value) => ({ value, title: PLATFORM_NAMES[value] }))}
            onChange={(value) => setPlatform(designPlatform(value, Platform.OS))}
          />
        </View>
        {DESIGN_SYSTEM_GROUPS.map((group) => (
          <Group key={group.title} title={group.title}>
            {group.sections.map((section) => (
              <Row
                key={section.id}
                title={section.title}
                icon={ICONS[section.id]}
                value={
                  section.preview?.kind === "value" ? section.preview.value : section.preview?.kind === "count" ? String(PLATFORM_RULES.length) : undefined
                }
                trailing={section.preview?.kind === "dots" ? <ColorDots /> : section.preview?.kind === "send" ? <SendPreview /> : undefined}
                onPress={() => open(section)}
              />
            ))}
          </Group>
        ))}
      </SettingsScroll>
    </>
  );
}

function ColorDots() {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View style={{ flexDirection: "row", gap: space.xs }}>
        {COLOR_PREVIEW.map((key) => (
          <View key={key} style={{ width: 12, height: 12, borderRadius: radius.full, backgroundColor: colors[key] }} />
        ))}
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
}

function SendPreview() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <PillButton title="Send" size="small" onPress={noop} />
      </View>
      <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
    </View>
  );
}

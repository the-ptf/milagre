import React from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { HStack as IOSHStack, Host as IOSHost, Image as IOSImage, Menu as IOSMenu, Rectangle, Section as IOSSection, Text as IOSText } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  disabled as nativeDisabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  menuOrder,
  padding,
  tint,
  shapes,
  rotationEffect,
  opacity,
} from "@expo/ui/swift-ui/modifiers";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { useTheme } from "../theme";
import { showChoiceSheet } from "../choice-store";
import { tap } from "./tap";
import { pressStyle } from "./press-style";
import type { MenuSection, NativeMenuTrigger } from "./menu";
import { NativeMenuSection } from "./native-menu-section";

/** A hitSlop as its four edges. */
const edges = (slop: number | Insets = 0) =>
  typeof slop === "number" ? { top: slop, bottom: slop, left: slop, right: slop } : { top: 0, bottom: 0, left: 0, right: 0, ...slop };

/**
 * A native pull-down menu on its trigger. With `onPress`, a tap runs it and a long press opens the menu (a Chat row);
 * without it, a tap opens the menu (the header switchers, a row's ⋯ button). `hitSlop` grows the touch area past the
 * trigger without moving it (`hitSlopFor(size)` for a small one): the menu's own target is padded by it and pulled back
 * by negative margins, which take the place of any margins in `style`.
 */
export function PullDown({
  title,
  sections,
  onSelect,
  children,
  label,
  onPress,
  style,
  nativeTrigger,
  searchable,
  fill = false,
  hitSlop,
}: {
  title?: string;
  sections: MenuSection[];
  onSelect: (id: string) => void;
  children: React.ReactNode;
  label: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  nativeTrigger?: NativeMenuTrigger;
  searchable?: { placeholder: string; emptyLabel: string };
  /** The trigger fills `style`'s box: a row's whole area under its own tap targets (a Chat row's PR links). */
  fill?: boolean;
  hitSlop?: number | Insets;
}) {
  const { colors } = useTheme();
  const slop = edges(hitSlop);
  const pullBack = hitSlop ? { marginTop: -slop.top, marginBottom: -slop.bottom, marginLeft: -slop.left, marginRight: -slop.right } : null;
  const padOut = hitSlop ? { paddingTop: slop.top, paddingBottom: slop.bottom, paddingLeft: slop.left, paddingRight: slop.right } : null;
  if (searchable)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${nativeTrigger?.title ? `: ${nativeTrigger.title}` : ""}`}
        accessibilityState={{ disabled: !!nativeTrigger?.disabled }}
        disabled={nativeTrigger?.disabled}
        hitSlop={hitSlop}
        style={({ pressed }) => [style, pressStyle({ pressed })]}
        onPress={() => {
          Keyboard.dismiss();
          tap();
          showChoiceSheet({ title: title || sections[0]?.title || label, ...searchable, items: sections.flatMap((section) => section.items), onSelect });
        }}
      >
        {children}
      </Pressable>
    );
  if (Platform.OS === "ios" && nativeTrigger && !nativeTrigger.icon && !onPress) {
    // Composer menus use only SwiftUI views. No React child is handed to SwiftUI, avoiding the Fabric reparenting crash.
    const select = (id: string) => {
      tap();
      setTimeout(() => onSelect(id), 250);
    };
    const body = sections.map((section, index) => <NativeMenuSection key={index} section={section} onSelect={select} />);
    // The slop pads the SwiftUI view (all of it tappable); the wrapper's negative margins keep its place in the row.
    const grow = padding({ top: slop.top, bottom: slop.bottom, leading: slop.left, trailing: slop.right });
    const trigger = nativeTrigger.title ? (
      <IOSHStack
        spacing={6}
        // A 44pt tall frame around the label (footnote, so it follows Dynamic Type), all of it tappable.
        modifiers={[
          padding({ horizontal: 12, vertical: 6 }),
          frame({ minWidth: 0, maxWidth: nativeTrigger.maxWidth ?? 260, minHeight: 44 - slop.top - slop.bottom, alignment: "leading" }),
          grow,
          contentShape(shapes.rectangle()),
        ]}
      >
        {nativeTrigger.showIcon !== false ? <IOSImage systemName={nativeTrigger.systemImage as never} size={12} color={colors.ink2} /> : null}
        <IOSText modifiers={[font({ textStyle: "footnote", weight: "medium" }), foregroundStyle(colors.ink2), lineLimit(1)]}>{nativeTrigger.title}</IOSText>
        <IOSImage systemName="chevron.up.chevron.down" size={12} color={colors.ink3} />
      </IOSHStack>
    ) : (
      <IOSImage
        systemName={nativeTrigger.systemImage as never}
        size={nativeTrigger.iconSize ?? 20}
        color={colors.ink2}
        modifiers={[
          ...(nativeTrigger.rotation ? [rotationEffect(nativeTrigger.rotation)] : []),
          frame({ width: 44 - slop.left - slop.right, height: 44 - slop.top - slop.bottom }),
          grow,
          contentShape(shapes.rectangle()),
        ]}
      />
    );
    return (
      <View style={[style, pullBack]} onTouchStart={() => Keyboard.dismiss()}>
        <IOSHost matchContents seedColor={nativeTrigger.menuTint ?? colors.ink2} testID={label} ignoreSafeArea="all">
          <IOSMenu
            label={trigger}
            modifiers={[accessibilityLabel(label), menuOrder("fixed"), tint(nativeTrigger.menuTint ?? colors.ink2), nativeDisabled(!!nativeTrigger.disabled)]}
          >
            {title ? <IOSSection title={title}>{body}</IOSSection> : body}
          </IOSMenu>
        </IOSHost>
      </View>
    );
  }
  if (Platform.OS === "ios") {
    // A SwiftUI menu laid over the trigger, its label an invisible shape. Hosting the React trigger inside the menu
    // (RNHostView) crashed Fabric when SwiftUI re-attached a view React had already recycled (TestFlight build 9,
    // -[RCTViewComponentView unmountChildComponentView:index:]); here no React view ever lives inside SwiftUI.
    // Like Paseo, the choice runs once the menu has gone, so the re-render it causes never races the menu's teardown.
    const select = (id: string) => {
      tap();
      setTimeout(() => onSelect(id), 250);
    };
    // A tap menu keeps the order it is given (desktop's order), instead of iOS reversing it when it opens upward.
    const body = sections.map((section, index) => <NativeMenuSection key={index} section={section} onSelect={select} />);
    // The system draws menus below the keyboard, so a touch on the trigger lowers it first.
    return (
      <View style={style} onTouchStart={() => Keyboard.dismiss()}>
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.shrink}>
          {children}
        </View>
        <IOSHost
          style={hitSlop ? { position: "absolute", top: -slop.top, bottom: -slop.bottom, left: -slop.left, right: -slop.right } : StyleSheet.absoluteFill}
          testID={label}
          ignoreSafeArea="all"
        >
          <IOSMenu
            label={
              <Rectangle
                modifiers={[
                  foregroundStyle("#00000001"),
                  ...(nativeTrigger?.icon ? [opacity(0.001)] : []),
                  contentShape(shapes.rectangle()),
                  accessibilityLabel(`${label}${nativeTrigger?.title ? `: ${nativeTrigger.title}` : ""}`),
                ]}
              />
            }
            onPrimaryAction={onPress}
            modifiers={[menuOrder("fixed"), nativeDisabled(!!nativeTrigger?.disabled)]}
          >
            {title ? <IOSSection title={title}>{body}</IOSSection> : body}
          </IOSMenu>
        </IOSHost>
      </View>
    );
  }
  // The system draws menus below the keyboard, so a touch on the trigger lowers it first.
  const box = [fill ? { flex: 1 } : styles.shrink, padOut];
  const trigger = onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onTouchStart={() => Keyboard.dismiss()}
      style={({ pressed }) => [box, pressStyle({ pressed })]}
    >
      {children}
    </Pressable>
  ) : (
    <View accessible accessibilityRole="button" accessibilityLabel={label} onTouchStart={() => Keyboard.dismiss()} style={box}>
      {children}
    </View>
  );
  const actions: MenuAction[] = sections.map((section, index) => ({
    id: `section-${index}`,
    title: section.title || "",
    displayInline: true,
    subactions: section.items.map((item) => ({
      id: item.id,
      title: item.subtitle ? `${item.title}\n${item.subtitle}` : item.title,
      image: item.systemImage as MenuAction["image"],
      state: item.checked ? "on" : undefined,
      attributes: { destructive: item.destructive, disabled: item.disabled },
    })),
  }));
  return (
    <MenuView
      title={title}
      actions={actions}
      shouldOpenOnLongPress={!!onPress}
      onPressAction={({ nativeEvent }) => {
        tap();
        onSelect(nativeEvent.event);
      }}
      style={[style, pullBack]}
      testID={label}
    >
      {trigger}
    </MenuView>
  );
}

// The trigger gives way when `style` lets the menu shrink (a chip truncating its name in a full row).
const styles = StyleSheet.create({ shrink: { flexShrink: 1 } });

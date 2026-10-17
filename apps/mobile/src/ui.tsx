import React from "react";
import RNCMaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
  type ScrollViewInstance,
  type ScrollViewProps,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewStyle,
  type ViewProps,
} from "react-native";
import { Button as NativeButton, Host, Picker, Switch } from "@expo/ui";
import {
  Button as IOSButton,
  HStack as IOSHStack,
  Host as IOSHost,
  Image as IOSImage,
  Label as IOSLabel,
  Menu as IOSMenu,
  Picker as IOSPicker,
  Rectangle,
  Section as IOSSection,
  Text as IOSText,
  Toggle as IOSToggle,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  contentShape,
  disabled as nativeDisabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  lineLimit,
  menuOrder,
  padding,
  tint,
  pickerStyle,
  shapes,
  tag,
  controlSize,
  rotationEffect,
  opacity,
} from "@expo/ui/swift-ui/modifiers";
import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import * as Haptics from "expo-haptics";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { createStylesHook, fonts, useTheme, type Palette } from "./theme";
import { confirmSheet } from "./confirm-store";
import { showChoiceSheet } from "./choice-store";
import { NativePickerIcon, type NativePickerIconName } from "./native-picker-icon";
import { Icon, type IconData, type Tone } from "./icons";

// The library still extends NativeMethods, which RN 0.88 removed; its native view props are unchanged.
const MaskedView = RNCMaskedView as unknown as React.ComponentType<ViewProps & { maskElement: React.ReactElement }>;

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.page },
    content: { padding: 20, gap: 20, paddingBottom: 36 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
    card: {
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: 20,
      borderCurve: "continuous",
      gap: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    title: { color: colors.ink, fontSize: 34, fontWeight: "700", letterSpacing: -0.6 },
    subtitle: { color: colors.ink, fontSize: 20, fontWeight: "600" },
    text: { color: colors.ink, fontSize: 16, lineHeight: 23 },
    muted: { color: colors.ink2, fontSize: 15, lineHeight: 21 },
    label: { color: colors.ink2, fontSize: 13, fontWeight: "500" },
    caption: { color: colors.ink3, fontSize: 12 },
    section: { color: colors.ink3, fontSize: 11, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
    input: {
      backgroundColor: colors.field,
      color: colors.ink,
      fontSize: 16,
      borderRadius: 12,
      borderCurve: "continuous",
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 44,
    },
    error: { backgroundColor: colors.redTint, borderRadius: 16, borderCurve: "continuous", padding: 16, gap: 12 },
    code: { color: colors.ink, fontSize: 13, lineHeight: 20, fontFamily: fonts.mono },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  });

export type Styles = ReturnType<typeof makeStyles>;
/** The shared styles for the current theme, built once per palette. */
export const useStyles = createStylesHook(makeStyles);

export const tap = () => {
  if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => {});
};

// Native scrolling and choice controls have one shared entry point.
export const PageScroll = React.forwardRef<ScrollViewInstance, ScrollViewProps & { fadeEdges?: boolean }>(function PageScroll(
  { children, contentContainerStyle, fadeEdges = false, style, onLayout, onContentSizeChange, onScroll, ...props },
  ref,
) {
  const styles = useStyles();
  const metrics = React.useRef({ offset: props.contentOffset?.y ?? 0, height: 0, content: 0 });
  const current = React.useRef({ top: false, bottom: false, height: 0 });
  const [edges, setEdges] = React.useState({ top: false, bottom: false, height: 0 });
  const fading = fadeEdges && !props.horizontal;
  const update = () => {
    const { offset, height, content } = metrics.current;
    const next = { top: content > height && offset > 1, bottom: height > 0 && offset + height < content - 1, height };
    // Scrolling only renders when an edge is crossed, never for every scroll frame.
    if (next.top === current.current.top && next.bottom === current.current.bottom && next.height === current.current.height) return;
    current.current = next;
    setEdges(next);
  };
  const scroll = (
    <ScrollView
      ref={ref}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      contentContainerStyle={[styles.content, contentContainerStyle]}
      style={fading ? { flex: 1 } : style}
      scrollEventThrottle={fading ? 16 : undefined}
      onLayout={
        fading
          ? (event) => {
              metrics.current.height = event.nativeEvent.layout.height;
              update();
              onLayout?.(event);
            }
          : onLayout
      }
      onContentSizeChange={
        fading
          ? (width, height) => {
              metrics.current.content = height;
              update();
              onContentSizeChange?.(width, height);
            }
          : onContentSizeChange
      }
      onScroll={
        fading
          ? (event) => {
              metrics.current.offset = event.nativeEvent.contentOffset.y;
              update();
              onScroll?.(event);
            }
          : onScroll
      }
      {...props}
    >
      {children}
    </ScrollView>
  );
  if (!fading) return scroll;
  const edge = Math.min(28 / (edges.height || 1), 0.5);
  return (
    <MaskedView
      style={[style, { overflow: "hidden" }]}
      maskElement={
        <LinearGradient
          colors={[edges.top ? "transparent" : "black", "black", "black", edges.bottom ? "transparent" : "black"]}
          locations={[0, edge, 1 - edge, 1]}
          style={{ flex: 1 }}
        />
      }
    >
      {scroll}
    </MaskedView>
  );
});
export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
  loading = false,
  destructive = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  destructive?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}>
      <Host ignoreSafeArea="all" matchContents seedColor={(destructive ? colors.red : colors.ink) as string}>
        <NativeButton
          label={title}
          variant={secondary ? "outlined" : "filled"}
          disabled={disabled || loading}
          onPress={() => {
            tap();
            onPress();
          }}
          modifiers={Platform.OS === "ios" ? [controlSize("large")] : undefined}
          style={{ height: 48 }}
        />
      </Host>
      {loading && <ActivityIndicator accessibilityLabel={title} style={{ position: "absolute", right: 12 }} color={colors.ink2} />}
    </View>
  );
}
/** A pill button drawn in React Native, for places that need desktop's ink fill. */
export function PillButton({
  title,
  onPress,
  icon,
  disabled = false,
  secondary = false,
  loading = false,
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconData;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        {
          height: 46,
          paddingHorizontal: 18,
          borderRadius: 23,
          borderCurve: "continuous",
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: secondary ? colors.surface : colors.ink,
          borderWidth: secondary ? 1 : 0,
          borderColor: colors.lineStrong,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? colors.ink2 : colors.onInk} />
      ) : icon ? (
        <Icon icon={icon} tone={secondary ? "ink" : "onInk"} size={18} />
      ) : null}
      <Text style={{ color: secondary ? colors.ink : colors.onInk, fontSize: 15, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
export function Toggle({
  title,
  selected,
  onPress,
  disabled = false,
  tint: seed,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** The switch's on color; green unless a screen asks for another (the MCP screens use ink). */
  tint?: ColorValue;
}) {
  const { colors } = useTheme();
  return (
    <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 44 }} seedColor={(seed ?? colors.green) as string}>
      <Switch label={title} value={selected} disabled={disabled} onValueChange={onPress} />
    </Host>
  );
}
export function Field({ label, hideLabel = false, ...props }: TextInputProps & { label: string; hideLabel?: boolean; ref?: React.Ref<TextInputInstance> }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View style={{ gap: 8 }}>
      {!hideLabel && <Text style={styles.label}>{label}</Text>}
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.ink3}
        selectionColor={colors.accent}
        {...props}
        style={[styles.input, props.style]}
      />
    </View>
  );
}
export function ErrorNotice({ message, retry, retryTitle = "Reconnect" }: { message: string; retry?: () => void; retryTitle?: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text selectable style={{ color: colors.red, fontSize: 15, lineHeight: 22 }}>
        {message}
      </Text>
      {retry && <PillButton title={retryTitle} secondary onPress={retry} style={{ alignSelf: "flex-start" }} />}
    </View>
  );
}
/** iOS segmented control (a native SwiftUI Picker); Android falls back to the dropdown Picker. */
export function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; title: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Host ignoreSafeArea="all" matchContents={{ vertical: true }} style={{ minHeight: 32, width: "100%" }}>
      {Platform.OS === "ios" ? (
        <IOSPicker
          label={label}
          selection={value}
          onSelectionChange={onChange}
          modifiers={[pickerStyle("segmented"), accessibilityLabel(label)]}
          testID={`segmented-${label}`}
        >
          {options.map((option) => (
            <IOSText key={option.value} modifiers={[tag(option.value)]}>
              {option.title}
            </IOSText>
          ))}
        </IOSPicker>
      ) : (
        <Picker selectedValue={value} onValueChange={onChange} testID={`segmented-${label}`}>
          {options.map((option) => (
            <Picker.Item key={option.value} value={option.value} label={option.title} />
          ))}
        </Picker>
      )}
    </Host>
  );
}
export function ListRow({
  title,
  subtitle,
  subtitleLines = 1,
  onPress,
  onLongPress,
  disabled = false,
  compact = false,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  subtitleLines?: number;
  compact?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={onLongPress ? [{ name: "longpress", label: "Actions" }] : undefined}
      onAccessibilityAction={onLongPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: compact ? 8 : 13,
        minHeight: compact ? 48 : 52,
        opacity: disabled ? 0.4 : pressed ? 0.5 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={[styles.text, { fontWeight: "500" }, compact && { fontSize: 15, lineHeight: 20 }]}>
          {title}
        </Text>
        {/* Paths keep their start and end; descriptions can wrap. */}
        {subtitle && (
          <Text style={styles.caption} numberOfLines={subtitleLines} ellipsizeMode={subtitleLines === 1 ? "middle" : "tail"}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing ?? <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />}
    </Pressable>
  );
}
export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  filled = false,
  loading = false,
  tone = "ink2",
  size = 36,
}: {
  label: string;
  icon: IconData;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  loading?: boolean;
  tone?: Tone;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      hitSlop={4}
      disabled={disabled || loading}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? colors.ink : "transparent",
        opacity: disabled ? 0.35 : pressed ? 0.5 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={filled ? colors.onInk : colors.ink2} /> : <Icon icon={icon} size={20} tone={filled ? "onInk" : tone} />}
    </Pressable>
  );
}
/** Native Liquid Glass on iOS 26; SwiftUI supplies the fallback on older iOS. */
export function GlassIconButton({
  label,
  systemImage,
  icon,
  onPress,
}: {
  label: string;
  systemImage: React.ComponentProps<typeof IOSButton>["systemImage"];
  icon: IconData;
  onPress: () => void;
}) {
  if (Platform.OS !== "ios") return <CircleButton label={label} icon={icon} onPress={onPress} />;
  return (
    <Host ignoreSafeArea="all" matchContents>
      <IOSButton
        label={label}
        systemImage={systemImage}
        onPress={() => {
          tap();
          onPress();
        }}
        modifiers={[
          buttonStyle("glass"),
          controlSize("large"),
          labelStyle("iconOnly"),
          buttonBorderShape("circle"),
          tint({ type: "hierarchical", style: "primary" }),
          accessibilityLabel(label),
        ]}
      />
    </Host>
  );
}
/** A bar button for the native header; iOS draws the round glass background itself. */
export function HeaderButton({ label, icon, onPress }: { label: string; icon: IconData; onPress?: () => void }) {
  const body = (
    <View accessible accessibilityRole="button" accessibilityLabel={label} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
      <Icon icon={icon} size={20} tone="ink" />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      {body}
    </Pressable>
  );
}
/** The round bordered buttons inside sheets (close, back, done). */
export function CircleButton({ label, icon, onPress, filled = false }: { label: string; icon: IconData; onPress?: () => void; filled?: boolean }) {
  const { colors } = useTheme();
  const body = (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? colors.accent : colors.surface,
        borderWidth: filled ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.lineStrong,
      }}
    >
      <Icon icon={icon} size={20} tone={filled ? "onAccent" : "ink"} />
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      {body}
    </Pressable>
  );
}
type MenuItem = {
  id: string;
  title: string;
  systemImage?: string;
  icon?: NativePickerIconName;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  subtitle?: string;
};
export type MenuSection = { title?: string; items: MenuItem[] };
type NativeMenuTrigger = {
  title?: string;
  icon?: NativePickerIconName;
  systemImage: string;
  disabled?: boolean;
  maxWidth?: number;
  showIcon?: boolean;
  iconSize?: number;
  menuTint?: ColorValue;
  rotation?: number;
};
/** Custom native choice labels need a Picker so UIKit retains its selected checkmark. */
function NativeMenuSection({ section, onSelect }: { section: MenuSection; onSelect: (id: string) => void }) {
  const customChoices = section.items.length > 0 && section.items.every((item) => item.icon && item.checked !== undefined);
  if (customChoices)
    return (
      <IOSPicker label="" selection={section.items.find((item) => item.checked)?.id} onSelectionChange={onSelect} modifiers={[pickerStyle("inline")]}>
        <IOSSection title={section.title}>
          {section.items.map((item) => (
            <IOSLabel
              key={item.id}
              title={item.title}
              icon={<NativePickerIcon name={item.icon!} />}
              modifiers={[tag(item.id), nativeDisabled(!!item.disabled)]}
            />
          ))}
        </IOSSection>
      </IOSPicker>
    );
  return (
    <IOSSection title={section.title}>
      {section.items.map((item) =>
        item.checked !== undefined ? (
          <IOSToggle
            key={item.id}
            label={item.title}
            systemImage={item.systemImage as never}
            isOn={item.checked}
            onIsOnChange={() => onSelect(item.id)}
            modifiers={[nativeDisabled(!!item.disabled)]}
          />
        ) : (
          <IOSButton
            key={item.id}
            label={item.title}
            systemImage={item.systemImage as never}
            role={item.destructive ? "destructive" : undefined}
            onPress={() => onSelect(item.id)}
            modifiers={[nativeDisabled(!!item.disabled)]}
          />
        ),
      )}
    </IOSSection>
  );
}
/** A row's actions or a short list of choices, in the confirmation bottom sheet with Cancel last. */
export function showActions({
  title,
  actions,
  onSelect,
}: {
  title?: string;
  actions: { id: string; title: string; destructive?: boolean; disabled?: boolean }[];
  onSelect: (id: string) => void;
}) {
  const enabled = actions.filter((action) => !action.disabled);
  if (!enabled.length) return;
  Keyboard.dismiss();
  confirmSheet(title || "", undefined, [
    ...enabled.map((action) => ({
      text: action.title,
      style: action.destructive ? ("destructive" as const) : ("default" as const),
      onPress: () => {
        tap();
        onSelect(action.id);
      },
    })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}
/**
 * A native pull-down menu on its trigger. With `onPress`, a tap runs it and a long press opens the menu (a Chat row);
 * without it, a tap opens the menu (the header switchers, a row's ⋯ button).
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
}) {
  const { colors } = useTheme();
  if (searchable)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${nativeTrigger?.title ? `: ${nativeTrigger.title}` : ""}`}
        accessibilityState={{ disabled: !!nativeTrigger?.disabled }}
        disabled={nativeTrigger?.disabled}
        style={style}
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
    const trigger = nativeTrigger.title ? (
      <IOSHStack
        spacing={6}
        modifiers={[padding({ horizontal: 10, vertical: 6 }), frame({ minWidth: 0, maxWidth: nativeTrigger.maxWidth ?? 260, alignment: "leading" })]}
      >
        {nativeTrigger.showIcon !== false ? <IOSImage systemName={nativeTrigger.systemImage as never} size={14} color={colors.ink2} /> : null}
        <IOSText modifiers={[font({ size: 13, weight: "medium" }), foregroundStyle(colors.ink2), lineLimit(1)]}>{nativeTrigger.title}</IOSText>
        <IOSImage systemName="chevron.up.chevron.down" size={13} color={colors.ink3} />
      </IOSHStack>
    ) : (
      <IOSImage
        systemName={nativeTrigger.systemImage as never}
        size={nativeTrigger.iconSize ?? 21}
        color={colors.ink2}
        modifiers={[...(nativeTrigger.rotation ? [rotationEffect(nativeTrigger.rotation)] : []), frame({ width: 36, height: 36 })]}
      />
    );
    return (
      <View style={style} onTouchStart={() => Keyboard.dismiss()}>
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
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {children}
        </View>
        <IOSHost style={StyleSheet.absoluteFill} testID={label} ignoreSafeArea="all">
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
  const trigger = onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onTouchStart={() => Keyboard.dismiss()}>
      {children}
    </Pressable>
  ) : (
    <View accessibilityLabel={label} onTouchStart={() => Keyboard.dismiss()}>
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
      style={style}
      testID={label}
    >
      {trigger}
    </MenuView>
  );
}

import { StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { EdgeFade } from "./bottom-fade";
import { GlassSurface } from "./primitives/glass-surface";
import { Icon } from "./icons";
import { radius, space, type } from "./design-tokens";
import { useTheme } from "./theme";

const HEIGHT = 48;
const FADE_EXTRA = 28;
const KEYBOARD_GAP = 8;

/** The room the list keeps under its last row: the search capsule, and the keyboard with it while it is up. */
export function useSearchBottomInset() {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  return HEIGHT + space.xxl + (keyboard ? keyboard + KEYBOARD_GAP : Math.max(insets.bottom, space.lg));
}

/** The page's search, a glass capsule floating over the bottom of the list, as the Chat list's (chat-list-controls.tsx). */
export function PullRequestSearch({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const bottom = Math.max(insets.bottom, space.lg);
  return (
    <KeyboardStickyView pointerEvents="box-none" offset={{ closed: 0, opened: bottom - KEYBOARD_GAP }} style={StyleSheet.absoluteFill}>
      <View pointerEvents="none" style={[s.fade, { height: HEIGHT + bottom + FADE_EXTRA }]}>
        <EdgeFade edge="bottom" height={HEIGHT + bottom + FADE_EXTRA} width={window.width} />
      </View>
      <View pointerEvents="box-none" style={[s.row, { paddingBottom: bottom }]}>
        <View style={s.search}>
          <GlassSurface />
          <Icon icon={Search01Icon} tone="ink3" size={18} />
          <TextInput
            accessibilityLabel="Search pull requests"
            placeholder="Search pull requests"
            placeholderTextColor={colors.ink3}
            selectionColor={colors.accent}
            value={query}
            onChangeText={onQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{ flex: 1, color: colors.ink, fontSize: type.body, paddingVertical: 0, height: HEIGHT }}
          />
        </View>
      </View>
    </KeyboardStickyView>
  );
}

const s = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "hidden" },
  row: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: space.gutter },
  search: {
    height: HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.full,
    borderCurve: "continuous",
  },
});

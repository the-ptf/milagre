import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { StyleSheet, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type TextInputInstance } from "react-native";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";
import { RepeatIcon, Search01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { chatMarkTone } from "@milagre/shared/chats";
import { UpdateSettingsBadge } from "./update-sheet";
import { EdgeFade } from "./bottom-fade";
import { Icon } from "./icons";
import { scaledTiming, useMotionScale } from "./motion";
import { GlassIconButton } from "./ui";
import { useTheme } from "./theme";
import { pinsControls, shownHidden } from "./chat-list-controls-pin";
import { insertDictation } from "./voice-dictation";
import { useVoiceDictation } from "./voice-dictation-hook";
import { VoiceMicButton } from "./voice-mic-button";

/** How tall the floating controls are, and the room the list keeps under its last row. */
const CONTROLS_HEIGHT = 48;
const FADE_EXTRA = 28;
const DICTATION_ERROR_SECONDS = 4;
/** The controls stop this far above the keyboard, like the Chat composer. */
const KEYBOARD_GAP = 8;

/** The room the list keeps under its last row: the controls, and the keyboard with them while it is up. */
export function useControlsBottomInset() {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const bottom = Math.max(insets.bottom, 12);
  return CONTROLS_HEIGHT + 36 + (keyboard ? keyboard + KEYBOARD_GAP : bottom);
}

/**
 * Hides the controls when the list scrolls down and brings them back on a scroll up, at the top or bottom, or on
 * `reveal()`. Only the controls' position animates: UIKit drops Liquid Glass for good when an ancestor's alpha animates.
 */
export function useControlsVisibility() {
  const hidden = useSharedValue(0);
  const scale = useMotionScale();
  const state = useRef({ y: 0, hidden: false });
  const move = useCallback(
    (next: boolean) => {
      if (state.current.hidden === next) return;
      state.current.hidden = next;
      hidden.set(withTiming(next ? 1 : 0, scaledTiming({ duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }, scale)));
    },
    [hidden, scale],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const y = contentOffset.y;
      const delta = y - state.current.y;
      state.current.y = y;
      const atTop = y <= 8;
      const atBottom = y + layoutMeasurement.height >= contentSize.height - 8;
      if (atTop || atBottom || delta < -4) move(false);
      else if (delta > 4) move(true);
    },
    [move],
  );
  return { hidden, onScroll, reveal: () => move(false) };
}

/**
 * Routines, search and Settings floating over the list on Liquid Glass. The search field ends in a dictation mic where the
 * phone can transcribe; the update dot sits on Settings and the unread-Run dot on Routines. A take ends when the list hides.
 * While a take is under way or the search field is focused the controls stay up, whatever the list scrolls: the mic is the
 * only way to stop a take, and the field is being typed in.
 */
export function ChatListControls({
  hidden,
  query,
  onQuery,
  inputRef,
  onFocus,
  routines,
  onRoutines,
  onSettings,
  visible = true,
}: {
  hidden: ReturnType<typeof useControlsVisibility>["hidden"];
  query: string;
  onQuery: (query: string) => void;
  /** The search field, which ⌘K focuses. */
  inputRef?: Ref<TextInputInstance>;
  onFocus: () => void;
  /** Absent when this phone has no Routines to show: `unread` lights the dot. */
  routines?: { unread: boolean };
  onRoutines: () => void;
  onSettings: () => void;
  /** False while the list is mounted but off screen. */
  visible?: boolean;
}) {
  const { colors } = useTheme();
  // Where the caret is in the search field, to dictate at; unknown until the field has reported one.
  const caret = useRef<{ start: number; end: number } | null>(null);
  const latest = useRef(query);
  useEffect(() => {
    latest.current = query;
  });
  const dictation = useVoiceDictation((text, anchor) => {
    const edit = insertDictation(latest.current, anchor.selection, text);
    if (edit) onQuery(edit.value);
  });
  const { cancel, dismiss, error: dictationError } = dictation;
  const [focused, setFocused] = useState(false);
  // 1 while the controls are held up; eased like the hide, so letting go does not snap them away.
  const pinned = useSharedValue(0);
  const pin = pinsControls(dictation.phase, focused);
  const scale = useMotionScale();
  useEffect(() => {
    pinned.set(withTiming(pin ? 1 : 0, scaledTiming({ duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }, scale)));
  }, [pin, pinned, scale]);
  useEffect(() => {
    if (!visible) cancel();
  }, [visible, cancel]);
  useEffect(() => {
    if (!dictationError) return;
    const timer = setTimeout(dismiss, DICTATION_ERROR_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [dictationError, dismiss]);
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 12);
  const travel = CONTROLS_HEIGHT + bottom + 16;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: shownHidden(hidden.get(), pinned.get()) * travel }] }));
  const fade = useAnimatedStyle(() => ({ opacity: 1 - shownHidden(hidden.get(), pinned.get()) }));
  return (
    <KeyboardStickyView pointerEvents="box-none" offset={{ closed: 0, opened: bottom - KEYBOARD_GAP }} style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, bottom: 0 }, fade]}>
        <EdgeFade edge="bottom" height={CONTROLS_HEIGHT + bottom + FADE_EXTRA} />
      </Animated.View>
      <Animated.View pointerEvents="box-none" style={[s.row, { paddingBottom: bottom }, slide]}>
        {routines && (
          <View style={s.circle}>
            <GlassIconButton label={routines.unread ? "Routines, unread Runs" : "Routines"} systemImage="repeat" icon={RepeatIcon} onPress={onRoutines} />
            {routines.unread && <View pointerEvents="none" style={[s.dot, { backgroundColor: colors[chatMarkTone("unread")] }]} />}
          </View>
        )}
        <View style={s.search}>
          <LiquidGlassView
            pointerEvents="none"
            glassType="regular"
            isInteractive={false}
            reducedTransparencyFallbackColor={colors.surface}
            style={[StyleSheet.absoluteFill, { borderRadius: CONTROLS_HEIGHT / 2, borderCurve: "continuous" }]}
          />
          <Icon icon={Search01Icon} tone="ink3" size={18} />
          <TextInput
            ref={inputRef}
            accessibilityLabel="Search chats"
            placeholder={dictationError?.message ?? "Search chats"}
            placeholderTextColor={colors.ink3}
            selectionColor={colors.accent}
            value={query}
            onChangeText={onQuery}
            onFocus={() => {
              setFocused(true);
              onFocus();
            }}
            onBlur={() => setFocused(false)}
            onSelectionChange={(event) => {
              caret.current = event.nativeEvent.selection;
            }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{ flex: 1, color: colors.ink, fontSize: 16, paddingVertical: 0, height: CONTROLS_HEIGHT }}
          />
          {dictation.available ? (
            <VoiceMicButton
              phase={dictation.phase}
              level={dictation.level}
              onPress={() => {
                if (dictation.phase === "recording") return void dictation.stop();
                // Where the words land is fixed now, at the caret the user left, or at the end before there is one.
                const end = query.length;
                void dictation.start({ draft: query, selection: caret.current ?? { start: end, end } });
              }}
            />
          ) : null}
        </View>
        <View style={s.circle}>
          <GlassIconButton label="Settings" systemImage="gearshape" icon={Settings01Icon} onPress={onSettings} />
          <UpdateSettingsBadge />
        </View>
      </Animated.View>
    </KeyboardStickyView>
  );
}

const s = StyleSheet.create({
  row: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  circle: { width: CONTROLS_HEIGHT, height: CONTROLS_HEIGHT, alignItems: "center", justifyContent: "center" },
  search: {
    flex: 1,
    height: CONTROLS_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    borderRadius: CONTROLS_HEIGHT / 2,
    borderCurve: "continuous",
  },
  dot: { position: "absolute", right: 4, top: 4, width: 9, height: 9, borderRadius: 5 },
});

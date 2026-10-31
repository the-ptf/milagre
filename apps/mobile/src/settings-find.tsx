import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, View, type ScrollViewInstance, type ViewInstance } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { PageScroll } from "./ui";
import { useTheme } from "./theme";
import { radius } from "./design-tokens";

/** The row a Settings search result opened: its exact title, and where to scroll it into view. */
type FindTarget = {
  title: string;
  /** A new result, even for the same row, lights it again. */
  nonce: string;
  scroll: React.RefObject<ScrollViewInstance | null>;
  /** How far the page is scrolled now. */
  offset: React.RefObject<number>;
};

const FindContext = createContext<FindTarget | null>(null);

/**
 * A Settings page's scroll: the page opened from a search result (with `find` in its params) scrolls to the row with
 * that title and lights it up; opened any other way, it is a plain PageScroll.
 */
export function SettingsScroll({ children, onScroll, ...props }: React.ComponentProps<typeof PageScroll>) {
  const params = useLocalSearchParams<{ find?: string; findAt?: string }>();
  const scroll = useRef<ScrollViewInstance>(null);
  const offset = useRef(0);
  const title = typeof params.find === "string" ? params.find : "";
  const nonce = typeof params.findAt === "string" ? params.findAt : "";
  const target = React.useMemo(() => (title ? { title, nonce, scroll, offset } : null), [title, nonce]);
  return (
    <PageScroll
      ref={scroll}
      scrollEventThrottle={16}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y;
        onScroll?.(event);
      }}
      {...props}
    >
      <FindContext.Provider value={target}>{children}</FindContext.Provider>
    </PageScroll>
  );
}

/** Wraps a Settings row; only the row a search result named is wrapped in anything. */
export function Findable({ title, children }: { title: string; children: ReactNode }) {
  const target = useContext(FindContext);
  if (!target || target.title !== title) return children;
  return (
    <FoundRow key={target.nonce} target={target}>
      {children}
    </FoundRow>
  );
}

function FoundRow({ target, children }: { target: FindTarget; children: ReactNode }) {
  const { colors } = useTheme();
  const row = useRef<ViewInstance | null>(null);
  const [tint] = useState(() => new Animated.Value(1));
  const laidOut = useRef(false);
  // Brings the row to the upper middle of the page. Rows above it can still be arriving (a Mac's reply, a list), so it
  // measures again once the page has settled.
  const scrollToRow = () => {
    const page = target.scroll.current;
    if (!row.current || !page) return;
    // Both in window coordinates, so the page's insets and header don't matter: the row's distance below the page's
    // top, plus where the page is scrolled now, is where to scroll for the row to sit at 40% of the page.
    row.current.measureInWindow((_x, rowY, _width, rowHeight) => {
      page.measureInWindow((_px, pageY, _pageWidth, pageHeight) => {
        const y = target.offset.current + rowY - pageY + rowHeight / 2 - pageHeight * 0.4;
        page.scrollTo({ y: Math.max(0, y), animated: true });
      });
    });
  };
  useEffect(() => {
    // The tint holds while the page settles and the row scrolls in, then fades back to the card.
    const fade = Animated.sequence([Animated.delay(1100), Animated.timing(tint, { toValue: 0, duration: 1500, useNativeDriver: true })]);
    fade.start();
    AccessibilityInfo.announceForAccessibility?.(`${target.title}, found`);
    return () => fade.stop();
  }, [tint, target.title]);
  useEffect(() => {
    const again = setTimeout(scrollToRow, 500);
    return () => clearTimeout(again);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per result; scrollToRow reads refs only
  }, []);
  return (
    <View
      ref={row}
      collapsable={false}
      onLayout={() => {
        if (laidOut.current) return;
        laidOut.current = true;
        scrollToRow();
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: -4,
          bottom: -4,
          left: -10,
          right: -10,
          borderRadius: radius.control,
          borderCurve: "continuous",
          backgroundColor: colors.accentTint,
          opacity: tint,
        }}
      />
      {children}
    </View>
  );
}
